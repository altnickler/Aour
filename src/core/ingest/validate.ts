/**
 * Strict validation of extracted findings. A finding that fails is discarded, never "fixed".
 *
 * For AI-assisted extraction, every window, price and special must be backed by a quote
 * that appears VERBATIM in the retrieved source text — this is what stops a model from
 * inventing hours or prices.
 */
import { validateWindow } from '../schedule'
import type { HappyHourFinding } from './types'

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()

export interface ValidationResult {
  ok: boolean
  errors: string[]
  finding: HappyHourFinding
}

export function validateFinding(f: HappyHourFinding, sourceText?: string): ValidationResult {
  const errors: string[] = []
  const source = sourceText ? norm(sourceText) : null
  const needsQuotes = f.method === 'llm'

  const windows = f.windows.filter((w, i) => {
    const err = validateWindow(w)
    if (err) errors.push(`window ${i}: ${err}`)
    return !err
  })
  const specials = f.specials.filter((s, i) => {
    if (!s.title || s.title.length < 3 || s.title.length > 80) {
      errors.push(`special ${i}: bad title`)
      return false
    }
    if (s.price !== null && !/(\$\s?\d|%|half|1\/2|bogo|buy one|2[\s-]for|two[\s-]for)/i.test(s.price)) {
      errors.push(`special ${i}: price "${s.price}" is not a published price`)
      return false
    }
    return true
  })

  if (source && needsQuotes) {
    for (const e of f.evidence) {
      if (!source.includes(norm(e.quote))) errors.push(`evidence for ${e.field} not found verbatim in source`)
    }
    // Each kept fact must have evidence, and its price must appear inside that evidence.
    const ev = (field: string) => f.evidence.find((e) => e.field === field && source.includes(norm(e.quote)))
    for (let i = windows.length - 1; i >= 0; i--) {
      if (!ev(`window:${f.windows.indexOf(windows[i])}`)) {
        errors.push(`window ${i}: no verifiable evidence`)
        windows.splice(i, 1)
      }
    }
    for (let i = specials.length - 1; i >= 0; i--) {
      const e = ev(`special:${f.specials.indexOf(specials[i])}`)
      const price = specials[i].price
      if (!e || (price && !norm(e.quote).includes(norm(price)))) {
        errors.push(`special ${i}: no verifiable evidence for title/price`)
        specials.splice(i, 1)
      }
    }
  }

  const finding: HappyHourFinding = { ...f, windows, specials, mentionedButUnparsed: f.mentionedButUnparsed || (!windows.length && f.windows.length > 0) }
  return { ok: errors.length === 0, errors, finding }
}

/** Stable fingerprint of the facts (for change detection and "unchanged source" skips). */
export function findingFingerprint(f: Pick<HappyHourFinding, 'windows' | 'specials' | 'restrictions'>): string {
  const w = [...f.windows].map((x) => `${[...x.days].sort().join('')}@${x.start}-${x.end}`).sort()
  const s = [...f.specials].map((x) => `${x.kind}:${norm(x.title)}:${norm(x.price ?? '')}`).sort()
  const r = [...f.restrictions].map(norm).sort()
  return JSON.stringify({ w, s, r })
}

/** Windows agree when they cover the same days with start/end within 15 minutes. */
export function schedulesAgree(a: HappyHourFinding['windows'], b: HappyHourFinding['windows']): boolean {
  if (!a.length || !b.length) return true // absence is not a conflict
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const expand = (ws: HappyHourFinding['windows']) =>
    ws.flatMap((w) => w.days.map((d) => ({ d, s: toMin(w.start), e: toMin(w.end) }))).sort((x, y) => x.d - y.d || x.s - y.s)
  const ea = expand(a)
  const eb = expand(b)
  if (new Set(ea.map((x) => x.d)).size !== new Set(eb.map((x) => x.d)).size) return false
  return ea.every((x) => eb.some((y) => y.d === x.d && Math.abs(y.s - x.s) <= 15 && Math.abs(y.e - x.e) <= 15))
}
