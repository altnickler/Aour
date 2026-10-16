/**
 * Place-data provider mappings (pure). The Worker does the HTTP; these functions turn each
 * provider's records into CandidatePlace, so providers can be swapped without touching
 * the rest of the pipeline.
 *
 * Licensing summary (see DATA_SOURCES.md — legal review recommended before launch):
 *   overture   Places theme: CDLA-Permissive-2.0 / Apache-2.0 / CC0 per source. No OSM data,
 *              no share-alike. Storage allowed. DEFAULT venue source (monthly bulk via DuckDB).
 *   osm        ODbL 1.0. Storage allowed with "© OpenStreetMap contributors". Merging OSM venues
 *              with other venue data creates a Derivative Database that must be offered under
 *              ODbL if used publicly → OFF by default (opt-in, see DATA_SOURCES.md).
 *   foursquare Places API (pay-as-you-go): ONLY fsq_place_id may be stored; no other fields may
 *              be cached server-side. The pipeline enforces `storage: 'id_only'`.
 */
import type { EstablishmentKind } from '../listing'
import type { CandidatePlace, ProviderId } from './types'

export interface BBox {
  south: number
  west: number
  north: number
  east: number
}

export function bboxAround(lat: number, lng: number, radiusMiles: number): BBox {
  const dLat = radiusMiles / 69
  const dLng = radiusMiles / (69 * Math.cos((lat * Math.PI) / 180))
  return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng }
}

export const ATTRIBUTION: Record<ProviderId, { text: string; license: string; storage: 'full' | 'id_only' }> = {
  osm: { text: '© OpenStreetMap contributors', license: 'ODbL-1.0', storage: 'full' },
  overture: { text: 'Overture Maps Foundation', license: 'CDLA-Permissive-2.0', storage: 'full' },
  foursquare: { text: 'Powered by Foursquare', license: 'Foursquare Places API terms', storage: 'id_only' },
  fsq_os: { text: 'Foursquare Open Source Places', license: 'Apache-2.0', storage: 'full' },
}

/** Whether venue attributes from this provider may be persisted (else: link ids only). */
export function storageAllowed(provider: ProviderId): boolean {
  return ATTRIBUTION[provider].storage === 'full'
}

// ---------------------------------------------------------------------------
// Category → kind. Only venues that plausibly run a happy hour are kept.
// ---------------------------------------------------------------------------
/**
 * Overture classification from the two fields Overture itself curates — basic_category (coarse)
 * and the primary category (most specific) — matched by EXACT name. Alternate categories are
 * noisy (an insurance agency can list "pub"), so they never qualify a place on their own.
 * Category names come from the live release (Stuart box, 2026-10; see scripts/maintenance.ts).
 */
const OVERTURE_BAR_KIND: Record<string, EstablishmentKind> = {
  bar: 'bar', pub: 'bar', irish_pub: 'bar', dive_bar: 'bar', beach_bar: 'bar', tavern: 'bar', saloon: 'bar', night_club: 'bar',
  nightclub: 'bar', dance_club: 'bar', karaoke: 'bar', piano_bar: 'bar', gay_bar: 'bar', bar_and_grill_restaurant: 'bar',
  gastropub: 'bar', izakaya: 'bar', sake_bar: 'bar',
  sports_bar: 'sports_bar',
  cocktail_bar: 'cocktail_lounge', lounge: 'cocktail_lounge', hotel_bar: 'cocktail_lounge', speakeasy: 'cocktail_lounge', rooftop_bar: 'cocktail_lounge',
  wine_bar: 'wine_bar', winery: 'wine_bar', wine_tasting_room: 'wine_bar',
  brewery: 'brewery', brewpub: 'brewery', beer_bar: 'brewery', beer_garden: 'brewery', taproom: 'brewery', distillery: 'brewery',
  tiki_bar: 'tiki_bar',
  oyster_bar: 'raw_bar', raw_bar: 'raw_bar',
}
/** Restaurant styles where a happy hour is plausible are kept; quick-service formats are not. */
const OVERTURE_NOT_RESTAURANT = new Set([
  'fast_food_restaurant', 'breakfast_and_brunch_restaurant', 'chicken_restaurant', 'food_court', 'cafeteria', 'hot_dog_restaurant',
  'donut_shop', 'bagel_shop', 'sandwich_shop', 'ice_cream_shop', 'dessert_shop', 'bakery', 'delicatessen', 'smoothie_juice_bar',
  'juice_bar', 'coffee_shop', 'cafe', 'tea_room', 'bubble_tea', 'food_truck_stand', 'acai_bowls', 'frozen_yogurt_shop',
])
const OVERTURE_RESTAURANT_EXACT = new Set(['restaurant', 'steakhouse', 'bistro', 'brasserie', 'tapas_bar', 'seafood_market_restaurant'])

/**
 * National quick-service / delivery chains that Overture files as ordinary restaurants but that
 * do not run bar-style happy hours. Matched on the normalised start of the name.
 */
const QUICK_SERVICE_CHAINS = [
  'burger king', 'mcdonald', 'wendy', 'taco bell', 'kfc', 'kentucky fried', 'subway', 'little caesar', 'papa john', 'domino',
  'pizza hut', 'hungry howie', 'marco\'s pizza', 'papa murphy', 'jersey mike', 'firehouse subs', 'jimmy john', 'chick-fil-a',
  'popeyes', 'zaxby', 'arby', 'sonic drive', 'dairy queen', 'chipotle', 'moe\'s southwest', 'bubbakoo', 'qdoba', 'five guys',
  'wingstop', 'panera', 'dunkin', 'starbucks', 'checkers', 'rally\'s', 'culver', 'panda express', 'tropical smoothie',
  'smoothie king', 'krispy kreme', 'ihop', 'waffle house', 'denny', 'cracker barrel', 'bojangles', 'jack in the box',
  'steak n shake', 'hardee', 'del taco', 'wawa', '7-eleven', 'golden corral', 'pdq', 'pollo tropical', 'boston market',
  'jet\'s pizza', 'cicis', 'sbarro', 'blaze pizza', 'mod pizza', 'jason\'s deli', 'potbelly', 'which wich', 'tijuana flats',
]

export function isQuickServiceChain(name: string): boolean {
  const n = name.toLowerCase().replace(/[\u2019]/g, "'").replace(/\s+/g, ' ').trim()
  return QUICK_SERVICE_CHAINS.some((c) => n === c || n.startsWith(`${c} `) || n.startsWith(`${c}'`) || n.startsWith(`${c}s`) || n.startsWith(c))
}

export function kindFromOverture(basic: string | null | undefined, primary: string | null | undefined, alternates: string[] = []): EstablishmentKind | null {
  const b = (basic ?? '').toLowerCase()
  const p = (primary ?? '').toLowerCase()
  if (OVERTURE_NOT_RESTAURANT.has(p) || OVERTURE_NOT_RESTAURANT.has(b)) return null
  if (OVERTURE_BAR_KIND[p]) return OVERTURE_BAR_KIND[p]
  if (b === 'bar' || b === 'pub' || b === 'lounge' || b === 'night_club') return OVERTURE_BAR_KIND[b] ?? 'bar'
  if (['brewery', 'winery', 'distillery'].includes(b)) return OVERTURE_BAR_KIND[b]
  // Live-music venues qualify only when Overture also lists them as a bar or pub.
  if (p === 'music_venue' && alternates.some((a) => a === 'bar' || a === 'pub')) return 'bar'
  if (b === 'restaurant' && p !== 'fast_food_restaurant') return 'restaurant'
  if (OVERTURE_RESTAURANT_EXACT.has(p) || (p.endsWith('_restaurant') && !OVERTURE_NOT_RESTAURANT.has(p))) return 'restaurant'
  return null
}

export function kindFromCategories(cats: string[]): EstablishmentKind | null {
  // Root nodes like Overture's "food_and_drink" say nothing about the venue type.
  const c = cats.filter((x) => !/^(food_and_drink|eat_and_drink)$/i.test(x)).join(' ').toLowerCase()
  if (/fast[_ ]food|coffee|cafe(?!.*bar)|bakery|ice[_ ]cream|juice|donut|food[_ ]truck|convenience|liquor[_ ]store|grocery|gas[_ ]station|caterer/.test(c) && !/\bbar\b|pub|brew|wine/.test(c)) return null
  if (/tiki/.test(c)) return 'tiki_bar'
  if (/brew|taproom|beer[_ ]garden|biergarten|beer[_ ]bar|microbrewery/.test(c)) return 'brewery'
  if (/winery|wine[_ ]bar|wine/.test(c)) return 'wine_bar'
  if (/cocktail|lounge|speakeasy|hotel[_ ]bar/.test(c)) return 'cocktail_lounge'
  if (/sports[_ ]bar/.test(c)) return 'sports_bar'
  if (/oyster|raw[_ ]bar|seafood/.test(c) && /bar/.test(c)) return 'raw_bar'
  if (/\bbar\b|\bbars?\b|pub|tavern|nightclub|night[_ ]club|saloon|dive|izakaya|beach[_ ]bar/.test(c)) return 'bar'
  if (/restaurant|grill|bistro|steakhouse|seafood|sushi|mexican|italian|american|gastropub|tapas|diner|eatery/.test(c)) return 'restaurant'
  return null
}

const clean = (s: unknown): string | null => (typeof s === 'string' && s.trim() ? s.trim() : null)

function normalizeWebsite(u: string | null): string | null {
  if (!u) return null
  const v = u.trim()
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`
  try {
    const url = new URL(withScheme)
    return /^https?:$/.test(url.protocol) ? url.toString().replace(/\/$/, '') : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// OpenStreetMap via Overpass
// ---------------------------------------------------------------------------
export function overpassQuery(b: BBox, timeoutSec = 60): string {
  const box = `${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}`
  return `[out:json][timeout:${timeoutSec}];
(
  nwr["amenity"~"^(bar|pub|restaurant|biergarten|nightclub)$"](${box});
  nwr["craft"~"^(brewery|winery|distillery)$"](${box});
  nwr["microbrewery"="yes"](${box});
);
out center tags;`
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

export function osmToCandidate(el: OsmElement): CandidatePlace | null {
  const t = el.tags ?? {}
  const name = clean(t.name)
  const lat = el.lat ?? el.center?.lat
  const lng = el.lon ?? el.center?.lon
  if (!name || lat === undefined || lng === undefined) return null
  const cats = [t.amenity, t.craft, t.cuisine, t.bar, t.microbrewery === 'yes' ? 'microbrewery' : null, t.drink === 'wine' ? 'wine' : null].filter(Boolean) as string[]
  const kind = kindFromCategories(cats) ?? (t.amenity === 'restaurant' ? 'restaurant' : null)
  if (!kind) return null
  const amenities: string[] = []
  if (t.outdoor_seating === 'yes') amenities.push('outdoor_seating')
  if (t.wheelchair === 'yes') amenities.push('wheelchair_accessible')
  if (t['live_music'] === 'yes') amenities.push('live_music')
  if (t.dog === 'yes') amenities.push('dog_friendly')
  if (/^(no|wine|beer)/.test(t['drink:spirits'] ?? '') || t.alcohol === 'beer_wine') amenities.push('beer_wine_only')
  const street = [clean(t['addr:housenumber']), clean(t['addr:street'])].filter(Boolean).join(' ')
  return {
    provider: 'osm',
    externalId: `${el.type}/${el.id}`,
    name,
    kind,
    categories: cats,
    lat,
    lng,
    address: street || null,
    city: clean(t['addr:city']),
    state: clean(t['addr:state']),
    postalCode: clean(t['addr:postcode']),
    phone: clean(t.phone ?? t['contact:phone']),
    website: normalizeWebsite(clean(t.website ?? t['contact:website'] ?? t.url)),
    openingHoursRaw: clean(t.opening_hours),
    happyHoursRaw: clean(t.happy_hours),
    amenities,
    attribution: ATTRIBUTION.osm.text,
    license: ATTRIBUTION.osm.license,
    closed: !!t['disused:amenity'] || t.opening_hours === 'closed' || !!t['end_date'],
  }
}

// ---------------------------------------------------------------------------
// Overture Maps — Places theme (rows from the GeoParquet release, via DuckDB)
// ---------------------------------------------------------------------------
/**
 * One row as selected by scripts/discovery (schema v2.0.0): names.primary, basic_category,
 * taxonomy.hierarchy + taxonomy.alternates, addresses[1], websites[1], phones[1].
 */
export interface OvertureRow {
  id: string
  name: string | null
  basic_category?: string | null
  /** Most specific category (taxonomy.primary or categories.primary). */
  primary_category?: string | null
  /** taxonomy.hierarchy ++ taxonomy.alternates */
  categories?: string[] | null
  lat: number
  lng: number
  freeform?: string | null
  locality?: string | null
  region?: string | null
  postcode?: string | null
  website?: string | null
  phone?: string | null
  confidence?: number | null
  operating_status?: string | null
}

export function overtureToCandidate(r: OvertureRow, minConfidence = 0.6): CandidatePlace | null {
  const name = clean(r.name)
  if (!name || (r.confidence ?? 1) < minConfidence) return null
  const cats = [r.basic_category ?? '', ...(r.categories ?? [])].filter(Boolean)
  const primary = r.primary_category ?? r.categories?.at(-1) ?? null
  const kind = kindFromOverture(r.basic_category, primary, r.categories ?? [])
  if (!kind || isQuickServiceChain(name)) return null
  return {
    provider: 'overture',
    externalId: r.id,
    name,
    kind,
    categories: cats,
    lat: r.lat,
    lng: r.lng,
    address: clean(r.freeform),
    city: clean(r.locality),
    state: clean(r.region)?.replace(/^US-/, '') ?? null,
    postalCode: clean(r.postcode),
    phone: clean(r.phone),
    website: normalizeWebsite(clean(r.website)),
    openingHoursRaw: null,
    happyHoursRaw: null,
    amenities: [],
    attribution: ATTRIBUTION.overture.text,
    license: ATTRIBUTION.overture.license,
    closed: r.operating_status === 'permanently_closed',
  }
}

// ---------------------------------------------------------------------------
// Foursquare Places API (places-api.foursquare.com /places/search) — optional, paid
// ---------------------------------------------------------------------------
export interface FsqPlace {
  fsq_place_id: string
  name: string
  latitude: number
  longitude: number
  categories?: { name: string }[]
  location?: { address?: string; locality?: string; region?: string; postcode?: string }
  website?: string
  tel?: string
  date_closed?: string | null
}

/** Foursquare category IDs/names for bars, breweries, wineries, restaurants are filtered by name. */
export function fsqToCandidate(p: FsqPlace): CandidatePlace | null {
  const cats = (p.categories ?? []).map((c) => c.name)
  const kind = kindFromCategories(cats)
  if (!kind || !clean(p.name)) return null
  return {
    provider: 'foursquare',
    externalId: p.fsq_place_id,
    name: p.name.trim(),
    kind,
    categories: cats,
    lat: p.latitude,
    lng: p.longitude,
    address: clean(p.location?.address),
    city: clean(p.location?.locality),
    state: clean(p.location?.region),
    postalCode: clean(p.location?.postcode),
    phone: clean(p.tel),
    website: normalizeWebsite(clean(p.website)),
    openingHoursRaw: null,
    happyHoursRaw: null,
    amenities: [],
    attribution: ATTRIBUTION.foursquare.text,
    license: ATTRIBUTION.foursquare.license,
    closed: !!p.date_closed,
  }
}
