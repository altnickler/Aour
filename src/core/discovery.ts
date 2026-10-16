/**
 * Discovery: filtering, ordering and curated collections over a market's listings.
 *
 * A launch market has a few hundred listings at most, so the client loads the whole
 * market once (one cached request) and filters locally for instant results. When a
 * market grows past ~1,500 listings, move these predicates into the SQL RPC.
 */

import { bayesianScore, buildRankings, type RatedVisit, type Weights } from './rating'
import { happyHourStatus, runsAt, runsOnDay, weekendOffsets, windowsForDay, zonedNow } from './schedule'
import { distanceMiles, freshness, type LatLng } from './listing'
import type { Establishment, Visit } from './types'
import type { PrimaryCategoryKey } from './categories'

/** now = happening now · later = later today · tomorrow · weekend = this Sat/Sun · day = a chosen weekday */
export type WhenFilter = 'any' | 'now' | 'later' | 'tomorrow' | 'weekend' | 'day'

export const RADIUS_OPTIONS = [2, 5, 10, 25, 50] as const
export const DEFAULT_RADIUS_MILES = 5

export interface DiscoveryFilters {
  query: string
  when: WhenFilter
  /** 0–6, used when `when === 'day'` */
  day: number
  /** minutes since midnight; optional time-of-day for `day` */
  time: number | null
  minRating: number | null
  kinds: string[]
  tags: string[]
  area: string | null
  verifiedOnly: boolean
}

export const DEFAULT_FILTERS: DiscoveryFilters = {
  query: '',
  when: 'any',
  day: new Date().getDay(),
  time: null,
  minRating: null,
  kinds: [],
  tags: [],
  area: null,
  verifiedOnly: false,
}

export function activeFilterCount(f: DiscoveryFilters): number {
  return (
    (f.when !== 'any' ? 1 : 0) +
    (f.minRating !== null ? 1 : 0) +
    (f.kinds.length ? 1 : 0) +
    (f.tags.length ? 1 : 0) +
    (f.area ? 1 : 0) +
    (f.verifiedOnly ? 1 : 0)
  )
}

export interface DiscoveryContext {
  now: Date
  /** Where distances are measured from: the device (coarse), a searched place, or a market centre. */
  origin: LatLng | null
  /** Search radius around `origin`; null = no limit. */
  radiusMiles?: number | null
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
}

export function matchesQuery(e: Establishment, query: string): boolean {
  const q = normalize(query.trim())
  if (!q) return true
  const hay = normalize([e.name, e.neighborhood ?? '', e.city, e.address, e.kind.replace('_', ' ')].join(' '))
  return q.split(/\s+/).every((term) => hay.includes(term))
}

/** Tags count if users applied them (≥1) OR the matching verified amenity exists. */
export function hasTag(e: Establishment, tag: string): boolean {
  if (e.community.topTags.some((t) => t.key === tag)) return true
  return e.amenities.includes(tag.replace(/-/g, '_'))
}

/**
 * A listing with actual happy-hour facts. Venues without any (e.g. newly discovered places)
 * are "candidates" and are shown separately, clearly labelled — never mixed into results.
 */
export function hasHappyHourInfo(e: Establishment): boolean {
  return e.hhStatus !== 'none' && (e.windows.length > 0 || e.specials.length > 0)
}

/** Does happy hour run on the venue's local day `offset` days from now? */
export function runsOnOffset(e: Establishment, now: Date, offset: number): boolean {
  return windowsForDay(e.windows, e.exceptions, e.timezone, now, offset).length > 0
}

export function filterEstablishments(
  list: readonly Establishment[],
  f: DiscoveryFilters,
  ctx: DiscoveryContext,
): Establishment[] {
  return list.filter((e) => {
    if (!matchesQuery(e, f.query)) return false
    if (f.area && e.neighborhood !== f.area && e.city !== f.area) return false
    if (f.kinds.length && !f.kinds.includes(e.kind)) return false
    if (f.tags.length && !f.tags.every((t) => hasTag(e, t))) return false
    if (f.minRating !== null && (e.community.average ?? 0) < f.minRating) return false
    if (f.verifiedOnly && freshness(e.hhStatus, e.hhVerifiedAt, ctx.now) !== 'fresh') return false
    if (ctx.radiusMiles != null && ctx.origin && distanceMiles(ctx.origin, e) > ctx.radiusMiles) return false
    if (f.when !== 'any') {
      // Only listings with actual schedule data can match a time filter.
      if (e.hhStatus === 'none' || e.windows.length === 0) return false
      switch (f.when) {
        case 'now':
          return happyHourStatus(e.windows, e.exceptions, e.timezone, ctx.now).state === 'now'
        case 'later':
          return happyHourStatus(e.windows, e.exceptions, e.timezone, ctx.now).state === 'later_today'
        case 'tomorrow':
          return runsOnOffset(e, ctx.now, 1)
        case 'weekend':
          return weekendOffsets(zonedNow(e.timezone, ctx.now).day).some((o) => runsOnOffset(e, ctx.now, o))
        case 'day':
          return f.time === null ? runsOnDay(e.windows, f.day) : runsAt(e.windows, f.day, f.time)
      }
    }
    return true
  })
}

/** recommended = "Best match" · rating = "Best overall" · distance = "Closest" */
export type DiscoverySort = 'recommended' | 'distance' | 'rating' | 'drinks' | 'food' | 'value' | 'ending_soon' | 'name'

export const SORT_LABEL: Record<DiscoverySort, string> = {
  recommended: 'Best match',
  distance: 'Closest',
  rating: 'Best overall',
  drinks: 'Best drinks',
  food: 'Best food',
  value: 'Best value',
  ending_soon: 'Ending soon',
  name: 'A–Z',
}

export function communityRank(e: Establishment): number {
  return bayesianScore(e.community.average, e.community.reviewers)
}

/** Bayesian-shrunk community score for one category; unrated places sort last. */
export function categoryRank(e: Establishment, key: PrimaryCategoryKey): number {
  const avg = e.community.categoryAverages[key]
  return avg == null ? -1 : bayesianScore(avg, e.community.reviewers)
}

export function sortEstablishments(
  list: readonly Establishment[],
  sort: DiscoverySort,
  ctx: DiscoveryContext,
  personal?: ReadonlyMap<string, number>,
): Establishment[] {
  const out = [...list]
  const dist = (e: Establishment) => (ctx.origin ? distanceMiles(ctx.origin, e) : 0)
  switch (sort) {
    case 'distance':
      return out.sort((a, b) => dist(a) - dist(b) || a.name.localeCompare(b.name))
    case 'rating':
      return out.sort((a, b) => communityRank(b) - communityRank(a) || dist(a) - dist(b) || a.name.localeCompare(b.name))
    case 'drinks':
    case 'food':
    case 'value':
      return out.sort((a, b) => categoryRank(b, sort) - categoryRank(a, sort) || communityRank(b) - communityRank(a) || dist(a) - dist(b))
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name))
    case 'ending_soon': {
      const key = (e: Establishment) => {
        const s = happyHourStatus(e.windows, e.exceptions, e.timezone, ctx.now)
        if (s.state === 'now') return s.endsInMinutes!
        if (s.state === 'later_today') return 10_000 + s.startsInMinutes!
        return 100_000
      }
      return out.sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name))
    }
    default:
      return out.sort((a, b) => recommendScore(b, ctx, personal) - recommendScore(a, ctx, personal) || a.name.localeCompare(b.name))
  }
}

/**
 * Transparent blend for the default "Best match" order:
 * Bayesian community score, a bonus if happening now/soon, a distance penalty scaled to the
 * search radius, a small trust bonus, and — when the user has rated it — their own score.
 */
export function recommendScore(e: Establishment, ctx: DiscoveryContext, personal?: ReadonlyMap<string, number>): number {
  let score = communityRank(e)
  const own = personal?.get(e.id)
  if (own !== undefined) score = (score + own * 2) / 3
  const s = happyHourStatus(e.windows, e.exceptions, e.timezone, ctx.now)
  if (s.state === 'now') score += 0.6
  else if (s.state === 'later_today') score += 0.3
  if (ctx.origin) score -= Math.min(1, distanceMiles(ctx.origin, e) / Math.max(5, ctx.radiusMiles ?? 15))
  if (freshness(e.hhStatus, e.hhVerifiedAt, ctx.now) === 'fresh') score += 0.15
  else if (e.hhStatus === 'establishment_reported') score += 0.05
  else if (e.hhStatus === 'outdated') score -= 0.3
  return score
}

// ---------------------------------------------------------------------------
// Curated discovery collections
// ---------------------------------------------------------------------------

export interface DiscoveryShelf {
  key: string
  title: string
  subtitle: string
  items: Establishment[]
}

export interface ShelfInput {
  listings: readonly Establishment[]
  ctx: DiscoveryContext
  myVisits?: readonly Visit[]
  myWeights?: Weights
  friendVisits?: readonly { establishmentId: string; createdAt: string }[]
}

const MIN_REVIEWERS_FOR_CATEGORY = 2

function byCategory(listings: readonly Establishment[], key: PrimaryCategoryKey): Establishment[] {
  return listings
    .filter((e) => (e.community.categoryAverages[key] ?? 0) >= 7.5 && e.community.reviewers >= MIN_REVIEWERS_FOR_CATEGORY)
    .sort((a, b) => b.community.categoryAverages[key]! - a.community.categoryAverages[key]!)
}

/**
 * Personalised picks: unrated places sharing tags/kinds with the user's top-ranked
 * places, ordered by community score. Empty until the user has rated something.
 */
export function recommendForUser(input: ShelfInput): Establishment[] {
  const { listings, myVisits = [], myWeights } = input
  if (!myVisits.length) return []
  const rated: RatedVisit[] = myVisits.map((v) => ({ id: v.id, establishmentId: v.establishmentId, visitedOn: v.visitedOn, createdAt: v.createdAt, scores: v.scores }))
  const top = buildRankings(rated, myWeights).filter((r) => r.score >= 7).slice(0, 5)
  const byId = new Map(listings.map((e) => [e.id, e]))
  const likedKinds = new Set<string>()
  const likedTags = new Map<string, number>()
  for (const r of top) {
    const e = byId.get(r.establishmentId)
    if (!e) continue
    likedKinds.add(e.kind)
    for (const t of e.community.topTags) likedTags.set(t.key, (likedTags.get(t.key) ?? 0) + 1)
  }
  for (const v of myVisits) for (const t of v.tags) likedTags.set(t, (likedTags.get(t) ?? 0) + 1)
  const visited = new Set(myVisits.map((v) => v.establishmentId))
  return listings
    .filter((e) => !visited.has(e.id))
    .map((e) => {
      let affinity = likedKinds.has(e.kind) ? 1 : 0
      for (const t of e.community.topTags) affinity += (likedTags.get(t.key) ?? 0) * 0.5
      return { e, s: affinity + communityRank(e) / 2 }
    })
    .filter((x) => x.s > communityRank(x.e) / 2) // must share something
    .sort((a, b) => b.s - a.s)
    .map((x) => x.e)
}

export function buildShelves(input: ShelfInput): DiscoveryShelf[] {
  const { listings, ctx } = input
  const near = ctx.origin
    ? [...listings].filter((e) => distanceMiles(ctx.origin!, e) <= 10)
    : [...listings]
  const rated = [...near].filter((e) => e.community.reviewers > 0).sort((a, b) => communityRank(b) - communityRank(a))
  const now = listings.filter((e) => happyHourStatus(e.windows, e.exceptions, e.timezone, ctx.now).state === 'now')
  const tagged = (tag: string) => listings.filter((e) => hasTag(e, tag)).sort((a, b) => communityRank(b) - communityRank(a))
  const hidden = listings
    .filter((e) => e.community.reviewers > 0 && e.community.reviewers <= 4 && (e.community.average ?? 0) >= 8)
    .sort((a, b) => (b.community.average ?? 0) - (a.community.average ?? 0))
  const cutoff = new Date(ctx.now.getTime() - 60 * 86_400_000).toISOString()
  const fresh = listings.filter((e) => e.createdAt >= cutoff).sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const friendCounts = new Map<string, number>()
  for (const v of input.friendVisits ?? []) friendCounts.set(v.establishmentId, (friendCounts.get(v.establishmentId) ?? 0) + 1)
  const trending = listings
    .filter((e) => friendCounts.has(e.id))
    .sort((a, b) => friendCounts.get(b.id)! - friendCounts.get(a.id)!)

  const shelves: DiscoveryShelf[] = [
    { key: 'now', title: 'Happening now', subtitle: 'Happy hour is on right now', items: now },
    { key: 'for-you', title: 'Picked for you', subtitle: 'Based on places you rated highly', items: recommendForUser(input) },
    { key: 'top', title: ctx.origin ? 'Highest rated near you' : 'Highest rated', subtitle: 'Community favorites', items: rated },
    { key: 'friends', title: 'Trending with friends', subtitle: 'Where people you follow have been', items: trending },
    { key: 'cocktails', title: 'Best cocktail happy hours', subtitle: 'Top community drinks scores', items: byCategory(listings, 'drinks') },
    { key: 'value', title: 'Best value', subtitle: 'The most for your money', items: byCategory(listings, 'value') },
    { key: 'food', title: 'Best food', subtitle: 'Bites worth staying for', items: byCategory(listings, 'food') },
    { key: 'waterfront', title: 'Waterfront happy hours', subtitle: 'Drinks with a view', items: tagged('waterfront') },
    { key: 'date-night', title: 'Date night spots', subtitle: 'Tagged by the community', items: tagged('date-night') },
    { key: 'hidden', title: 'Hidden gems', subtitle: 'Highly rated, not yet crowded', items: hidden },
    { key: 'new', title: 'New places to try', subtitle: 'Recently added to Aour', items: fresh },
  ]
  return shelves.filter((s) => s.items.length > 0).map((s) => ({ ...s, items: s.items.slice(0, 12) }))
}

/** Current local day/time for a market, for default filter values. */
export function marketNow(timeZone: string, at: Date = new Date()) {
  return zonedNow(timeZone, at)
}
