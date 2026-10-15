import { describe, expect, it } from 'vitest'
import {
  formatDays,
  formatRange,
  formatTime,
  happyHourStatus,
  runsAt,
  validateWindow,
  windowLength,
  zonedNow,
  type HappyHourWindow,
} from '@/core/schedule'
import { freshness, freshnessLabel, distanceMiles, validateUsername, slugify } from '@/core/listing'

const TZ = 'America/New_York'
const weekdays: HappyHourWindow = { id: 'w1', days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00' }
const lateNight: HappyHourWindow = { id: 'w2', days: [5, 6], start: '22:00', end: '01:00', label: 'Late night' }

// 2026-10-16 is a Friday. EDT = UTC−4.
const at = (local: string) => new Date(`${local}-04:00`)

describe('zonedNow', () => {
  it('uses the establishment time zone, not the device zone', () => {
    const z = zonedNow(TZ, new Date('2026-10-16T21:30:00Z'))
    expect(z).toEqual({ day: 5, minutes: 17 * 60 + 30, date: '2026-10-16' })
    const la = zonedNow('America/Los_Angeles', new Date('2026-10-16T21:30:00Z'))
    expect(la.minutes).toBe(14 * 60 + 30)
  })
})

describe('happyHourStatus', () => {
  it('reports happening now with minutes left', () => {
    const s = happyHourStatus([weekdays], [], TZ, at('2026-10-16T18:15:00'))
    expect(s.state).toBe('now')
    expect(s.endsInMinutes).toBe(45)
  })

  it('reports later today', () => {
    const s = happyHourStatus([weekdays], [], TZ, at('2026-10-16T12:00:00'))
    expect(s.state).toBe('later_today')
    expect(s.startsInMinutes).toBe(240)
  })

  it('end time is exclusive', () => {
    expect(happyHourStatus([weekdays], [], TZ, at('2026-10-16T19:00:00')).state).not.toBe('now')
  })

  it('finds the next day when today is over (weekend → Monday)', () => {
    const s = happyHourStatus([weekdays], [], TZ, at('2026-10-17T12:00:00')) // Saturday
    expect(s.state).toBe('upcoming')
    expect(s.nextDay).toBe(1)
  })

  it('handles windows that cross midnight (started yesterday)', () => {
    // Saturday 00:30 — Friday's 22:00–01:00 window is still on.
    const s = happyHourStatus([lateNight], [], TZ, at('2026-10-17T00:30:00'))
    expect(s.state).toBe('now')
    expect(s.endsInMinutes).toBe(30)
    expect(windowLength(lateNight)).toBe(180)
  })

  it('honours closed exceptions and special-hours exceptions', () => {
    const closed = happyHourStatus([weekdays], [{ id: 'x', date: '2026-10-16', closed: true }], TZ, at('2026-10-16T17:00:00'))
    expect(closed.state).toBe('upcoming')
    const special = happyHourStatus([weekdays], [{ id: 'y', date: '2026-10-16', closed: false, start: '12:00', end: '20:00', note: 'Festival' }], TZ, at('2026-10-16T13:00:00'))
    expect(special.state).toBe('now')
  })

  it('returns none without schedule data', () => {
    expect(happyHourStatus([], [], TZ).state).toBe('none')
  })
})

describe('runsAt', () => {
  it('matches day + time including overnight spill', () => {
    expect(runsAt([weekdays], 5, 17 * 60)).toBe(true)
    expect(runsAt([weekdays], 6, 17 * 60)).toBe(false)
    expect(runsAt([lateNight], 0, 30)).toBe(true) // Sunday 00:30 from Saturday window
    expect(runsAt([lateNight], 1, 30)).toBe(false)
  })
})

describe('formatting', () => {
  it('formats times and ranges compactly', () => {
    expect(formatTime('16:00')).toBe('4pm')
    expect(formatTime('16:30')).toBe('4:30pm')
    expect(formatTime('00:00')).toBe('midnight')
    expect(formatTime('12:00')).toBe('noon')
    expect(formatRange('16:00', '19:00')).toBe('4–7pm')
    expect(formatRange('11:00', '14:00')).toBe('11am–2pm')
    expect(formatRange('22:00', '01:00')).toBe('10pm–1am')
  })

  it('formats day sets', () => {
    expect(formatDays([1, 2, 3, 4, 5])).toBe('Mon–Fri')
    expect(formatDays([0, 1, 2, 3, 4, 5, 6])).toBe('Daily')
    expect(formatDays([0, 6])).toBe('Weekends')
    expect(formatDays([1, 3, 5])).toBe('Mon, Wed, Fri')
    expect(formatDays([5, 6, 0])).toBe('Fri–Sun')
  })

  it('validates windows', () => {
    expect(validateWindow(weekdays)).toBeNull()
    expect(validateWindow({ days: [], start: '16:00', end: '18:00' })).toMatch(/day/)
    expect(validateWindow({ days: [1], start: '16:00', end: '16:00' })).toMatch(/same/)
    expect(validateWindow({ days: [1], start: '4pm', end: '18:00' })).toMatch(/Times/)
  })
})

describe('listing freshness', () => {
  const now = new Date('2026-10-15T12:00:00Z')
  it('classifies verification age', () => {
    expect(freshness('verified', '2026-09-01T00:00:00Z', now)).toBe('fresh')
    expect(freshness('verified', '2026-06-01T00:00:00Z', now)).toBe('aging')
    expect(freshness('verified', '2025-12-01T00:00:00Z', now)).toBe('stale')
    expect(freshness('verified', null, now)).toBe('unverified')
    expect(freshness('unverified', '2026-10-01T00:00:00Z', now)).toBe('unverified')
    expect(freshness('outdated', '2026-10-01T00:00:00Z', now)).toBe('stale')
    expect(freshnessLabel('fresh', '2026-10-10T12:00:00Z', now)).toBe('Verified 5 days ago')
  })
})

describe('misc helpers', () => {
  it('distance and validation', () => {
    // Stuart → Jensen Beach is roughly 5 miles.
    const d = distanceMiles({ lat: 27.1975, lng: -80.2528 }, { lat: 27.2545, lng: -80.2298 })
    expect(d).toBeGreaterThan(3)
    expect(d).toBeLessThan(6)
    expect(validateUsername('allie_k')).toBeNull()
    expect(validateUsername('Al')).not.toBeNull()
    expect(validateUsername('admin')).not.toBeNull()
    expect(slugify("Mulligan's Beach House & Grill")).toBe('mulligan-s-beach-house-and-grill')
  })
})
