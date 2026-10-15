/**
 * On-device demo backend (used when no Supabase project is configured).
 *
 * Mirrors the server's privacy rules so the UI behaves the same in both modes, and uses
 * the same core rating engine for community stats. Data lives in localStorage on this
 * device only. Listings are FICTIONAL demo data and are badged as such in the UI.
 */

import seed from '../demo-seed.json'
import { communityStats, visitComposite, isValidScore, DEFAULT_WEIGHTS, validateWeights } from '@/core/rating'
import { CATEGORY_BY_KEY, PRIMARY_CATEGORY_KEYS, TAG_BY_KEY } from '@/core/categories'
import { validateUsername } from '@/core/listing'
import type {
  AdminUser,
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
import { ApiError, type AdminApi, type Api, type AuthUser, type EstablishmentInput, type ProfileView, type UserCard } from '../api'

const STORAGE_KEY = 'aour-demo-v1'
import { DEMO_CODE } from './constants'
export { DEMO_CODE }
const MARKET_ID = 'demo-market-treasure-coast'
const DAY = 86_400_000

type StoredEstablishment = Omit<Establishment, 'community'>
interface StoredUser {
  id: string
  email: string
  profile: Profile
}
interface StoredReport {
  id: string
  visitId: string
  reporterId: string
  reason: ReviewReport['reason']
  details: string | null
  status: ReviewReport['status']
  createdAt: string
}
interface State {
  version: 1
  sessionUserId: string | null
  users: StoredUser[]
  establishments: StoredEstablishment[]
  visits: (Visit & { excluded?: boolean; reportCount?: number })[]
  saved: (SavedPlace & { userId: string })[]
  collections: Collection[]
  follows: { followerId: string; followeeId: string; createdAt: string }[]
  prefs: Record<string, Preferences>
  submissions: Submission[]
  reports: StoredReport[]
  sources: ListingSource[]
}

const MARKET: Market = {
  id: MARKET_ID,
  slug: 'treasure-coast',
  name: 'Stuart & Martin County',
  region: 'Florida',
  lat: 27.1975,
  lng: -80.2528,
  timezone: 'America/New_York',
  areas: ['Downtown Stuart', 'Stuart', 'Palm City', 'Jensen Beach', 'Hutchinson Island', "Sewall's Point", 'Port Salerno', 'Hobe Sound'],
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const dateAgo = (days: number) => iso(days * DAY).slice(0, 10)
const id = () => crypto.randomUUID()
const tick = () => new Promise((r) => setTimeout(r, 60))

function initialState(): State {
  const users: StoredUser[] = seed.users.map((u, i) => ({
    id: u.id,
    email: u.email,
    profile: {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      avatarUrl: null,
      bio: u.bio,
      homeCity: u.homeCity,
      marketId: MARKET_ID,
      visibility: 'public',
      defaultVisitVisibility: 'public',
      contributeToCommunity: true,
      role: 'user',
      suspended: false,
      createdAt: iso((300 - i * 20) * DAY),
    },
  }))
  const establishments: StoredEstablishment[] = seed.establishments.map((e) => ({
    id: e.id,
    slug: e.slug,
    name: e.name,
    kind: e.kind as Establishment['kind'],
    marketId: MARKET_ID,
    neighborhood: e.neighborhood,
    city: e.city,
    state: e.state,
    address: e.address,
    postalCode: null,
    lat: e.lat,
    lng: e.lng,
    timezone: 'America/New_York',
    phone: null,
    website: null,
    description: e.description,
    priceLevel: e.priceLevel as Establishment['priceLevel'],
    amenities: e.amenities,
    hhStatus: e.hhStatus as Establishment['hhStatus'],
    hhVerifiedAt: e.verifiedDaysAgo === null ? null : iso(e.verifiedDaysAgo * DAY),
    hhSourceNote: e.hhSourceNote,
    windows: e.windows.map((w) => ({ ...w })),
    exceptions: [],
    specials: e.specials.map((s) => ({ ...s, kind: s.kind as 'drink' | 'food' | 'other' })),
    photos: [],
    status: 'published',
    isDemo: true,
    createdAt: iso(e.createdDaysAgo * DAY),
    updatedAt: iso(e.createdDaysAgo * DAY),
  }))
  const visits: State['visits'] = seed.visits.map((v) => ({
    id: v.id,
    userId: v.userId,
    establishmentId: v.establishmentId,
    visitedOn: dateAgo(v.daysAgo),
    mode: v.mode as Visit['mode'],
    scores: v.scores as Record<string, number | null>,
    tags: v.tags,
    note: null,
    review: v.review,
    reviewStatus: v.review ? 'published' : null,
    visibility: 'public',
    photoUrls: [],
    createdAt: iso(v.daysAgo * DAY),
    updatedAt: iso(v.daysAgo * DAY),
  }))
  // A demo public collection so shared links have something to show.
  const collections: Collection[] = [
    {
      id: 'demo-collection-1',
      userId: users[0].id,
      ownerUsername: users[0].profile.username,
      name: 'Sunset happy hours',
      description: 'Where to be at golden hour.',
      visibility: 'public',
      shareId: 'sunsets',
      featured: true,
      items: establishments
        .filter((e) => e.amenities.includes('waterfront') || e.amenities.includes('rooftop'))
        .map((e, i) => ({ establishmentId: e.id, note: null, position: i })),
      createdAt: iso(40 * DAY),
      updatedAt: iso(40 * DAY),
    },
  ]
  return {
    version: 1,
    sessionUserId: null,
    users,
    establishments,
    visits,
    saved: [{ userId: users[0].id, establishmentId: establishments[2].id, list: 'favorite', createdAt: iso(5 * DAY) }],
    collections,
    follows: [{ followerId: users[1].id, followeeId: users[0].id, createdAt: iso(20 * DAY) }],
    prefs: {},
    submissions: [
      {
        id: 'demo-sub-1',
        kind: 'new_place',
        establishmentId: null,
        payload: { name: 'Example Oyster Shack', area: 'Port Salerno', happyHour: 'Weekdays 3–6pm (unconfirmed)' },
        status: 'pending',
        userId: users[3].id,
        submitterUsername: users[3].profile.username,
        adminNote: null,
        createdAt: iso(2 * DAY),
        reviewedAt: null,
      },
    ],
    reports: [],
    sources: [],
  }
}

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as State
      if (s.version === 1) return s
    }
  } catch {
    /* storage unavailable or corrupt → start fresh */
  }
  return initialState()
}

export class DemoApi implements Api {
  readonly mode = 'demo' as const
  private state: State = load()
  private listeners = new Set<(u: AuthUser | null) => void>()

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      /* quota exceeded or private mode — keep in memory */
    }
  }

  private emit() {
    const u = this.currentAuth()
    this.listeners.forEach((cb) => cb(u))
  }

  private currentAuth(): AuthUser | null {
    const u = this.state.users.find((x) => x.id === this.state.sessionUserId)
    return u ? { id: u.id, email: u.email } : null
  }

  private me(): StoredUser {
    const u = this.state.users.find((x) => x.id === this.state.sessionUserId)
    if (!u) throw new ApiError('Sign in to continue.', 'auth')
    return u
  }

  private activeMe(): StoredUser {
    const u = this.me()
    if (u.profile.suspended) throw new ApiError('Your account is suspended.', 'suspended')
    return u
  }

  private requireAdmin(): StoredUser {
    const u = this.me()
    if (u.profile.role !== 'admin' || u.profile.suspended) throw new ApiError('Administrator access required.', 'forbidden')
    return u
  }

  private user(id: string) {
    return this.state.users.find((u) => u.id === id)
  }

  private card(userId: string): UserCard {
    const p = this.user(userId)!.profile
    return { id: p.id, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl }
  }

  private profileIsPublic(userId: string) {
    const p = this.user(userId)?.profile
    return !!p && p.visibility === 'public' && !p.suspended
  }

  private canViewVisit(v: State['visits'][number]) {
    const me = this.state.sessionUserId
    if (v.userId === me) return true
    if (this.user(me ?? '')?.profile.role === 'admin') return true
    return v.visibility === 'public' && !v.excluded && this.profileIsPublic(v.userId)
  }

  private withCommunity(e: StoredEstablishment): Establishment {
    const contributing = this.state.visits.filter((v) => {
      if (v.establishmentId !== e.id || v.excluded || v.visibility !== 'public') return false
      const p = this.user(v.userId)?.profile
      return !!p && p.contributeToCommunity && !p.suspended
    })
    return { ...e, community: communityStats(contributing.map((v) => ({ userId: v.userId, scores: v.scores, tags: v.tags }))) }
  }

  private toReview(v: State['visits'][number]): PublicReview {
    return {
      visitId: v.id,
      establishmentId: v.establishmentId,
      user: this.card(v.userId),
      visitedOn: v.visitedOn,
      composite: visitComposite(v.scores),
      scores: v.scores,
      tags: v.tags,
      review: v.reviewStatus === 'published' ? v.review : null,
      photoUrls: v.photoUrls,
      createdAt: v.createdAt,
    }
  }

  // Auth -----------------------------------------------------------------------
  async getUser() {
    return this.currentAuth()
  }

  onAuthChange(cb: (u: AuthUser | null) => void) {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  async sendEmailCode(email: string) {
    await tick()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError('Enter a valid email address.')
  }

  async verifyEmailCode(email: string, code: string) {
    await tick()
    if (code.trim() !== DEMO_CODE) throw new ApiError(`In demo mode the code is ${DEMO_CODE}.`)
    const normalized = email.trim().toLowerCase()
    let u = this.state.users.find((x) => x.email === normalized)
    if (!u) {
      const isFirstRealUser = this.state.users.every((x) => x.email.endsWith('@demo.aour.app'))
      let base = normalized.split('@')[0].replace(/[^a-z0-9_]/g, '').slice(0, 18)
      if (base.length < 3) base = `${base}friend`
      let username = base
      while (this.state.users.some((x) => x.profile.username === username) || validateUsername(username)) {
        username = `${base}${Math.floor(1000 + Math.random() * 9000)}`
      }
      const uid = id()
      u = {
        id: uid,
        email: normalized,
        profile: {
          id: uid,
          username,
          displayName: base.charAt(0).toUpperCase() + base.slice(1),
          avatarUrl: null,
          bio: null,
          homeCity: null,
          marketId: MARKET_ID,
          visibility: 'public',
          defaultVisitVisibility: 'public',
          contributeToCommunity: true,
          // Demo convenience: the first account on this device can explore the admin tools.
          role: isFirstRealUser ? 'admin' : 'user',
          suspended: false,
          createdAt: new Date().toISOString(),
        },
      }
      this.state.users.push(u)
    }
    this.state.sessionUserId = u.id
    this.persist()
    this.emit()
  }

  async signInWithApple() {
    throw new ApiError('Sign in with Apple is available once Aour is connected to its backend.')
  }

  async signOut() {
    this.state.sessionUserId = null
    this.persist()
    this.emit()
  }

  async deleteAccount() {
    const me = this.me()
    const s = this.state
    s.users = s.users.filter((u) => u.id !== me.id)
    s.visits = s.visits.filter((v) => v.userId !== me.id)
    s.saved = s.saved.filter((x) => x.userId !== me.id)
    s.collections = s.collections.filter((c) => c.userId !== me.id)
    s.follows = s.follows.filter((f) => f.followerId !== me.id && f.followeeId !== me.id)
    s.reports = s.reports.filter((r) => r.reporterId !== me.id)
    s.submissions = s.submissions.map((x) => (x.userId === me.id ? { ...x, userId: null, submitterUsername: null } : x))
    delete s.prefs[me.id]
    s.sessionUserId = null
    this.persist()
    this.emit()
  }

  // Listings ---------------------------------------------------------------------
  async listMarkets() {
    return [MARKET]
  }

  async listEstablishments(marketId: string) {
    await tick()
    return this.state.establishments.filter((e) => e.marketId === marketId && e.status === 'published').map((e) => this.withCommunity(e))
  }

  async getEstablishment(slugOrId: string) {
    await tick()
    const isAdmin = this.user(this.state.sessionUserId ?? '')?.profile.role === 'admin'
    const e = this.state.establishments.find((x) => (x.slug === slugOrId || x.id === slugOrId) && (x.status === 'published' || isAdmin))
    return e ? this.withCommunity(e) : null
  }

  async establishmentReviews(establishmentId: string, opts: { followingOnly?: boolean; before?: string } = {}) {
    await tick()
    const me = this.state.sessionUserId
    const following = new Set(this.state.follows.filter((f) => f.followerId === me).map((f) => f.followeeId))
    return this.state.visits
      .filter(
        (v) =>
          v.establishmentId === establishmentId &&
          v.visibility === 'public' &&
          !v.excluded &&
          this.profileIsPublic(v.userId) &&
          (!opts.followingOnly || following.has(v.userId)) &&
          (!opts.before || v.createdAt < opts.before),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((v) => this.toReview(v))
  }

  // Me ---------------------------------------------------------------------------
  async getMyProfile() {
    return this.state.users.find((u) => u.id === this.state.sessionUserId)?.profile ?? null
  }

  async updateMyProfile(patch: Partial<Profile>) {
    const me = this.activeMe()
    if (patch.username !== undefined) {
      const err = validateUsername(patch.username)
      if (err) throw new ApiError(err)
      if (this.state.users.some((u) => u.id !== me.id && u.profile.username === patch.username)) throw new ApiError('That username is taken.')
    }
    if (patch.displayName !== undefined && !patch.displayName.trim()) throw new ApiError('Add a display name.')
    const allowed: (keyof Profile)[] = ['username', 'displayName', 'bio', 'homeCity', 'marketId', 'visibility', 'defaultVisitVisibility', 'contributeToCommunity', 'avatarUrl']
    for (const k of allowed) if (k in patch) (me.profile as unknown as Record<string, unknown>)[k] = patch[k]
    this.persist()
    return me.profile
  }

  async uploadAvatar(file: Blob) {
    return blobToDataUrl(file)
  }

  async getPreferences(): Promise<Preferences> {
    const me = this.state.sessionUserId
    return (me && this.state.prefs[me]) || { weights: { ...DEFAULT_WEIGHTS } }
  }

  async savePreferences(prefs: Preferences) {
    const me = this.activeMe()
    const v = validateWeights(prefs.weights)
    if (!v.ok) throw new ApiError(v.error!)
    this.state.prefs[me.id] = prefs
    this.persist()
  }

  async listMyVisits() {
    await tick()
    const me = this.state.sessionUserId
    return this.state.visits.filter((v) => v.userId === me).map(({ excluded: _e, reportCount: _r, ...v }) => v)
  }

  async saveVisit(input: Parameters<Api['saveVisit']>[0]) {
    await tick()
    const me = this.activeMe()
    const est = this.state.establishments.find((e) => e.id === input.establishmentId && e.status === 'published')
    if (!est) throw new ApiError('That place is not available.')
    for (const [k, s] of Object.entries(input.scores)) {
      if (!CATEGORY_BY_KEY[k]) throw new ApiError(`Unknown category ${k}`)
      if (s !== null && !isValidScore(s)) throw new ApiError('Scores go from 1 to 10 in half steps.')
    }
    if (!PRIMARY_CATEGORY_KEYS.some((k) => typeof input.scores[k] === 'number')) throw new ApiError('Score at least one of the main categories.')
    if (input.tags.some((t) => !TAG_BY_KEY[t])) throw new ApiError('Unknown tag')
    if (input.visitedOn > new Date(Date.now() + DAY).toISOString().slice(0, 10)) throw new ApiError("Visits can't be in the future.")
    if (!input.id && this.state.visits.filter((v) => v.userId === me.id && v.createdAt > iso(DAY)).length >= 40) {
      throw new ApiError("You're doing that a lot — please try again later.")
    }
    const newPhotos = await Promise.all((input.newPhotos ?? []).map(blobToDataUrl))
    const photoUrls = [...(input.keepPhotoUrls ?? []), ...newPhotos]
    if (photoUrls.length > 4) throw new ApiError('Up to 4 photos per visit.')
    const now = new Date().toISOString()
    const review = input.review?.trim() || null
    if (review && (review.match(/(https?:\/\/|www\.)/gi)?.length ?? 0) > 1) throw new ApiError('Reviews can include at most one link.')
    const existing = input.id ? this.state.visits.find((v) => v.id === input.id && v.userId === me.id) : undefined
    if (input.id && !existing) throw new ApiError('Visit not found.')
    const moderated = existing?.review && existing.reviewStatus && existing.reviewStatus !== 'published'
    const keptReview = !review && moderated ? existing!.review : review
    const visit: State['visits'][number] = {
      id: existing?.id ?? id(),
      userId: me.id,
      establishmentId: existing?.establishmentId ?? input.establishmentId,
      visitedOn: input.visitedOn,
      mode: input.mode,
      scores: { ...input.scores },
      tags: [...new Set(input.tags)],
      note: input.note?.trim() || null,
      review: keptReview,
      reviewStatus: keptReview ? (existing?.reviewStatus ?? 'published') : null,
      visibility: input.visibility,
      photoUrls,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      excluded: existing?.excluded,
      reportCount: existing?.reportCount,
    }
    this.state.visits = existing ? this.state.visits.map((v) => (v.id === visit.id ? visit : v)) : [...this.state.visits, visit]
    this.persist()
    return visit.id
  }

  async deleteVisit(visitId: string) {
    const me = this.me()
    const v = this.state.visits.find((x) => x.id === visitId)
    if (v && v.userId === me.id && me.profile.role !== 'admin' && v.reviewStatus && v.reviewStatus !== 'published') {
      throw new ApiError("This rating's review is under moderation, so it can't be deleted right now.")
    }
    this.state.visits = this.state.visits.filter((v) => !(v.id === visitId && (v.userId === me.id || me.profile.role === 'admin')))
    this.persist()
  }

  async listSaved() {
    const me = this.state.sessionUserId
    return this.state.saved.filter((s) => s.userId === me).map(({ userId: _u, ...s }) => s)
  }

  async setSaved(establishmentId: string, list: SavedPlace['list'], saved: boolean) {
    const me = this.activeMe()
    this.state.saved = this.state.saved.filter((s) => !(s.userId === me.id && s.establishmentId === establishmentId && s.list === list))
    if (saved) this.state.saved.push({ userId: me.id, establishmentId, list, createdAt: new Date().toISOString() })
    this.persist()
  }

  // Collections --------------------------------------------------------------------
  async listMyCollections() {
    const me = this.state.sessionUserId
    return this.state.collections.filter((c) => c.userId === me).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async getCollectionByShareId(shareId: string) {
    await tick()
    const c = this.state.collections.find((x) => x.shareId === shareId)
    if (!c) return null
    const owner = this.user(c.userId)
    if (c.userId === this.state.sessionUserId || (c.visibility === 'public' && owner && !owner.profile.suspended)) return c
    return null
  }

  async saveCollection(input: Parameters<Api['saveCollection']>[0]) {
    const me = this.activeMe()
    const name = input.name.trim()
    if (!name || name.length > 60) throw new ApiError('Give your collection a name (up to 60 characters).')
    const now = new Date().toISOString()
    if (input.id) {
      const c = this.state.collections.find((x) => x.id === input.id && x.userId === me.id)
      if (!c) throw new ApiError('Collection not found.')
      Object.assign(c, { name, description: input.description, visibility: input.visibility, updatedAt: now })
      this.persist()
      return c
    }
    const c: Collection = {
      id: id(),
      userId: me.id,
      ownerUsername: me.profile.username,
      name,
      description: input.description,
      visibility: input.visibility,
      shareId: id().replace(/-/g, '').slice(0, 12),
      featured: false,
      items: [],
      createdAt: now,
      updatedAt: now,
    }
    this.state.collections.push(c)
    this.persist()
    return c
  }

  async deleteCollection(collectionId: string) {
    const me = this.me()
    this.state.collections = this.state.collections.filter((c) => !(c.id === collectionId && c.userId === me.id))
    this.persist()
  }

  async setCollectionItem(collectionId: string, establishmentId: string, included: boolean) {
    const me = this.activeMe()
    const c = this.state.collections.find((x) => x.id === collectionId && x.userId === me.id)
    if (!c) throw new ApiError('Collection not found.')
    if (included && !this.state.establishments.some((e) => e.id === establishmentId && e.status === 'published')) throw new ApiError('That place is not available.')
    c.items = c.items.filter((i) => i.establishmentId !== establishmentId)
    if (included) c.items.push({ establishmentId, note: null, position: c.items.length })
    c.updatedAt = new Date().toISOString()
    this.persist()
  }

  async featuredCollections() {
    return this.state.collections.filter((c) => c.featured && c.visibility === 'public')
  }

  // Social -------------------------------------------------------------------------
  async getProfile(username: string): Promise<ProfileView | null> {
    await tick()
    const u = this.state.users.find((x) => x.profile.username === username.toLowerCase())
    const me = this.state.sessionUserId
    if (!u || (u.profile.suspended && this.user(me ?? '')?.profile.role !== 'admin')) return null
    const visible = u.profile.visibility === 'public' || u.id === me
    const visits = this.state.visits.filter((v) => v.userId === u.id && (v.visibility === 'public' || u.id === me))
    return {
      id: u.id,
      username: u.profile.username,
      displayName: u.profile.displayName,
      avatarUrl: u.profile.avatarUrl,
      bio: visible ? u.profile.bio : null,
      homeCity: visible ? u.profile.homeCity : null,
      isPrivate: !visible,
      placesRated: visible ? new Set(visits.map((v) => v.establishmentId)).size : 0,
      visitsLogged: visible ? visits.length : 0,
      followers: this.state.follows.filter((f) => f.followeeId === u.id).length,
      following: this.state.follows.filter((f) => f.followerId === u.id).length,
      isFollowing: this.state.follows.some((f) => f.followerId === me && f.followeeId === u.id),
      createdAt: u.profile.createdAt,
    }
  }

  async profileReviews(userId: string) {
    const me = this.state.sessionUserId
    return this.state.visits
      .filter((v) => v.userId === userId && (userId === me || (this.profileIsPublic(userId) && v.visibility === 'public' && !v.excluded)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((v) => this.toReview(v))
  }

  async profileFavorites(userId: string) {
    if (userId !== this.state.sessionUserId && !this.profileIsPublic(userId)) return []
    return this.state.saved.filter((s) => s.userId === userId && s.list === 'favorite').map((s) => s.establishmentId)
  }

  async profileCollections(userId: string) {
    const me = this.state.sessionUserId
    return this.state.collections.filter((c) => c.userId === userId && (c.visibility === 'public' || userId === me))
  }

  async searchProfiles(query: string) {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    return this.state.users
      .filter((u) => u.profile.visibility === 'public' && !u.profile.suspended)
      .filter((u) => u.profile.username.startsWith(q) || u.profile.displayName.toLowerCase().includes(q))
      .slice(0, 20)
      .map((u) => this.card(u.id))
  }

  async setFollowing(userId: string, follow: boolean) {
    const me = this.activeMe()
    if (userId === me.id) throw new ApiError("You can't follow yourself.")
    this.state.follows = this.state.follows.filter((f) => !(f.followerId === me.id && f.followeeId === userId))
    if (follow) {
      if (!this.profileIsPublic(userId)) throw new ApiError('This profile is private.')
      this.state.follows.push({ followerId: me.id, followeeId: userId, createdAt: new Date().toISOString() })
    }
    this.persist()
  }

  async listFollowing() {
    const me = this.state.sessionUserId
    return this.state.follows.filter((f) => f.followerId === me && this.user(f.followeeId)).map((f) => this.card(f.followeeId))
  }

  async feed(before?: string): Promise<FeedItem[]> {
    await tick()
    const me = this.state.sessionUserId
    const followees = new Set(this.state.follows.filter((f) => f.followerId === me).map((f) => f.followeeId).filter((u) => this.profileIsPublic(u)))
    const items: FeedItem[] = [
      ...this.state.visits
        .filter((v) => followees.has(v.userId) && v.visibility === 'public' && !v.excluded)
        .map((v): FeedItem => ({ kind: 'visit', id: `visit:${v.id}`, at: v.createdAt, review: this.toReview(v) })),
      ...this.state.saved
        .filter((s) => followees.has(s.userId) && s.list === 'favorite')
        .map((s): FeedItem => ({ kind: 'favorite', id: `fav:${s.userId}:${s.establishmentId}`, at: s.createdAt, user: this.card(s.userId), establishmentId: s.establishmentId })),
      ...this.state.collections
        .filter((c) => followees.has(c.userId) && c.visibility === 'public')
        .map((c): FeedItem => ({ kind: 'collection', id: `col:${c.id}`, at: c.createdAt, user: this.card(c.userId), collection: { id: c.id, name: c.name, shareId: c.shareId, itemCount: c.items.length } })),
    ]
    return items.filter((i) => !before || i.at < before).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30)
  }

  async friendActivity() {
    const me = this.state.sessionUserId
    const followees = new Set(this.state.follows.filter((f) => f.followerId === me).map((f) => f.followeeId))
    const cutoff = iso(30 * DAY)
    return this.state.visits
      .filter((v) => followees.has(v.userId) && v.visibility === 'public' && v.createdAt > cutoff && this.profileIsPublic(v.userId))
      .map((v) => ({ establishmentId: v.establishmentId, createdAt: v.createdAt }))
  }

  // Trust ----------------------------------------------------------------------------
  async reportReview(visitId: string, reason: ReviewReport['reason'], details: string | null) {
    const me = this.activeMe()
    const v = this.state.visits.find((x) => x.id === visitId)
    if (!v || !this.canViewVisit(v)) throw new ApiError('Review not found.')
    if (v.userId === me.id) throw new ApiError("You can't report your own review.")
    if (this.state.reports.some((r) => r.visitId === visitId && r.reporterId === me.id)) throw new ApiError("You've already reported this.")
    this.state.reports.push({ id: id(), visitId, reporterId: me.id, reason, details, status: 'open', createdAt: new Date().toISOString() })
    v.reportCount = (v.reportCount ?? 0) + 1
    const open = this.state.reports.filter((r) => r.visitId === visitId && r.status === 'open').length
    if (open >= 3 && v.reviewStatus === 'published') v.reviewStatus = 'hidden'
    this.persist()
  }

  async submit(kind: Submission['kind'], establishmentId: string | null, payload: Record<string, string>) {
    const me = this.activeMe()
    if (establishmentId && !this.state.establishments.some((e) => e.id === establishmentId && (e.status === 'published' || me.profile.role === 'admin'))) {
      throw new ApiError('That place is not available.')
    }
    if (this.state.submissions.filter((s) => s.userId === me.id && s.createdAt > iso(DAY)).length >= 10) {
      throw new ApiError("You're doing that a lot — please try again later.")
    }
    this.state.submissions.push({
      id: id(),
      kind,
      establishmentId,
      payload,
      status: 'pending',
      userId: me.id,
      submitterUsername: me.profile.username,
      adminNote: null,
      createdAt: new Date().toISOString(),
      reviewedAt: null,
    })
    if (kind === 'outdated' && establishmentId) {
      const cutoff = iso(30 * DAY)
      const reporters = new Set(this.state.submissions.filter((s) => s.kind === 'outdated' && s.establishmentId === establishmentId && s.status === 'pending' && s.createdAt > cutoff).map((s) => s.userId))
      const est = this.state.establishments.find((e) => e.id === establishmentId)
      if (est && reporters.size >= 3 && est.hhStatus === 'verified') est.hhStatus = 'outdated'
    }
    this.persist()
  }

  // Admin --------------------------------------------------------------------------------
  admin: AdminApi = {
    stats: async () => {
      this.requireAdmin()
      const s = this.state
      const weekAgo = iso(7 * DAY)
      const staleCutoff = iso(90 * DAY)
      return {
        users: s.users.length,
        newUsers7d: s.users.filter((u) => u.profile.createdAt > weekAgo).length,
        visits: s.visits.length,
        visits7d: s.visits.filter((v) => v.createdAt > weekAgo).length,
        establishments: s.establishments.filter((e) => e.status !== 'archived').length,
        published: s.establishments.filter((e) => e.status === 'published').length,
        pendingSubmissions: s.submissions.filter((x) => x.status === 'pending').length,
        openReports: s.reports.filter((r) => r.status === 'open').length,
        staleListings: s.establishments.filter((e) => e.status === 'published' && e.hhStatus !== 'none' && (e.hhStatus !== 'verified' || (e.hhVerifiedAt ?? '') < staleCutoff)).length,
      }
    },
    listEstablishments: async () => {
      this.requireAdmin()
      return this.state.establishments.map((e) => this.withCommunity(e)).sort((a, b) => a.name.localeCompare(b.name))
    },
    saveEstablishment: async (input: EstablishmentInput) => {
      const admin = this.requireAdmin()
      if (this.state.establishments.some((e) => e.slug === input.slug && e.id !== input.id)) throw new ApiError('That URL slug is already used.')
      const now = new Date().toISOString()
      const existing = input.id ? this.state.establishments.find((e) => e.id === input.id) : undefined
      if (input.id && !existing) throw new ApiError('Listing not found.')
      const { windows, exceptions, specials, ...fields } = input
      const hhStatus = input.hhStatus === 'verified' ? (existing?.hhStatus ?? 'unverified') : input.hhStatus
      const next: StoredEstablishment = {
        ...(existing ?? { photos: [], isDemo: false, createdAt: now, hhVerifiedAt: null }),
        ...fields,
        id: existing?.id ?? id(),
        hhStatus,
        windows: windows.map((w) => ({ ...w, id: id() })),
        exceptions: exceptions.map((x) => ({ ...x, id: id() })),
        specials: specials.map((x) => ({ ...x, id: id() })),
        updatedAt: now,
      } as StoredEstablishment
      this.state.establishments = existing ? this.state.establishments.map((e) => (e.id === next.id ? next : e)) : [...this.state.establishments, next]
      void admin
      this.persist()
      return next.id
    },
    deleteEstablishment: async (estId) => {
      this.requireAdmin()
      this.state.establishments = this.state.establishments.filter((e) => e.id !== estId)
      this.state.visits = this.state.visits.filter((v) => v.establishmentId !== estId)
      this.persist()
    },
    verifyListing: async (estId, kind, note, url) => {
      const admin = this.requireAdmin()
      const e = this.state.establishments.find((x) => x.id === estId)
      if (!e) throw new ApiError('Listing not found.')
      const now = new Date().toISOString()
      this.state.sources.push({ id: id(), establishmentId: estId, kind, note, url, observedOn: now.slice(0, 10), createdAt: now })
      if (e.hhStatus !== 'none') e.hhStatus = 'verified'
      e.hhVerifiedAt = now
      void admin
      this.persist()
    },
    listSources: async (estId) => {
      this.requireAdmin()
      return this.state.sources.filter((s) => s.establishmentId === estId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    addPhoto: async (estId, file, alt, attribution) => {
      this.requireAdmin()
      const e = this.state.establishments.find((x) => x.id === estId)
      if (!e) throw new ApiError('Listing not found.')
      e.photos.push({ id: id(), url: await blobToDataUrl(file), alt, attribution })
      this.persist()
    },
    deletePhoto: async (photoId) => {
      this.requireAdmin()
      for (const e of this.state.establishments) e.photos = e.photos.filter((p) => p.id !== photoId)
      this.persist()
    },
    listSubmissions: async (status) => {
      this.requireAdmin()
      return this.state.submissions.filter((s) => s.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    reviewSubmission: async (subId, status, note) => {
      this.requireAdmin()
      const s = this.state.submissions.find((x) => x.id === subId)
      if (s) Object.assign(s, { status, adminNote: note, reviewedAt: new Date().toISOString() })
      this.persist()
    },
    listReports: async () => {
      this.requireAdmin()
      return this.state.reports
        .filter((r) => r.status === 'open')
        .map((r): ReviewReport => {
          const v = this.state.visits.find((x) => x.id === r.visitId)
          return {
            id: r.id,
            visitId: r.visitId,
            reason: r.reason,
            details: r.details,
            status: r.status,
            createdAt: r.createdAt,
            review: v ? { ...this.toReview(v), review: v.review } : null,
            reporterUsername: this.user(r.reporterId)?.profile.username ?? null,
          }
        })
    },
    moderateReview: async (visitId, status) => {
      this.requireAdmin()
      const v = this.state.visits.find((x) => x.id === visitId)
      if (v && v.review) v.reviewStatus = status
      for (const r of this.state.reports) if (r.visitId === visitId && r.status === 'open') r.status = 'resolved'
      this.persist()
    },
    excludeVisit: async (visitId, excluded) => {
      this.requireAdmin()
      const v = this.state.visits.find((x) => x.id === visitId)
      if (v) v.excluded = excluded
      this.persist()
    },
    dismissReport: async (reportId) => {
      this.requireAdmin()
      const r = this.state.reports.find((x) => x.id === reportId)
      if (r) r.status = 'dismissed'
      this.persist()
    },
    listUsers: async (query) => {
      this.requireAdmin()
      const q = query.trim().toLowerCase()
      return this.state.users
        .filter((u) => !q || u.profile.username.includes(q) || u.profile.displayName.toLowerCase().includes(q))
        .map(
          (u): AdminUser => ({
            id: u.id,
            username: u.profile.username,
            displayName: u.profile.displayName,
            role: u.profile.role,
            suspended: u.profile.suspended,
            visits: this.state.visits.filter((v) => v.userId === u.id).length,
            createdAt: u.profile.createdAt,
          }),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    setSuspended: async (userId, suspended) => {
      const admin = this.requireAdmin()
      if (userId === admin.id) throw new ApiError('You cannot suspend yourself.')
      const u = this.user(userId)
      if (u) u.profile.suspended = suspended
      this.persist()
    },
    setRole: async (userId, role) => {
      const admin = this.requireAdmin()
      if (userId === admin.id && role !== 'admin') throw new ApiError('You cannot remove your own admin role.')
      const u = this.user(userId)
      if (u) u.profile.role = role
      this.persist()
    },
    listPublicCollections: async () => {
      this.requireAdmin()
      return this.state.collections.filter((c) => c.visibility === 'public')
    },
    setFeatured: async (collectionId, featured) => {
      this.requireAdmin()
      const c = this.state.collections.find((x) => x.id === collectionId && x.visibility === 'public')
      if (c) c.featured = featured
      this.persist()
    },
  }

  /** Test/demo helper: wipe local demo data. */
  reset() {
    this.state = initialState()
    this.persist()
    this.emit()
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}
