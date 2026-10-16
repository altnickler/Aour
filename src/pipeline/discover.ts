/**
 * Market discovery: pull candidate venues from licensed place-data sources, match them
 * against what we already have (provider id → name/address/geo/website/phone), and create
 * or update listings. A discovered venue is a *potential* happy-hour spot, nothing more:
 * new rows start with hh_status = 'none' until enrichment or a person supplies facts.
 */
import { assess, decideApply } from '@/core/ingest/confidence'
import { findBestMatch, type MatchablePlace } from '@/core/ingest/match'
import { bboxAround, type BBox } from '@/core/ingest/providers'
import { parseOsmOpeningHours } from '@/core/ingest/timeparse'
import type { CandidatePlace, HappyHourFinding, ProviderId } from '@/core/ingest/types'
import { findingFingerprint } from '@/core/ingest/validate'
import { distanceMiles } from '@/core/listing'
import type { MarketInfo, PipelineStore } from './store'

export interface PlaceSource {
  provider: ProviderId
  /** provider_limits key charged once per market query. */
  budgetKey: string
  fetchCandidates(bbox: BBox, market: MarketInfo): Promise<CandidatePlace[]>
}

export interface DiscoverResult {
  market: string
  skipped?: string
  sources: { provider: ProviderId; status: 'ok' | 'budget' | 'error'; candidates: number; error?: string }[]
  created: number
  createdForReview: number
  updated: number
  linked: number
  ignored: number
  osmFindings: number
}

/** OSM `happy_hours=*` tag → a community-reported finding (the tag value is the evidence). */
export function osmHappyHourFinding(c: CandidatePlace, checkedAt: string): HappyHourFinding | null {
  if (c.provider !== 'osm' || !c.happyHoursRaw) return null
  const windows = parseOsmOpeningHours(c.happyHoursRaw)
  if (!windows?.length) return null
  return {
    sourceKind: 'osm',
    method: 'osm_tag',
    sourceUrl: `https://www.openstreetmap.org/${c.externalId}`,
    windows: windows.map((w) => ({ ...w, label: w.label ?? null })),
    specials: [],
    restrictions: [],
    evidence: windows.map((_, i) => ({ field: `window:${i}`, quote: `happy_hours=${c.happyHoursRaw}` })),
    sourcePublishedAt: null,
    checkedAt,
    mentionedButUnparsed: false,
  }
}

export async function discoverMarket(
  marketId: string,
  deps: { store: PipelineStore; sources: PlaceSource[]; now?: () => Date },
): Promise<DiscoverResult> {
  const now = deps.now ?? (() => new Date())
  const { store } = deps
  const result: DiscoverResult = { market: marketId, sources: [], created: 0, createdForReview: 0, updated: 0, linked: 0, ignored: 0, osmFindings: 0 }
  const market = await store.getMarket(marketId)
  if (!market) return { ...result, skipped: 'market not found' }
  if (!market.discoveryEnabled) return { ...result, skipped: 'discovery disabled for this market' }

  const radiusMiles = Number(market.radiusMiles)
  const bbox = bboxAround(Number(market.lat), Number(market.lng), radiusMiles)
  const centre = { lat: Number(market.lat), lng: Number(market.lng) }
  const existing: MatchablePlace[] = await store.nearbyForMatch(centre.lat, centre.lng, radiusMiles * 1609.34 + 500)
  let anyOk = false

  for (const source of deps.sources) {
    if (!(await store.consumeBudget(source.budgetKey))) {
      result.sources.push({ provider: source.provider, status: 'budget', candidates: 0 })
      continue
    }
    let candidates: CandidatePlace[]
    try {
      candidates = await source.fetchCandidates(bbox, market)
    } catch (e) {
      result.sources.push({ provider: source.provider, status: 'error', candidates: 0, error: (e as Error).message.slice(0, 300) })
      continue
    }
    anyOk = true
    result.sources.push({ provider: source.provider, status: 'ok', candidates: candidates.length })

    for (const c of candidates) {
      if (distanceMiles(centre, c) > radiusMiles) {
        result.ignored++
        continue
      }
      const match = findBestMatch(c, existing)
      const businessHours = parseOsmOpeningHours(c.openingHoursRaw)
      const res = await store.upsertPlace(market.id, { ...c, businessHours }, {
        decision: match.decision,
        establishmentId: match.match?.id ?? null,
        score: Math.round(match.score * 100) / 100,
        reasons: match.reasons,
      })
      switch (res.action) {
        case 'created':
          result.created++
          break
        case 'created_for_review':
          result.createdForReview++
          break
        case 'updated':
          result.updated++
          break
        case 'linked':
          result.linked++
          break
        default:
          result.ignored++
      }
      const estId = res.establishmentId
      if (!estId) continue
      if (res.action === 'created' || res.action === 'created_for_review') {
        // Later candidates (from this or another source) must match against the new row.
        existing.push({ id: estId, name: c.name, lat: c.lat, lng: c.lng, website: c.website, phone: c.phone, externalIds: [{ provider: c.provider, externalId: c.externalId }] })
      } else {
        const known = existing.find((e) => e.id === estId)
        if (known && !known.externalIds?.some((x) => x.provider === c.provider && x.externalId === c.externalId)) {
          known.externalIds = [...(known.externalIds ?? []), { provider: c.provider, externalId: c.externalId }]
        }
      }

      const finding = osmHappyHourFinding(c, now().toISOString())
      if (finding) {
        const target = await store.enrichmentTarget(estId)
        if (!target) continue
        const others = target.findings.filter((f) => f.sourceUrl !== finding.sourceUrl)
        const assessment = assess([finding, ...others], now())
        const decision = decideApply(finding, target, assessment)
        await store.recordFinding(estId, finding, decision.action, { ...assessment, reason: [decision.reason, ...assessment.reasons].join('; ') }, findingFingerprint(finding))
        result.osmFindings++
      }
    }
  }

  await store.markMarketDiscovered(market.id, anyOk)
  return result
}
