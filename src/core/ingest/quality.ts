/**
 * Plausibility checks for automatically read happy-hour facts.
 *
 * Production audit (2026-10-20) found the text reader turning opening hours, lunch, delivery and
 * band times into "happy hours", and gift cards, $29–$45 dinners and FAQ questions into
 * "specials". Lines that are clearly not happy hour are skipped while reading (extract.ts). What
 * remains but still looks unusual is not shown as confirmed: the listing reads "Needs
 * verification" and an admin gets the finding to review, with these reasons.
 *
 * These checks use only the stored facts, so they give the same answer on every re-check.
 */
import { DAY_SHORT, parseHHMM } from '../schedule'
import type { ExtractedSpecial, ExtractedWindow, HappyHourFinding } from './types'

/** Longest plausible single happy-hour window, in minutes. */
export const MAX_WINDOW_MINUTES = 6 * 60
/** Earliest plausible start (11:00). */
export const EARLIEST_START = 11 * 60
/** Specials above this are menu items, dinners, events or gift cards, not happy-hour deals. */
export const MAX_SPECIAL_PRICE = 20

const span = (w: Pick<ExtractedWindow, 'start' | 'end'>) => {
  const s = parseHHMM(w.start)
  let e = parseHHMM(w.end)
  if (e <= s) e += 24 * 60 // runs past midnight
  return { s, e }
}
const clock = (m: number) => {
  const h = Math.floor(m / 60) % 24
  const mm = m % 60
  const h12 = h % 12 || 12
  return `${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`
}

/** Why a set of windows/specials should be checked by a person before it is shown as confirmed. */
export function questionableReasons(f: Pick<HappyHourFinding, 'windows' | 'specials'>): string[] {
  const reasons = new Set<string>()
  for (const w of f.windows) {
    const { s, e } = span(w)
    if (e - s > MAX_WINDOW_MINUTES) reasons.add(`${clock(s)}–${clock(e)} is longer than a typical happy hour (over 6 hours; often opening hours)`)
    if (s < EARLIEST_START) reasons.add(`${clock(s)} start is earlier than a typical happy hour (often lunch or opening hours)`)
  }
  for (let day = 0; day < 7; day++) {
    const today = f.windows.filter((w) => w.days.includes(day)).map(span).sort((a, b) => a.s - b.s)
    if (today.length > 2) reasons.add(`${today.length} different times on ${DAY_SHORT[day]}`)
    for (let i = 1; i < today.length; i++) {
      if (today[i].s < today[i - 1].e) reasons.add(`overlapping times on ${DAY_SHORT[day]} (${clock(today[i - 1].s)}–${clock(today[i - 1].e)} and ${clock(today[i].s)}–${clock(today[i].e)})`)
    }
  }
  return [...reasons]
}

/** A dollar price above the happy-hour range ("$29", "$45.00"); percentages and "half off" pass. */
export function priceTooHigh(price: string | null): boolean {
  if (!price || /%|half|1\/2|bogo|buy one|for|off/i.test(price)) return false
  const m = /\$\s?(\d{1,4}(?:\.\d{2})?)/.exec(price)
  return !!m && Number(m[1]) > MAX_SPECIAL_PRICE
}

/** Text that describes something other than a happy-hour deal. */
const NOT_A_SPECIAL = /gift\s*(card|certificate)|per person|\bpp\b|up to \$|\?|\b(lunch|brunch|breakfast|dinner|entr[eé]es?|catering|private (event|party|dining)|party|reservations?|tickets?|upgrade|delivery|shipping)\b|^\s*price\s*$/i

export function notASpecial(s: Pick<ExtractedSpecial, 'title' | 'price'>, quote = ''): boolean {
  return NOT_A_SPECIAL.test(s.title) || NOT_A_SPECIAL.test(quote) || priceTooHigh(s.price)
}
