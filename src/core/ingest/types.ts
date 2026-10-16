/**
 * Types shared by the discovery + enrichment pipeline (Cloudflare Worker) and the app.
 * Pure data — no I/O — so the pipeline is unit-testable with fixtures.
 */
import type { EstablishmentKind } from '../listing'

export type ProviderId = 'osm' | 'overture' | 'foursquare' | 'fsq_os'

/** A venue as reported by a place-data provider, normalised. Not a confirmed happy hour. */
export interface CandidatePlace {
  provider: ProviderId
  /** Stable provider identifier (e.g. "node/123", Overture GERS id, fsq_place_id). */
  externalId: string
  name: string
  kind: EstablishmentKind
  categories: string[]
  lat: number
  lng: number
  address: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  phone: string | null
  website: string | null
  /** Raw business opening hours (OSM opening_hours syntax) — NOT happy-hour hours. */
  openingHoursRaw: string | null
  /** Raw OSM `happy_hours` tag, when a mapper recorded one. */
  happyHoursRaw: string | null
  /** Objective amenities from the source, mapped to Aour amenity keys. */
  amenities: string[]
  /** Required credit line, e.g. "© OpenStreetMap contributors". */
  attribution: string
  license: string
  /** The provider says the venue has closed. */
  closed: boolean
}

export interface ExtractedWindow {
  days: number[]
  start: string
  end: string
  label: string | null
}

export interface ExtractedSpecial {
  kind: 'drink' | 'food' | 'other'
  title: string
  /** Exactly as published (e.g. "$5", "half price"); null when not published. */
  price: string | null
  description: string | null
}

export type ExtractionMethod = 'json_ld' | 'pattern' | 'llm' | 'osm_tag' | 'user' | 'admin'
export type FindingSourceKind = 'official_website' | 'osm' | 'user' | 'admin' | 'partner_feed'

export interface Evidence {
  /** "window:0", "special:2", "restriction:0" … */
  field: string
  /** Verbatim text from the source that supports the field. */
  quote: string
}

/** Happy-hour facts extracted from ONE source document. Missing ≠ zero: absent facts stay absent. */
export interface HappyHourFinding {
  sourceKind: FindingSourceKind
  method: ExtractionMethod
  sourceUrl: string | null
  windows: ExtractedWindow[]
  specials: ExtractedSpecial[]
  /** e.g. "Bar area only", "Dine-in only", "Not valid on holidays". */
  restrictions: string[]
  evidence: Evidence[]
  /** Publication/update date stated by the source, if any. */
  sourcePublishedAt: string | null
  checkedAt: string
  /** The page mentions happy hour but we could not extract structured facts. */
  mentionedButUnparsed: boolean
}

/** Public verification states (UI labels in core/verification.ts). */
export type HappyHourStatus =
  | 'verified' // confirmed by an Aour admin with a recorded source
  | 'establishment_reported' // published by the venue itself (official site/owner)
  | 'community_reported' // users or open data (OSM) — not independently confirmed
  | 'unverified' // "Needs verification": extracted/submitted but low confidence or conflicting
  | 'outdated' // too old or reported as changed
  | 'none' // no happy-hour information available
