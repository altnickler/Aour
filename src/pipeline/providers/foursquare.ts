/**
 * Foursquare Places API — OPTIONAL, paid, and disabled by default.
 *
 * Foursquare's API terms allow storing only the fsq_place_id; other fields may not be cached
 * server-side. This adapter therefore only LINKS Foursquare ids to venues we already have
 * (pipeline_upsert_place refuses to create or update anything from 'foursquare' candidates).
 * Useful later for showing live Foursquare details client-side under their attribution rules.
 */
import { fsqToCandidate, type FsqPlace } from '@/core/ingest/providers'
import type { CandidatePlace } from '@/core/ingest/types'
import type { PlaceSource } from '../discover'

export const FOURSQUARE_ENDPOINT = 'https://places-api.foursquare.com/places/search'
export const FOURSQUARE_API_VERSION = '2025-06-17'

export function foursquareSource(opts: { fetch: typeof fetch; apiKey: string; endpoint?: string }): PlaceSource {
  return {
    provider: 'foursquare',
    budgetKey: 'foursquare',
    async fetchCandidates(_bbox, market) {
      const out: CandidatePlace[] = []
      const params = new URLSearchParams({
        ll: `${market.lat},${market.lng}`,
        radius: String(Math.min(100_000, Math.round(Number(market.radiusMiles) * 1609.34))),
        query: 'bar',
        limit: '50',
        fields: 'fsq_place_id,name,latitude,longitude,categories,location,website,tel,date_closed',
      })
      const res = await opts.fetch(`${opts.endpoint ?? FOURSQUARE_ENDPOINT}?${params}`, {
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'X-Places-Api-Version': FOURSQUARE_API_VERSION, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`Foursquare HTTP ${res.status}`)
      const json = (await res.json()) as { results?: FsqPlace[] }
      for (const p of json.results ?? []) {
        const c = fsqToCandidate(p)
        if (c) out.push(c)
      }
      return out
    },
  }
}
