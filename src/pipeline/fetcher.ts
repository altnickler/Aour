/**
 * A deliberately polite, narrow web fetcher for venue websites.
 *
 * It fetches only the venue's own site (never aggregators or social networks) and:
 *  - honours robots.txt (RFC 9309), cached per host for ≤ 24 h, plus Crawl-delay;
 *  - waits ≥ 5 s between requests to the same host (shared across workers via the database);
 *  - spends from the monthly `website_fetch` budget before every request, robots.txt included;
 *  - sends conditional requests (ETag / Last-Modified) so unchanged pages cost almost nothing;
 *  - accepts HTML only, caps the body size and times out after 10 s;
 *  - follows redirects only within the same site;
 *  - treats 401/403, 429 and CAPTCHA / bot-challenge pages as "stop", never as something to get around.
 */
import { isAllowed, robotsFromResponse } from '@/core/ingest/robots'
import { isCrawlableWebsite, politeDelayMs } from '@/core/ingest/refresh'
import type { PipelineStore } from './store'

export const USER_AGENT = 'AourBot/1.0 (+https://aour.app/bot)'
const ROBOTS_TTL_MS = 24 * 3_600_000
const ROBOTS_MAX_BYTES = 500 * 1024
const HTML_MAX_BYTES = 1_500_000
const MAX_REDIRECTS = 3
/** Longest we will sleep for politeness inside one job; longer waits defer the job instead. */
const MAX_INLINE_WAIT_MS = 30_000

export type FetchResult =
  | { kind: 'ok'; url: string; status: number; html: string; etag: string | null; lastModified: string | null; contentHash: string; truncated: boolean }
  | { kind: 'unchanged'; url: string; status: number }
  | { kind: 'not_found'; url: string; status: number }
  /** robots.txt, 401/403, or an anti-bot challenge: we do not fetch this. */
  | { kind: 'blocked'; url: string; status: number | null; reason: string }
  /** Rate-limited or politeness window not yet open: try again after `until`. */
  | { kind: 'deferred'; url: string; until: Date; reason: string }
  | { kind: 'budget'; url: string }
  | { kind: 'error'; url: string; status: number | null; message: string }

export interface Validators {
  etag?: string | null
  lastModified?: string | null
  contentHash?: string | null
}

export interface FetcherDeps {
  store: PipelineStore
  fetch: typeof fetch
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  userAgent?: string
}

export type Fetcher = ReturnType<typeof createFetcher>

/** Present only on an actual challenge / block page. */
const CHALLENGE_PAGE = [/<title>\s*(just a moment|attention required|access denied|are you a robot|security check)/i, /cf-chl-|cf_chl_opt/i]
/** Bot-protection scripts that also run on ordinary pages (Cloudflare's JS detection, CAPTCHA widgets). */
const PROTECTION_SCRIPTS = [/challenge-platform/i, /g-recaptcha|hcaptcha\.com|captcha-delivery\.com|px-captcha|perimeterx|datadome/i]

export function looksLikeChallenge(status: number, headers: Headers, body: string): boolean {
  if (headers.get('cf-mitigated') === 'challenge') return true
  if (CHALLENGE_PAGE.some((re) => re.test(body))) return true
  // A protection script on a page that was served normally (2xx) is not a block: Cloudflare adds
  // /cdn-cgi/challenge-platform/ to every page of many small sites, and contact forms carry CAPTCHAs.
  const refused = status === 401 || status === 403 || status === 429 || status === 503
  return refused && PROTECTION_SCRIPTS.some((re) => re.test(body))
}

export function parseRetryAfter(value: string | null, now: Date): Date | null {
  if (!value) return null
  const secs = Number(value)
  if (Number.isFinite(secs) && secs >= 0) return new Date(now.getTime() + Math.min(secs, 7 * 86_400) * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(Math.min(at, now.getTime() + 7 * 86_400_000)) : null
}

/** A readable reason for a failed request, including the underlying code (DNS, TLS, refused…). */
export function networkError(e: unknown, timeoutMs: number): string {
  const err = e as Error & { cause?: { code?: string; message?: string } }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `timed out after ${timeoutMs} ms`
  const cause = err?.cause?.code || err?.cause?.message
  return `network error: ${err?.message ?? String(e)}${cause ? ` (${cause})` : ''}`
}

/** Same site = identical host ignoring a leading "www.". */
export function sameSite(a: URL, b: URL): boolean {
  return a.hostname.replace(/^www\./, '').toLowerCase() === b.hostname.replace(/^www\./, '').toLowerCase()
}

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (size >= max) {
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
  }
  const all = new Uint8Array(Math.min(size, max))
  let offset = 0
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, all.byteLength - offset))
    all.set(part, offset)
    offset += part.byteLength
    if (offset >= all.byteLength) break
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(all), truncated }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createFetcher(deps: FetcherDeps) {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = deps.timeoutMs ?? 10_000
  const ua = deps.userAgent ?? USER_AGENT
  const { store } = deps

  // Call fetch unbound: Cloudflare Workers reject `deps.fetch(...)` ("Illegal invocation").
  const fetchImpl = deps.fetch
  async function request(url: string, headers: Record<string, string>): Promise<Response> {
    return fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': ua, ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  /** Wait for (or defer until) the host's next politeness slot, then reserve the following one. */
  async function takeSlot(host: string, crawlDelaySec: number | null, nextAllowedAt: string | null): Promise<Date | null> {
    const t = now()
    const next = nextAllowedAt ? new Date(nextAllowedAt) : null
    if (next && next > t) {
      const wait = next.getTime() - t.getTime()
      if (wait > MAX_INLINE_WAIT_MS) return next
      await sleep(wait)
    }
    await store.putDomain(host, { next_allowed_at: new Date(now().getTime() + politeDelayMs(crawlDelaySec)).toISOString() })
    return null
  }

  /** After a response, restart the host's quiet period so the gap is measured from when the request ended. */
  async function release(host: string, crawlDelaySec: number | null) {
    await store.putDomain(host, { next_allowed_at: new Date(now().getTime() + politeDelayMs(crawlDelaySec)).toISOString() })
  }

  async function robotsFor(origin: URL): Promise<{ allowed: (path: string) => boolean; crawlDelay: number | null; nextAllowedAt: string | null; blocked: string | null } | FetchResult> {
    const host = origin.hostname.toLowerCase()
    let state = await store.getDomain(host)
    if (state?.blocked) return { allowed: () => false, crawlDelay: null, nextAllowedAt: null, blocked: state.blocked_reason ?? 'blocked' }

    // Only a definite answer (2xx/4xx) is cached; after a server or network error we ask again next time.
    const fresh = state?.robots_fetched_at && (state.robots_status ?? 0) < 500 && now().getTime() - Date.parse(state.robots_fetched_at) < ROBOTS_TTL_MS
    if (!fresh) {
      const robotsUrl = `${origin.protocol}//${origin.host}/robots.txt`
      const deferred = await takeSlot(host, state?.crawl_delay_sec ?? null, state?.next_allowed_at ?? null)
      if (deferred) return { kind: 'deferred', url: robotsUrl, until: deferred, reason: 'politeness window' }
      if (!(await store.consumeBudget('website_fetch'))) return { kind: 'budget', url: robotsUrl }
      let status: number
      let body = ''
      try {
        const res = await request(robotsUrl, { Accept: 'text/plain' })
        status = res.status
        // Redirects for robots.txt: RFC 9309 allows following up to 5; we keep it simple and only accept direct answers.
        if (status >= 300 && status < 400) status = 404
        if (status >= 200 && status < 300) body = (await readCapped(res, ROBOTS_MAX_BYTES)).text
        else await res.body?.cancel().catch(() => {})
      } catch (e) {
        // Unreachable ⇒ RFC 9309: crawl nothing now. That is a temporary failure, not the site's
        // wish, so report an error (retried with backoff) instead of a long "blocked" pause.
        await release(host, null)
        return { kind: 'error', url: robotsUrl, status: null, message: `robots.txt unreachable: ${networkError(e, timeoutMs)}` }
      }
      if (status >= 500) {
        await release(host, null)
        return { kind: 'error', url: robotsUrl, status, message: `robots.txt server error (HTTP ${status}); not crawling until it answers` }
      }
      const rules = robotsFromResponse(status, body, ua)
      await store.putDomain(host, {
        robots_txt: body.slice(0, ROBOTS_MAX_BYTES),
        robots_status: status,
        robots_fetched_at: now().toISOString(),
        crawl_delay_sec: rules.crawlDelaySec,
        next_allowed_at: new Date(now().getTime() + politeDelayMs(rules.crawlDelaySec)).toISOString(),
      })
      state = await store.getDomain(host)
    }
    const rules = robotsFromResponse(state?.robots_status ?? 404, state?.robots_txt ?? '', ua)
    return {
      allowed: (path: string) => isAllowed(rules, path),
      crawlDelay: rules.crawlDelaySec,
      nextAllowedAt: state?.next_allowed_at ?? null,
      blocked: null,
    }
  }

  async function get(url: string, validators: Validators = {}, hops = 0): Promise<FetchResult> {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return { kind: 'error', url, status: null, message: 'invalid URL' }
    }
    if (!isCrawlableWebsite(u.toString())) return { kind: 'blocked', url, status: null, reason: 'not a crawlable venue website' }
    const host = u.hostname.toLowerCase()

    const robots = await robotsFor(u)
    if ('kind' in robots) return robots
    if (robots.blocked) return { kind: 'blocked', url, status: null, reason: `domain blocked: ${robots.blocked}` }
    if (!robots.allowed(u.pathname + u.search)) return { kind: 'blocked', url, status: null, reason: 'disallowed by robots.txt' }

    const deferred = await takeSlot(host, robots.crawlDelay, (await store.getDomain(host))?.next_allowed_at ?? null)
    if (deferred) return { kind: 'deferred', url, until: deferred, reason: 'politeness window' }
    if (!(await store.consumeBudget('website_fetch'))) return { kind: 'budget', url }

    const headers: Record<string, string> = { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Language': 'en-US,en;q=0.8' }
    if (validators.etag) headers['If-None-Match'] = validators.etag
    if (validators.lastModified) headers['If-Modified-Since'] = validators.lastModified

    let res: Response
    try {
      res = await request(u.toString(), headers)
    } catch (e) {
      await release(host, robots.crawlDelay)
      return { kind: 'error', url, status: null, message: networkError(e, timeoutMs) }
    }

    await release(host, robots.crawlDelay)
    const status = res.status
    if (status >= 300 && status < 400 && status !== 304) {
      await res.body?.cancel().catch(() => {})
      const location = res.headers.get('location')
      if (!location || hops >= MAX_REDIRECTS) return { kind: 'error', url, status, message: 'too many or empty redirects' }
      const next = new URL(location, u)
      if (!sameSite(u, next) || !/^https?:$/.test(next.protocol)) return { kind: 'blocked', url, status, reason: `redirects off-site to ${next.hostname}` }
      return get(next.toString(), next.toString() === u.toString() ? validators : {}, hops + 1)
    }
    if (status === 304) return { kind: 'unchanged', url, status }
    if (status === 404 || status === 410) {
      await res.body?.cancel().catch(() => {})
      return { kind: 'not_found', url, status }
    }
    if (status === 429 || status === 503) {
      const body = (await readCapped(res, 50_000)).text
      if (looksLikeChallenge(status, res.headers, body)) return block(host, url, status, 'anti-bot challenge')
      const until = parseRetryAfter(res.headers.get('retry-after'), now()) ?? new Date(now().getTime() + (status === 429 ? 3_600_000 : 1_800_000))
      await store.putDomain(host, { next_allowed_at: until.toISOString() })
      return { kind: 'deferred', url, until, reason: status === 429 ? 'rate limited (429)' : 'service unavailable (503)' }
    }
    if (status === 401 || status === 403) {
      const body = (await readCapped(res, 50_000)).text
      if (looksLikeChallenge(status, res.headers, body)) return block(host, url, status, 'anti-bot challenge')
      // Access refused: back off this host for 30 days rather than retrying.
      await store.putDomain(host, { next_allowed_at: new Date(now().getTime() + 30 * 86_400_000).toISOString() })
      return { kind: 'blocked', url, status, reason: `access refused (${status})` }
    }
    if (status < 200 || status >= 300) {
      await res.body?.cancel().catch(() => {})
      return { kind: 'error', url, status, message: `HTTP ${status}` }
    }

    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (type && !/text\/html|application\/xhtml\+xml/.test(type)) {
      await res.body?.cancel().catch(() => {})
      return { kind: 'error', url, status, message: `not HTML (${type.split(';')[0]})` }
    }
    const { text, truncated } = await readCapped(res, HTML_MAX_BYTES)
    if (looksLikeChallenge(status, res.headers, text)) return block(host, url, status, 'anti-bot challenge')
    const contentHash = await sha256Hex(text)
    if (validators.contentHash && validators.contentHash === contentHash) return { kind: 'unchanged', url, status }
    return {
      kind: 'ok',
      url,
      status,
      html: text,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      contentHash,
      truncated,
    }
  }

  async function block(host: string, url: string, status: number, reason: string): Promise<FetchResult> {
    // Sticky until an admin reviews it: we never try to solve or evade a challenge.
    await store.putDomain(host, { blocked: true, blocked_reason: reason })
    return { kind: 'blocked', url, status, reason }
  }

  return { get }
}
