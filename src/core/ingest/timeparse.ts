/**
 * Deterministic parsing of days and times as written by humans and by OpenStreetMap.
 * Anything ambiguous returns null — callers must treat that as "unknown", never guess.
 */
import type { ExtractedWindow } from './types'

const DAY_WORDS: [RegExp, number][] = [
  [/^(su|sun|sunday|sundays)$/, 0],
  [/^(mo|mon|monday|mondays|m)$/, 1],
  [/^(tu|tue|tues|tuesday|tuesdays)$/, 2],
  [/^(we|wed|weds|wednesday|wednesdays|w)$/, 3],
  [/^(th|thu|thur|thurs|thursday|thursdays|r)$/, 4],
  [/^(fr|fri|friday|fridays|f)$/, 5],
  [/^(sa|sat|saturday|saturdays)$/, 6],
]

export function dayIndex(word: string): number | null {
  const w = word.toLowerCase().replace(/\./g, '')
  for (const [re, i] of DAY_WORDS) if (re.test(w)) return i
  return null
}

function dayRange(a: number, b: number): number[] {
  const out: number[] = []
  // Week runs Mon..Sun for human ranges like "Fri–Sun"; wrap through Saturday→Sunday.
  let d = a
  for (let i = 0; i < 7; i++) {
    out.push(d)
    if (d === b) break
    d = (d + 1) % 7
  }
  return out
}

const sortDays = (days: Iterable<number>) => [...new Set(days)].sort((x, y) => x - y)

/**
 * Parse a human day expression: "Mon-Fri", "Monday – Friday", "M-F", "Tues & Thurs",
 * "daily", "every day", "weekdays", "weekends", "7 days a week", "Sun-Thu".
 * Returns null when no day expression is recognised.
 */
export function parseDays(text: string): number[] | null {
  const t = ` ${text.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ')} `
  if (/\b(daily|every ?day|7 days|seven days|all week|mon(day)?\s*-\s*sun(day)?)\b/.test(t)) return [0, 1, 2, 3, 4, 5, 6]
  const days = new Set<number>()
  if (/\bweekdays?\b/.test(t)) [1, 2, 3, 4, 5].forEach((d) => days.add(d))
  if (/\bweekends?\b/.test(t)) [0, 6].forEach((d) => days.add(d))
  // Ranges: "mon - fri", "monday through friday", "m-f"
  const word = '(sun(?:day)?s?|mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:s|nesday)?s?|thu(?:r(?:s(?:day)?)?)?s?|fri(?:day)?s?|sat(?:urday)?s?|m|f)'
  const rangeRe = new RegExp(`\\b${word}\\.?\\s*(?:-|to|through|thru)\\s*${word}\\.?\\b`, 'g')
  let consumed = t
  for (const m of t.matchAll(rangeRe)) {
    const a = dayIndex(m[1])
    const b = dayIndex(m[2])
    // single-letter abbreviations only in the "m-f" form
    if (a === null || b === null) continue
    if ((m[1].length === 1 || m[2].length === 1) && !(m[1] === 'm' && m[2] === 'f')) continue
    dayRange(a, b).forEach((d) => days.add(d))
    consumed = consumed.replace(m[0], ' ')
  }
  const listRe = /\b(sun(?:day)?s?|mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:s|nesday)?s?|thu(?:r(?:s(?:day)?)?)?s?|fri(?:day)?s?|sat(?:urday)?s?)\b/g
  for (const m of consumed.matchAll(listRe)) {
    const d = dayIndex(m[1])
    if (d !== null) days.add(d)
  }
  return days.size ? sortDays(days) : null
}

function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

interface RawTime {
  h: number
  m: number
  suffix: 'am' | 'pm' | null
  special?: 'noon' | 'midnight'
}

function parseTimeToken(tok: string): RawTime | null {
  const t = tok.trim().toLowerCase().replace(/\./g, '')
  if (t === 'noon') return { h: 12, m: 0, suffix: 'pm', special: 'noon' }
  if (t === 'midnight') return { h: 12, m: 0, suffix: 'am', special: 'midnight' }
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(t)
  if (!m) return null
  const h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  if (h > 24 || min > 59) return null
  const suffix = m[3] ? (m[3].startsWith('a') ? 'am' : 'pm') : null
  return { h, m: min, suffix }
}

function toMinutes(t: RawTime, suffix: 'am' | 'pm' | null): number | null {
  // 24-hour clock ("15:00", "00:30"): an explicit am/pm on such a token is nonsense ("15pm").
  if (t.h > 12 || t.h === 0) return t.suffix ? null : t.h * 60 + t.m
  const s = t.suffix ?? suffix
  if (!s) return null
  const h = t.h % 12 + (s === 'pm' ? 12 : 0)
  return h * 60 + t.m
}

const TIME = String.raw`(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|a|p)?)`
const SEP = String.raw`\s*(?:-|–|—|to|until|til|till)\s*`
export const TIME_RANGE_RE = new RegExp(String.raw`(?<![\d$])(${TIME})${SEP}(${TIME}|close|closing)(?![\d%])`, 'gi')

/**
 * Parse "3pm-6pm", "3-6pm", "3:00 PM to 6:00 PM", "15:00-18:00", "4 - 7" (assumed pm in a
 * happy-hour context), "11am-2pm". Returns null for "9pm-close" (end unknown) or nonsense.
 */
export function parseTimeRange(start: string, end: string, assumePm = true): { start: string; end: string } | null {
  if (/^clos/i.test(end.trim())) return null
  const a = parseTimeToken(start)
  const b = parseTimeToken(end)
  if (!a || !b) return null
  let endMin = toMinutes(b, null)
  let startMin: number | null
  if (endMin === null) {
    // Neither clock is explicit: in happy-hour text "4-7" means 4pm-7pm.
    if (a.suffix || !assumePm) return null
    endMin = toMinutes(b, 'pm')
    startMin = toMinutes(a, 'pm')
  } else {
    // Start inherits the end's suffix unless that makes it later than the end ("11-2pm" → 11am).
    startMin = toMinutes(a, b.suffix ?? (b.h > 12 ? 'pm' : null))
    if (startMin === null) startMin = toMinutes(a, 'pm')
    if (startMin !== null && !a.suffix && b.suffix === 'pm' && startMin > endMin && a.h <= 12) {
      startMin = toMinutes(a, 'am')
    }
  }
  if (startMin === null || endMin === null || startMin === endMin) return null
  const len = endMin > startMin ? endMin - startMin : endMin + 1440 - startMin
  if (len > 12 * 60) return null
  return { start: hhmm(startMin), end: hhmm(endMin) }
}

// ---------------------------------------------------------------------------
// OpenStreetMap opening_hours (subset). Used for business hours and the `happy_hours` tag.
// Supports: "Mo-Fr 16:00-19:00; Sa,Su 15:00-18:00", "Mo-Su 16:00-18:00,21:00-23:00",
// "PH off", "24/7". Anything else (months, weeks, sunrise, comments) → null.
// ---------------------------------------------------------------------------
const OSM_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

export function parseOsmOpeningHours(value: string | null | undefined): ExtractedWindow[] | null {
  if (!value) return null
  const v = value.trim()
  if (v === '24/7') return [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00', label: null }]
  const windows: ExtractedWindow[] = []
  for (const raw of v.split(';')) {
    const rule = raw.trim()
    if (!rule) continue
    if (/^PH\b/.test(rule) || /^SH\b/.test(rule)) continue // holidays: handled as exceptions manually
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(.*)$/.exec(rule)
    if (!m) return null
    const daySpec = m[1]
    const timeSpec = m[2].trim()
    if (/^off$|^closed$/i.test(timeSpec)) continue
    let days: number[] = [0, 1, 2, 3, 4, 5, 6]
    if (daySpec) {
      days = []
      for (const part of daySpec.split(',')) {
        const [a, b] = part.split('-').map((d) => OSM_DAYS.indexOf(d))
        if (b === undefined) days.push(a)
        else days.push(...dayRange(a, b))
      }
    }
    if (!timeSpec) return null
    for (const range of timeSpec.split(',')) {
      const tm = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})\+?$/.exec(range.trim())
      if (!tm) return null
      const s = Number(tm[1]) * 60 + Number(tm[2])
      const e = Number(tm[3]) * 60 + Number(tm[4])
      if (s >= 1440 || e > 1440 || s === e) return null
      windows.push({ days: sortDays(days), start: hhmm(s), end: e === 1440 ? '24:00' : hhmm(e), label: null })
    }
  }
  return windows.length ? windows : null
}
