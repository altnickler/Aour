/**
 * The public listing requests, defined once. The web app (supabaseApi.ts) and the production
 * browser check (scripts/production-browser.ts) both build their requests from here, and
 * tests/unit/supabase-api.test.ts asserts the app's real requests equal these — so a check can
 * never again pass or fail on a request shape the app does not send.
 *
 * Never add filters on embedded resources (e.g. "schedule_exceptions.date") to the nearby RPC:
 * PostgREST rejects them on RPC results ("column pgrst_call.date does not exist", HTTP 400),
 * which emptied Discover and Search in production on 2026-10-20.
 */
import type { LatLng } from '@/core/listing'

// Explicit public columns: pipeline internals are not readable through the public API.
export const EST_COLUMNS =
  'id, slug, name, kind, market_id, neighborhood, city, state, address, postal_code, lat, lng, timezone, phone, website, description, ' +
  'price_level, amenities, hh_status, hh_verified_at, hh_source_note, status, is_demo, created_at, updated_at, attribution, ' +
  'business_hours, hh_source_url, hh_last_confirmed_at, hh_restrictions'
export const EST_SELECT = `${EST_COLUMNS}, happy_hour_windows(*), schedule_exceptions(*), happy_hour_specials(*), establishment_photos(*), establishment_stats(*)`

export const NEARBY_LIMIT = 300
export const SEARCH_LIMIT = 200

export function nearbyArgs(center: LatLng, radiusMiles: number) {
  return { p_lat: center.lat, p_lng: center.lng, p_radius_m: Math.round(radiusMiles * 1609.34), p_limit: NEARBY_LIMIT }
}

/** Characters with meaning in PostgREST filter syntax are dropped; the term is matched as plain text. */
export function searchTerm(query: string): string | null {
  const terms = query
    .normalize('NFKC')
    .replace(/["\\*%,()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length)
  return terms[0] ?? null
}

/** `or` filter for a name / city / neighborhood / address search (value quoted). */
export function searchOrFilter(term: string): string {
  const like = `"*${term}*"`
  return `name.ilike.${like},city.ilike.${like},neighborhood.ilike.${like},address.ilike.${like}`
}

/** The same requests as raw REST paths (relative to /rest/v1/), for scripts without supabase-js. */
export const restRequests = {
  nearby: (center: LatLng, radiusMiles: number) => {
    const p = new URLSearchParams({ select: EST_SELECT.replace(/\s+/g, ''), status: 'eq.published' })
    return { method: 'POST' as const, path: `rpc/nearby_establishments?${p}`, body: nearbyArgs(center, radiusMiles) }
  },
  search: (query: string) => {
    const term = searchTerm(query)
    if (!term) return null
    const p = new URLSearchParams({
      select: EST_SELECT.replace(/\s+/g, ''),
      status: 'eq.published',
      or: `(${searchOrFilter(term)})`,
      order: 'name.asc',
      limit: String(SEARCH_LIMIT),
    })
    return { method: 'GET' as const, path: `establishments?${p}` }
  },
}
