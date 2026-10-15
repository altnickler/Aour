/**
 * Happy-hour schedule logic. All times are wall-clock times in the establishment's
 * IANA time zone ("America/New_York"), so "happening now" is correct regardless of
 * where the viewer's device is.
 *
 * A window whose end <= start crosses midnight (e.g. 21:00 → 00:00 or 22:00 → 01:00);
 * its `days` refer to the day it starts.
 */

export interface HappyHourWindow {
  id: string
  /** 0 = Sunday … 6 = Saturday */
  days: number[]
  /** "HH:MM" 24h */
  start: string
  end: string
  label?: string | null
  notes?: string | null
}

export interface ScheduleException {
  id: string
  /** YYYY-MM-DD in the establishment's zone */
  date: string
  /** true = no happy hour that day */
  closed: boolean
  start?: string | null
  end?: string | null
  note?: string | null
}

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
export const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

export function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!m) throw new RangeError(`Invalid time "${value}"`)
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new RangeError(`Invalid time "${value}"`)
  return h * 60 + min
}

/** Duration in minutes; windows crossing midnight wrap. */
export function windowLength(w: Pick<HappyHourWindow, 'start' | 'end'>): number {
  const s = parseHHMM(w.start)
  const e = parseHHMM(w.end)
  return e > s ? e - s : e + 1440 - s
}

export interface ZonedNow {
  /** 0–6 */
  day: number
  /** minutes since local midnight */
  minutes: number
  /** YYYY-MM-DD */
  date: string
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    fmtCache.set(timeZone, f)
  }
  return f
}

export function zonedNow(timeZone: string, at: Date = new Date()): ZonedNow {
  const parts = Object.fromEntries(zoneFormatter(timeZone).formatToParts(at).map((p) => [p.type, p.value]))
  const day = DAY_SHORT.indexOf(parts.weekday as (typeof DAY_SHORT)[number])
  return {
    day,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  }
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

interface Occurrence {
  window: HappyHourWindow
  /** absolute minutes relative to local midnight of `now.date` (may be negative or > 1440) */
  startAbs: number
  endAbs: number
}

/** Concrete occurrences for the local day at `offset` days from today, honouring exceptions. */
function occurrencesForDay(
  windows: readonly HappyHourWindow[],
  exceptions: readonly ScheduleException[],
  now: ZonedNow,
  offset: number,
): Occurrence[] {
  const date = addDays(now.date, offset)
  const day = (((now.day + offset) % 7) + 7) % 7
  const base = offset * 1440
  const ex = exceptions.find((e) => e.date === date)
  if (ex?.closed) return []
  if (ex && ex.start && ex.end) {
    const s = parseHHMM(ex.start)
    const len = windowLength({ start: ex.start, end: ex.end })
    return [{ window: { id: `ex-${ex.id}`, days: [day], start: ex.start, end: ex.end, label: ex.note ?? 'Special hours' }, startAbs: base + s, endAbs: base + s + len }]
  }
  return windows
    .filter((w) => w.days.includes(day))
    .map((w) => {
      const s = parseHHMM(w.start)
      return { window: w, startAbs: base + s, endAbs: base + s + windowLength(w) }
    })
    .sort((a, b) => a.startAbs - b.startAbs)
}

export type HappyHourState = 'now' | 'later_today' | 'upcoming' | 'none'

export interface HappyHourStatus {
  state: HappyHourState
  window: HappyHourWindow | null
  /** Minutes until the active window ends (state "now"). */
  endsInMinutes?: number
  /** Minutes until the next window starts (states "later_today" / "upcoming"). */
  startsInMinutes?: number
  /** Day of week the next window starts (state "upcoming"). */
  nextDay?: number
}

/** Status of a schedule at a moment in time. Looks back one day (overnight) and ahead seven. */
export function happyHourStatus(
  windows: readonly HappyHourWindow[],
  exceptions: readonly ScheduleException[],
  timeZone: string,
  at: Date = new Date(),
): HappyHourStatus {
  if (windows.length === 0 && exceptions.every((e) => !e.start)) return { state: 'none', window: null }
  const now = zonedNow(timeZone, at)
  const t = now.minutes

  for (const offset of [-1, 0]) {
    for (const o of occurrencesForDay(windows, exceptions, now, offset)) {
      if (o.startAbs <= t && t < o.endAbs) return { state: 'now', window: o.window, endsInMinutes: o.endAbs - t }
    }
  }
  for (let offset = 0; offset <= 7; offset++) {
    const next = occurrencesForDay(windows, exceptions, now, offset).find((o) => o.startAbs > t)
    if (next) {
      return {
        state: offset === 0 ? 'later_today' : 'upcoming',
        window: next.window,
        startsInMinutes: next.startAbs - t,
        nextDay: (now.day + offset) % 7,
      }
    }
  }
  return { state: 'none', window: null }
}

/** Whether any window starts on the given weekday (ignores exceptions). */
export function runsOnDay(windows: readonly HappyHourWindow[], day: number): boolean {
  return windows.some((w) => w.days.includes(day))
}

/** Whether happy hour overlaps a given wall-clock time on a weekday, e.g. "Fri at 5pm". */
export function runsAt(windows: readonly HappyHourWindow[], day: number, minutes: number): boolean {
  return windows.some((w) => {
    const s = parseHHMM(w.start)
    const len = windowLength(w)
    if (w.days.includes(day) && minutes >= s && minutes < s + len) return true
    const prev = (day + 6) % 7
    return w.days.includes(prev) && s + len > 1440 && minutes < s + len - 1440
  })
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTime(hhmm: string): string {
  const total = parseHHMM(hhmm) % 1440
  const h = Math.floor(total / 60)
  const m = total % 60
  if (total === 0) return 'midnight'
  if (total === 720) return 'noon'
  const suffix = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`
}

export function formatRange(start: string, end: string): string {
  const a = formatTime(start)
  const b = formatTime(end)
  // "4–7pm" when both share a suffix
  const sa = a.slice(-2)
  if ((sa === 'am' || sa === 'pm') && b.endsWith(sa) && !['noon', 'midnight'].includes(a)) return `${a.slice(0, -2)}–${b}`
  return `${a}–${b}`
}

/** "Mon–Fri", "Mon, Wed, Fri", "Daily", "Weekends". */
export function formatDays(days: readonly number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b)
  if (set.length === 7) return 'Daily'
  if (set.length === 2 && set[0] === 0 && set[1] === 6) return 'Weekends'
  // Treat Monday as the start of the week for readable runs.
  const order = set.map((d) => (d + 6) % 7).sort((a, b) => a - b)
  const runs: number[][] = []
  for (const d of order) {
    const last = runs.at(-1)
    if (last && d === last[last.length - 1] + 1) last.push(d)
    else runs.push([d])
  }
  const name = (mondayIdx: number) => DAY_SHORT[(mondayIdx + 1) % 7]
  return runs
    .map((r) => (r.length >= 3 ? `${name(r[0])}–${name(r[r.length - 1])}` : r.map(name).join(', ')))
    .join(', ')
}

export function formatWindow(w: Pick<HappyHourWindow, 'days' | 'start' | 'end'>): string {
  return `${formatDays(w.days)} · ${formatRange(w.start, w.end)}`
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`
}

export function statusLabel(s: HappyHourStatus): string {
  switch (s.state) {
    case 'now':
      return s.endsInMinutes! <= 60 ? `Ends in ${formatDuration(s.endsInMinutes!)}` : `Until ${formatTime(s.window!.end)}`
    case 'later_today':
      return s.startsInMinutes! <= 60 ? `Starts in ${formatDuration(s.startsInMinutes!)}` : `Today ${formatTime(s.window!.start)}`
    case 'upcoming':
      return `${DAY_SHORT[s.nextDay!]} ${formatTime(s.window!.start)}`
    default:
      return 'No happy hour listed'
  }
}

export function validateWindow(w: Pick<HappyHourWindow, 'days' | 'start' | 'end'>): string | null {
  if (!w.days.length) return 'Pick at least one day'
  if (w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Invalid day'
  try {
    parseHHMM(w.start)
    parseHHMM(w.end)
  } catch {
    return 'Times must look like 16:00'
  }
  if (w.start === w.end) return 'Start and end cannot be the same'
  if (windowLength(w) > 12 * 60) return 'A happy hour longer than 12 hours looks like a typo'
  return null
}
