/**
 * The exact requests the web app sends to Supabase's REST API (PostgREST). Production showed
 * Discover and Search empty because the nearby request carried a filter PostgREST cannot apply
 * to an RPC result ("column pgrst_call.date does not exist", HTTP 400). No network is used.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SupabaseApi, searchTerm } from '@/data/supabase/supabaseApi'
import { restRequests } from '@/data/supabase/queries'

function capture() {
  const calls: { url: URL; method: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('Supabase listing requests', () => {
  it('asks for nearby places without embedded-resource filters (they fail on RPC results)', async () => {
    const calls = capture()
    const api = new SupabaseApi('https://example.supabase.co', 'anon-key', 'https://aour.example')
    await api.nearbyEstablishments({ lat: 27.1975, lng: -80.2528 }, 5)
    const call = calls.find((c) => c.url.pathname.endsWith('/rpc/nearby_establishments'))!
    expect(call.method).toBe('POST')
    const params = [...call.url.searchParams.keys()]
    // Only top-level filters; anything like "schedule_exceptions.date" is rejected by PostgREST.
    expect(params.filter((k) => k.includes('.'))).toEqual([])
    expect(call.url.searchParams.get('status')).toBe('eq.published')
  })

  it('searches published listings by name, city, neighborhood or address with a quoted, sanitised term', async () => {
    const calls = capture()
    const api = new SupabaseApi('https://example.supabase.co', 'anon-key', 'https://aour.example')
    await api.searchEstablishments('Black Marlin')
    const call = calls.find((c) => c.url.pathname.endsWith('/establishments'))!
    expect(call.url.searchParams.get('status')).toBe('eq.published')
    expect(call.url.searchParams.get('or')).toBe('(name.ilike."*Marlin*",city.ilike."*Marlin*",neighborhood.ilike."*Marlin*",address.ilike."*Marlin*")')
  })

  it('drops filter syntax from search terms', () => {
    expect(searchTerm('  black   marlin ')).toBe('marlin')
    expect(searchTerm('a),status.eq.draft')).toBe('status.eq.draft')
    expect(searchTerm('"*%')).toBeNull()
    expect(searchTerm('x')).toBeNull()
  })

  // scripts/production-browser.ts checks production with restRequests; it must send exactly what
  // the app sends, or the check can pass/fail on requests no visitor makes (as on 2026-10-20).
  it('the production check sends exactly the requests the app sends', async () => {
    const sorted = (u: URL | URLSearchParams) => [...(u instanceof URL ? u.searchParams : u).entries()].sort()
    const calls = capture()
    const api = new SupabaseApi('https://example.supabase.co', 'anon-key', 'https://aour.example')

    await api.nearbyEstablishments({ lat: 27.0595, lng: -80.1364 }, 5)
    const appNearby = calls.find((c) => c.url.pathname.endsWith('/rpc/nearby_establishments'))!
    const checkNearby = restRequests.nearby({ lat: 27.0595, lng: -80.1364 }, 5)
    const checkNearbyUrl = new URL(checkNearby.path, 'https://example.supabase.co/rest/v1/')
    expect(appNearby.method).toBe(checkNearby.method)
    expect(appNearby.url.pathname).toBe(checkNearbyUrl.pathname)
    expect(sorted(appNearby.url)).toEqual(sorted(checkNearbyUrl))
    expect(appNearby.body).toEqual(checkNearby.body)

    await api.searchEstablishments('Black Marlin')
    const appSearch = calls.find((c) => c.url.pathname.endsWith('/establishments'))!
    const checkSearchUrl = new URL(restRequests.search('Black Marlin')!.path, 'https://example.supabase.co/rest/v1/')
    expect(appSearch.url.pathname).toBe(checkSearchUrl.pathname)
    expect(sorted(appSearch.url)).toEqual(sorted(checkSearchUrl))
  })
})
