/**
 * Refresh scheduling and cost guards for the background pipeline (pure functions).
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

export type RefreshOutcome = 'changed' | 'unchanged' | 'not_found' | 'blocked' | 'error'

export interface RefreshState {
  failures: number
  lastSuccessAt: string | null
}

/**
 * When to look at a source again.
 *  - Changed info: re-check sooner (14 days) — schedules that change once often change again.
 *  - Unchanged: back off progressively up to 60 days.
 *  - No happy-hour info on the site: 90 days.
 *  - Blocked by robots/terms/anti-bot: 30 days, never retried sooner.
 *  - Errors: exponential backoff 1h, 2h, 4h … capped at 7 days.
 *  - Priority (popular/saved places) halves the interval.
 */
export function nextCheckAt(outcome: RefreshOutcome, state: RefreshState, now: Date, priority = false): Date {
  let ms: number
  switch (outcome) {
    case 'changed':
      ms = 14 * DAY
      break
    case 'unchanged': {
      const age = state.lastSuccessAt ? now.getTime() - Date.parse(state.lastSuccessAt) : 0
      ms = Math.min(60 * DAY, Math.max(21 * DAY, age * 1.5))
      break
    }
    case 'not_found':
      ms = 90 * DAY
      break
    case 'blocked':
      return new Date(now.getTime() + 30 * DAY)
    case 'error':
      ms = Math.min(7 * DAY, HOUR * 2 ** Math.min(10, state.failures))
      return new Date(now.getTime() + ms)
  }
  if (priority) ms /= 2
  return new Date(now.getTime() + ms)
}

/** Discovery for a market: weekly is plenty — venues open/close slowly. */
export const MARKET_DISCOVERY_INTERVAL_DAYS = 7

/** Listings older than this without any re-confirmation are downgraded to "outdated". */
export const STALE_AFTER_DAYS = 180

export function isStale(lastConfirmedAt: string | null, now: Date): boolean {
  return !lastConfirmedAt || now.getTime() - Date.parse(lastConfirmedAt) > STALE_AFTER_DAYS * DAY
}

export interface Budget {
  provider: string
  monthlyLimit: number
  used: number
}

/** Pure budget check; the database performs the same check atomically when consuming. */
export function canSpend(b: Budget, units: number): boolean {
  return b.used + units <= b.monthlyLimit
}

/** Per-domain politeness: at most one request per `minDelaySec` (or robots Crawl-delay, max 30s). */
export function politeDelayMs(crawlDelaySec: number | null, minDelaySec = 5): number {
  return Math.min(30, Math.max(minDelaySec, crawlDelaySec ?? 0)) * 1000
}

/** Domains we never crawl: aggregators/social networks whose terms forbid it, or that aren't the venue. */
export const NEVER_CRAWL = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'yelp.com', 'google.com', 'goo.gl',
  'tripadvisor.com', 'opentable.com', 'resy.com', 'doordash.com', 'ubereats.com', 'grubhub.com', 'seamless.com',
  'toasttab.com', 'linktr.ee', 'foursquare.com', 'zomato.com', 'menupix.com', 'allmenus.com', 'menuism.com',
]

export function isCrawlableWebsite(url: string | null): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return false
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    return !NEVER_CRAWL.some((d) => host === d || host.endsWith(`.${d}`))
  } catch {
    return false
  }
}
