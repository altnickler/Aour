/**
 * Duplicate detection between provider candidates and existing Aour establishments.
 *
 * Order of evidence:
 *   1. Same provider + external id  → same place (certain).
 *   2. Weighted score from name similarity, distance, website domain and phone.
 *      ≥ AUTO_LINK   → link automatically
 *      ≥ REVIEW      → create a "possible duplicate" for an admin to merge or dismiss
 *      otherwise     → new place
 */
import { distanceMiles, type LatLng } from '../listing'

export const AUTO_LINK = 0.85
export const REVIEW = 0.6

const STOP = new Set([
  'the', 'a', 'an', 'and', 'of', 'at', 'on', 'by', 'n',
  'bar', 'grill', 'grille', 'restaurant', 'pub', 'tavern', 'kitchen', 'cafe', 'lounge', 'house',
  'co', 'company', 'inc', 'llc', 'eatery', 'bistro', 'taproom', 'brewery', 'brewing',
])

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Distinctive tokens: normalised words minus generic venue words. */
export function nameTokens(name: string): string[] {
  const words = normalizeName(name).split(' ').filter(Boolean)
  const distinctive = words.filter((w) => !STOP.has(w))
  return distinctive.length ? distinctive : words
}

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aM = new Array<boolean>(a.length).fill(false)
  const bM = new Array<boolean>(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bM[j] || a[i] !== b[j]) continue
      aM[i] = bM[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let t = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aM[i]) continue
    while (!bM[k]) k++
    if (a[i] !== b[k]) t++
    k++
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3
  let prefix = 0
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}

/** Name similarity robust to word order and generic suffixes ("Tiki Bar & Grill" vs "Tiki Bar"). */
export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  const sa = new Set(ta)
  const sb = new Set(tb)
  const inter = [...sa].filter((t) => sb.has(t)).length
  const union = new Set([...sa, ...sb]).size
  const jaccard = union ? inter / union : 0
  // Containment catches "Driftwood" vs "Driftwood Social Club".
  const containment = Math.min(sa.size, sb.size) ? inter / Math.min(sa.size, sb.size) : 0
  const jw = jaroWinkler(ta.join(' '), tb.join(' '))
  return Math.max(jw * 0.9, (jaccard + containment) / 2)
}

export function websiteDomain(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    return u.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Social/aggregator domains are not evidence of identity (many venues share them). */
const SHARED_DOMAINS = /(^|\.)(facebook|instagram|yelp|tripadvisor|google|linktr|toasttab|square|squareup|wixsite|business\.site|opentable|doordash|ubereats|grubhub)\./

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const d = phone.replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? ten : null
}

export interface MatchablePlace extends LatLng {
  id: string
  name: string
  website?: string | null
  phone?: string | null
  externalIds?: { provider: string; externalId: string }[]
}

export interface MatchInput extends LatLng {
  provider?: string
  externalId?: string
  name: string
  website?: string | null
  phone?: string | null
}

export interface MatchResult {
  decision: 'same' | 'review' | 'new'
  score: number
  match: MatchablePlace | null
  reasons: string[]
}

export function matchScore(c: MatchInput, e: MatchablePlace): { score: number; reasons: string[] } {
  const reasons: string[] = []
  const meters = distanceMiles(c, e) * 1609.34
  // Beyond 400 m two venues are different places, whatever their names.
  if (meters > 400) return { score: 0, reasons: ['too far apart'] }

  const name = nameSimilarity(c.name, e.name)
  const distance = meters <= 30 ? 1 : meters <= 75 ? 0.85 : meters <= 150 ? 0.6 : 0.25
  let score = name * 0.65 + distance * 0.35
  reasons.push(`name ${name.toFixed(2)}`, `${Math.round(meters)} m`)

  const dc = websiteDomain(c.website)
  const de = websiteDomain(e.website)
  if (dc && de && !SHARED_DOMAINS.test(`${dc}.`)) {
    if (dc === de) {
      score += 0.2
      reasons.push('same website')
    } else score -= 0.1
  }
  const pc = normalizePhone(c.phone)
  const pe = normalizePhone(e.phone)
  if (pc && pe) {
    if (pc === pe) {
      score += 0.2
      reasons.push('same phone')
    } else score -= 0.1
  }
  return { score: Math.max(0, Math.min(1, score)), reasons }
}

export function findBestMatch(c: MatchInput, existing: readonly MatchablePlace[]): MatchResult {
  if (c.provider && c.externalId) {
    const exact = existing.find((e) => e.externalIds?.some((x) => x.provider === c.provider && x.externalId === c.externalId))
    if (exact) return { decision: 'same', score: 1, match: exact, reasons: ['same provider id'] }
  }
  let best: MatchResult = { decision: 'new', score: 0, match: null, reasons: [] }
  for (const e of existing) {
    const { score, reasons } = matchScore(c, e)
    if (score > best.score) best = { decision: 'new', score, match: e, reasons }
  }
  if (best.score >= AUTO_LINK) return { ...best, decision: 'same' }
  if (best.score >= REVIEW) return { ...best, decision: 'review' }
  return { decision: 'new', score: best.score, match: null, reasons: best.reasons }
}
