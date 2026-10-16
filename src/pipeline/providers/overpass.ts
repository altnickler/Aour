/**
 * OpenStreetMap via the Overpass API. OFF by default (provider_limits.osm_overpass disabled):
 * OSM data is ODbL, and merging it with other venue data publicly needs the share-alike review
 * described in DATA_SOURCES.md. One query per market per discovery run, never per page view.
 */
import { osmToCandidate, overpassQuery, type OsmElement } from '@/core/ingest/providers'
import type { CandidatePlace } from '@/core/ingest/types'
import type { PlaceSource } from '../discover'
import { USER_AGENT } from '../fetcher'

export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'

export function overpassSource(opts: { fetch: typeof fetch; endpoint?: string; userAgent?: string }): PlaceSource {
  const fetchImpl = opts.fetch // unbound: Workers reject opts.fetch(...)
  return {
    provider: 'osm',
    budgetKey: 'osm_overpass',
    async fetchCandidates(bbox) {
      const res = await fetchImpl(opts.endpoint ?? OVERPASS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': opts.userAgent ?? USER_AGENT },
        body: new URLSearchParams({ data: overpassQuery(bbox) }).toString(),
        signal: AbortSignal.timeout(90_000),
      })
      if (res.status === 429 || res.status === 504) throw new Error(`Overpass busy (${res.status}); retry later`)
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`)
      const json = (await res.json()) as { elements?: OsmElement[]; remark?: string }
      if (json.remark && /runtime error|timed out/i.test(json.remark)) throw new Error(`Overpass: ${json.remark.slice(0, 200)}`)
      return (json.elements ?? []).map(osmToCandidate).filter((c): c is CandidatePlace => !!c)
    },
  }
}
