/**
 * Pipeline pieces that need no database: Overture query (DuckDB over a local Parquet file with
 * Overture's column layout — rows are FICTIONAL), fetcher helpers, AI-input selection, Worker API.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { bboxAround } from '@/core/ingest/providers'
import { overtureSource } from '@/pipeline/providers/overture'
import { looksLikeChallenge, parseRetryAfter, sameSite } from '@/pipeline/fetcher'
import { selectRelevantText, toFinding } from '@/pipeline/llm'
import { retryDelayMs } from '@/pipeline/runner'
import { supabaseRpc } from '@/pipeline/rest'
import worker, { geocode, type Env } from '../../worker/index'

const dir = mkdtempSync(join(tmpdir(), 'aour-overture-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('Overture adapter', () => {
  it('reads only plausible venues inside the market bbox from Overture-shaped Parquet', async () => {
    const file = join(dir, 'places.parquet')
    const db = await DuckDBInstance.create(':memory:')
    const c = await db.connect()
    const row = (id: string, name: string, cat: string, lat: number, lng: number, conf = 0.9, status = 'open') => `(
      '${id}', {'primary': '${name}'}, '${cat}', {'hierarchy': ['food_and_drink', '${cat}'], 'alternates': []::VARCHAR[]},
      {'xmin': ${lng}, 'xmax': ${lng}, 'ymin': ${lat}, 'ymax': ${lat}}, ${conf}, '${status}',
      [{'freeform': '1 Example Way', 'locality': 'Stuart', 'region': 'US-FL', 'postcode': '34994', 'country': 'US'}],
      ['https://${id}.example'], ['+17725550100'])`
    await c.run(`CREATE TABLE places AS SELECT * FROM (VALUES
      ${row('a', 'Fixture Dock Bar', 'bar', 27.198, -80.253)},
      ${row('b', 'Fixture Grill', 'american_restaurant', 27.2, -80.25)},
      ${row('c', 'Fixture Coffee', 'coffee_shop', 27.199, -80.252)},
      ${row('d', 'Fixture Far Pub', 'pub', 28.5, -81.4)},
      ${row('e', 'Fixture Maybe Bar', 'bar', 27.197, -80.251, 0.3)},
      ${row('f', 'Fixture Closed Tavern', 'bar', 27.196, -80.254, 0.9, 'permanently_closed')}
    ) t(id, names, basic_category, taxonomy, bbox, confidence, operating_status, addresses, websites, phones)`)
    await c.run(`COPY places TO '${file}' (FORMAT parquet)`)
    c.closeSync()

    const source = overtureSource({ path: file })
    const out = await source.fetchCandidates(bboxAround(27.1975, -80.2528, 15), { id: 'm', name: 'Stuart', lat: 27.1975, lng: -80.2528, radiusMiles: 15, timezone: 'America/New_York', discoveryEnabled: true })
    const byName = Object.fromEntries(out.map((p) => [p.name, p]))
    expect(Object.keys(byName).sort()).toEqual(['Fixture Closed Tavern', 'Fixture Dock Bar', 'Fixture Grill'])
    expect(byName['Fixture Dock Bar']).toMatchObject({ provider: 'overture', externalId: 'a', kind: 'bar', state: 'FL', website: 'https://a.example', lat: 27.198, closed: false })
    expect(byName['Fixture Grill'].kind).toBe('restaurant')
    expect(byName['Fixture Closed Tavern'].closed).toBe(true) // kept so an existing listing can be archived
  })

  it('refuses to guess a release', async () => {
    const source = overtureSource({})
    await expect(source.fetchCandidates(bboxAround(27, -80, 5), {} as never)).rejects.toThrow(/OVERTURE_RELEASE/)
  })
})

describe('fetcher helpers', () => {
  const now = new Date('2026-10-16T12:00:00Z')
  it('parses Retry-After seconds and dates, capped at 7 days', () => {
    expect(parseRetryAfter('120', now)!.toISOString()).toBe('2026-10-16T12:02:00.000Z')
    expect(parseRetryAfter('Fri, 16 Oct 2026 13:00:00 GMT', now)!.toISOString()).toBe('2026-10-16T13:00:00.000Z')
    expect(parseRetryAfter('99999999', now)!.getTime() - now.getTime()).toBe(7 * 86_400_000)
    expect(parseRetryAfter('soon', now)).toBeNull()
  })

  it('recognises bot challenges but not ordinary pages with a contact-form CAPTCHA', () => {
    const h = new Headers()
    expect(looksLikeChallenge(403, h, '<title>Just a moment...</title>')).toBe(true)
    expect(looksLikeChallenge(200, new Headers({ 'cf-mitigated': 'challenge' }), '')).toBe(true)
    const bigPage = `<html>${'<p>menu item</p>'.repeat(3000)}<div class="g-recaptcha"></div></html>`
    expect(looksLikeChallenge(200, h, bigPage)).toBe(false)
  })

  it('treats www and apex as the same site only', () => {
    expect(sameSite(new URL('https://www.a.example/x'), new URL('https://a.example/y'))).toBe(true)
    expect(sameSite(new URL('https://a.example/'), new URL('https://b.example/'))).toBe(false)
    expect(sameSite(new URL('https://a.example/'), new URL('https://a.example.evil.test/'))).toBe(false)
  })

  it('backs off failing jobs exponentially', () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([300_000, 1_200_000, 4_800_000])
    expect(retryDelayMs(10)).toBe(12 * 3_600_000)
  })
})

describe('AI extraction input/output', () => {
  it('sends only the sections around happy-hour mentions, and nothing for pages without one', () => {
    const html = `<p>About us</p>${'<p>filler</p>'.repeat(60)}<h2>Happy Hour</h2><p>Weekdays four to six</p>`
    const sel = selectRelevantText(html)!
    expect(sel.text.startsWith('…')).toBe(false)
    expect(sel.text).toContain('Weekdays four to six')
    expect(sel.text).not.toContain('About us')
    expect(selectRelevantText('<p>Dinner nightly</p>')).toBeNull()
  })

  it('drops model output that is not quoted verbatim, including made-up prices', () => {
    const src = 'Happy hour weekdays four to six. Drafts three dollars.'
    const { finding, rejected } = toFinding(
      {
        windows: [{ days: [1, 2, 3, 4, 5], start: '16:00', end: '18:00', label: null, quote: 'Happy hour weekdays four to six' }],
        specials: [{ kind: 'drink', title: 'Drafts', price: '$3', description: null, quote: 'Drafts three dollars' }],
        restrictions: [{ text: 'Bar only', quote: 'bar seating only' }],
        notes: null,
      },
      src, 'https://a.example', 'now',
    )
    expect(finding!.windows).toHaveLength(1)
    expect(finding!.specials).toEqual([]) // "$3" does not appear in the quote
    expect(finding!.restrictions).toEqual([])
    expect(rejected.length).toBeGreaterThan(0)
  })
})

describe('Worker API', () => {
  const ctx = { waitUntil: () => {} }
  const env = (over: Partial<Env> = {}): Env => ({ ASSETS: { fetch: async () => new Response('asset') }, ...over })

  it('serves assets for non-API paths and reports configuration without secrets', async () => {
    expect(await (await worker.fetch(new Request('https://aour.app/discover'), env(), ctx)).text()).toBe('asset')
    const health = await (await worker.fetch(new Request('https://aour.app/api/health'), env({ SUPABASE_SERVICE_ROLE_KEY: 'secret-value', SUPABASE_URL: 'https://x.supabase.co' }), ctx)).text()
    expect(JSON.parse(health)).toMatchObject({ ok: true, pipeline: true, ai: false })
    expect(health).not.toContain('secret-value')
    expect((await worker.fetch(new Request('https://aour.app/api/nope'), env(), ctx)).status).toBe(404)
  })

  it('requires an admin for manual refresh', async () => {
    const e = env({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' })
    expect((await worker.fetch(new Request('https://aour.app/api/admin/run', { method: 'POST' }), e, ctx)).status).toBe(401)
  })

  it('validates, rate-limits, budgets and caches geocoding', async () => {
    const calls: string[] = []
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      calls.push(url)
      if (url.includes('/rest/v1/rpc/pipeline_consume_budget')) {
        expect(JSON.parse(String(init?.body))).toEqual({ p_provider: 'geocode', p_units: 1 })
        return new Response('true')
      }
      return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-80.05, 26.71] }, properties: { name: 'West Palm Beach', state: 'Florida', countrycode: 'us', type: 'city' } }] }))
    }) as typeof fetch
    const e = env({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x' })

    expect((await geocode(new Request('https://aour.app/api/geocode?q=a'), e, ctx, fakeFetch)).status).toBe(400)
    const limited = { ...e, GEOCODE_LIMITER: { limit: async () => ({ success: false }) } }
    expect((await geocode(new Request('https://aour.app/api/geocode?q=west palm'), limited, ctx, fakeFetch)).status).toBe(429)

    const res = await geocode(new Request('https://aour.app/api/geocode?q=west%20palm'), e, ctx, fakeFetch)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([{ label: 'West Palm Beach, Florida, US', lat: 26.71, lng: -80.05, kind: 'city' }])
    expect(body.attribution).toMatch(/OpenStreetMap/)
    expect(calls[0]).toContain('pipeline_consume_budget')
    expect(calls[1]).toMatch(/^https:\/\/photon\.komoot\.io\/api\/\?q=west\+palm/)
  })

  it('sends new-style secret keys only as apikey, legacy JWT keys also as Authorization', async () => {
    const seen: Headers[] = []
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response('null')
    }) as typeof fetch
    await supabaseRpc('https://x.supabase.co/', 'sb_secret_abc', f)('fn', {})
    await supabaseRpc('https://x.supabase.co', 'eyJhbGciOi.x.y', f)('fn', {})
    expect(seen[0].get('apikey')).toBe('sb_secret_abc')
    expect(seen[0].get('authorization')).toBeNull()
    expect(seen[1].get('authorization')).toBe('Bearer eyJhbGciOi.x.y')
  })
})
