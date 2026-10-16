/**
 * The pipeline runtime end to end — fetcher, enrichment, discovery, job runner, AI validation —
 * against the real migrations through the same service-role RPCs production uses.
 *
 * The "web" here is a fake fetch serving FICTIONAL fixture pages (tests/fixtures/ingest).
 * Nothing in this file contacts a real website, and none of these venues exist.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { createEstablishment, createTestDatabase, marketId, pgRpc } from './helpers'
import { createStore, type PipelineStore } from '@/pipeline/store'
import { createFetcher } from '@/pipeline/fetcher'
import { enrichEstablishment } from '@/pipeline/enrich'
import { discoverMarket } from '@/pipeline/discover'
import { overpassSource } from '@/pipeline/providers/overpass'
import { runTick } from '@/pipeline/runner'
import { createLlmExtractor, type MessagesClient } from '@/pipeline/llm'

const fx = (name: string) => readFileSync(join(import.meta.dirname, '../fixtures/ingest', name), 'utf8')
const HOME = `<!doctype html><html><head><title>Fixture venue</title></head><body>
<nav><a href="/menu">Menu</a> <a href="/happy-hour">Happy Hour</a> <a href="/order-online">Order</a> <a href="https://www.instagram.com/x">IG</a></nav>
<h1>Fixture venue</h1><p>Waterfront dining.</p></body></html>`

type Handler = string | ((req: Request) => Response | Promise<Response>)

function fakeWeb(routes: Record<string, Handler>, now: () => Date = () => new Date()) {
  const calls: { url: string; headers: Headers; at: number }[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const req = new Request(url, init)
    calls.push({ url, headers: req.headers, at: now().getTime() })
    const h = routes[url]
    if (h === undefined) return new Response('not found', { status: 404 })
    if (typeof h === 'string') return new Response(h, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    return h(req)
  }) as typeof fetch
  return { fetch: f, calls, routes }
}

function clock() {
  let offset = 0
  return {
    now: () => new Date(Date.now() + offset),
    sleep: async (ms: number) => {
      offset += ms
    },
    slept: () => offset,
  }
}

let pool: pg.Pool
let drop: () => Promise<void>
let store: PipelineStore
let market: string
let n = 0

beforeAll(async () => {
  ;({ pool, drop } = await createTestDatabase('aour_pipeline_runtime'))
  store = createStore(pgRpc(pool))
  market = await marketId(pool)
})
afterAll(async () => drop())

/** A fresh venue on its own fictional domain (pipeline-managed unless stated). */
async function venue(opts: { managedBy?: 'auto' | 'admin'; website?: string } = {}) {
  n++
  const domain = `venue${n}.example`
  const id = await createEstablishment(pool)
  await pool.query(`update public.establishments set website = $2, hh_managed_by = $3, origin = 'import' where id = $1`, [
    id, opts.website ?? `https://${domain}`, opts.managedBy ?? 'auto',
  ])
  return { id, base: `https://${domain}` }
}

function siteRoutes(base: string, pages: Record<string, Handler>, robots = 'User-agent: *\nDisallow: /order-online\n'): Record<string, Handler> {
  const out: Record<string, Handler> = { [`${base}/robots.txt`]: () => new Response(robots, { headers: { 'content-type': 'text/plain' } }) }
  for (const [path, h] of Object.entries(pages)) out[`${base}${path}`] = h
  return out
}

function deps(web: ReturnType<typeof fakeWeb>, c = clock(), timeoutMs?: number) {
  return { store, fetcher: createFetcher({ store, fetch: web.fetch, now: c.now, sleep: c.sleep, timeoutMs }), now: c.now }
}

const row = async (id: string) => (await pool.query(`select * from public.establishments where id = $1`, [id])).rows[0]
const windows = async (id: string) =>
  (await pool.query(`select days, start_time::text as start, end_time::text as end from public.happy_hour_windows where establishment_id = $1 order by sort_order`, [id])).rows
const daysFromNow = (d: Date) => (d.getTime() - Date.now()) / 86_400_000

describe('enrichment from a venue website', () => {
  it('applies official-site facts with provenance, politeness and no off-site/robots-excluded requests', async () => {
    const v = await venue()
    const c = clock()
    const web = fakeWeb(siteRoutes(v.base, { '/': HOME, '/happy-hour': fx('official-site.html') }), c.now)
    const r = await enrichEstablishment(v.id, deps(web, c))

    expect(r.outcome).toBe('changed')
    expect(r.action).toBe('apply')
    expect(await windows(v.id)).toEqual([{ days: [1, 2, 3, 4, 5], start: '15:00:00', end: '18:00:00' }])
    const e = await row(v.id)
    expect(e.hh_status).toBe('establishment_reported')
    expect(e.hh_source_url).toBe(`${v.base}/happy-hour`)
    expect(e.hh_restrictions).toEqual(['Bar area only', 'Not on holidays'])
    expect(daysFromNow(e.next_enrich_at)).toBeGreaterThan(13)
    const specials = (await pool.query(`select title, price from public.happy_hour_specials where establishment_id = $1 order by sort_order`, [v.id])).rows
    expect(specials.length).toBe(5)
    expect(specials[0].price).toBe('$1.50')

    const urls = web.calls.map((x) => x.url)
    expect(urls[0]).toBe(`${v.base}/robots.txt`)
    expect(urls).toContain(`${v.base}/happy-hour`)
    expect(urls.some((u) => /order-online|instagram|facebook/.test(u))).toBe(false)
    expect(web.calls.every((x) => x.headers.get('user-agent')?.startsWith('AourBot/1.0'))).toBe(true)
    // ≥ 5 s between consecutive requests to the same host.
    for (let i = 1; i < web.calls.length; i++) expect(web.calls[i].at - web.calls[i - 1].at).toBeGreaterThanOrEqual(5000)

    const changes = (await pool.query(`select actor from public.listing_changes where establishment_id = $1`, [v.id])).rows
    expect(changes).toEqual([{ actor: 'pipeline' }])
    const finding = (await pool.query(`select status, method, evidence from public.hh_findings where establishment_id = $1`, [v.id])).rows
    expect(finding).toHaveLength(1)
    expect(finding[0].status).toBe('applied')
    expect(finding[0].evidence.length).toBeGreaterThan(0)
  })

  it('re-checks with conditional requests and re-confirms unchanged facts without rewriting them', async () => {
    const v = await venue()
    const page = (body: string, etag: string) => (req: Request) =>
      req.headers.get('if-none-match') === etag ? new Response(null, { status: 304 }) : new Response(body, { headers: { 'content-type': 'text/html', etag } })
    const web = fakeWeb(siteRoutes(v.base, { '/': page(HOME, '"h1"'), '/happy-hour': page(fx('official-site.html'), '"p1"') }))
    await enrichEstablishment(v.id, deps(web))
    const before = await row(v.id)

    const second = await enrichEstablishment(v.id, deps(web))
    expect(second.outcome).toBe('unchanged')
    const hh = web.calls.filter((x) => x.url === `${v.base}/happy-hour`)
    expect(hh.at(-1)!.headers.get('if-none-match')).toBe('"p1"')
    const after = await row(v.id)
    expect(after.hh_fingerprint).toBe(before.hh_fingerprint)
    expect(after.hh_last_confirmed_at.getTime()).toBeGreaterThanOrEqual(before.hh_last_confirmed_at.getTime())
    expect(daysFromNow(after.next_enrich_at)).toBeGreaterThan(20)
    expect((await pool.query(`select count(*)::int as n from public.listing_changes where establishment_id = $1`, [v.id])).rows[0].n).toBe(1)
    expect((await pool.query(`select count(*)::int as n from public.hh_findings where establishment_id = $1`, [v.id])).rows[0].n).toBe(1)
  })

  it('honours robots.txt, including rules aimed at AourBot specifically', async () => {
    for (const robots of ['User-agent: *\nDisallow: /\n', 'User-agent: AourBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n']) {
      const v = await venue()
      const web = fakeWeb(siteRoutes(v.base, { '/': HOME }, robots))
      const r = await enrichEstablishment(v.id, deps(web))
      expect(r.outcome).toBe('blocked')
      expect(web.calls.map((x) => x.url)).toEqual([`${v.base}/robots.txt`])
      expect(daysFromNow((await row(v.id)).next_enrich_at)).toBeGreaterThan(29)
    }
  })

  it('treats a robots.txt server error as "crawl nothing for now" and retries soon', async () => {
    const v = await venue()
    const web = fakeWeb({ [`${v.base}/robots.txt`]: () => new Response('oops', { status: 500 }), [`${v.base}/`]: HOME })
    const r = await enrichEstablishment(v.id, deps(web))
    expect(r.outcome).toBe('error')
    expect(web.calls).toHaveLength(1)
    expect(daysFromNow((await row(v.id)).next_enrich_at)).toBeLessThan(1)
    // Not cached: the next attempt asks for robots.txt again and crawls once it answers.
    web.routes[`${v.base}/robots.txt`] = () => new Response('User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain' } })
    const c = clock()
    await c.sleep(60_000)
    const again = await enrichEstablishment(v.id, deps(web, c))
    expect(again.outcome).not.toBe('error')
    expect(web.calls.map((x) => x.url).slice(1, 3)).toEqual([`${v.base}/robots.txt`, `${v.base}/`])
  })

  it('treats an unreachable robots.txt as a temporary error with the network cause', async () => {
    const v = await venue()
    const web = fakeWeb({
      [`${v.base}/robots.txt`]: () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })
      },
      [`${v.base}/`]: HOME,
    })
    const r = await enrichEstablishment(v.id, deps(web))
    expect(r).toMatchObject({ outcome: 'error', reason: expect.stringContaining('UNABLE_TO_VERIFY_LEAF_SIGNATURE') })
    expect(web.calls).toHaveLength(1)
    const domain = (await pool.query(`select robots_fetched_at from public.source_domains where domain = $1`, [new URL(v.base).hostname])).rows[0]
    expect(domain?.robots_fetched_at ?? null).toBeNull()
  })

  it('backs off on 429 using Retry-After, without counting a failure or retrying early', async () => {
    const v = await venue()
    const web = fakeWeb(siteRoutes(v.base, { '/': () => new Response('slow down', { status: 429, headers: { 'retry-after': '7200' } }) }))
    const c = clock()
    const r = await enrichEstablishment(v.id, deps(web, c))
    expect(r.outcome).toBe('deferred')
    const e = await row(v.id)
    expect(e.enrich_failures).toBe(0)
    expect((e.next_enrich_at.getTime() - Date.now()) / 3_600_000).toBeGreaterThan(1.9)
    const domain = (await pool.query(`select next_allowed_at from public.source_domains where domain = $1`, [new URL(v.base).hostname])).rows[0]
    expect((domain.next_allowed_at.getTime() - Date.now()) / 3_600_000).toBeGreaterThan(1.9)

    const callsBefore = web.calls.length
    const again = await enrichEstablishment(v.id, deps(web, c))
    expect(again.outcome).toBe('deferred')
    expect(web.calls.length).toBe(callsBefore) // no request while the host asked us to wait
  })

  it('counts server errors as failures with exponential backoff', async () => {
    const v = await venue()
    const web = fakeWeb(siteRoutes(v.base, { '/': () => new Response('boom', { status: 500 }) }))
    const r = await enrichEstablishment(v.id, deps(web))
    expect(r.outcome).toBe('error')
    const e = await row(v.id)
    expect(e.enrich_failures).toBe(1)
    const hours = (e.next_enrich_at.getTime() - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(1.5)
    expect(hours).toBeLessThan(2.5)
    const doc = (await pool.query(`select outcome, failures, last_status from public.source_documents where establishment_id = $1`, [v.id])).rows[0]
    expect(doc).toEqual({ outcome: 'error', failures: 1, last_status: 500 })
  })

  it('stops at CAPTCHA / bot challenges and never contacts that host again until an admin lifts the block', async () => {
    const v = await venue()
    const challenge = '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div></body></html>'
    const web = fakeWeb(siteRoutes(v.base, { '/': () => new Response(challenge, { status: 403, headers: { 'content-type': 'text/html' } }) }))
    const r = await enrichEstablishment(v.id, deps(web))
    expect(r.outcome).toBe('blocked')
    const d = (await pool.query(`select blocked, blocked_reason from public.source_domains where domain = $1`, [new URL(v.base).hostname])).rows[0]
    expect(d).toEqual({ blocked: true, blocked_reason: 'anti-bot challenge' })

    const calls = web.calls.length
    await pool.query(`update public.establishments set next_enrich_at = now() where id = $1`, [v.id])
    expect((await enrichEstablishment(v.id, deps(web))).outcome).toBe('blocked')
    expect(web.calls.length).toBe(calls)
  })

  it('times out slow sites', async () => {
    const v = await venue()
    const hang = (req: Request) =>
      new Promise<Response>((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason ?? new DOMException('timeout', 'TimeoutError'))))
    const web = fakeWeb(siteRoutes(v.base, { '/': hang }))
    const r = await enrichEstablishment(v.id, deps(web, clock(), 50))
    expect(r.outcome).toBe('error')
    expect(r.reason).toMatch(/timed out/)
  })

  it('refuses redirects to another site and never crawls social/aggregator URLs', async () => {
    const v = await venue()
    const web = fakeWeb(siteRoutes(v.base, { '/': () => new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } }) }))
    expect((await enrichEstablishment(v.id, deps(web))).outcome).toBe('blocked')
    expect(web.calls.some((x) => x.url.includes('elsewhere'))).toBe(false)

    const social = await venue({ website: 'https://www.facebook.com/fixturevenue' })
    const web2 = fakeWeb({})
    const r = await enrichEstablishment(social.id, deps(web2))
    expect(r.outcome).toBe('not_found')
    expect(web2.calls).toHaveLength(0)
  })

  it('stops all fetching when the monthly website budget is spent', async () => {
    const v = await venue()
    await pool.query(`update public.provider_limits set monthly_limit = 0 where provider = 'website_fetch'`)
    try {
      const web = fakeWeb(siteRoutes(v.base, { '/': HOME }))
      const r = await enrichEstablishment(v.id, deps(web))
      expect(r.outcome).toBe('deferred')
      expect(r.reason).toMatch(/budget/)
      expect(web.calls).toHaveLength(0)
      expect((await row(v.id)).enrich_failures).toBe(0)
    } finally {
      await pool.query(`update public.provider_limits set monthly_limit = 20000 where provider = 'website_fetch'`)
    }
  })

  it('never overwrites an admin-managed listing; proposes the change for review instead', async () => {
    const v = await venue({ managedBy: 'admin' })
    await pool.query(`insert into public.happy_hour_windows (establishment_id, days, start_time, end_time, sort_order) values ($1, '{1,2,3,4,5}', '16:00', '19:00', 1)`, [v.id])
    await pool.query(`update public.establishments set hh_status = 'verified', hh_verified_at = now() where id = $1`, [v.id])
    const web = fakeWeb(siteRoutes(v.base, { '/': HOME, '/happy-hour': fx('official-site.html') }))
    const r = await enrichEstablishment(v.id, deps(web))
    expect(r.action).toBe('review')
    expect(await windows(v.id)).toEqual([{ days: [1, 2, 3, 4, 5], start: '16:00:00', end: '19:00:00' }])
    expect((await row(v.id)).hh_status).toBe('verified')
    const f = (await pool.query(`select status from public.hh_findings where establishment_id = $1`, [v.id])).rows
    expect(f).toEqual([{ status: 'pending' }])
  })

  it('marks automated info outdated (not deleted) when the site stops mentioning happy hour', async () => {
    const v = await venue()
    const pages: Record<string, Handler> = { '/': HOME, '/happy-hour': fx('official-site.html') }
    const web = fakeWeb(siteRoutes(v.base, pages))
    await enrichEstablishment(v.id, deps(web))
    expect((await row(v.id)).hh_status).toBe('establishment_reported')

    web.routes[`${v.base}/happy-hour`] = fx('no-happy-hour.html')
    const r = await enrichEstablishment(v.id, deps(web))
    expect(r.action).toBe('outdated')
    expect((await row(v.id)).hh_status).toBe('outdated')
    expect(await windows(v.id)).toHaveLength(1)
  })

  it('re-checks the page where it found happy hour even after the homepage drops the link', async () => {
    const v = await venue()
    const web = fakeWeb(siteRoutes(v.base, { '/': HOME, '/happy-hour': fx('official-site.html') }))
    await enrichEstablishment(v.id, deps(web))
    expect((await row(v.id)).hh_status).toBe('establishment_reported')

    // Redesigned homepage: new links, none to /happy-hour.
    web.routes[`${v.base}/`] = HOME.replace(/<nav>[\s\S]*?<\/nav>/, '<nav><a href="/events">Events</a> <a href="/gallery">Gallery</a> <a href="/contact">Contact</a></nav>') + ' '
    const c = clock()
    await c.sleep(60_000)
    const r = await enrichEstablishment(v.id, deps(web, c))
    expect(r.action).not.toBe('outdated')
    expect(web.calls.map((x) => x.url)).toContain(`${v.base}/happy-hour`)
    expect((await row(v.id)).hh_status).toBe('establishment_reported')
  })

  it('queues unparseable happy-hour mentions for a human when AI extraction is off', async () => {
    const v = await venue()
    const web = fakeWeb(siteRoutes(v.base, { '/': HOME, '/happy-hour': fx('ambiguous.html') }))
    const r = await enrichEstablishment(v.id, { ...deps(web), llm: null })
    expect(r.reason).toMatch(/review/)
    const f = (await pool.query(`select status, mentioned_but_unparsed, windows from public.hh_findings where establishment_id = $1`, [v.id])).rows
    expect(f).toEqual([{ status: 'pending', mentioned_but_unparsed: true, windows: [] }])
    expect(await windows(v.id)).toEqual([])
    expect((await row(v.id)).hh_status).toBe('unverified') // unchanged default: "Needs verification"
  })
})

describe('AI-assisted extraction', () => {
  const fakeClient = (output: unknown, calls: unknown[] = []): MessagesClient => ({
    beta: {
      messages: {
        create: (async (body: unknown) => {
          calls.push(body)
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }] }
        }) as unknown as MessagesClient['beta']['messages']['create'],
      },
    },
  })

  it('is skipped entirely while the llm_extract budget is disabled (the default)', async () => {
    const calls: unknown[] = []
    const llm = createLlmExtractor({ client: fakeClient({ windows: [], specials: [], restrictions: [], notes: null }, calls), store })
    const r = await llm.extract(fx('ambiguous.html'), 'https://amb.example/', new Date().toISOString())
    expect(r.skipped).toMatch(/budget/)
    expect(calls).toHaveLength(0)
  })

  it('keeps only facts quoted verbatim from the page and always sends them to review', async () => {
    await pool.query(`update public.provider_limits set enabled = true where provider = 'llm_extract'`)
    try {
      const v = await venue()
      // Words, not digits: the deterministic parser cannot read this, so the model is consulted.
      const page = fx('ambiguous.html').replace('Happy hour 4-7', 'Happy hour runs from four until seven, Monday through Friday')
      const output = {
        windows: [
          { days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00', label: null, quote: 'Happy hour runs from four until seven, Monday through Friday' },
          { days: [6], start: '12:00', end: '15:00', label: null, quote: 'Saturday happy hour noon to 3' }, // invented
        ],
        specials: [{ kind: 'drink', title: 'Well drinks', price: '$3', description: null, quote: '$3 well drinks' }], // invented
        restrictions: [],
        notes: null,
      }
      const calls: { model: string; system: string }[] = []
      const llm = createLlmExtractor({ client: fakeClient(output, calls), store })
      const web = fakeWeb(siteRoutes(v.base, { '/': HOME, '/happy-hour': page }))
      const r = await enrichEstablishment(v.id, { ...deps(web), llm })

      expect(calls).toHaveLength(1)
      expect(calls[0].model).toBe('claude-opus-5-5')
      expect(r.action).toBe('review')
      const f = (await pool.query(`select status, method, windows, specials from public.hh_findings where establishment_id = $1`, [v.id])).rows
      expect(f).toHaveLength(1)
      expect(f[0].status).toBe('pending')
      expect(f[0].method).toBe('llm')
      expect(f[0].windows).toEqual([{ days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00', label: null }])
      expect(f[0].specials).toEqual([])
      // Public listing untouched until an admin approves.
      expect(await windows(v.id)).toEqual([])
      expect((await row(v.id)).hh_status).toBe('unverified')
    } finally {
      await pool.query(`update public.provider_limits set enabled = false where provider = 'llm_extract'`)
    }
  })
})

describe('market discovery', () => {
  const overpass = () => {
    const web = fakeWeb({ 'https://overpass-api.de/api/interpreter': () => new Response(fx('overpass.json'), { headers: { 'content-type': 'application/json' } }) })
    return { web, source: overpassSource({ fetch: web.fetch }) }
  }

  it('does not call a provider whose budget is disabled (OSM is opt-in)', async () => {
    const { web, source } = overpass()
    const r = await discoverMarket(market, { store, sources: [source] })
    expect(r.sources).toEqual([{ provider: 'osm', status: 'budget', candidates: 0 }])
    expect(web.calls).toHaveLength(0)
  })

  it('creates candidate venues once, keeps business hours separate, and is idempotent', async () => {
    await pool.query(`update public.provider_limits set enabled = true, monthly_limit = 10 where provider = 'osm_overpass'`)
    try {
      const { source } = overpass()
      const first = await discoverMarket(market, { store, sources: [source] })
      expect(first.created).toBe(3) // tavern, oyster house, taproom; fast food, café, unnamed and closed skipped
      const tavern = (await pool.query(`select * from public.establishments where name = 'Fixture Tavern'`)).rows[0]
      expect(tavern.origin).toBe('import')
      expect(tavern.attribution).toBe('© OpenStreetMap contributors')
      expect(tavern.business_hours).toEqual([{ days: [0, 1, 2, 3, 4, 5, 6], start: '11:00', end: '02:00', label: null }])
      // The OSM happy_hours tag is community-reported, including the window that crosses midnight.
      expect(tavern.hh_status).toBe('community_reported')
      expect(await windows(tavern.id)).toEqual([
        { days: [1, 2, 3, 4, 5], start: '16:00:00', end: '19:00:00' },
        { days: [0, 6], start: '21:00:00', end: '01:00:00' },
      ])
      const oyster = (await pool.query(`select hh_status from public.establishments where name = 'Fixture Bay Oyster House'`)).rows[0]
      expect(oyster.hh_status).toBe('none') // a venue is not a confirmed happy hour

      const second = await discoverMarket(market, { store, sources: [source] })
      expect(second.created).toBe(0)
      expect(second.updated).toBe(3)
      expect((await pool.query(`select count(*)::int as n from public.establishments where name like 'Fixture %'`)).rows[0].n).toBe(3)
      expect((await pool.query(`select count(*)::int as n from public.listing_changes where establishment_id = $1`, [tavern.id])).rows[0].n).toBe(1)
      const m = (await pool.query(`select last_discovered_at, next_discovery_at from public.markets where id = $1`, [market])).rows[0]
      expect(m.last_discovered_at).not.toBeNull()
      expect(daysFromNow(m.next_discovery_at)).toBeGreaterThan(6)
    } finally {
      await pool.query(`update public.provider_limits set enabled = false, monthly_limit = 0 where provider = 'osm_overpass'`)
    }
  })
})

describe('scheduler ticks', () => {
  it('never processes the same venue twice when ticks overlap, and records every job', async () => {
    await pool.query(`update public.establishments set next_enrich_at = now() + interval '1 year'`)
    await pool.query(`update public.markets set next_discovery_at = now() + interval '1 year'`)
    await pool.query(`delete from public.refresh_jobs`)
    const vs = [await venue(), await venue(), await venue()]
    await pool.query(`update public.establishments set next_enrich_at = null where id = any($1)`, [vs.map((v) => v.id)])
    const routes: Record<string, Handler> = {}
    for (const v of vs) Object.assign(routes, siteRoutes(v.base, { '/': HOME, '/happy-hour': fx('official-site.html') }))
    const web = fakeWeb(routes)
    const c = clock()
    const fetcher = createFetcher({ store, fetch: web.fetch, now: c.now, sleep: c.sleep })
    const tick = (worker: string) =>
      runTick({ store, worker, kinds: ['enrich_establishment', 'discover_market'], limit: 10, handlers: { enrich: (id) => enrichEstablishment(id, { store, fetcher, now: c.now }) } })

    const [a, b] = await Promise.all([tick('w1'), tick('w2')])
    expect(a.claimed + b.claimed).toBe(3)
    for (const v of vs) expect(web.calls.filter((x) => x.url === `${v.base}/`)).toHaveLength(1)
    const jobs = (await pool.query(`select status from public.refresh_jobs where target_id = any($1)`, [vs.map((v) => v.id)])).rows
    expect(jobs.map((j) => j.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])

    // Nothing is due any more: the next tick is a no-op and makes no requests.
    const calls = web.calls.length
    const next = await tick('w3')
    expect(next.claimed).toBe(0)
    expect(web.calls.length).toBe(calls)
  })

  it('retries a crashing job with backoff and gives up after max attempts', async () => {
    await pool.query(`delete from public.refresh_jobs`)
    const v = await venue()
    await pool.query(`update public.establishments set next_enrich_at = null where id = $1`, [v.id])
    const tick = () => runTick({ store, worker: 'w', kinds: ['enrich_establishment'], handlers: { enrich: async () => { throw new Error('parser crashed') } } })
    const r = await tick()
    expect(r.failed).toBe(1)
    const job = (await pool.query(`select status, attempts, last_error, run_after from public.refresh_jobs where target_id = $1`, [v.id])).rows[0]
    expect(job.status).toBe('queued')
    expect(job.last_error).toBe('parser crashed')
    expect((job.run_after.getTime() - Date.now()) / 60_000).toBeGreaterThan(4)

    for (let i = 0; i < 3; i++) {
      await pool.query(`update public.refresh_jobs set run_after = now() where target_id = $1 and status = 'queued'`, [v.id])
      await tick()
    }
    const final = (await pool.query(`select status, attempts from public.refresh_jobs where target_id = $1 order by created_at`, [v.id])).rows
    expect(final[0]).toEqual({ status: 'failed', attempts: 4 })
  })
})
