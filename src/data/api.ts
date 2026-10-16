/**
 * The one data-access contract the UI depends on. Two implementations:
 *   - SupabaseApi (production): Postgres + RLS via supabase-js.
 *   - DemoApi (no backend configured): on-device demo using localStorage.
 * Screens never import supabase-js directly — this keeps a future native client simple.
 */

import type {
  AdminStats,
  AdminUser,
  Collection,
  Establishment,
  FeedItem,
  ListingSource,
  Market,
  Preferences,
  Profile,
  PublicProfile,
  PublicReview,
  ReviewReport,
  Role,
  SavedList,
  SavedPlace,
  Special,
  Submission,
  SubmissionKind,
  SubmissionStatus,
  Visibility,
  Visit,
  VisitInput,
} from '@/core/types'
import type { HappyHourWindow, ScheduleException } from '@/core/schedule'
import type { LatLng } from '@/core/listing'

export interface GeoResult {
  label: string
  lat: number
  lng: number
  /** city, street, house, … */
  kind: string
}

export interface AuthUser {
  id: string
  email: string | null
}

export interface UserCard {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
}

export type ProfileView = PublicProfile & { isFollowing: boolean }

export type ProfilePatch = Partial<
  Pick<Profile, 'username' | 'displayName' | 'bio' | 'homeCity' | 'marketId' | 'visibility' | 'defaultVisitVisibility' | 'contributeToCommunity' | 'avatarUrl'>
>

export interface CollectionInput {
  id?: string
  name: string
  description: string | null
  visibility: Visibility
}

export interface EstablishmentInput {
  id?: string
  slug: string
  name: string
  kind: Establishment['kind']
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
  priceLevel: Establishment['priceLevel']
  amenities: string[]
  hhStatus: Establishment['hhStatus']
  hhSourceNote: string | null
  status: Establishment['status']
  windows: Omit<HappyHourWindow, 'id'>[]
  exceptions: Omit<ScheduleException, 'id'>[]
  specials: Omit<Special, 'id'>[]
}

// Data pipeline (admin) ------------------------------------------------------------

export interface PipelineBudget {
  provider: string
  limit: number
  used: number
  enabled: boolean
  note: string | null
}

export interface PipelineJob {
  id: string
  kind: 'discover_market' | 'enrich_establishment'
  target_id: string
  target_name: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
  attempts: number
  last_error: string | null
  result: Record<string, unknown> | null
  created_at: string
  finished_at: string | null
  run_after: string
}

export interface CoverageRequest {
  cell: string
  lat: number
  lng: number
  label: string | null
  requests: number
  last_requested_at: string
}

export interface PipelineOverview {
  jobs: Partial<Record<PipelineJob['status'], number>>
  recentJobs: PipelineJob[]
  budgets: PipelineBudget[]
  pendingFindings: number
  openDuplicates: number
  coverageRequests: CoverageRequest[]
  markets: { id: string; name: string; lastDiscoveredAt: string | null; nextDiscoveryAt: string | null; discoveryEnabled: boolean; radiusMiles: number; places: number }[]
}

export interface Finding {
  id: string
  establishment_id: string
  establishmentName: string
  establishmentSlug: string
  managedBy: 'auto' | 'admin'
  source_kind: string
  method: string
  source_url: string | null
  windows: Omit<HappyHourWindow, 'id'>[]
  specials: Omit<Special, 'id'>[]
  restrictions: string[]
  evidence: { field: string; quote: string }[]
  source_published_at: string | null
  checked_at: string
  confidence: number | null
  mentioned_but_unparsed: boolean
  status: 'pending' | 'applied' | 'rejected' | 'approved' | 'superseded'
  decision_reason: string | null
  created_at: string
}

export interface DuplicateSide {
  id: string
  name: string
  slug: string
  address: string
  website: string | null
  status: string
  origin: string
  visits: number
}

export interface DuplicatePair {
  id: string
  score: number
  reasons: string[]
  createdAt: string
  a: DuplicateSide
  b: DuplicateSide
}

export interface ListingHistory {
  changes: { id: string; actor: 'pipeline' | 'admin'; summary: string; source_url: string | null; created_at: string }[]
  jobs: PipelineJob[]
  documents: { url: string; outcome: string | null; last_status: number | null; last_attempt_at: string | null; last_success_at: string | null; failures: number }[]
  externalIds: { provider: string; external_id: string; last_seen_at: string }[]
  /** Internal pipeline state (admin only). */
  listing: {
    managedBy: 'auto' | 'admin'
    origin: 'manual' | 'import' | 'user_submission'
    confidence: number | null
    conflict: boolean
    lockedFields: string[]
    attribution: string | null
    lastConfirmedAt: string | null
    lastChangedAt: string | null
    nextEnrichAt: string | null
    lastEnrichAttemptAt: string | null
    lastEnrichSuccessAt: string | null
    enrichFailures: number
    mergedInto: string | null
  } | null
}

export interface MarketInput {
  id?: string
  slug: string
  name: string
  region: string
  lat: number
  lng: number
  timezone: string
  radiusMiles: number
  autoPublish: boolean
  coverageCell?: string
}

export interface PipelineAdminApi {
  overview(): Promise<PipelineOverview>
  listFindings(status: 'pending' | 'all', establishmentId?: string): Promise<Finding[]>
  reviewFinding(id: string, action: 'approve' | 'reject', note: string | null): Promise<void>
  setManagedBy(establishmentId: string, managedBy: 'auto' | 'admin'): Promise<void>
  listDuplicates(): Promise<DuplicatePair[]>
  resolveDuplicate(id: string, action: 'merge' | 'dismiss'): Promise<void>
  mergeEstablishments(keepId: string, mergeId: string): Promise<void>
  enqueueRefresh(kind: PipelineJob['kind'], targetId: string): Promise<void>
  /** Ask the Worker to run queued jobs now; false when that endpoint is unavailable (they run on the next schedule). */
  runNow(): Promise<boolean>
  setProviderLimit(provider: string, monthlyLimit: number, enabled: boolean): Promise<void>
  saveMarket(input: MarketInput): Promise<string>
  dismissCoverage(cell: string): Promise<void>
  history(establishmentId: string): Promise<ListingHistory>
}

export interface AdminApi {
  pipeline: PipelineAdminApi
  stats(): Promise<AdminStats>
  listEstablishments(): Promise<Establishment[]>
  saveEstablishment(input: EstablishmentInput): Promise<string>
  deleteEstablishment(id: string): Promise<void>
  verifyListing(id: string, source: ListingSource['kind'], note: string | null, url: string | null): Promise<void>
  listSources(establishmentId: string): Promise<ListingSource[]>
  addPhoto(establishmentId: string, file: Blob, alt: string | null, attribution: string | null): Promise<void>
  deletePhoto(photoId: string): Promise<void>
  listSubmissions(status: SubmissionStatus): Promise<Submission[]>
  reviewSubmission(id: string, status: SubmissionStatus, note: string | null): Promise<void>
  listReports(): Promise<ReviewReport[]>
  moderateReview(visitId: string, status: 'published' | 'hidden' | 'removed'): Promise<void>
  excludeVisit(visitId: string, excluded: boolean): Promise<void>
  dismissReport(id: string): Promise<void>
  listUsers(query: string): Promise<AdminUser[]>
  setSuspended(userId: string, suspended: boolean, reason: string | null): Promise<void>
  setRole(userId: string, role: Role): Promise<void>
  listPublicCollections(): Promise<Collection[]>
  setFeatured(collectionId: string, featured: boolean): Promise<void>
}

export interface Api {
  readonly mode: 'supabase' | 'demo'

  // Auth ---------------------------------------------------------------------
  getUser(): Promise<AuthUser | null>
  onAuthChange(cb: (user: AuthUser | null) => void): () => void
  /** Sends a 6-digit code (and magic link) to the address. Creates the account if new. */
  sendEmailCode(email: string): Promise<void>
  verifyEmailCode(email: string, code: string): Promise<void>
  signInWithApple(): Promise<void>
  signOut(): Promise<void>
  deleteAccount(): Promise<void>

  // Listings -------------------------------------------------------------------
  listMarkets(): Promise<Market[]>
  /** All published listings in a market (a few hundred at most), with stats. */
  listEstablishments(marketId: string): Promise<Establishment[]>
  /** Published listings within `radiusMiles` of a point (indexed geospatial query), any market. */
  nearbyEstablishments(center: LatLng, radiusMiles: number): Promise<Establishment[]>
  /** Resolve specific listings (e.g. ones a user rated or saved elsewhere). */
  getEstablishmentsByIds(ids: string[]): Promise<Establishment[]>
  getEstablishment(slugOrId: string): Promise<Establishment | null>
  /** City/address search. Only called when the user types; results are not stored. */
  geocode(query: string): Promise<{ results: GeoResult[]; attribution: string | null }>
  /** Anonymous "bring Aour here" signal for an area with no coverage (rounded to ~11 km). */
  requestCoverage(center: LatLng, label: string | null): Promise<void>
  establishmentReviews(establishmentId: string, opts?: { followingOnly?: boolean; before?: string }): Promise<PublicReview[]>

  // Me -------------------------------------------------------------------------
  getMyProfile(): Promise<Profile | null>
  updateMyProfile(patch: ProfilePatch): Promise<Profile>
  uploadAvatar(file: Blob): Promise<string>
  getPreferences(): Promise<Preferences>
  savePreferences(prefs: Preferences): Promise<void>
  listMyVisits(): Promise<Visit[]>
  saveVisit(input: VisitInput & { id?: string }): Promise<string>
  deleteVisit(id: string): Promise<void>
  listSaved(): Promise<SavedPlace[]>
  setSaved(establishmentId: string, list: SavedList, saved: boolean): Promise<void>

  // Collections ------------------------------------------------------------------
  listMyCollections(): Promise<Collection[]>
  getCollectionByShareId(shareId: string): Promise<Collection | null>
  saveCollection(input: CollectionInput): Promise<Collection>
  deleteCollection(id: string): Promise<void>
  setCollectionItem(collectionId: string, establishmentId: string, included: boolean): Promise<void>
  featuredCollections(): Promise<Collection[]>

  // Social ---------------------------------------------------------------------
  getProfile(username: string): Promise<ProfileView | null>
  profileReviews(userId: string): Promise<PublicReview[]>
  profileFavorites(userId: string): Promise<string[]>
  profileCollections(userId: string): Promise<Collection[]>
  searchProfiles(query: string): Promise<UserCard[]>
  setFollowing(userId: string, follow: boolean): Promise<void>
  listFollowing(): Promise<UserCard[]>
  feed(before?: string): Promise<FeedItem[]>
  friendActivity(): Promise<{ establishmentId: string; createdAt: string }[]>

  // Trust ----------------------------------------------------------------------
  reportReview(visitId: string, reason: ReviewReport['reason'], details: string | null): Promise<void>
  submit(kind: SubmissionKind, establishmentId: string | null, payload: Record<string, string>): Promise<void>

  admin: AdminApi
}

/** User-facing error with a friendly message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
