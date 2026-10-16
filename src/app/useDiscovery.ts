import { useMemo } from 'react'
import { useLocationState } from './location'
import { useNow } from './useNow'
import { useNearby, useRankings } from '@/data/hooks'

/** Everything discovery screens need: nearby listings, personal scores, time, search centre. */
export function useDiscovery() {
  const loc = useLocationState()
  // A named area of a launch market is searched in full (areas have no single centre point).
  const radiusMiles = loc.area && loc.market ? Math.max(loc.radiusMiles, loc.market.radiusMiles ?? 15) : loc.radiusMiles
  const listings = useNearby(loc.center?.point ?? null, radiusMiles)
  const { byPlace } = useRankings()
  const now = useNow()
  const personal = useMemo(() => new Map([...byPlace].map(([id, r]) => [id, r.score])), [byPlace])
  const point = loc.center?.point ?? null
  // Stable unless time/centre/radius actually change, so memoised filters don't recompute every render.
  const ctx = useMemo(() => ({ now, origin: point, radiusMiles }), [now, point?.lat, point?.lng, radiusMiles]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...loc, effectiveRadiusMiles: radiusMiles, listings, personal, rankingByPlace: byPlace, now, referencePoint: point, ctx }
}
