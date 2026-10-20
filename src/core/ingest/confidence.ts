/**
 * Transparent confidence + verification status for happy-hour information.
 *
 * Confidence is an internal ranking signal, not proof. Only an administrator action
 * produces the "verified" status — never an automated extraction, however confident.
 *
 *   confidence = reliability(source, method) × recency(age) + corroboration bonus
 *   capped at 0.5 when credible sources disagree (and the conflict is flagged).
 */
import { questionableReasons } from './quality'
import type { ExtractionMethod, FindingSourceKind, HappyHourFinding, HappyHourStatus } from './types'
import { findingFingerprint, schedulesAgree } from './validate'

const RELIABILITY: Record<FindingSourceKind, Partial<Record<ExtractionMethod, number>>> = {
  admin: { admin: 1 },
  official_website: { json_ld: 0.85, pattern: 0.75, llm: 0.55 },
  partner_feed: { pattern: 0.8, json_ld: 0.8 },
  osm: { osm_tag: 0.45 },
  user: { user: 0.35 },
}

export function reliability(sourceKind: FindingSourceKind, method: ExtractionMethod): number {
  return RELIABILITY[sourceKind]?.[method] ?? 0.3
}

const DAY = 86_400_000

/** 1.0 within 30 days, sliding to 0.25 after a year. Uses the source's own date if stated. */
export function recencyFactor(f: Pick<HappyHourFinding, 'checkedAt' | 'sourcePublishedAt'>, now: Date): number {
  // A page we fetched today but that says "updated March 2023" is as old as its stated date.
  const stamp = f.sourcePublishedAt ? Math.min(Date.parse(f.sourcePublishedAt), Date.parse(f.checkedAt)) : Date.parse(f.checkedAt)
  const days = Math.max(0, (now.getTime() - stamp) / DAY)
  if (days <= 30) return 1
  if (days <= 90) return 0.85
  if (days <= 180) return 0.6
  if (days <= 365) return 0.4
  return 0.25
}

export interface Assessment {
  status: HappyHourStatus
  confidence: number
  conflict: boolean
  /** Finding chosen to represent the listing (null when nothing usable). */
  primary: HappyHourFinding | null
  reasons: string[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Combine every current finding for one establishment.
 * `adminVerifiedAt` set ⇒ an admin confirmed the current data (status "verified" while fresh).
 */
export function assess(findings: readonly HappyHourFinding[], now: Date, adminVerifiedAt: string | null = null): Assessment {
  const usable = findings.filter((f) => f.windows.length || f.specials.length)
  const reasons: string[] = []
  if (adminVerifiedAt && now.getTime() - Date.parse(adminVerifiedAt) <= 180 * DAY) {
    return { status: 'verified', confidence: 1, conflict: false, primary: usable[0] ?? null, reasons: ['verified by an Aour admin'] }
  }
  if (!usable.length) {
    const mentioned = findings.some((f) => f.mentionedButUnparsed)
    return { status: mentioned ? 'unverified' : 'none', confidence: 0, conflict: false, primary: null, reasons: [mentioned ? 'happy hour mentioned but not parseable' : 'no information'] }
  }

  const scored = usable
    .map((f) => ({ f, s: reliability(f.sourceKind, f.method) * recencyFactor(f, now) }))
    .sort((a, b) => b.s - a.s)
  const top = scored[0]
  let confidence = top.s

  // Corroboration from independent sources that agree on the schedule.
  const agreeing = scored.slice(1).filter((x) => x.f.sourceUrl !== top.f.sourceUrl && schedulesAgree(x.f.windows, top.f.windows) && x.s >= 0.3)
  confidence = Math.min(0.95, confidence + 0.1 * agreeing.length)
  if (agreeing.length) reasons.push(`corroborated by ${agreeing.length} other source(s)`)

  // Conflicts between credible sources must be flagged, not silently resolved.
  const conflict = scored.slice(1).some((x) => x.s >= 0.4 && x.f.windows.length > 0 && top.f.windows.length > 0 && !schedulesAgree(x.f.windows, top.f.windows))
  if (conflict) {
    confidence = Math.min(confidence, 0.5)
    reasons.push('sources disagree on the schedule')
  }

  const age = recencyFactor(top.f, now)
  let status: HappyHourStatus
  if (age <= 0.25) status = 'outdated'
  else if (conflict || top.f.method === 'llm') status = 'unverified'
  else if (top.f.sourceKind === 'official_website' || top.f.sourceKind === 'partner_feed') status = confidence >= 0.6 ? 'establishment_reported' : 'unverified'
  else if (top.f.sourceKind === 'osm' || top.f.sourceKind === 'user') status = 'community_reported'
  else status = 'unverified'
  // Unusual schedules (overlaps, opening-hours-length windows…) are never shown as confirmed.
  const questionable = questionableReasons(top.f)
  if (questionable.length && (status === 'establishment_reported' || status === 'community_reported')) {
    status = 'unverified'
    reasons.push(`needs review: ${questionable.join('; ')}`)
  }
  reasons.push(`best source: ${top.f.sourceKind}/${top.f.method}`)
  return { status, confidence: round2(confidence), conflict, primary: top.f, reasons }
}

export type ApplyDecision =
  | { action: 'apply'; reason: string } // write to the public listing
  | { action: 'review'; reason: string } // keep as pending finding for an admin
  | { action: 'touch'; reason: string } // unchanged: just record that we checked
  | { action: 'discard'; reason: string }

/**
 * Should a new finding change the PUBLIC listing automatically?
 * Admin-managed listings are never overwritten; AI-only and conflicting results wait for review.
 */
export function decideApply(
  finding: HappyHourFinding,
  current: { managedBy: 'auto' | 'admin'; fingerprint: string | null; hasData: boolean },
  assessment: Assessment,
): ApplyDecision {
  if (!finding.windows.length && !finding.specials.length) return { action: 'discard', reason: 'no structured facts' }
  if (current.fingerprint && current.fingerprint === findingFingerprint(finding)) return { action: 'touch', reason: 'unchanged' }
  if (current.managedBy === 'admin') return { action: 'review', reason: 'listing is admin-managed; proposing change' }
  if (finding.method === 'llm') return { action: 'review', reason: 'AI-extracted facts always need human review' }
  if (assessment.conflict) return { action: 'review', reason: 'conflicts with another source' }
  if (finding.sourceKind === 'user') return { action: 'review', reason: 'user submissions need confirmation' }
  if (finding.sourceKind === 'osm' && current.hasData) return { action: 'review', reason: 'open-data tag differs from existing data' }
  return { action: 'apply', reason: `${finding.sourceKind}/${finding.method}` }
}

export const STATUS_LABEL: Record<HappyHourStatus, string> = {
  verified: 'Verified',
  establishment_reported: 'Reported by venue',
  community_reported: 'Community reported',
  unverified: 'Needs verification',
  outdated: 'Outdated',
  none: 'No happy-hour info',
}
