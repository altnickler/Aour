/**
 * Enrich one venue from its own website: fetch politely, extract happy-hour facts
 * deterministically, validate, assess, and either apply, queue for review, or just
 * record that nothing changed. Facts are never invented: no information ⇒ no finding.
 */
import { assess, decideApply } from '@/core/ingest/confidence'
import { questionableReasons } from '@/core/ingest/quality'
import { extractHappyHour, findCandidateLinks } from '@/core/ingest/extract'
import { isCrawlableWebsite, nextCheckAt, type RefreshOutcome } from '@/core/ingest/refresh'
import type { HappyHourFinding } from '@/core/ingest/types'
import { findingFingerprint, validateFinding } from '@/core/ingest/validate'
import { htmlToText } from '@/core/ingest/extract'
import type { Fetcher, FetchResult } from './fetcher'
import type { LlmExtractor } from './llm'
import type { EnrichmentTarget, PipelineStore } from './store'

/** Homepage + at most this many same-site pages (menu / happy-hour / specials) per venue. */
export const MAX_SUBPAGES = 3

export interface EnrichDeps {
  store: PipelineStore
  fetcher: Fetcher
  now?: () => Date
  llm?: LlmExtractor | null
}

export interface EnrichResult {
  outcome: RefreshOutcome | 'deferred' | 'skipped'
  action?: string
  reason: string
  pages: { url: string; result: FetchResult['kind'] }[]
  nextAt?: string
}

function documentOutcome(r: FetchResult): 'changed' | 'unchanged' | 'not_found' | 'blocked' | 'error' | null {
  switch (r.kind) {
    case 'ok':
      return 'changed'
    case 'unchanged':
      return 'unchanged'
    case 'not_found':
      return 'not_found'
    case 'blocked':
      return 'blocked'
    case 'error':
      return 'error'
    default:
      return null // deferred / budget: nothing was fetched
  }
}

function pick(findings: HappyHourFinding[]): HappyHourFinding | null {
  const withFacts = findings.filter((f) => f.windows.length || f.specials.length)
  if (!withFacts.length) return null
  const rank = (f: HappyHourFinding) => (f.windows.length ? 10 : 0) + (f.method === 'json_ld' ? 5 : 0) + f.specials.length
  return withFacts.sort((a, b) => rank(b) - rank(a))[0]
}

export async function enrichEstablishment(id: string, deps: EnrichDeps): Promise<EnrichResult> {
  const now = deps.now ?? (() => new Date())
  const { store, fetcher } = deps
  const target = await store.enrichmentTarget(id)
  if (!target) return { outcome: 'skipped', reason: 'establishment not found', pages: [] }

  const schedule = async (outcome: RefreshOutcome, ok: boolean | null, at?: Date) => {
    const next = at ?? nextCheckAt(outcome, { failures: target.failures + (outcome === 'error' ? 1 : 0), lastSuccessAt: target.lastSuccessAt }, now(), target.priority)
    await store.scheduleEstablishment(id, ok as boolean, next)
    return next.toISOString()
  }

  if (!isCrawlableWebsite(target.website)) {
    return { outcome: 'not_found', reason: 'no crawlable venue website', pages: [], nextAt: await schedule('not_found', true) }
  }

  const docs = new Map(target.documents.map((d) => [d.url, d]))
  const home = new URL(target.website!).toString()
  const pages: EnrichResult['pages'] = []
  const fetched: { url: string; html: string }[] = []
  const unchangedUrls = new Set<string>()

  const fetchOne = async (url: string): Promise<FetchResult> => {
    const d = docs.get(url)
    const r = await fetcher.get(url, { etag: d?.etag, lastModified: d?.lastModified, contentHash: d?.contentHash })
    pages.push({ url, result: r.kind })
    const outcome = documentOutcome(r)
    if (outcome) {
      await store.recordDocument(id, url, {
        outcome,
        status: 'status' in r ? r.status : null,
        etag: r.kind === 'ok' ? r.etag : null,
        lastModified: r.kind === 'ok' ? r.lastModified : null,
        contentHash: r.kind === 'ok' ? r.contentHash : null,
      })
    }
    if (r.kind === 'ok') fetched.push({ url, html: r.html })
    if (r.kind === 'unchanged') unchangedUrls.add(url)
    return r
  }

  const homeResult = await fetchOne(home)
  switch (homeResult.kind) {
    case 'deferred':
      return { outcome: 'deferred', reason: homeResult.reason, pages, nextAt: await schedule('error', null, homeResult.until) }
    case 'budget':
      // Budget exhausted for the month: try again tomorrow without counting a failure.
      return { outcome: 'deferred', reason: 'website_fetch budget exhausted', pages, nextAt: await schedule('error', null, new Date(now().getTime() + 86_400_000)) }
    case 'blocked':
      return { outcome: 'blocked', reason: homeResult.reason, pages, nextAt: await schedule('blocked', false) }
    case 'error':
      return { outcome: 'error', reason: homeResult.message, pages, nextAt: await schedule('error', false) }
    case 'not_found':
      return { outcome: 'not_found', reason: 'website returned 404/410', pages, nextAt: await schedule('not_found', true) }
  }

  // Sub-pages: fresh links when the homepage changed, otherwise the pages we checked last time.
  // Pages where we found happy-hour facts before always come first, so a redesigned homepage with
  // different links cannot make us miss the happy-hour page and wrongly call it gone.
  const known = target.findings
    .filter((f) => f.sourceKind === 'official_website' && f.sourceUrl && f.sourceUrl !== home && (f.windows.length || f.specials.length))
    .map((f) => f.sourceUrl!)
  const subpages = [
    ...new Set([
      ...known,
      ...(homeResult.kind === 'ok' ? findCandidateLinks(homeResult.html, homeResult.url, MAX_SUBPAGES) : [...docs.keys()].filter((u) => u !== home)),
    ]),
  ].slice(0, MAX_SUBPAGES)
  for (const url of subpages) {
    const r = await fetchOne(url)
    if (r.kind === 'deferred' || r.kind === 'budget') break // keep what we have; the rest waits for the next run
  }

  const checkedAt = now().toISOString()
  const fresh: HappyHourFinding[] = []
  const mentions: { url: string; html: string }[] = []
  for (const page of fetched) {
    const raw = extractHappyHour(page.html, page.url, checkedAt)
    if (!raw) continue
    const { finding } = validateFinding(raw, htmlToText(page.html))
    if (finding.windows.length || finding.specials.length) fresh.push(finding)
    else if (finding.mentionedButUnparsed) mentions.push(page)
  }
  // A homepage often mentions happy hour only in a nav link; prefer the dedicated page.
  const mentionRank = (u: string) => (/happy|special|hh/i.test(new URL(u).pathname) ? 0 : u === home ? 2 : 1)
  const mentioned = mentions.sort((a, b) => mentionRank(a.url) - mentionRank(b.url))[0] ?? null

  // Previous findings from sources we did not re-read stay in the picture; unchanged pages count as re-confirmed.
  const freshUrls = new Set(fetched.map((p) => p.url))
  const previous = target.findings
    .filter((f) => !f.sourceUrl || !freshUrls.has(f.sourceUrl))
    .map((f) => (f.sourceUrl && unchangedUrls.has(f.sourceUrl) ? { ...f, checkedAt } : f))

  let best = pick(fresh)
  if (!best && mentioned && deps.llm) {
    const { finding } = await deps.llm.extract(mentioned.html, mentioned.url, checkedAt)
    if (finding) best = finding
  }

  if (best) {
    const assessment = assess([best, ...previous], now())
    const decision = decideApply(best, target, assessment)
    const res = await store.recordFinding(id, best, decision.action, { ...assessment, reason: [decision.reason, ...assessment.reasons].join('; ') }, findingFingerprint(best))
    // Shown as "Needs verification" (never as confirmed); an admin also gets it to review.
    const questionable = questionableReasons(best)
    if (questionable.length && decision.action === 'apply') {
      await store.recordFinding(id, best, 'review', { ...assessment, reason: `Unusual schedule, please check: ${questionable.join('; ')}` }, findingFingerprint(best))
    }
    const outcome: RefreshOutcome = decision.action === 'touch' ? 'unchanged' : 'changed'
    return { outcome, action: res.action, reason: decision.reason, pages, nextAt: await schedule(outcome, true) }
  }

  if (mentioned) {
    // The site talks about happy hour but we could not read the details: ask a human.
    const finding: HappyHourFinding = {
      sourceKind: 'official_website', method: 'pattern', sourceUrl: mentioned.url, windows: [], specials: [], restrictions: [], evidence: [],
      sourcePublishedAt: null, checkedAt, mentionedButUnparsed: true,
    }
    const res = await store.recordFinding(id, finding, 'review', { status: 'unverified', confidence: 0, conflict: false, reason: 'happy hour mentioned but details not machine-readable' }, findingFingerprint(finding))
    // Details we showed earlier from this website can no longer be read from it: stop presenting
    // them as current (kept, not deleted) until an admin reviews the queued finding.
    if (target.hasData && hadWebsiteSource(target)) await store.markOutdated(id, 'the venue website mentions happy hour but its details need checking')
    return { outcome: 'changed', action: res.action, reason: 'mentioned but unparsed; queued for review', pages, nextAt: await schedule('changed', true) }
  }

  // Every page we know is unchanged, or the page holding the facts is unchanged (only the homepage or
  // another page changed): re-confirm the current facts rather than calling them gone.
  const confirmedByUnchanged = target.findings.some((f) => f.sourceUrl && unchangedUrls.has(f.sourceUrl) && (f.windows.length || f.specials.length))
  if (!fetched.length || confirmedByUnchanged) {
    const assessment = assess(previous, now())
    const primary = assessment.primary
    if (primary && target.fingerprint && findingFingerprint(primary) === target.fingerprint && assessment.status !== 'verified') {
      await store.recordFinding(id, primary, 'touch', { ...assessment, reason: 'source unchanged' }, target.fingerprint)
    }
    return { outcome: 'unchanged', action: 'touch', reason: 'source pages unchanged', pages, nextAt: await schedule('unchanged', true) }
  }

  // Pages changed and none mention happy hour any more.
  if (target.hasData && hadWebsiteSource(target)) {
    await store.markOutdated(id, 'the venue website no longer mentions a happy hour')
    return { outcome: 'changed', action: 'outdated', reason: 'happy hour no longer on website', pages, nextAt: await schedule('changed', true) }
  }
  return { outcome: 'not_found', reason: 'no happy-hour information on the website', pages, nextAt: await schedule('not_found', true) }
}

function hadWebsiteSource(t: EnrichmentTarget): boolean {
  return t.findings.some((f) => f.sourceKind === 'official_website' && (f.windows.length > 0 || f.specials.length > 0))
}
