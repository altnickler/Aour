import { useMemo } from 'react'
import { useLocationState, useReferencePoint } from './location'
import { useNow } from './useNow'
import { useListings, useRankings } from '@/data/hooks'

/** Everything discovery screens need: market listings, personal scores, time, origin. */
export function useDiscovery() {
  const loc = useLocationState()
  const listings = useListings(loc.market?.id)
  const { byPlace } = useRankings()
  const now = useNow()
  const referencePoint = useReferencePoint()
  const personal = useMemo(() => new Map([...byPlace].map(([id, r]) => [id, r.score])), [byPlace])
  const ctxOrigin = loc.origin ?? referencePoint
  // Stable unless time/origin actually change, so memoised filters don't recompute every render.
  const ctx = useMemo(() => ({ now, origin: ctxOrigin }), [now, ctxOrigin?.lat, ctxOrigin?.lng]) // eslint-disable-line react-hooks/exhaustive-deps
  // `origin` (from loc) is the device location only; ctx.origin falls back to the market centre.
  return { ...loc, listings, personal, rankingByPlace: byPlace, now, referencePoint, ctx }
}
