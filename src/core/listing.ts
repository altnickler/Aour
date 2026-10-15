/**
 * Listing freshness, geography and small display helpers shared by every screen.
 */

export type HappyHourVerification = 'verified' | 'unverified' | 'outdated' | 'none'
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

export function freshnessLabel(f: Freshness, verifiedAt: string | null, now: Date = new Date()): string {
  const days = daysSince(verifiedAt, now)
  const ago = days === null ? '' : days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? `${days} days ago` : `${Math.round(days / 30)} months ago`
  switch (f) {
    case 'fresh':
      return `Verified ${ago}`
    case 'aging':
      return `Verified ${ago} · may have changed`
    case 'stale':
      return verifiedAt ? `Last verified ${ago} · likely outdated` : 'Reported outdated'
    default:
      return 'Not yet verified'
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
