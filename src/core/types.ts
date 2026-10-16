/**
 * Domain model shared by the UI and both data backends (Supabase and on-device demo).
 * camelCase here; the Supabase adapter maps to/from snake_case rows.
 */

import type { CommunityStats, Weights } from './rating'
import type { HappyHourWindow, ScheduleException } from './schedule'
import type { EstablishmentKind, HappyHourVerification } from './listing'

export type { HappyHourWindow, ScheduleException } from './schedule'

export interface Market {
  id: string
  slug: string
  name: string
  region: string
  lat: number
  lng: number
  timezone: string
  /** Neighbourhoods/towns in the market, for manual selection. */
  areas: string[]
  /** Coverage radius around the centre. */
  radiusMiles?: number
  /** Created automatically from coverage requests (not a curated launch city). */
  autoCreated?: boolean
}

export interface Special {
  id: string
  kind: 'drink' | 'food' | 'other'
  title: string
  price: string | null
  description: string | null
}

export interface EstablishmentPhoto {
  id: string
  url: string
  alt: string | null
  /** Required credit line, e.g. "Photo: owner" or "© Jane Doe, CC BY 4.0". */
  attribution: string | null
}

export type ListingStatus = 'draft' | 'published' | 'archived'

export interface Establishment {
  id: string
  slug: string
  name: string
  kind: EstablishmentKind
  marketId: string
  neighborhood: string | null
  city: string
  state: string
  address: string
  postalCode: string | null
  lat: number
  lng: number
  timezone: string
  phone: string | null
  website: string | null
  description: string | null
  priceLevel: 1 | 2 | 3 | 4 | null
  amenities: string[]
  hhStatus: HappyHourVerification
  hhVerifiedAt: string | null
  /** Public, human-readable source summary, e.g. "Confirmed by phone with manager". */
  hhSourceNote: string | null
  /** When the source last confirmed the current details (automated re-checks included). */
  hhCheckedAt: string | null
  /** Where the details were published (the venue's own page), when known. */
  hhSourceUrl: string | null
  /** e.g. "Bar area only", "Not on holidays" — exactly as the source states. */
  hhRestrictions: string[]
  /** Business opening hours (NOT happy hour), when a licensed source provides them. */
  businessHours: Omit<HappyHourWindow, 'id'>[] | null
  /** Required credit line for imported venue data, e.g. "Overture Maps Foundation". */
  attribution: string | null
  windows: HappyHourWindow[]
  exceptions: ScheduleException[]
  specials: Special[]
  photos: EstablishmentPhoto[]
  community: CommunityStats
  status: ListingStatus
  /** Development/demo record. Always badged in the UI; never seeded into production. */
  isDemo: boolean
  createdAt: string
  updatedAt: string
}

export type Visibility = 'public' | 'private'

export interface Visit {
  id: string
  userId: string
  establishmentId: string
  visitedOn: string
  mode: 'quick' | 'detailed'
  /** category key → score; null = N/A */
  scores: Record<string, number | null>
  tags: string[]
  /** Private note, visible only to the author. */
  note: string | null
  /** Public written review (moderated). */
  review: string | null
  reviewStatus: 'published' | 'hidden' | 'removed' | null
  visibility: Visibility
  photoUrls: string[]
  createdAt: string
  updatedAt: string
}

export interface VisitInput {
  establishmentId: string
  visitedOn: string
  mode: 'quick' | 'detailed'
  scores: Record<string, number | null>
  tags: string[]
  note: string | null
  review: string | null
  visibility: Visibility
  /** Already-compressed image blobs to upload. */
  newPhotos?: Blob[]
  keepPhotoUrls?: string[]
}

export type SavedList = 'want_to_try' | 'favorite'

export interface SavedPlace {
  establishmentId: string
  list: SavedList
  createdAt: string
}

export interface CollectionItem {
  establishmentId: string
  note: string | null
  position: number
}

export interface Collection {
  id: string
  userId: string
  ownerUsername: string | null
  name: string
  description: string | null
  visibility: Visibility
  shareId: string
  featured: boolean
  items: CollectionItem[]
  createdAt: string
  updatedAt: string
}

export type Role = 'user' | 'admin'

export interface Profile {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
  bio: string | null
  homeCity: string | null
  marketId: string | null
  visibility: Visibility
  defaultVisitVisibility: Visibility
  contributeToCommunity: boolean
  role: Role
  suspended: boolean
  createdAt: string
}

export interface PublicProfile {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
  bio: string | null
  homeCity: string | null
  isPrivate: boolean
  placesRated: number
  visitsLogged: number
  followers: number
  following: number
  createdAt: string
}

export interface Preferences {
  weights: Weights
}

/** A public review shown on establishment pages and feeds. */
export interface PublicReview {
  visitId: string
  establishmentId: string
  user: { id: string; username: string; displayName: string; avatarUrl: string | null }
  visitedOn: string
  composite: number | null
  scores: Record<string, number | null>
  tags: string[]
  review: string | null
  photoUrls: string[]
  createdAt: string
}

export type FeedItem =
  | { kind: 'visit'; id: string; at: string; review: PublicReview }
  | { kind: 'favorite'; id: string; at: string; user: PublicReview['user']; establishmentId: string }
  | { kind: 'collection'; id: string; at: string; user: PublicReview['user']; collection: Pick<Collection, 'id' | 'name' | 'shareId'> & { itemCount: number } }

export type SubmissionKind = 'new_place' | 'correction' | 'outdated'
export type SubmissionStatus = 'pending' | 'approved' | 'rejected'

export interface Submission {
  id: string
  kind: SubmissionKind
  establishmentId: string | null
  /** Free-form fields: name, address, happy hour text, what changed, etc. */
  payload: Record<string, string>
  status: SubmissionStatus
  userId: string | null
  submitterUsername: string | null
  adminNote: string | null
  createdAt: string
  reviewedAt: string | null
}

export interface ReviewReport {
  id: string
  visitId: string
  reason: 'spam' | 'offensive' | 'not_relevant' | 'fake' | 'other'
  details: string | null
  status: 'open' | 'resolved' | 'dismissed'
  createdAt: string
  review: PublicReview | null
  reporterUsername: string | null
}

export interface ListingSource {
  id: string
  establishmentId: string
  kind: 'in_person' | 'phone' | 'website' | 'menu_photo' | 'owner' | 'user_submission' | 'social' | 'official_website' | 'open_data'
  url: string | null
  note: string | null
  observedOn: string
  createdAt: string
}

export interface AdminStats {
  users: number
  newUsers7d: number
  visits: number
  visits7d: number
  establishments: number
  published: number
  pendingSubmissions: number
  openReports: number
  staleListings: number
}

export interface AdminUser {
  id: string
  username: string
  displayName: string
  role: Role
  suspended: boolean
  visits: number
  createdAt: string
}
