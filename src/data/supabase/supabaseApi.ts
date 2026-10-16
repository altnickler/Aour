/**
 * Production backend: Supabase (Postgres + RLS, Auth, Storage).
 * Only the public anon key is used here; every permission is enforced in the database.
 */

import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js'
import type {
  Collection,
  Establishment,
  FeedItem,
  ListingSource,
  Market,
  Preferences,
  Profile,
  PublicReview,
  ReviewReport,
  SavedPlace,
  Submission,
  Visit,
} from '@/core/types'
import { EMPTY_COMMUNITY_STATS, sanitizeWeights, type CommunityStats } from '@/core/rating'
import {
  ApiError,
  type AdminApi,
  type Api,
  type AuthUser,
  type DuplicatePair,
  type EstablishmentInput,
  type Finding,
  type GeoResult,
  type ListingHistory,
  type PipelineOverview,
  type ProfilePatch,
  type UserCard,
} from '../api'
import type { LatLng } from '@/core/listing'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

// Explicit public columns: pipeline internals are not readable through the public API.
const EST_COLUMNS =
  'id, slug, name, kind, market_id, neighborhood, city, state, address, postal_code, lat, lng, timezone, phone, website, description, ' +
  'price_level, amenities, hh_status, hh_verified_at, hh_source_note, status, is_demo, created_at, updated_at, attribution, ' +
  'business_hours, hh_source_url, hh_last_confirmed_at, hh_restrictions'
const EST_SELECT = `${EST_COLUMNS}, happy_hour_windows(*), schedule_exceptions(*), happy_hour_specials(*), establishment_photos(*), establishment_stats(*)`
const VISIT_SELECT = '*, rating_scores(category_key, score), visit_tags(tag), visit_notes(body), reviews(body, status), visit_photos(storage_path)'

function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null)

function friendly(error: PostgrestError | { message: string; code?: string } | null): never {
  const msg = error?.message ?? 'Something went wrong'
  const code = (error as PostgrestError | null)?.code
  if (code === '42501' || /permission denied|row-level security/i.test(msg)) {
    throw new ApiError("You don't have permission to do that.", 'forbidden')
  }
  if (code === '23505') throw new ApiError('That already exists.', 'conflict')
  if (code === '23514' && /username/.test(msg)) throw new ApiError('That username is not allowed.', 'invalid')
  if (code === '23514') throw new ApiError('Some values are out of range.', 'invalid')
  throw new ApiError(msg, code)
}

function check<T>(res: { data: T | null; error: PostgrestError | null }): T {
  if (res.error) friendly(res.error)
  // Writes without .select() return null data; treat as an empty result.
  return (res.data ?? []) as T
}

function mapStats(s: Row | null): CommunityStats {
  if (!s) return EMPTY_COMMUNITY_STATS
  return {
    average: num(s.average),
    reviewers: s.reviewers ?? 0,
    visits: s.visit_count ?? 0,
    categoryAverages: Object.fromEntries(Object.entries(s.category_averages ?? {}).map(([k, v]) => [k, Number(v)])),
    distribution: s.distribution ?? Array(10).fill(0),
    topTags: s.top_tags ?? [],
  }
}

function mapEstablishment(r: Row): Establishment {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    marketId: r.market_id,
    neighborhood: r.neighborhood,
    city: r.city,
    state: r.state,
    address: r.address,
    postalCode: r.postal_code,
    lat: r.lat,
    lng: r.lng,
    timezone: r.timezone,
    phone: r.phone,
    website: r.website,
    description: r.description,
    priceLevel: r.price_level,
    amenities: r.amenities ?? [],
    hhStatus: r.hh_status,
    hhVerifiedAt: r.hh_verified_at,
    hhSourceNote: r.hh_source_note,
    hhCheckedAt: r.hh_last_confirmed_at ?? r.hh_verified_at ?? null,
    hhSourceUrl: r.hh_source_url ?? null,
    hhRestrictions: r.hh_restrictions ?? [],
    businessHours: Array.isArray(r.business_hours) ? r.business_hours : null,
    attribution: r.attribution ?? null,
    windows: (r.happy_hour_windows ?? [])
      .sort((a: Row, b: Row) => a.sort_order - b.sort_order)
      .map((w: Row) => ({ id: w.id, days: w.days, start: hhmm(w.start_time)!, end: hhmm(w.end_time)!, label: w.label, notes: w.notes })),
    exceptions: (r.schedule_exceptions ?? []).map((x: Row) => ({
      id: x.id,
      date: x.date,
      closed: x.closed,
      start: hhmm(x.start_time),
      end: hhmm(x.end_time),
      note: x.note,
    })),
    specials: (r.happy_hour_specials ?? [])
      .sort((a: Row, b: Row) => a.sort_order - b.sort_order)
      .map((s: Row) => ({ id: s.id, kind: s.kind, title: s.title, price: s.price, description: s.description })),
    photos: (r.establishment_photos ?? [])
      .sort((a: Row, b: Row) => a.sort_order - b.sort_order)
      .map((p: Row) => ({ id: p.id, url: p.url, alt: p.alt, attribution: p.attribution })),
    community: mapStats(one(r.establishment_stats)),
    status: r.status,
    isDemo: r.is_demo,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapProfile(r: Row): Profile {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    bio: r.bio,
    homeCity: r.home_city,
    marketId: r.market_id,
    visibility: r.visibility,
    defaultVisitVisibility: r.default_visit_visibility,
    contributeToCommunity: r.contribute_to_community,
    role: r.role,
    suspended: r.suspended_at !== null,
    createdAt: r.created_at,
  }
}

function mapCollection(r: Row, ownerUsername: string | null): Collection {
  return {
    id: r.id,
    userId: r.user_id,
    ownerUsername: ownerUsername ?? one(r.owner)?.username ?? null,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    shareId: r.share_id,
    featured: r.featured_at !== null && r.featured_at !== undefined,
    items: (r.collection_items ?? [])
      .map((i: Row) => ({ establishmentId: i.establishment_id, note: i.note, position: i.position }))
      .sort((a: { position: number }, b: { position: number }) => a.position - b.position),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export class SupabaseApi implements Api {
  readonly mode = 'supabase' as const
  readonly client: SupabaseClient
  private uid: string | null = null
  private username: string | null = null

  constructor(
    private url: string,
    anonKey: string,
    private siteUrl: string,
  ) {
    this.client = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    })
    this.client.auth.onAuthStateChange((_e, session) => {
      this.uid = session?.user.id ?? null
    })
  }

  private publicUrl(bucket: string, path: string) {
    return `${this.url}/storage/v1/object/public/${bucket}/${path}`
  }

  private pathFromUrl(bucket: string, url: string) {
    const prefix = `${this.url}/storage/v1/object/public/${bucket}/`
    return url.startsWith(prefix) ? url.slice(prefix.length) : null
  }

  private mapReview = (r: Row): PublicReview => ({
    visitId: r.visitId,
    establishmentId: r.establishmentId,
    user: r.user,
    visitedOn: r.visitedOn,
    composite: num(r.composite),
    scores: Object.fromEntries(Object.entries(r.scores ?? {}).map(([k, v]) => [k, num(v)])),
    tags: r.tags ?? [],
    review: r.review ?? null,
    photoUrls: (r.photoPaths ?? []).map((p: string) => this.publicUrl('visit-photos', p)),
    createdAt: r.createdAt,
  })

  private async requireUid(): Promise<string> {
    if (this.uid) return this.uid
    const { data } = await this.client.auth.getUser()
    if (!data.user) throw new ApiError('Sign in to continue.', 'auth')
    this.uid = data.user.id
    return this.uid
  }

  private async rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args)
    if (error) friendly(error)
    return data as T
  }

  // Auth -------------------------------------------------------------------------
  async getUser(): Promise<AuthUser | null> {
    const { data } = await this.client.auth.getSession()
    const u = data.session?.user
    this.uid = u?.id ?? null
    return u ? { id: u.id, email: u.email ?? null } : null
  }

  onAuthChange(cb: (u: AuthUser | null) => void) {
    const { data } = this.client.auth.onAuthStateChange((_e, session) => {
      const u = session?.user
      cb(u ? { id: u.id, email: u.email ?? null } : null)
    })
    return () => data.subscription.unsubscribe()
  }

  async sendEmailCode(email: string) {
    const { error } = await this.client.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: true, emailRedirectTo: this.siteUrl },
    })
    if (error) {
      if (/rate limit/i.test(error.message)) throw new ApiError('Too many codes requested. Please wait a minute and try again.')
      throw new ApiError(error.message)
    }
  }

  async verifyEmailCode(email: string, code: string) {
    const { error } = await this.client.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'email' })
    if (error) throw new ApiError(/expired|invalid/i.test(error.message) ? 'That code is invalid or has expired.' : error.message)
  }

  async signInWithApple() {
    const { error } = await this.client.auth.signInWithOAuth({ provider: 'apple', options: { redirectTo: this.siteUrl } })
    if (error) throw new ApiError(error.message)
  }

  async signOut() {
    await this.client.auth.signOut()
    this.uid = null
    this.username = null
  }

  async deleteAccount() {
    const uid = await this.requireUid()
    // Storage objects must be deleted through the Storage API (not SQL).
    for (const bucket of ['visit-photos', 'avatars']) {
      for (;;) {
        const { data } = await this.client.storage.from(bucket).list(uid, { limit: 100 })
        if (!data?.length) break
        const { error } = await this.client.storage.from(bucket).remove(data.map((f) => `${uid}/${f.name}`))
        if (error) throw new ApiError('Could not delete your photos. Please try again.')
        if (data.length < 100) break
      }
    }
    await this.rpc('delete_my_account')
    await this.client.auth.signOut({ scope: 'local' })
    this.uid = null
  }

  // Listings -----------------------------------------------------------------------
  async listMarkets(): Promise<Market[]> {
    const rows = check(await this.client.from('markets').select('*').order('name'))
    return rows.map((m: Row) => ({ id: m.id, slug: m.slug, name: m.name, region: m.region, lat: m.lat, lng: m.lng, timezone: m.timezone, areas: m.areas, radiusMiles: m.radius_miles == null ? undefined : Number(m.radius_miles) }))
  }

  async listEstablishments(marketId: string) {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const rows = check(
      await this.client
        .from('establishments')
        .select(EST_SELECT)
        .eq('market_id', marketId)
        .eq('status', 'published')
        .gte('schedule_exceptions.date', yesterday)
        .limit(1000),
    )
    return rows.map(mapEstablishment)
  }

  async nearbyEstablishments(center: LatLng, radiusMiles: number) {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const rows = check(
      await this.client
        .rpc('nearby_establishments', { p_lat: center.lat, p_lng: center.lng, p_radius_m: Math.round(radiusMiles * 1609.34), p_limit: 300 })
        .select(EST_SELECT)
        .eq('status', 'published')
        .gte('schedule_exceptions.date', yesterday),
    ) as Row[]
    return rows.map(mapEstablishment)
  }

  async getEstablishmentsByIds(ids: string[]) {
    const unique = [...new Set(ids)].filter((x) => /^[0-9a-f-]{36}$/.test(x))
    const out: Establishment[] = []
    for (let i = 0; i < unique.length; i += 100) {
      const rows = check(await this.client.from('establishments').select(EST_SELECT).in('id', unique.slice(i, i + 100)))
      out.push(...rows.map(mapEstablishment))
    }
    return out
  }

  async geocode(query: string) {
    let res: Response
    try {
      res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`, { headers: { Accept: 'application/json' } })
    } catch {
      throw new ApiError('Place search is unavailable. Check your connection.', 'network')
    }
    const body = (await res.json().catch(() => null)) as { results?: GeoResult[]; attribution?: string; error?: string } | null
    if (!res.ok || !body?.results) throw new ApiError(body?.error ?? 'Place search is unavailable right now.', String(res.status))
    return { results: body.results, attribution: body.attribution ?? null }
  }

  async requestCoverage(center: LatLng, label: string | null) {
    await this.rpc('request_coverage', { p_lat: center.lat, p_lng: center.lng, p_label: label })
  }

  async getEstablishment(slugOrId: string) {
    const isUuid = /^[0-9a-f-]{36}$/.test(slugOrId)
    const rows = check(await this.client.from('establishments').select(EST_SELECT).eq(isUuid ? 'id' : 'slug', slugOrId).limit(1))
    return rows[0] ? mapEstablishment(rows[0]) : null
  }

  async establishmentReviews(establishmentId: string, opts: { followingOnly?: boolean; before?: string } = {}) {
    const rows = await this.rpc<Row[]>('establishment_reviews', {
      p_establishment: establishmentId,
      p_following_only: !!opts.followingOnly,
      p_limit: opts.followingOnly ? 50 : 20,
      p_before: opts.before ?? null,
    })
    return rows.map(this.mapReview)
  }

  // Me ---------------------------------------------------------------------------
  async getMyProfile() {
    const uid = this.uid ?? (await this.getUser())?.id
    if (!uid) return null
    const rows = check(await this.client.from('profiles').select('*').eq('id', uid).limit(1))
    if (!rows[0]) return null
    const p = mapProfile(rows[0])
    this.username = p.username
    return p
  }

  async updateMyProfile(patch: ProfilePatch) {
    const uid = await this.requireUid()
    const row: Row = {}
    if (patch.username !== undefined) row.username = patch.username
    if (patch.displayName !== undefined) row.display_name = patch.displayName
    if (patch.bio !== undefined) row.bio = patch.bio
    if (patch.homeCity !== undefined) row.home_city = patch.homeCity
    if (patch.marketId !== undefined) row.market_id = patch.marketId
    if (patch.visibility !== undefined) row.visibility = patch.visibility
    if (patch.defaultVisitVisibility !== undefined) row.default_visit_visibility = patch.defaultVisitVisibility
    if (patch.contributeToCommunity !== undefined) row.contribute_to_community = patch.contributeToCommunity
    if (patch.avatarUrl !== undefined) row.avatar_url = patch.avatarUrl
    const res = await this.client.from('profiles').update(row).eq('id', uid).select('*').single()
    if (res.error?.code === '23505') throw new ApiError('That username is taken.')
    return mapProfile(check(res))
  }

  async uploadAvatar(file: Blob) {
    const uid = await this.requireUid()
    const path = `${uid}/${crypto.randomUUID()}.jpg`
    const { error } = await this.client.storage.from('avatars').upload(path, file, { contentType: file.type || 'image/jpeg', cacheControl: '31536000' })
    if (error) throw new ApiError('Could not upload that photo.')
    return this.publicUrl('avatars', path)
  }

  async getPreferences(): Promise<Preferences> {
    const uid = this.uid ?? (await this.getUser())?.id
    if (!uid) return { weights: sanitizeWeights(null) }
    const rows = check(await this.client.from('user_preferences').select('weights').eq('user_id', uid).limit(1))
    return { weights: sanitizeWeights(rows[0]?.weights) }
  }

  async savePreferences(prefs: Preferences) {
    const uid = await this.requireUid()
    check(await this.client.from('user_preferences').upsert({ user_id: uid, weights: prefs.weights }))
  }

  async listMyVisits(): Promise<Visit[]> {
    const uid = this.uid ?? (await this.getUser())?.id
    if (!uid) return []
    const rows = check(await this.client.from('visits').select(VISIT_SELECT).eq('user_id', uid).order('visited_on', { ascending: false }).limit(2000))
    return rows.map((r: Row) => {
      const review = one(r.reviews)
      return {
        id: r.id,
        userId: r.user_id,
        establishmentId: r.establishment_id,
        visitedOn: r.visited_on,
        mode: r.mode,
        scores: Object.fromEntries((r.rating_scores ?? []).map((s: Row) => [s.category_key, num(s.score)])),
        tags: (r.visit_tags ?? []).map((t: Row) => t.tag),
        note: one(r.visit_notes)?.body ?? null,
        review: review?.body ?? null,
        reviewStatus: review?.status ?? null,
        visibility: r.visibility,
        photoUrls: (r.visit_photos ?? []).map((p: Row) => this.publicUrl('visit-photos', p.storage_path)),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }
    })
  }

  async saveVisit(input: Parameters<Api['saveVisit']>[0]) {
    const uid = await this.requireUid()
    const uploaded: string[] = []
    for (const blob of input.newPhotos ?? []) {
      const path = `${uid}/${crypto.randomUUID()}.jpg`
      const { error } = await this.client.storage.from('visit-photos').upload(path, blob, { contentType: blob.type || 'image/jpeg', cacheControl: '31536000' })
      if (error) throw new ApiError('Could not upload a photo. Check your connection and try again.')
      uploaded.push(path)
    }
    const kept = (input.keepPhotoUrls ?? []).map((u) => this.pathFromUrl('visit-photos', u)).filter((p): p is string => !!p)
    const before = input.id
      ? check(await this.client.from('visit_photos').select('storage_path').eq('visit_id', input.id)).map((r: Row) => r.storage_path as string)
      : []
    let id: string
    try {
      id = await this.rpc<string>('save_visit', {
        p: {
          id: input.id ?? null,
          establishment_id: input.establishmentId,
          visited_on: input.visitedOn,
          mode: input.mode,
          visibility: input.visibility,
          scores: input.scores,
          tags: input.tags,
          note: input.note,
          review: input.review,
          photo_paths: [...kept, ...uploaded],
        },
      })
    } catch (e) {
      if (uploaded.length) await this.client.storage.from('visit-photos').remove(uploaded)
      throw e
    }
    // Public bucket: removed photos must be deleted from storage, not just unlinked.
    const dropped = before.filter((p) => !kept.includes(p))
    if (dropped.length) await this.client.storage.from('visit-photos').remove(dropped)
    return id
  }

  async deleteVisit(id: string) {
    const photos = check(await this.client.from('visit_photos').select('storage_path').eq('visit_id', id))
    const deleted = check(await this.client.from('visits').delete().eq('id', id).select('id'))
    if (!deleted.length) throw new ApiError("This rating's review is under moderation, so it can't be deleted right now.", 'forbidden')
    if (photos.length) await this.client.storage.from('visit-photos').remove(photos.map((p: Row) => p.storage_path))
  }

  async listSaved(): Promise<SavedPlace[]> {
    const uid = this.uid ?? (await this.getUser())?.id
    if (!uid) return []
    const rows = check(await this.client.from('saved_places').select('*').eq('user_id', uid))
    return rows.map((r: Row) => ({ establishmentId: r.establishment_id, list: r.list, createdAt: r.created_at }))
  }

  async setSaved(establishmentId: string, list: SavedPlace['list'], saved: boolean) {
    const uid = await this.requireUid()
    if (saved) {
      check(await this.client.from('saved_places').upsert({ user_id: uid, establishment_id: establishmentId, list }, { ignoreDuplicates: true }))
    } else {
      check(await this.client.from('saved_places').delete().match({ user_id: uid, establishment_id: establishmentId, list }))
    }
  }

  // Collections -----------------------------------------------------------------------
  async listMyCollections() {
    const uid = this.uid ?? (await this.getUser())?.id
    if (!uid) return []
    const rows = check(await this.client.from('collections').select('*, collection_items(*)').eq('user_id', uid).order('updated_at', { ascending: false }))
    return rows.map((r: Row) => mapCollection(r, this.username))
  }

  async getCollectionByShareId(shareId: string) {
    const c = await this.rpc<Collection | null>('collection_by_share', { p_share_id: shareId })
    return c
  }

  async saveCollection(input: Parameters<Api['saveCollection']>[0]) {
    const uid = await this.requireUid()
    const body = { name: input.name.trim(), description: input.description, visibility: input.visibility }
    const res = input.id
      ? await this.client.from('collections').update(body).eq('id', input.id).select('*, collection_items(*)').single()
      : await this.client.from('collections').insert({ ...body, user_id: uid }).select('*, collection_items(*)').single()
    return mapCollection(check(res), this.username)
  }

  async deleteCollection(id: string) {
    check(await this.client.from('collections').delete().eq('id', id))
  }

  async setCollectionItem(collectionId: string, establishmentId: string, included: boolean) {
    if (included) {
      const { count } = await this.client.from('collection_items').select('*', { count: 'exact', head: true }).eq('collection_id', collectionId)
      check(await this.client.from('collection_items').upsert({ collection_id: collectionId, establishment_id: establishmentId, position: count ?? 0 }, { ignoreDuplicates: true }))
    } else {
      check(await this.client.from('collection_items').delete().match({ collection_id: collectionId, establishment_id: establishmentId }))
    }
  }

  async featuredCollections() {
    return this.rpc<Collection[]>('featured_collections')
  }

  // Social -------------------------------------------------------------------------
  async getProfile(username: string) {
    return this.rpc<Awaited<ReturnType<Api['getProfile']>>>('get_profile', { p_username: username })
  }

  async profileReviews(userId: string) {
    const rows = await this.rpc<Row[]>('profile_reviews', { p_user: userId })
    return rows.map(this.mapReview)
  }

  async profileFavorites(userId: string) {
    return this.rpc<string[]>('profile_favorites', { p_user: userId })
  }

  async profileCollections(userId: string) {
    // RLS already limits other people's collections to public ones; your own include private.
    const rows = check(await this.client.from('collections').select('*, collection_items(*)').eq('user_id', userId).order('updated_at', { ascending: false }))
    return rows.map((r: Row) => mapCollection(r, null))
  }

  async searchProfiles(query: string) {
    return this.rpc<UserCard[]>('search_profiles', { p_query: query })
  }

  async setFollowing(userId: string, follow: boolean) {
    const uid = await this.requireUid()
    if (follow) check(await this.client.from('follows').upsert({ follower_id: uid, followee_id: userId }, { ignoreDuplicates: true }))
    else check(await this.client.from('follows').delete().match({ follower_id: uid, followee_id: userId }))
  }

  async listFollowing() {
    return this.rpc<UserCard[]>('my_following')
  }

  async feed(before?: string): Promise<FeedItem[]> {
    const rows = await this.rpc<Row[]>('following_feed', { p_before: before ?? null })
    return rows.map((r) => (r.kind === 'visit' ? { kind: 'visit', id: r.id, at: r.at, review: this.mapReview(r.review) } : (r as FeedItem)))
  }

  async friendActivity() {
    return this.rpc<{ establishmentId: string; createdAt: string }[]>('friend_activity')
  }

  // Trust ------------------------------------------------------------------------------
  async reportReview(visitId: string, reason: ReviewReport['reason'], details: string | null) {
    const uid = await this.requireUid()
    const res = await this.client.from('review_reports').insert({ visit_id: visitId, reporter_id: uid, reason, details })
    if (res.error?.code === '23505') throw new ApiError("You've already reported this.")
    check(res)
  }

  async submit(kind: Submission['kind'], establishmentId: string | null, payload: Record<string, string>) {
    const uid = await this.requireUid()
    check(await this.client.from('establishment_submissions').insert({ kind, establishment_id: establishmentId, user_id: uid, payload }))
  }

  // Admin -----------------------------------------------------------------------------
  admin: AdminApi = {
    pipeline: {
      overview: () => this.rpc<PipelineOverview>('admin_pipeline_overview'),
      listFindings: (status, establishmentId) => this.rpc<Finding[]>('admin_list_findings', { p_status: status, p_establishment: establishmentId ?? null }),
      reviewFinding: async (id, action, note) => {
        await this.rpc('admin_review_finding', { p_finding: id, p_action: action, p_note: note })
      },
      setManagedBy: async (id, managedBy) => {
        await this.rpc('admin_set_hh_managed', { p_establishment: id, p_managed_by: managedBy })
      },
      listDuplicates: () => this.rpc<DuplicatePair[]>('admin_list_duplicates'),
      resolveDuplicate: async (id, action) => {
        await this.rpc('admin_resolve_duplicate', { p_duplicate: id, p_action: action })
      },
      mergeEstablishments: async (keep, merge) => {
        await this.rpc('admin_merge_establishments', { p_keep: keep, p_merge: merge })
      },
      enqueueRefresh: async (kind, target) => {
        await this.rpc('admin_enqueue_refresh', { p_kind: kind, p_target: target })
      },
      runNow: async () => {
        const { data } = await this.client.auth.getSession()
        const token = data.session?.access_token
        if (!token) return false
        try {
          const res = await fetch('/api/admin/run', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
          return res.status === 202
        } catch {
          return false
        }
      },
      setProviderLimit: async (provider, limit, enabled) => {
        await this.rpc('admin_set_provider_limit', { p_provider: provider, p_monthly_limit: limit, p_enabled: enabled })
      },
      saveMarket: (input) => this.rpc<string>('admin_save_market', { p: input }),
      dismissCoverage: async (cell) => {
        await this.rpc('admin_dismiss_coverage', { p_cell: cell })
      },
      history: (id) => this.rpc<ListingHistory>('admin_listing_history', { p_establishment: id }),
    },
    stats: () => this.rpc('admin_stats'),
    listEstablishments: async () => {
      const rows = check(await this.client.from('establishments').select(EST_SELECT).order('name').limit(2000))
      return rows.map(mapEstablishment)
    },
    saveEstablishment: (input: EstablishmentInput) =>
      this.rpc<string>('admin_save_establishment', {
        p: {
          id: input.id ?? null,
          slug: input.slug,
          name: input.name,
          kind: input.kind,
          market_id: input.marketId,
          neighborhood: input.neighborhood,
          city: input.city,
          state: input.state,
          address: input.address,
          postal_code: input.postalCode,
          lat: input.lat,
          lng: input.lng,
          timezone: input.timezone,
          phone: input.phone,
          website: input.website,
          description: input.description,
          price_level: input.priceLevel,
          amenities: input.amenities,
          hh_status: input.hhStatus,
          hh_source_note: input.hhSourceNote,
          status: input.status,
          windows: input.windows,
          exceptions: input.exceptions,
          specials: input.specials,
        },
      }),
    deleteEstablishment: async (id) => {
      check(await this.client.from('establishments').delete().eq('id', id))
    },
    verifyListing: async (id, kind, note, url) => {
      await this.rpc('admin_verify_listing', { p_establishment: id, p_source_kind: kind, p_source_note: note, p_source_url: url })
    },
    listSources: async (id) => {
      const rows = check(await this.client.from('listing_sources').select('*').eq('establishment_id', id).order('created_at', { ascending: false }))
      return rows.map(
        (r: Row): ListingSource => ({ id: r.id, establishmentId: r.establishment_id, kind: r.kind, url: r.url, note: r.note, observedOn: r.observed_on, createdAt: r.created_at }),
      )
    },
    addPhoto: async (establishmentId, file, alt, attribution) => {
      const path = `${establishmentId}/${crypto.randomUUID()}.jpg`
      const { error } = await this.client.storage.from('establishment-photos').upload(path, file, { contentType: file.type || 'image/jpeg', cacheControl: '31536000' })
      if (error) throw new ApiError('Upload failed.')
      check(await this.client.from('establishment_photos').insert({ establishment_id: establishmentId, url: this.publicUrl('establishment-photos', path), alt, attribution }))
    },
    deletePhoto: async (photoId) => {
      const rows = check(await this.client.from('establishment_photos').delete().eq('id', photoId).select('url'))
      const path = rows[0] ? this.pathFromUrl('establishment-photos', rows[0].url) : null
      if (path) await this.client.storage.from('establishment-photos').remove([path])
    },
    listSubmissions: async (status) => {
      const rows = check(
        await this.client
          .from('establishment_submissions')
          .select('*, submitter:profiles!establishment_submissions_user_id_fkey(username)')
          .eq('status', status)
          .order('created_at', { ascending: false })
          .limit(200),
      )
      return rows.map(
        (r: Row): Submission => ({
          id: r.id,
          kind: r.kind,
          establishmentId: r.establishment_id,
          payload: r.payload,
          status: r.status,
          userId: r.user_id,
          submitterUsername: one(r.submitter)?.username ?? null,
          adminNote: r.admin_note,
          createdAt: r.created_at,
          reviewedAt: r.reviewed_at,
        }),
      )
    },
    reviewSubmission: async (id, status, note) => {
      await this.rpc('admin_review_submission', { p_submission: id, p_status: status, p_note: note })
    },
    listReports: async () => {
      const rows = await this.rpc<Row[]>('admin_list_reports', { p_status: 'open' })
      return rows.map((r) => ({ ...r, review: r.review ? this.mapReview(r.review) : null }) as ReviewReport)
    },
    moderateReview: async (visitId, status) => {
      await this.rpc('admin_moderate_review', { p_visit: visitId, p_status: status })
    },
    excludeVisit: async (visitId, excluded) => {
      await this.rpc('admin_set_visit_excluded', { p_visit: visitId, p_excluded: excluded })
    },
    dismissReport: async (id) => {
      await this.rpc('admin_dismiss_report', { p_report: id })
    },
    listUsers: (query) => this.rpc('admin_list_users', { p_query: query }),
    setSuspended: async (userId, suspended, reason) => {
      await this.rpc('admin_set_suspended', { p_user: userId, p_suspended: suspended, p_reason: reason })
    },
    setRole: async (userId, role) => {
      await this.rpc('admin_set_role', { p_user: userId, p_role: role })
    },
    listPublicCollections: async () => {
      const rows = check(
        await this.client.from('collections').select('*, collection_items(*), owner:profiles!collections_user_id_fkey(username)').eq('visibility', 'public').order('updated_at', { ascending: false }).limit(200),
      )
      return rows.map((r: Row) => mapCollection(r, null))
    },
    setFeatured: async (collectionId, featured) => {
      await this.rpc('admin_set_featured', { p_collection: collectionId, p_featured: featured })
    },
  }
}
