/**
 * Listing freshness, geography and small display helpers shared by every screen.
 */

/**
 * Public verification states for happy-hour details (same set as hh_status in the database):
 *  verified               confirmed by an Aour admin against a recorded source
 *  establishment_reported published by the venue itself (its website, or the owner)
 *  community_reported     users or open data (OpenStreetMap), not independently confirmed
 *  unverified             "Needs verification": low confidence, conflicting, or unchecked
 *  outdated               too old, or reported as changed
 *  none                   no happy-hour information available
 */
export type HappyHourVerification = 'verified' | 'establishment_reported' | 'community_reported' | 'unverified' | 'outdated' | 'none'
export type Freshness = 'fresh' | 'aging' | 'stale' | 'unverified'

export const FRESH_DAYS = 90
export const STALE_DAYS = 180

const DAY_MS = 86_400_000

export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS))
}

/**
 * How much to trust the listed happy-hour details.
 * Only "verified" listings with a verification date can be fresh; an admin can
 * mark details outdated explicitly (e.g. after user reports).
 */
export function freshness(status: HappyHourVerification, verifiedAt: string | null, now: Date = new Date()): Freshness {
  if (status !== 'verified') return status === 'outdated' ? 'stale' : 'unverified'
  const days = daysSince(verifiedAt, now)
  if (days === null) return 'unverified'
  if (days <= FRESH_DAYS) return 'fresh'
  if (days <= STALE_DAYS) return 'aging'
  return 'stale'
}

function ago(days: number | null): string {
  if (days === null) return ''
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? `${days} days ago` : `${Math.round(days / 30)} months ago`
}

export function freshnessLabel(f: Freshness, verifiedAt: string | null, now: Date = new Date()): string {
  const when = ago(daysSince(verifiedAt, now))
  switch (f) {
    case 'fresh':
      return `Verified ${when}`
    case 'aging':
      return `Verified ${when} · may have changed`
    case 'stale':
      return verifiedAt ? `Last verified ${when} · likely outdated` : 'Reported outdated'
    default:
      return 'Not yet verified'
  }
}

export interface VerificationInfo {
  label: string
  tone: 'success' | 'warn' | 'danger' | 'neutral' | 'info'
  /** Longer explanation for the place page. */
  detail: string
}

/** What a user should be told about where the happy-hour details came from and how current they are. */
export function verificationInfo(
  e: { hhStatus: HappyHourVerification; hhVerifiedAt: string | null; hhCheckedAt?: string | null },
  now: Date = new Date(),
): VerificationInfo {
  const checked = daysSince(e.hhCheckedAt ?? null, now)
  const checkedText = checked === null ? '' : ` Last checked ${ago(checked)}.`
  switch (e.hhStatus) {
    case 'verified': {
      const f = freshness('verified', e.hhVerifiedAt, now)
      return {
        label: freshnessLabel(f, e.hhVerifiedAt, now),
        tone: f === 'fresh' ? 'success' : f === 'aging' ? 'warn' : 'danger',
        detail: 'Confirmed by the Aour team against a recorded source.' + (f !== 'fresh' ? ' It has been a while, so details may have changed.' : ''),
      }
    }
    case 'establishment_reported':
      return { label: 'Reported by venue', tone: 'info', detail: `Published by the venue itself (for example on its website). Not yet confirmed by Aour.${checkedText}` }
    case 'community_reported':
      return { label: 'Community reported', tone: 'neutral', detail: `Shared by the community or open map data. Not yet confirmed by the venue or Aour.${checkedText}` }
    case 'outdated':
      return { label: 'Outdated', tone: 'danger', detail: 'These details may no longer be accurate. Check with the venue before you go.' }
    case 'none':
      return { label: 'No happy-hour info', tone: 'neutral', detail: 'We have not found happy-hour information for this place yet.' }
    default:
      return { label: 'Needs verification', tone: 'warn', detail: `We found these details but have not been able to confirm them yet.${checkedText}` }
  }
}

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number
  lng: number
}

const EARTH_RADIUS_MI = 3958.8

export function distanceMiles(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function formatMiles(mi: number): string {
  if (mi < 0.1) return 'Nearby'
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`
}

/**
 * Coarsen a device location before it is used anywhere beyond the current screen.
 * ~1.1 km precision; exact device location is never stored or sent to the server.
 */
export function coarsen(p: LatLng): LatLng {
  return { lat: Math.round(p.lat * 100) / 100, lng: Math.round(p.lng * 100) / 100 }
}

export function appleMapsUrl(name: string, address: string, p: LatLng): string {
  const q = encodeURIComponent(`${name}, ${address}`)
  return `https://maps.apple.com/?q=${q}&ll=${p.lat},${p.lng}`
}

export function priceLabel(level: number | null | undefined): string {
  return level ? '$'.repeat(level) : ''
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export const USERNAME_RE = /^[a-z0-9_]{3,24}$/

export function validateUsername(u: string): string | null {
  if (!USERNAME_RE.test(u)) return 'Use 3–24 lowercase letters, numbers or underscores'
  if (RESERVED_USERNAMES.has(u)) return 'That username is reserved'
  return null
}

const RESERVED_USERNAMES = new Set(['admin', 'aour', 'support', 'help', 'settings', 'about', 'api', 'root', 'staff', 'moderator'])

export const ESTABLISHMENT_KINDS = [
  { key: 'bar', label: 'Bar' },
  { key: 'restaurant', label: 'Restaurant' },
  { key: 'cocktail_lounge', label: 'Cocktail lounge' },
  { key: 'wine_bar', label: 'Wine bar' },
  { key: 'brewery', label: 'Brewery' },
  { key: 'tiki_bar', label: 'Tiki bar' },
  { key: 'raw_bar', label: 'Raw bar' },
  { key: 'sports_bar', label: 'Sports bar' },
  { key: 'other', label: 'Other' },
] as const

export type EstablishmentKind = (typeof ESTABLISHMENT_KINDS)[number]['key']

export const KIND_LABEL: Record<string, string> = Object.fromEntries(ESTABLISHMENT_KINDS.map((k) => [k.key, k.label]))
export const KIND_EMOJI: Record<string, string> = {
  bar: '🍺',
  restaurant: '🍽️',
  cocktail_lounge: '🍸',
  wine_bar: '🍷',
  brewery: '🍻',
  tiki_bar: '🌺',
  raw_bar: '🦪',
  sports_bar: '🏈',
  other: '✨',
}
