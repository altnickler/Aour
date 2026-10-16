/**
 * Deterministic happy-hour extraction from a venue's OWN web pages.
 *
 *   1. schema.org JSON-LD (structured, highest confidence)
 *   2. Text patterns around "happy hour" mentions (days + time ranges + priced specials)
 *
 * Every extracted fact carries a verbatim evidence quote. Nothing is inferred: if days or
 * times are missing or ambiguous the window is dropped and the page is flagged
 * `mentionedButUnparsed` for human/LLM follow-up.
 */
import { parseDays, parseOsmOpeningHours, parseTimeRange, TIME_RANGE_RE } from './timeparse'
import type { Evidence, ExtractedSpecial, ExtractedWindow, HappyHourFinding } from './types'

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…', rdquo: '”', ldquo: '“' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Visible text with one block element per line. Scripts, styles, nav chrome removed. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|dt|dd|td|th|ul|ol|table)>/gi, '\n')
      .replace(/<(p|div|li|h[1-6]|tr|section|article|dt|dd)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Link discovery (which pages on the venue's site are worth one fetch each)
// ---------------------------------------------------------------------------
export function findCandidateLinks(html: string, baseUrl: string, max = 4): string[] {
  const base = new URL(baseUrl)
  const scored: { url: string; score: number }[] = []
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL
    try {
      url = new URL(decodeEntities(m[1]), base)
    } catch {
      continue
    }
    if (!/^https?:$/.test(url.protocol)) continue
    if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue // same site only
    if (/\.(pdf|jpe?g|png|gif|webp|zip|docx?)$/i.test(url.pathname)) continue
    const label = `${htmlToText(m[2])} ${url.pathname}`.toLowerCase()
    let score = 0
    if (/happy[\s_-]*hour/.test(label)) score += 10
    if (/special|deal|promo/.test(label)) score += 5
    if (/\bmenu|drinks|bar\b/.test(label)) score += 3
    if (/event|calendar/.test(label)) score += 1
    if (/order|cart|reserv|gift|career|job|login|account/.test(label)) score -= 10
    if (score > 0) scored.push({ url: url.toString().replace(/\/$/, ''), score })
  }
  const seen = new Set<string>([baseUrl.replace(/\/$/, '')])
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((s) => !seen.has(s.url) && seen.add(s.url))
    .slice(0, max)
    .map((s) => s.url)
}

// ---------------------------------------------------------------------------
// Specials & restrictions
// ---------------------------------------------------------------------------
const PRICE_RE = /(\$\s?\d{1,3}(?:\.\d{2})?(?:\s?(?:off|each|ea))?|\d{1,2}\s?%\s?off|half[\s-]?(?:price|off)|1\/2\s?(?:price|off)|bogo|buy one,? get one(?: free)?|2[\s-]for[\s-]1|two[\s-]for[\s-]one)/i
const DRINK_WORDS = /\b(beer|beers|draft|drafts|draught|pint|pints|wine|wines|glass|rosé|rose|sangria|cocktail|cocktails|martini|margarita|margaritas|mojito|well|wells|rail|spirits|liquor|shot|shots|mimosa|bucket|domestic|domestics|ipa|lager|seltzer|frozen|sake|bubbles|prosecco|drink|drinks|bottles?|cans?|spritz|old fashioned|bloody mary)\b/i
const FOOD_WORDS = /\b(appetizer|appetizers|apps|wings|oysters?|tacos?|sliders?|fries|nachos|flatbreads?|pizza|bites|plates?|shrimp|wings|burger|burgers|calamari|dip|chips|food|bar menu|small plates|tapas|clams|sushi|rolls?|quesadillas?|pretzel|pretzels|fish|crab|mussels|bao|dumplings|charcuterie|cheese|snacks?)\b/i

const RESTRICTIONS: [RegExp, string][] = [
  [/\b(bar|lounge)\s*(area\s*)?(seating\s*)?only\b|\bat the bar only\b|\bin the bar( area)?\b|\bbar[- ]top only\b/i, 'Bar area only'],
  [/\bdine[\s-]?in only\b|\bnot (valid|available) (for|on) (takeout|to-go|carry[\s-]?out)\b/i, 'Dine-in only'],
  [/\b(patio|outdoor seating|outside) only\b/i, 'Patio only'],
  [/\bexcludes? holidays\b|\bnot (valid|available) on holidays\b|\bexcept holidays\b/i, 'Not on holidays'],
  [/\bexcludes? special events\b|\bnot (valid|available) during (special )?events\b/i, 'Not during special events'],
  [/\b21\+|\bmust be 21\b/i, '21+ only'],
  [/\bcannot be combined\b|\bnot valid with other (offers|discounts)\b/i, 'Cannot be combined with other offers'],
]

function cleanTitle(line: string, price: string | null): string {
  let t = line
  if (price) t = t.replace(price, ' ')
  return t
    .replace(/^[\s•·*\-–—:|]+|[\s•·*\-–—:|.]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function classifySpecial(text: string): ExtractedSpecial['kind'] {
  const d = DRINK_WORDS.test(text)
  const f = FOOD_WORDS.test(text)
  if (d && !f) return 'drink'
  if (f && !d) return 'food'
  return d && f ? 'other' : 'other'
}

// ---------------------------------------------------------------------------
// Text pattern extraction
// ---------------------------------------------------------------------------
const HH_RE = /\b(reverse\s+)?happy\s*hours?\b/i
const HAS_TIME_RANGE = new RegExp(TIME_RANGE_RE.source, 'i')
const MAX_BLOCK_LINES = 14

export function extractFromText(text: string, sourceUrl: string | null, checkedAt: string): HappyHourFinding | null {
  const lines = text.split('\n')
  const mentions = lines.map((l, i) => (HH_RE.test(l) ? i : -1)).filter((i) => i >= 0)
  if (!mentions.length) return null

  const windows: ExtractedWindow[] = []
  const specials: ExtractedSpecial[] = []
  const restrictions = new Set<string>()
  const evidence: Evidence[] = []
  const usedLines = new Set<number>()

  for (const start of mentions) {
    const reverse = /reverse/i.test(lines[start])
    const end = Math.min(lines.length, start + MAX_BLOCK_LINES)
    let lastDays: { days: number[]; line: number } | null = null
    for (let i = start; i < end; i++) {
      // Stop at the next unrelated heading-like line that mentions another time-based program.
      if (i > start && /\b(brunch|lunch special|kids eat|trivia|live music)\b/i.test(lines[i]) && !HH_RE.test(lines[i])) break
      const line = lines[i]
      const days = parseDays(line)
      if (days) lastDays = { days, line: i }
      for (const m of line.matchAll(TIME_RANGE_RE)) {
        const range = parseTimeRange(m[1], m[2])
        const d = days ?? (lastDays && i - lastDays.line <= 2 ? lastDays.days : null)
        if (!range || !d) continue
        const key = `${d.join(',')}|${range.start}|${range.end}`
        if (windows.some((w) => `${w.days.join(',')}|${w.start}|${w.end}` === key)) continue
        windows.push({ days: d, start: range.start, end: range.end, label: reverse ? 'Reverse happy hour' : null })
        const quoteLines = days || !lastDays ? line : `${lines[lastDays.line]}\n${line}`
        evidence.push({ field: `window:${windows.length - 1}`, quote: quoteLines })
        usedLines.add(i)
      }
      for (const [re, label] of RESTRICTIONS) {
        if (re.test(line) && !restrictions.has(label)) {
          restrictions.add(label)
          evidence.push({ field: `restriction:${label}`, quote: line })
        }
      }
      // Specials: priced lines that are not just the schedule line.
      const price = PRICE_RE.exec(line)
      if (price && line.length <= 160 && !(usedLines.has(i) && !DRINK_WORDS.test(line) && !FOOD_WORDS.test(line))) {
        const title = cleanTitle(line, price[0])
        if (title.length >= 3 && title.length <= 80 && !HH_RE.test(title) && !HAS_TIME_RANGE.test(title)) {
          if (!specials.some((s) => s.title.toLowerCase() === title.toLowerCase())) {
            specials.push({ kind: classifySpecial(line), title, price: price[0].replace(/\s+/g, ' ').trim(), description: null })
            evidence.push({ field: `special:${specials.length - 1}`, quote: line })
          }
        }
      }
    }
  }

  return {
    sourceKind: 'official_website',
    method: 'pattern',
    sourceUrl,
    windows,
    specials: specials.slice(0, 12),
    restrictions: [...restrictions],
    evidence,
    sourcePublishedAt: null,
    checkedAt,
    mentionedButUnparsed: windows.length === 0,
  }
}

// ---------------------------------------------------------------------------
// schema.org JSON-LD
// ---------------------------------------------------------------------------
type Json = Record<string, unknown>

export function parseJsonLd(html: string): Json[] {
  const out: Json[] = []
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim()) as unknown
      const walk = (n: unknown) => {
        if (Array.isArray(n)) n.forEach(walk)
        else if (n && typeof n === 'object') {
          const o = n as Json
          out.push(o)
          if (Array.isArray(o['@graph'])) (o['@graph'] as unknown[]).forEach(walk)
          for (const k of ['hasMenu', 'hasMenuSection', 'hasMenuItem', 'event', 'events', 'makesOffer', 'subEvent']) if (o[k]) walk(o[k])
        }
      }
      walk(data)
    } catch {
      /* malformed JSON-LD is common; ignore that block */
    }
  }
  return out
}

const types = (o: Json): string[] => ([] as unknown[]).concat(o['@type'] ?? []).map(String)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function dayFromSchema(v: unknown): number | null {
  const s = String(v).replace(/^https?:\/\/schema\.org\//, '')
  const map: Record<string, number> = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 }
  return s in map ? map[s] : null
}

function schemaTime(v: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? ''))
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null
}

/** Business opening hours from the venue's own structured data (NOT happy hour). */
export function businessHoursFromJsonLd(nodes: Json[]): ExtractedWindow[] | null {
  const venue = nodes.find((n) => types(n).some((t) => /Restaurant|BarOrPub|FoodEstablishment|Brewery|Winery|LocalBusiness|NightClub/.test(t)))
  if (!venue) return null
  const spec = ([] as unknown[]).concat(venue.openingHoursSpecification ?? []) as Json[]
  const windows: ExtractedWindow[] = []
  for (const s of spec) {
    const days = ([] as unknown[]).concat(s.dayOfWeek ?? []).map(dayFromSchema).filter((d): d is number => d !== null)
    const opens = schemaTime(s.opens)
    const closes = schemaTime(s.closes)
    if (days.length && opens && closes && opens !== closes) windows.push({ days: [...new Set(days)].sort(), start: opens, end: closes === '00:00' ? '24:00' : closes, label: null })
  }
  if (windows.length) return windows
  const oh = ([] as unknown[]).concat(venue.openingHours ?? []).map(String).join('; ')
  return parseOsmOpeningHours(oh)
}

/** Happy hour expressed as schema.org Event / Offer / Menu nodes named "Happy Hour". */
export function extractFromJsonLd(nodes: Json[], sourceUrl: string | null, checkedAt: string): HappyHourFinding | null {
  const hh = nodes.filter((n) => HH_RE.test(String(n.name ?? '')))
  if (!hh.length) return null
  const windows: ExtractedWindow[] = []
  const specials: ExtractedSpecial[] = []
  const evidence: Evidence[] = []
  let published: string | null = null

  for (const n of hh) {
    published ??= str(n.dateModified) ?? str(n.datePublished)
    const schedules = ([] as unknown[]).concat(n.eventSchedule ?? [], n.availabilityStarts ? [] : [], n.hoursAvailable ?? []) as Json[]
    for (const s of schedules) {
      const days = ([] as unknown[]).concat(s.byDay ?? s.dayOfWeek ?? []).map(dayFromSchema).filter((d): d is number => d !== null)
      const start = schemaTime(s.startTime ?? s.opens)
      const end = schemaTime(s.endTime ?? s.closes)
      if (days.length && start && end && start !== end) {
        windows.push({ days: [...new Set(days)].sort(), start, end, label: null })
        evidence.push({ field: `window:${windows.length - 1}`, quote: JSON.stringify(s) })
      }
    }
    const items = ([] as unknown[]).concat(n.hasMenuItem ?? [], ...([] as unknown[]).concat(n.hasMenuSection ?? []).map((sec) => (sec as Json).hasMenuItem ?? [])) as Json[]
    for (const it of items) {
      const title = str(it.name)
      if (!title) continue
      const offer = ([] as unknown[]).concat(it.offers ?? [])[0] as Json | undefined
      const priceVal = offer?.price ?? null
      const currency = str(offer?.priceCurrency) ?? 'USD'
      const price = priceVal === null || priceVal === undefined || priceVal === '' ? null : currency === 'USD' ? `$${priceVal}` : `${priceVal} ${currency}`
      specials.push({ kind: classifySpecial(`${title} ${str(it.description) ?? ''}`), title: title.slice(0, 80), price, description: str(it.description)?.slice(0, 200) ?? null })
      evidence.push({ field: `special:${specials.length - 1}`, quote: JSON.stringify({ name: it.name, offers: it.offers ?? null }) })
    }
  }
  if (!windows.length && !specials.length) return null
  return {
    sourceKind: 'official_website',
    method: 'json_ld',
    sourceUrl,
    windows,
    specials: specials.slice(0, 20),
    restrictions: [],
    evidence,
    sourcePublishedAt: published,
    checkedAt,
    mentionedButUnparsed: windows.length === 0,
  }
}

/** Visible "last updated" dates on the page, if stated (used for recency, never invented). */
/**
 * A date the page itself states for its content ("Updated March 3, 2026", "effective 1/5/2026").
 * Page-wide CMS stamps (article:modified_time, og:updated_time…) are deliberately ignored: SEO
 * plugins add them to every page, and a homepage nobody edited for a year still shows the current
 * happy hour — production marked well-known venues "outdated" because of them.
 */
export function findPublishedDate(_html: string, text: string): string | null {
  const m = /\b(?:updated|last updated|effective)[:\s]+([A-Z][a-z]+ \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i.exec(text)
  if (m && !Number.isNaN(Date.parse(m[1]))) return new Date(m[1]).toISOString()
  return null
}

/** Run every deterministic extractor over one page and merge the best result. */
export function extractHappyHour(html: string, sourceUrl: string, checkedAt: string): HappyHourFinding | null {
  const nodes = parseJsonLd(html)
  const text = htmlToText(html)
  const fromLd = extractFromJsonLd(nodes, sourceUrl, checkedAt)
  const fromText = extractFromText(text, sourceUrl, checkedAt)
  const published = findPublishedDate(html, text)
  const best = fromLd && fromLd.windows.length ? fromLd : fromText && (fromText.windows.length || fromText.specials.length) ? fromText : (fromLd ?? fromText)
  if (!best) return null
  // Prefer structured windows, but keep text specials when JSON-LD had none.
  if (best === fromLd && fromText && !fromLd.specials.length && fromText.specials.length) {
    const offset = best.specials.length
    best.specials = fromText.specials
    best.evidence.push(...fromText.evidence.filter((e) => e.field.startsWith('special:')).map((e) => ({ ...e, field: `special:${Number(e.field.split(':')[1]) + offset}` })))
    best.restrictions = fromText.restrictions
  }
  best.sourcePublishedAt ??= published
  return best
}
