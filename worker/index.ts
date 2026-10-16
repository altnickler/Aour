/**
 * Aour Cloudflare Worker.
 *
 *  - Static assets (the PWA) are served by the assets binding; only /api/* reaches this code
 *    (`run_worker_first`), so page views stay free and never trigger external API calls.
 *  - scheduled(): Cron Trigger → one bounded pipeline tick (enrichment from venue websites).
 *  - GET  /api/health         → liveness + which optional features are configured (no secrets).
 *  - GET  /api/geocode?q=     → city/address search (edge-cached, rate-limited, budgeted).
 *  - POST /api/admin/run      → admin-only "refresh now": runs one tick in the background.
 *
 * Secrets (wrangler secret put …): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * optional ANTHROPIC_API_KEY / ANTHROPIC_MODEL, FOURSQUARE_API_KEY. See DEPLOYMENT.md.
 */
import { runPipelineTick } from '@/pipeline'
import type { PlaceSource } from '@/pipeline/discover'
import { anthropicClient, createLlmExtractor } from '@/pipeline/llm'
import { foursquareSource } from '@/pipeline/providers/foursquare'
import { overpassSource } from '@/pipeline/providers/overpass'
import { rpcAsUser, supabaseRpc } from '@/pipeline/rest'
import { createStore, type Job } from '@/pipeline/store'

interface RateLimit {
  limit(o: { key: string }): Promise<{ success: boolean }>
}
interface Ctx {
  waitUntil(p: Promise<unknown>): void
}

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> }
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL?: string
  FOURSQUARE_API_KEY?: string
  /** "false" pauses the cron pipeline without a redeploy of code. */
  PIPELINE_ENABLED?: string
  /** Comma list of discovery sources the Worker may run: "osm", "foursquare". Overture runs in GitHub Actions. */
  WORKER_DISCOVERY?: string
  GEOCODE_LIMITER?: RateLimit
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })

function pipelineConfigured(env: Env): boolean {
  return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)
}

function tick(env: Env, worker: string, limit: number) {
  const rpc = supabaseRpc(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!)
  const store = createStore(rpc)
  const wanted = (env.WORKER_DISCOVERY ?? '').split(',').map((s) => s.trim())
  const sources: PlaceSource[] = []
  if (wanted.includes('osm')) sources.push(overpassSource({ fetch }))
  if (wanted.includes('foursquare') && env.FOURSQUARE_API_KEY) sources.push(foursquareSource({ fetch, apiKey: env.FOURSQUARE_API_KEY }))
  const kinds: Job['kind'][] = sources.length ? ['enrich_establishment', 'discover_market'] : ['enrich_establishment']
  const llm = env.ANTHROPIC_API_KEY ? createLlmExtractor({ client: anthropicClient(env.ANTHROPIC_API_KEY), store, model: env.ANTHROPIC_MODEL }) : null
  return runPipelineTick({
    rpc, fetch, worker, kinds, sources, llm, limit, concurrency: 3,
    log: (msg, data) => console.log(JSON.stringify({ msg, data })),
  })
}

/** Liveness, deployed build and configuration gaps — names of missing settings only, never values. */
export async function health(req: Request, env: Env): Promise<Response> {
  let build: unknown = null
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/version.json', req.url)))
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) build = await res.json()
  } catch {
    /* no version file in this build */
  }
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const
  return json({
    ok: true,
    time: new Date().toISOString(),
    build,
    pipeline: pipelineConfigured(env) && env.PIPELINE_ENABLED !== 'false',
    ai: !!env.ANTHROPIC_API_KEY,
    missing: required.filter((k) => !env[k]),
  })
}

export async function geocode(req: Request, env: Env, ctx: Ctx, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url)
  const q = (url.searchParams.get('q') ?? '').trim().replace(/\s+/g, ' ')
  if (q.length < 2 || q.length > 120) return json({ error: 'Search for a city or address (2–120 characters).' }, 400)

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
  if (env.GEOCODE_LIMITER && !(await env.GEOCODE_LIMITER.limit({ key: ip })).success) {
    return json({ error: 'Too many searches. Try again in a minute.' }, 429, { 'Retry-After': '60' })
  }

  // Shared edge cache keyed by the normalised query only (no user data).
  const cacheKey = new Request(`https://geocode.cache.aour/?q=${encodeURIComponent(q.toLowerCase())}`)
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default
  const hit = await cache?.match(cacheKey)
  if (hit) return hit

  if (!pipelineConfigured(env)) return json({ error: 'Place search is not configured.' }, 503)
  const store = createStore(supabaseRpc(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, fetchImpl))
  if (!(await store.consumeBudget('geocode'))) return json({ error: 'Place search is temporarily unavailable. Use your location or pick a city.' }, 503)

  const params = new URLSearchParams({ q, limit: '6', lang: 'en' })
  for (const layer of ['city', 'locality', 'district', 'county', 'street', 'house']) params.append('layer', layer)
  let res: Response
  try {
    res = await fetchImpl(`https://photon.komoot.io/api/?${params}`, {
      headers: { 'User-Agent': 'AourBot/1.0 (+https://aour.app/bot)' },
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    return json({ error: 'Place search is unavailable right now.' }, 502)
  }
  if (!res.ok) return json({ error: 'Place search is unavailable right now.' }, 502)
  const data = (await res.json()) as { features?: { geometry: { coordinates: [number, number] }; properties: Record<string, string | undefined> }[] }
  const results = (data.features ?? []).map((f) => {
    const p = f.properties
    const street = [p.housenumber, p.street].filter(Boolean).join(' ')
    const label = [p.name && p.name !== street ? p.name : null, street || null, p.city && p.city !== p.name ? p.city : null, p.state, p.countrycode?.toUpperCase()]
      .filter(Boolean)
      .join(', ')
    return { label, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], kind: p.type ?? 'place' }
  })
  const out = json({ results, attribution: 'Search by Photon · © OpenStreetMap contributors' }, 200, { 'Cache-Control': 'public, max-age=86400' })
  if (cache) ctx.waitUntil(cache.put(cacheKey, out.clone()))
  return out
}

async function adminRun(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!pipelineConfigured(env) || !env.SUPABASE_ANON_KEY) return json({ error: 'Pipeline not configured' }, 503)
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Sign in required' }, 401)
  // The database decides: aour_is_admin() evaluated with the caller's own JWT.
  const isAdmin = await rpcAsUser(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY, token, 'aour_is_admin', {})
  if (isAdmin !== true) return json({ error: 'Admins only' }, 403)
  ctx.waitUntil(tick(env, `admin-${crypto.randomUUID().slice(0, 8)}`, 4).catch((e) => console.error('admin tick failed', e)))
  return json({ started: true }, 202)
}

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url)
    try {
      if (url.pathname === '/api/health') return await health(req, env)
      if (url.pathname === '/api/geocode') return await geocode(req, env, ctx)
      if (url.pathname === '/api/admin/run') return await adminRun(req, env, ctx)
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    } catch (e) {
      console.error('api error', e)
      return json({ error: 'Something went wrong' }, 500)
    }
    return env.ASSETS.fetch(req)
  },

  async scheduled(_controller: unknown, env: Env, ctx: Ctx): Promise<void> {
    if (!pipelineConfigured(env) || env.PIPELINE_ENABLED === 'false') return
    ctx.waitUntil(
      tick(env, `cron-${crypto.randomUUID().slice(0, 8)}`, 6)
        .then((r) => console.log(JSON.stringify({ msg: 'tick', claimed: r.claimed, succeeded: r.succeeded, failed: r.failed, queued: r.queued })))
        .catch((e) => console.error('tick failed', e)),
    )
  },
}
