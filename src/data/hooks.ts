/**
 * React Query hooks — the only way screens read or write data.
 * Query keys live here so invalidation stays consistent.
 */

import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type CollectionInput, type ProfilePatch } from './index'
import { useAuth } from '@/app/auth'
import { buildRankings, visitComposite, type RankingEntry } from '@/core/rating'
import type { Establishment, Preferences, SavedList, SavedPlace, Visit, VisitInput } from '@/core/types'

export const keys = {
  markets: ['markets'] as const,
  listings: (marketId: string) => ['listings', marketId] as const,
  place: (slug: string) => ['place', slug] as const,
  reviews: (id: string, following: boolean) => ['reviews', id, following] as const,
  me: (uid: string | null) => ['me', uid] as const,
  visits: (uid: string | null) => ['visits', uid] as const,
  saved: (uid: string | null) => ['saved', uid] as const,
  prefs: (uid: string | null) => ['prefs', uid] as const,
  collections: (uid: string | null) => ['collections', uid] as const,
  collection: (shareId: string) => ['collection', shareId] as const,
  featured: ['featured'] as const,
  following: (uid: string | null) => ['following', uid] as const,
  feed: (uid: string | null) => ['feed', uid] as const,
  friendActivity: (uid: string | null) => ['friend-activity', uid] as const,
  profile: (username: string) => ['profile', username] as const,
  profileReviews: (id: string) => ['profile-reviews', id] as const,
  profileFavorites: (id: string) => ['profile-favorites', id] as const,
  profileCollections: (id: string) => ['profile-collections', id] as const,
}

const FIVE_MIN = 5 * 60_000

export function useMarkets() {
  return useQuery({ queryKey: keys.markets, queryFn: () => api.listMarkets(), staleTime: 60 * 60_000 })
}

export function useListings(marketId: string | undefined) {
  return useQuery({
    queryKey: keys.listings(marketId ?? ''),
    queryFn: () => api.listEstablishments(marketId!),
    enabled: !!marketId,
    staleTime: FIVE_MIN,
  })
}

/** Index of the current market's listings by id. */
export function useListingIndex(marketId: string | undefined) {
  const q = useListings(marketId)
  const index = useMemo(() => new Map((q.data ?? []).map((e) => [e.id, e])), [q.data])
  return { ...q, index }
}

export function usePlace(slug: string) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: keys.place(slug),
    queryFn: () => api.getEstablishment(slug),
    staleTime: FIVE_MIN,
    // Instant render from the cached market list when available.
    placeholderData: () => {
      for (const [, list] of qc.getQueriesData<Establishment[]>({ queryKey: ['listings'] })) {
        const hit = list?.find((e) => e.slug === slug || e.id === slug)
        if (hit) return hit
      }
      return undefined
    },
  })
}

export function usePlaceReviews(establishmentId: string | undefined, followingOnly = false) {
  const { user } = useAuth()
  return useQuery({
    queryKey: keys.reviews(establishmentId ?? '', followingOnly),
    queryFn: () => api.establishmentReviews(establishmentId!, { followingOnly }),
    enabled: !!establishmentId && (!followingOnly || !!user),
    staleTime: 60_000,
  })
}

export function useMyVisits() {
  const { user } = useAuth()
  return useQuery({ queryKey: keys.visits(user?.id ?? null), queryFn: () => api.listMyVisits(), enabled: !!user })
}

export function usePreferences() {
  const { user } = useAuth()
  return useQuery({ queryKey: keys.prefs(user?.id ?? null), queryFn: () => api.getPreferences(), enabled: !!user, staleTime: Infinity })
}

/** Personal rankings recomputed on the client whenever visits or weights change. */
export function useRankings() {
  const visits = useMyVisits()
  const prefs = usePreferences()
  const rankings = useMemo<RankingEntry[]>(
    () => (visits.data ? buildRankings(visits.data, prefs.data?.weights) : []),
    [visits.data, prefs.data],
  )
  const byPlace = useMemo(() => new Map(rankings.map((r) => [r.establishmentId, r])), [rankings])
  return { rankings, byPlace, isLoading: visits.isLoading || prefs.isLoading, visits: visits.data ?? [], weights: prefs.data?.weights }
}

export function useSaved() {
  const { user } = useAuth()
  const q = useQuery({ queryKey: keys.saved(user?.id ?? null), queryFn: () => api.listSaved(), enabled: !!user })
  const has = useMemo(() => {
    const set = new Set((q.data ?? []).map((s) => `${s.list}:${s.establishmentId}`))
    return (list: SavedList, id: string) => set.has(`${list}:${id}`)
  }, [q.data])
  return { ...q, has }
}

export function useToggleSaved() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const key = keys.saved(user?.id ?? null)
  return useMutation({
    mutationFn: ({ id, list, saved }: { id: string; list: SavedList; saved: boolean }) => api.setSaved(id, list, saved),
    onMutate: async ({ id, list, saved }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<SavedPlace[]>(key)
      const rest = (prev ?? []).filter((s) => !(s.establishmentId === id && s.list === list))
      qc.setQueryData<SavedPlace[]>(key, saved ? [...rest, { establishmentId: id, list, createdAt: new Date().toISOString() }] : rest)
      return { prev }
    },
    onError: (_e, _v, ctx) => qc.setQueryData(key, ctx?.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
}

export function useSaveVisit() {
  const qc = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: (input: VisitInput & { id?: string }) => api.saveVisit(input),
    onSuccess: (_id, input) => {
      void qc.invalidateQueries({ queryKey: keys.visits(user?.id ?? null) })
      void qc.invalidateQueries({ queryKey: ['listings'] })
      void qc.invalidateQueries({ queryKey: ['place'] })
      void qc.invalidateQueries({ queryKey: ['reviews', input.establishmentId] })
    },
  })
}

export function useDeleteVisit() {
  const qc = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: (visit: Visit) => api.deleteVisit(visit.id),
    onMutate: async (visit) => {
      const key = keys.visits(user?.id ?? null)
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<Visit[]>(key)
      qc.setQueryData<Visit[]>(key, (prev ?? []).filter((v) => v.id !== visit.id))
      return { prev, key }
    },
    onError: (_e, _v, ctx) => ctx && qc.setQueryData(ctx.key, ctx.prev),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.visits(user?.id ?? null) })
      void qc.invalidateQueries({ queryKey: ['listings'] })
      void qc.invalidateQueries({ queryKey: ['place'] })
      void qc.invalidateQueries({ queryKey: ['reviews'] })
    },
  })
}

export function useSavePreferences() {
  const qc = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: (p: Preferences) => api.savePreferences(p),
    onMutate: (p) => {
      const key = keys.prefs(user?.id ?? null)
      const prev = qc.getQueryData<Preferences>(key)
      qc.setQueryData(key, p)
      return { prev, key }
    },
    onError: (_e, _v, ctx) => ctx && qc.setQueryData(ctx.key, ctx.prev),
  })
}

export function useUpdateProfile() {
  const qc = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: (patch: ProfilePatch) => api.updateMyProfile(patch),
    onSuccess: (p) => qc.setQueryData(keys.me(user?.id ?? null), p),
  })
}

export function useMyCollections() {
  const { user } = useAuth()
  return useQuery({ queryKey: keys.collections(user?.id ?? null), queryFn: () => api.listMyCollections(), enabled: !!user })
}

export function useCollectionMutations() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: keys.collections(user?.id ?? null) })
    void qc.invalidateQueries({ queryKey: ['collection'] })
  }
  return {
    save: useMutation({ mutationFn: (input: CollectionInput) => api.saveCollection(input), onSuccess: invalidate }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteCollection(id), onSuccess: invalidate }),
    setItem: useMutation({
      mutationFn: (v: { collectionId: string; establishmentId: string; included: boolean }) => api.setCollectionItem(v.collectionId, v.establishmentId, v.included),
      onSuccess: invalidate,
    }),
  }
}

export function useCollection(shareId: string) {
  return useQuery({ queryKey: keys.collection(shareId), queryFn: () => api.getCollectionByShareId(shareId) })
}

export function useFeaturedCollections() {
  return useQuery({ queryKey: keys.featured, queryFn: () => api.featuredCollections(), staleTime: FIVE_MIN })
}

export function useFollowing() {
  const { user } = useAuth()
  return useQuery({ queryKey: keys.following(user?.id ?? null), queryFn: () => api.listFollowing(), enabled: !!user })
}

export function useFeed() {
  const { user } = useAuth()
  return useQuery({ queryKey: keys.feed(user?.id ?? null), queryFn: () => api.feed(), enabled: !!user, staleTime: 60_000 })
}

export function useFriendActivity() {
  const { user } = useAuth()
  return useQuery({ queryKey: keys.friendActivity(user?.id ?? null), queryFn: () => api.friendActivity(), enabled: !!user, staleTime: FIVE_MIN })
}

export function useProfile(username: string) {
  return useQuery({ queryKey: keys.profile(username), queryFn: () => api.getProfile(username) })
}

export function useProfileReviews(userId: string | undefined) {
  return useQuery({ queryKey: keys.profileReviews(userId ?? ''), queryFn: () => api.profileReviews(userId!), enabled: !!userId })
}

export function useProfileFavorites(userId: string | undefined) {
  return useQuery({ queryKey: keys.profileFavorites(userId ?? ''), queryFn: () => api.profileFavorites(userId!), enabled: !!userId })
}

export function useProfileCollections(userId: string | undefined) {
  return useQuery({ queryKey: keys.profileCollections(userId ?? ''), queryFn: () => api.profileCollections(userId!), enabled: !!userId })
}

export function useFollow() {
  const qc = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: ({ userId, follow }: { userId: string; follow: boolean; username: string }) => api.setFollowing(userId, follow),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: keys.profile(v.username) })
      void qc.invalidateQueries({ queryKey: keys.following(user?.id ?? null) })
      void qc.invalidateQueries({ queryKey: keys.feed(user?.id ?? null) })
      void qc.invalidateQueries({ queryKey: keys.friendActivity(user?.id ?? null) })
    },
  })
}

/** Composite of a single visit with the user's weights (for history rows). */
export function useVisitScore() {
  const prefs = usePreferences()
  return (v: Pick<Visit, 'scores'>) => visitComposite(v.scores, prefs.data?.weights)
}
