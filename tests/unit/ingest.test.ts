import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayIndex, parseDays, parseOsmOpeningHours, parseTimeRange } from '@/core/ingest/timeparse'
import { businessHoursFromJsonLd, extractFromText, extractHappyHour, findCandidateLinks, htmlToText, parseJsonLd } from '@/core/ingest/extract'
import { findingFingerprint, schedulesAgree, validateFinding } from '@/core/ingest/validate'
import { assess, decideApply, recencyFactor, reliability } from '@/core/ingest/confidence'
import { findBestMatch, nameSimilarity, normalizePhone, websiteDomain } from '@/core/ingest/match'
import { isAllowed, parseRobots, robotsFromResponse } from '@/core/ingest/robots'
import { canSpend, isCrawlableWebsite, isStale, nextCheckAt, politeDelayMs } from '@/core/ingest/refresh'
import { bboxAround, fsqToCandidate, isQuickServiceChain, kindFromCategories, kindFromOverture, osmToCandidate, overpassQuery, overtureToCandidate, storageAllowed, type OsmElement } from '@/core/ingest/providers'
import type { HappyHourFinding } from '@/core/ingest/types'
import { happyHourStatus } from '@/core/schedule'

const FIX = join(import.meta.dirname, '..', 'fixtures', 'ingest')
const fixture = (f: string) => readFileSync(join(FIX, f), 'utf8')
const NOW = '2026-10-15T12:00:00Z'

describe('timeparse', () => {
  it('parses human day expressions', () => {
    expect(parseDays('Monday – Friday')).toEqual([1, 2, 3, 4, 5])
    expect(parseDays('Mon-Fri')).toEqual([1, 2, 3, 4, 5])
    expect(parseDays('M-F 3-6pm')).toEqual([1, 2, 3, 4, 5])
    expect(parseDays('Tues & Thurs')).toEqual([2, 4])
    expect(parseDays('Fri & Sat 9pm-close')).toEqual([5, 6])
    expect(parseDays('Sun-Thu')).toEqual([0, 1, 2, 3, 4])
    expect(parseDays('Daily')).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(parseDays('7 days a week')).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(parseDays('weekdays')).toEqual([1, 2, 3, 4, 5])
    expect(parseDays('Weekends')).toEqual([0, 6])
    expect(parseDays('Join us for drinks')).toBeNull()
    expect(dayIndex('Thurs')).toBe(4)
  })

  it('parses time ranges without guessing', () => {
    expect(parseTimeRange('3:00 PM', '6:00 PM')).toEqual({ start: '15:00', end: '18:00' })
    expect(parseTimeRange('3', '6pm')).toEqual({ start: '15:00', end: '18:00' })
    expect(parseTimeRange('11', '2pm')).toEqual({ start: '11:00', end: '14:00' })
    expect(parseTimeRange('4', '7')).toEqual({ start: '16:00', end: '19:00' })
    expect(parseTimeRange('4', '7', false)).toBeNull()
    expect(parseTimeRange('15:00', '18:00')).toEqual({ start: '15:00', end: '18:00' })
    expect(parseTimeRange('10pm', '1am')).toEqual({ start: '22:00', end: '01:00' })
    expect(parseTimeRange('9pm', 'close')).toBeNull()
    expect(parseTimeRange('3pm', '3pm')).toBeNull()
    expect(parseTimeRange('8am', '11pm')).toBeNull() // > 12 hours: not a happy hour
  })

  it('parses OSM opening_hours including windows past midnight', () => {
    expect(parseOsmOpeningHours('Mo-Fr 16:00-19:00; Sa,Su 21:00-01:00')).toEqual([
      { days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00', label: null },
      { days: [0, 6], start: '21:00', end: '01:00', label: null },
    ])
    expect(parseOsmOpeningHours('Fr-Su 16:00-18:00; PH off')).toEqual([{ days: [0, 5, 6], start: '16:00', end: '18:00', label: null }])
    expect(parseOsmOpeningHours('Jan-Mar Mo 10:00-12:00')).toBeNull()
    expect(parseOsmOpeningHours('sunset-sunrise')).toBeNull()
    expect(parseOsmOpeningHours('')).toBeNull()
    // A window 21:00-01:00 on Saturday is "now" at 00:30 Sunday.
    const w = parseOsmOpeningHours('Sa 21:00-01:00')!.map((x, i) => ({ ...x, id: String(i) }))
    expect(happyHourStatus(w, [], 'America/New_York', new Date('2026-10-18T00:30:00-04:00')).state).toBe('now')
  })
})

describe('extraction from official websites', () => {
  it('extracts days, times, priced specials, restrictions and evidence', () => {
    const f = extractHappyHour(fixture('official-site.html'), 'https://fixturebay.example/specials', NOW)!
    expect(f.method).toBe('pattern')
    expect(f.windows).toEqual([{ days: [1, 2, 3, 4, 5], start: '15:00', end: '18:00', label: null }])
    expect(f.specials.map((s) => [s.kind, s.title, s.price])).toEqual([
      ['food', 'Oysters on the half shell', '$1.50'],
      ['drink', 'House Wine', '$5'],
      ['drink', 'Domestic Drafts', '$4'],
      ['food', 'appetizers', 'Half-price'],
      ['drink', 'Margaritas', '$7'],
    ])
    expect(f.restrictions).toEqual(['Bar area only', 'Not on holidays'])
    // "9pm-close" has no end time: dropped, never guessed.
    expect(f.windows.some((w) => w.start === '21:00')).toBe(false)
    expect(f.sourcePublishedAt).toBe('2026-09-02T14:00:00.000Z')
    // Every fact has a verbatim quote from the page.
    const text = htmlToText(fixture('official-site.html'))
    for (const e of f.evidence) expect(text).toContain(e.quote)
    // The fake "happy hour 1-2am" inside a <script> is ignored, as is the live-music cover charge.
    expect(f.specials.some((s) => /cover/i.test(s.title))).toBe(false)
  })

  it('reads schema.org JSON-LD happy hour + menu and business hours separately', () => {
    const html = fixture('jsonld-site.html')
    const f = extractHappyHour(html, 'https://fixturehall.example', NOW)!
    expect(f.method).toBe('json_ld')
    expect(f.windows).toEqual([{ days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00', label: null }])
    expect(f.specials).toEqual([
      { kind: 'drink', title: 'Pints of house lager', price: '$4', description: null },
      { kind: 'food', title: 'Pretzel bites', price: '$6.00', description: null },
    ])
    expect(f.sourcePublishedAt).toBe('2026-08-20')
    const hours = businessHoursFromJsonLd(parseJsonLd(html))!
    expect(hours).toEqual([
      { days: [1, 2, 3, 4], start: '11:00', end: '23:00', label: null },
      { days: [5, 6], start: '11:00', end: '01:00', label: null },
    ])
  })

  it('returns nothing when a site has no happy hour (missing information stays missing)', () => {
    expect(extractHappyHour(fixture('no-happy-hour.html'), 'https://fine.example', NOW)).toBeNull()
  })

  it('flags mentions it cannot parse instead of guessing days', () => {
    const f = extractFromText(htmlToText(fixture('ambiguous.html')), 'https://amb.example', NOW)!
    expect(f.windows).toEqual([]) // "Happy hour 4-7" has no days
    expect(f.mentionedButUnparsed).toBe(true)
    expect(f.specials.some((s) => /mimosa/i.test(s.title))).toBe(false) // brunch is a different program
  })

  it('finds same-site happy hour / specials pages and skips social, ordering and files', () => {
    const links = findCandidateLinks(fixture('official-site.html'), 'https://fixturebay.example')
    expect(links[0]).toBe('https://fixturebay.example/happy-hour')
    expect(links).toContain('https://fixturebay.example/menu')
    expect(links.some((l) => /facebook|order/.test(l))).toBe(false)
  })
})

const finding = (over: Partial<HappyHourFinding> = {}): HappyHourFinding => ({
  sourceKind: 'official_website',
  method: 'pattern',
  sourceUrl: 'https://a.example',
  windows: [{ days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00', label: null }],
  specials: [{ kind: 'drink', title: 'House wine', price: '$5', description: null }],
  restrictions: [],
  evidence: [
    { field: 'window:0', quote: 'Mon-Fri 4-7pm' },
    { field: 'special:0', quote: '$5 house wine' },
  ],
  sourcePublishedAt: null,
  checkedAt: NOW,
  mentionedButUnparsed: false,
  ...over,
})

describe('validation (anti-invention)', () => {
  it('drops AI-extracted facts whose evidence is not verbatim in the source', () => {
    const source = 'Happy Hour Mon-Fri 4-7pm. $5 house wine.'
    const ok = validateFinding(finding({ method: 'llm' }), source)
    expect(ok.finding.windows).toHaveLength(1)
    expect(ok.finding.specials).toHaveLength(1)

    const invented = validateFinding(
      finding({ method: 'llm', specials: [{ kind: 'drink', title: 'House wine', price: '$3', description: null }], evidence: [{ field: 'window:0', quote: 'Mon-Sun 2-8pm' }, { field: 'special:0', quote: '$5 house wine' }] }),
      source,
    )
    expect(invented.ok).toBe(false)
    expect(invented.finding.windows).toHaveLength(0) // quote not in source
    expect(invented.finding.specials).toHaveLength(0) // price not in its evidence
  })

  it('rejects malformed windows and fake prices', () => {
    const r = validateFinding(finding({ windows: [{ days: [], start: '16:00', end: '19:00', label: null }], specials: [{ kind: 'food', title: 'Wings', price: 'cheap', description: null }] }))
    expect(r.finding.windows).toHaveLength(0)
    expect(r.finding.specials).toHaveLength(0)
  })

  it('fingerprints are order-insensitive and detect changes', () => {
    const a = finding()
    const b = finding({ specials: [...a.specials].reverse() })
    expect(findingFingerprint(a)).toBe(findingFingerprint(b))
    expect(findingFingerprint(a)).not.toBe(findingFingerprint(finding({ windows: [{ days: [1, 2, 3, 4, 5], start: '15:00', end: '18:00', label: null }] })))
  })

  it('schedules agree within 15 minutes and disagree otherwise', () => {
    const w = finding().windows
    expect(schedulesAgree(w, [{ days: [1, 2, 3, 4, 5], start: '16:15', end: '19:00', label: null }])).toBe(true)
    expect(schedulesAgree(w, [{ days: [1, 2, 3, 4, 5], start: '15:00', end: '18:00', label: null }])).toBe(false)
    expect(schedulesAgree(w, [{ days: [1, 2, 3], start: '16:00', end: '19:00', label: null }])).toBe(false)
    expect(schedulesAgree(w, [])).toBe(true)
  })
})

describe('confidence and verification status', () => {
  const now = new Date(NOW)

  it('never labels automated extraction as verified', () => {
    const a = assess([finding({ method: 'json_ld' })], now)
    expect(a.status).toBe('establishment_reported')
    expect(a.confidence).toBe(0.85)
    expect(assess([finding({ method: 'llm' })], now).status).toBe('unverified')
    expect(assess([finding({ sourceKind: 'user', method: 'user' })], now).status).toBe('community_reported')
    expect(assess([finding({ sourceKind: 'osm', method: 'osm_tag' })], now).status).toBe('community_reported')
  })

  it('only an admin action yields "verified" (and it expires)', () => {
    expect(assess([finding()], now, '2026-10-01T00:00:00Z').status).toBe('verified')
    expect(assess([finding()], now, '2026-01-01T00:00:00Z').status).not.toBe('verified')
  })

  it('decays with age, using the page’s own stated date', () => {
    expect(recencyFactor({ checkedAt: NOW, sourcePublishedAt: null }, now)).toBe(1)
    expect(recencyFactor({ checkedAt: NOW, sourcePublishedAt: '2025-06-01T00:00:00Z' }, now)).toBe(0.25)
    expect(assess([finding({ sourcePublishedAt: '2025-06-01T00:00:00Z' })], now).status).toBe('outdated')
  })

  it('corroboration raises confidence; conflicts cap it and are flagged', () => {
    const agree = assess([finding(), finding({ sourceUrl: 'https://b.example', sourceKind: 'osm', method: 'osm_tag' })], now)
    expect(agree.confidence).toBeGreaterThan(reliability('official_website', 'pattern'))
    const conflict = assess([finding(), finding({ sourceUrl: 'https://b.example', method: 'json_ld', windows: [{ days: [1, 2, 3, 4, 5], start: '15:00', end: '17:00', label: null }] })], now)
    expect(conflict.conflict).toBe(true)
    expect(conflict.confidence).toBeLessThanOrEqual(0.5)
    expect(conflict.status).toBe('unverified')
  })

  it('missing information is "none"; unparsed mentions are "needs verification"', () => {
    expect(assess([], now).status).toBe('none')
    expect(assess([finding({ windows: [], specials: [], mentionedButUnparsed: true })], now).status).toBe('unverified')
  })
})

describe('apply decisions (manual overrides are preserved)', () => {
  const now = new Date(NOW)
  const f = finding()
  const a = assess([f], now)
  it('applies trusted deterministic findings to auto-managed listings', () => {
    expect(decideApply(f, { managedBy: 'auto', fingerprint: null, hasData: false }, a).action).toBe('apply')
  })
  it('never overwrites admin-managed listings — proposes for review instead', () => {
    expect(decideApply(f, { managedBy: 'admin', fingerprint: 'x', hasData: true }, a).action).toBe('review')
  })
  it('AI, user and conflicting findings wait for review; unchanged data is a touch', () => {
    expect(decideApply(finding({ method: 'llm' }), { managedBy: 'auto', fingerprint: null, hasData: false }, a).action).toBe('review')
    expect(decideApply(finding({ sourceKind: 'user', method: 'user' }), { managedBy: 'auto', fingerprint: null, hasData: false }, a).action).toBe('review')
    expect(decideApply(f, { managedBy: 'auto', fingerprint: null, hasData: false }, { ...a, conflict: true }).action).toBe('review')
    expect(decideApply(f, { managedBy: 'auto', fingerprint: findingFingerprint(f), hasData: true }, a).action).toBe('touch')
    expect(decideApply(finding({ windows: [], specials: [] }), { managedBy: 'auto', fingerprint: null, hasData: false }, a).action).toBe('discard')
  })
})

describe('duplicate matching', () => {
  const existing = [
    { id: 'e1', name: "Mulligan's Beach House Bar & Grill", lat: 27.2001, lng: -80.2502, website: 'https://mulligansbeachhouse.example', phone: '(772) 555-0101' },
    { id: 'e2', name: 'The Driftwood', lat: 27.1979, lng: -80.2537, externalIds: [{ provider: 'osm', externalId: 'node/1' }] },
    { id: 'e3', name: 'Driftwood Social', lat: 27.3, lng: -80.3 },
  ]
  it('links by provider id first', () => {
    expect(findBestMatch({ provider: 'osm', externalId: 'node/1', name: 'Totally different', lat: 0, lng: 0 }, existing)).toMatchObject({ decision: 'same', match: { id: 'e2' } })
  })
  it('matches name variants nearby, boosted by website/phone', () => {
    const r = findBestMatch({ name: 'Mulligans Beach House', lat: 27.2003, lng: -80.2503, website: 'http://www.mulligansbeachhouse.example/', phone: '+1 772-555-0101' }, existing)
    expect(r.decision).toBe('same')
    expect(r.match?.id).toBe('e1')
  })
  it('sends plausible-but-uncertain pairs to review and keeps distinct places separate', () => {
    expect(findBestMatch({ name: 'Driftwood Bar', lat: 27.1995, lng: -80.2537 }, existing).decision).toBe('review') // ~180 m away
    expect(findBestMatch({ name: 'Driftwood Social', lat: 27.1979, lng: -80.2537 }, existing.slice(2)).decision).toBe('new') // same name, 10 mi away
    expect(findBestMatch({ name: 'Copper Heron', lat: 27.2001, lng: -80.2502 }, existing).decision).toBe('new')
  })
  it('helpers', () => {
    expect(nameSimilarity('The Pelican Pour', 'Pelican Pour Bar')).toBeGreaterThan(0.9)
    expect(websiteDomain('www.Example.com/menu')).toBe('example.com')
    expect(normalizePhone('+1 (772) 555-0100')).toBe('7725550100')
  })
})

describe('robots.txt', () => {
  const txt = `User-agent: *\nDisallow: /private\nAllow: /private/menu\nDisallow: /*.pdf$\n\nUser-agent: AourBot\nUser-agent: OtherBot\nDisallow: /admin\nCrawl-delay: 12\n`
  it('uses the most specific group and longest match', () => {
    const r = parseRobots(txt, 'AourBot/1.0 (+https://aour.app/bot)')
    expect(isAllowed(r, '/admin/x')).toBe(false)
    expect(isAllowed(r, '/private')).toBe(true) // AourBot group has no rule for it
    expect(r.crawlDelaySec).toBe(12)
    const star = parseRobots(txt, 'SomeoneElse/2')
    expect(isAllowed(star, '/private/x')).toBe(false)
    expect(isAllowed(star, '/private/menu')).toBe(true)
    expect(isAllowed(star, '/files/a.pdf')).toBe(false)
    expect(isAllowed(star, '/files/a.pdf?x=1')).toBe(true)
  })
  it('follows RFC 9309 status handling', () => {
    expect(isAllowed(robotsFromResponse(404, '', 'AourBot'), '/anything')).toBe(true)
    expect(isAllowed(robotsFromResponse(503, '', 'AourBot'), '/anything')).toBe(false)
  })
})

describe('refresh scheduling and cost guards', () => {
  const now = new Date(NOW)
  const days = (d: Date) => Math.round((d.getTime() - now.getTime()) / 86_400_000)
  it('backs off on errors exponentially and caps', () => {
    expect((nextCheckAt('error', { failures: 0, lastSuccessAt: null }, now).getTime() - now.getTime()) / 3.6e6).toBe(1)
    expect((nextCheckAt('error', { failures: 3, lastSuccessAt: null }, now).getTime() - now.getTime()) / 3.6e6).toBe(8)
    expect(days(nextCheckAt('error', { failures: 20, lastSuccessAt: null }, now))).toBe(7)
  })
  it('checks changed sources sooner and unchanged ones less often', () => {
    expect(days(nextCheckAt('changed', { failures: 0, lastSuccessAt: NOW }, now))).toBe(14)
    expect(days(nextCheckAt('unchanged', { failures: 0, lastSuccessAt: NOW }, now))).toBe(21)
    expect(days(nextCheckAt('unchanged', { failures: 0, lastSuccessAt: '2026-07-01T00:00:00Z' }, now))).toBe(60)
    expect(days(nextCheckAt('blocked', { failures: 0, lastSuccessAt: null }, now))).toBe(30)
    expect(days(nextCheckAt('changed', { failures: 0, lastSuccessAt: NOW }, now, true))).toBe(7)
  })
  it('budgets, staleness, politeness, crawl scope', () => {
    expect(canSpend({ provider: 'x', monthlyLimit: 100, used: 99 }, 1)).toBe(true)
    expect(canSpend({ provider: 'x', monthlyLimit: 100, used: 100 }, 1)).toBe(false)
    expect(isStale('2026-01-01T00:00:00Z', now)).toBe(true)
    expect(isStale('2026-09-01T00:00:00Z', now)).toBe(false)
    expect(isStale(null, now)).toBe(true)
    expect(politeDelayMs(null)).toBe(5000)
    expect(politeDelayMs(60)).toBe(30000)
    expect(isCrawlableWebsite('https://fixturebay.example')).toBe(true)
    expect(isCrawlableWebsite('https://www.facebook.com/fixturebay')).toBe(false)
    expect(isCrawlableWebsite('https://m.yelp.com/biz/x')).toBe(false)
    expect(isCrawlableWebsite('ftp://x.example')).toBe(false)
  })
})

describe('provider adapters', () => {
  it('maps Overpass elements, skipping non-venues, unnamed and closed places', () => {
    const json = JSON.parse(fixture('overpass.json')) as { elements: OsmElement[] }
    const out = json.elements.map(osmToCandidate).filter((c) => c && !c.closed)
    expect(out.map((c) => c!.name)).toEqual(['Fixture Tavern', 'Fixture Bay Oyster House', 'Fixture Hall Taproom'])
    const tavern = out[0]!
    expect(tavern).toMatchObject({
      externalId: 'node/9000000001',
      kind: 'bar',
      website: 'https://fixturetavern.example',
      address: '10 Example Street',
      happyHoursRaw: 'Mo-Fr 16:00-19:00; Sa,Su 21:00-01:00',
      amenities: ['outdoor_seating'],
      attribution: '© OpenStreetMap contributors',
    })
    expect(out[2]!.kind).toBe('brewery')
    expect(overpassQuery(bboxAround(27.2, -80.25, 5))).toContain('"amenity"~"^(bar|pub|restaurant|biergarten|nightclub)$"')
  })

  it('maps Overture v2 rows and drops low-confidence or closed records', () => {
    const row = { id: 'ovt-1', name: 'Fixture Wine Room', basic_category: 'bar', categories: ['food_and_drink', 'bar', 'wine_bar'], lat: 27.2, lng: -80.25, region: 'US-FL', website: 'fixturewine.example', confidence: 0.9 }
    expect(overtureToCandidate(row)).toMatchObject({ provider: 'overture', kind: 'wine_bar', state: 'FL', website: 'https://fixturewine.example', closed: false })
    expect(overtureToCandidate({ ...row, confidence: 0.3 })).toBeNull()
    expect(overtureToCandidate({ ...row, operating_status: 'permanently_closed' })!.closed).toBe(true)
    expect(overtureToCandidate({ ...row, basic_category: 'coffee_shop', categories: ['food_and_drink', 'cafe', 'coffee_shop'] })).toBeNull()
  })

  it('Foursquare API data is id-only (cannot be stored)', () => {
    expect(storageAllowed('foursquare')).toBe(false)
    expect(storageAllowed('overture')).toBe(true)
    expect(fsqToCandidate({ fsq_place_id: 'f1', name: 'Fixture Brewpub', latitude: 1, longitude: 2, categories: [{ name: 'Brewery' }] })!.kind).toBe('brewery')
  })

  it('Overture classification uses exact basic/primary categories from the live release', () => {
    // Kept: real categories observed around Stuart, FL.
    expect(kindFromOverture('bar', 'bar')).toBe('bar')
    expect(kindFromOverture('bar', 'sports_bar')).toBe('sports_bar')
    expect(kindFromOverture('lounge', 'lounge')).toBe('cocktail_lounge')
    expect(kindFromOverture('restaurant', 'seafood_restaurant')).toBe('restaurant')
    expect(kindFromOverture('restaurant', 'bar_and_grill_restaurant')).toBe('bar')
    expect(kindFromOverture('restaurant', 'steakhouse')).toBe('restaurant')
    expect(kindFromOverture('music_venue', 'music_venue', ['bar'])).toBe('bar')
    // Dropped: everything that slipped through substring matching before.
    for (const [b, p, alt] of [
      ['financial_service', 'insurance_agency', ['pub']],
      ['specialized_health_care', 'podiatry', []],
      ['food_and_beverage_store', 'liquor_store', ['wine']],
      ['casual_eatery', 'sandwich_shop', []],
      ['smoothie_juice_bar', 'smoothie_juice_bar', []],
      ['fast_food_restaurant', 'fast_food_restaurant', []],
      ['coffee_shop', 'coffee_shop', []],
      ['cafe', 'cafe', []],
      ['casual_eatery', 'ice_cream_shop', []],
      ['restaurant', 'breakfast_and_brunch_restaurant', []],
      ['music_venue', 'music_venue', []],
      [null, null, ['bar']],
    ] as [string | null, string | null, string[]][]) {
      expect(kindFromOverture(b, p, alt), `${b}/${p}`).toBeNull()
    }
  })

  it('drops quick-service chains Overture files as restaurants, but not lookalike local names', () => {
    for (const n of ['Burger King', "Papa John's Pizza", 'Little Caesars Pizza', "Hungry Howie's Pizza", 'Bubbakoo\'s Burritos', 'KFC', 'IHOP', 'Wendy\'s'])
      expect(isQuickServiceChain(n), n).toBe(true)
    for (const n of ["Conchy Joe's Seafood", "Duffy's Sports Grill", 'Harry and the Natives', 'Townies Tavern', 'The Sandbar Tiki Bar and Grill', "Carrabba's Italian Grill"])
      expect(isQuickServiceChain(n), n).toBe(false)
    const row = { id: 'x', name: 'Burger King', basic_category: 'restaurant', primary_category: 'burger_restaurant', lat: 27.2, lng: -80.25, confidence: 0.9 }
    expect(overtureToCandidate(row)).toBeNull()
  })

  it('category filter keeps happy-hour venue types only', () => {
    expect(kindFromCategories(['cocktail_bar'])).toBe('cocktail_lounge')
    expect(kindFromCategories(['restaurant', 'seafood_restaurant'])).toBe('restaurant')
    expect(kindFromCategories(['fast_food_restaurant'])).toBeNull()
    expect(kindFromCategories(['coffee_shop'])).toBeNull()
    expect(kindFromCategories(['winery'])).toBe('wine_bar')
  })
})
