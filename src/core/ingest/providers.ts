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
  const kind = kindFromCategories(cats)
  if (!kind) return null
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
