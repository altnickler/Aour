import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMarkets } from '@/data/hooks'
import { coarsen, type LatLng } from '@/core/listing'
import type { Market } from '@/core/types'

const STORAGE_KEY = 'aour-place-v1'

interface Stored {
  marketSlug: string | null
  area: string | null
  onboarded: boolean
}

interface LocationState {
  market: Market | undefined
  markets: Market[]
  area: string | null
  /** Coarsened device location, only after the user asked for "near me". Never persisted or sent. */
  origin: LatLng | null
  locating: boolean
  locationError: string | null
  onboarded: boolean
  setMarket: (slug: string) => void
  setArea: (area: string | null) => void
  requestLocation: () => void
  clearLocation: () => void
  completeOnboarding: () => void
}

const Ctx = createContext<LocationState | null>(null)

function read(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { marketSlug: null, area: null, onboarded: false, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { marketSlug: null, area: null, onboarded: false }
}

export function LocationProvider({ children }: { children: ReactNode }) {
  const markets = useMarkets()
  const [stored, setStored] = useState<Stored>(read)
  const [origin, setOrigin] = useState<LatLng | null>(null)
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    } catch {
      /* ignore */
    }
  }, [stored])

  const list = useMemo(() => markets.data ?? [], [markets.data])
  const market = list.find((m) => m.slug === stored.marketSlug) ?? list[0]

  const requestLocation = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setLocationError('Location is not available on this device.')
      return
    }
    setLocating(true)
    setLocationError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setOrigin(coarsen({ lat: pos.coords.latitude, lng: pos.coords.longitude }))
        setLocating(false)
      },
      (err) => {
        setLocating(false)
        setLocationError(err.code === err.PERMISSION_DENIED ? 'Location permission was denied. You can pick an area instead.' : 'Could not get your location.')
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    )
  }, [])

  const value: LocationState = {
    market,
    markets: list,
    area: stored.area,
    origin,
    locating,
    locationError,
    onboarded: stored.onboarded,
    setMarket: (slug) => setStored((s) => ({ ...s, marketSlug: slug, area: null })),
    setArea: (area) => setStored((s) => ({ ...s, area })),
    requestLocation,
    clearLocation: () => setOrigin(null),
    completeOnboarding: () => setStored((s) => ({ ...s, onboarded: true })),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useLocationState() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useLocationState outside LocationProvider')
  return v
}

/** Reference point for distances: device location if shared, else the chosen area/market centre. */
export function useReferencePoint(): LatLng | null {
  const { origin, market } = useLocationState()
  return origin ?? (market ? { lat: market.lat, lng: market.lng } : null)
}
