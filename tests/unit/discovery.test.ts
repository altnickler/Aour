/**
 * Location-aware discovery: radius, proximity, sorts, time filters across time zones and
 * midnight, verification labels. Listings here are FICTIONAL test objects.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS, filterEstablishments, hasHappyHourInfo, sortEstablishments, type DiscoveryContext } from '@/core/discovery'
import { distanceMiles, verificationInfo } from '@/core/listing'
import { windowsForDay, weekendOffsets } from '@/core/schedule'
import { marketFor } from '@/app/location'
import { EMPTY_COMMUNITY_STATS } from '@/core/rating'
import type { Establishment, Market } from '@/core/types'

let n = 0
function place(over: Partial<Establishment> = {}): Establishment {
  n++
  return {
    id: `p${n}`, slug: `p${n}`, name: `Fixture ${n}`, kind: 'bar', marketId: 'm', neighborhood: null, city: 'Stuart', state: 'FL',
    address: '1 Example Way', postalCode: null, lat: 27.1975, lng: -80.2528, timezone: 'America/New_York', phone: null, website: null,
    description: null, priceLevel: null, amenities: [], hhStatus: 'establishment_reported', hhVerifiedAt: null, hhSourceNote: null,
    hhCheckedAt: null, hhSourceUrl: null, hhRestrictions: [], businessHours: null, attribution: null,
    windows: [{ id: 'w', days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00' }], exceptions: [], specials: [], photos: [],
    community: EMPTY_COMMUNITY_STATS, status: 'published', isDemo: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

const STUART = { lat: 27.1975, lng: -80.2528 }
// Wednesday 2026-10-14 17:30 in New York (21:30 UTC).
const WED_1730_NY = new Date('2026-10-14T21:30:00Z')
const ctx = (over: Partial<DiscoveryContext> = {}): DiscoveryContext => ({ now: WED_1730_NY, origin: STUART, radiusMiles: 5, ...over })

describe('radius and proximity', () => {
  const near = place({ lat: 27.2, lng: -80.25 }) // ~0.3 mi
  const mid = place({ lat: 27.26, lng: -80.23 }) // ~4.5 mi
  const far = place({ lat: 27.33, lng: -80.25 }) // ~9 mi

  it('keeps only places inside the radius', () => {
    expect(filterEstablishments([near, mid, far], DEFAULT_FILTERS, ctx({ radiusMiles: 2 })).map((e) => e.id)).toEqual([near.id])
    expect(filterEstablishments([near, mid, far], DEFAULT_FILTERS, ctx({ radiusMiles: 5 })).map((e) => e.id)).toEqual([near.id, mid.id])
    expect(filterEstablishments([near, mid, far], DEFAULT_FILTERS, ctx({ radiusMiles: 10 }))).toHaveLength(3)
  })

  it('sorts nearest first from the search centre, not from a market', () => {
    const jensen = { lat: 27.2545, lng: -80.2298 }
    expect(sortEstablishments([near, far, mid], 'distance', ctx({ origin: jensen })).map((e) => e.id)).toEqual([mid.id, near.id, far.id])
    expect(distanceMiles(jensen, mid)).toBeLessThan(distanceMiles(jensen, near))
  })

  it('sorts best value / drinks by the community category score, unrated last', () => {
    const stats = (value: number, drinks: number, reviewers = 6) => ({ ...EMPTY_COMMUNITY_STATS, average: 8, reviewers, categoryAverages: { value, drinks } })
    const a = place({ community: stats(9.2, 6) })
    const b = place({ community: stats(7, 9.5) })
    const c = place()
    expect(sortEstablishments([c, b, a], 'value', ctx()).map((e) => e.id)).toEqual([a.id, b.id, c.id])
    expect(sortEstablishments([c, a, b], 'drinks', ctx()).map((e) => e.id)).toEqual([b.id, a.id, c.id])
  })

  it('finds the launch market containing a point, and none far away', () => {
    const m = { id: 'm', slug: 'tc', name: 'Stuart & Martin County', region: 'FL', timezone: 'America/New_York', areas: [], radiusMiles: 15, ...STUART } as Market
    expect(marketFor([m], { lat: 27.25, lng: -80.23 })?.id).toBe('m')
    expect(marketFor([m], { lat: 41.88, lng: -87.63 })).toBeUndefined() // Chicago
  })
})

describe('time filters in the venue time zone', () => {
  it('happening now vs later today', () => {
    const on = place() // 4–7pm weekdays, it's 5:30pm Wed
    const later = place({ windows: [{ id: 'l', days: [3], start: '21:00', end: '23:00' }] })
    expect(filterEstablishments([on, later], { ...DEFAULT_FILTERS, when: 'now' }, ctx()).map((e) => e.id)).toEqual([on.id])
    expect(filterEstablishments([on, later], { ...DEFAULT_FILTERS, when: 'later' }, ctx()).map((e) => e.id)).toEqual([later.id])
  })

  it('uses each venue’s own clock (a Los Angeles venue is 3 hours behind)', () => {
    const la = place({ timezone: 'America/Los_Angeles', windows: [{ id: 'x', days: [3], start: '14:00', end: '15:00' }] })
    // 17:30 in New York is 14:30 in Los Angeles.
    expect(filterEstablishments([la], { ...DEFAULT_FILTERS, when: 'now' }, ctx())).toHaveLength(1)
  })

  it('tomorrow and this weekend', () => {
    const thu = place({ windows: [{ id: 't', days: [4], start: '16:00', end: '18:00' }] })
    const sat = place({ windows: [{ id: 's', days: [6], start: '12:00', end: '15:00' }] })
    expect(filterEstablishments([thu, sat], { ...DEFAULT_FILTERS, when: 'tomorrow' }, ctx()).map((e) => e.id)).toEqual([thu.id])
    expect(filterEstablishments([thu, sat], { ...DEFAULT_FILTERS, when: 'weekend' }, ctx()).map((e) => e.id)).toEqual([sat.id])
    expect(weekendOffsets(3)).toEqual([3, 4])
    expect(weekendOffsets(6)).toEqual([0, 1])
    expect(weekendOffsets(0)).toEqual([0])
  })

  it('handles windows that cross midnight', () => {
    const late = place({ windows: [{ id: 'm', days: [5, 6], start: '22:00', end: '01:00' }] })
    // Saturday 00:30 New York: the Friday-night window is still running.
    const sat0030 = new Date('2026-10-17T04:30:00Z')
    expect(filterEstablishments([late], { ...DEFAULT_FILTERS, when: 'now' }, ctx({ now: sat0030 }))).toHaveLength(1)
    // Sunday 01:30: over.
    expect(filterEstablishments([late], { ...DEFAULT_FILTERS, when: 'now' }, ctx({ now: new Date('2026-10-18T05:30:00Z') }))).toHaveLength(0)
  })

  it('respects dated exceptions for today', () => {
    const e = place({ exceptions: [{ id: 'x', date: '2026-10-14', closed: true }] })
    expect(windowsForDay(e.windows, e.exceptions, e.timezone, WED_1730_NY, 0)).toEqual([])
    expect(filterEstablishments([e], { ...DEFAULT_FILTERS, when: 'now' }, ctx())).toHaveLength(0)
  })
})

describe('missing information and verification', () => {
  it('venues without happy-hour facts are candidates, never results for time filters', () => {
    const candidate = place({ hhStatus: 'none', windows: [] })
    expect(hasHappyHourInfo(candidate)).toBe(false)
    expect(filterEstablishments([candidate], { ...DEFAULT_FILTERS, when: 'tomorrow' }, ctx())).toHaveLength(0)
    expect(hasHappyHourInfo(place({ windows: [], specials: [{ id: 's', kind: 'drink', title: 'Drafts', price: '$4', description: null }] }))).toBe(true)
  })

  it('"Verified only" requires a recent admin verification, not venue- or community-reported data', () => {
    const fresh = place({ hhStatus: 'verified', hhVerifiedAt: '2026-10-01T00:00:00Z' })
    const old = place({ hhStatus: 'verified', hhVerifiedAt: '2026-01-01T00:00:00Z' })
    const venue = place({ hhStatus: 'establishment_reported' })
    const community = place({ hhStatus: 'community_reported' })
    expect(filterEstablishments([fresh, old, venue, community], { ...DEFAULT_FILTERS, verifiedOnly: true }, ctx()).map((e) => e.id)).toEqual([fresh.id])
  })

  it('labels each status plainly', () => {
    const now = WED_1730_NY
    expect(verificationInfo({ hhStatus: 'verified', hhVerifiedAt: '2026-10-10T00:00:00Z' }, now).label).toBe('Verified 4 days ago')
    expect(verificationInfo({ hhStatus: 'establishment_reported', hhVerifiedAt: null, hhCheckedAt: '2026-10-13T00:00:00Z' }, now)).toMatchObject({ label: 'Reported by venue' })
    expect(verificationInfo({ hhStatus: 'community_reported', hhVerifiedAt: null }, now).label).toBe('Community reported')
    expect(verificationInfo({ hhStatus: 'unverified', hhVerifiedAt: null }, now).label).toBe('Needs verification')
    expect(verificationInfo({ hhStatus: 'outdated', hhVerifiedAt: null }, now).label).toBe('Outdated')
    expect(verificationInfo({ hhStatus: 'none', hhVerifiedAt: null }, now).label).toBe('No happy-hour info')
  })
})

describe('confirmed vs unconfirmed happy hours', () => {
  it('only verified or reported happy hours count as current', async () => {
    const { hasConfirmedHappyHour } = await import('@/core/discovery')
    const w = [{ id: 'w', days: [0, 1, 2, 3, 4, 5, 6], start: '15:00', end: '18:00', label: null, notes: null }]
    const base = { windows: w } as unknown as Parameters<typeof hasConfirmedHappyHour>[0]
    expect(hasConfirmedHappyHour({ ...base, hhStatus: 'establishment_reported' })).toBe(true)
    expect(hasConfirmedHappyHour({ ...base, hhStatus: 'verified' })).toBe(true)
    expect(hasConfirmedHappyHour({ ...base, hhStatus: 'unverified' })).toBe(false)
    expect(hasConfirmedHappyHour({ ...base, hhStatus: 'outdated' })).toBe(false)
    expect(hasConfirmedHappyHour({ ...base, hhStatus: 'establishment_reported', windows: [] })).toBe(false)
  })
})
