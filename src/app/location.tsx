import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMarkets } from '@/data/hooks'
import { coarsen, distanceMiles, type LatLng } from '@/core/listing'
import { DEFAULT_RADIUS_MILES, RADIUS_OPTIONS } from '@/core/discovery'
import type { Market } from '@/core/types'

const STORAGE_KEY = 'aour-place-v2'

/** A searched city/address, coarsened to ~1 km before it is kept on this device. */
interface ChosenPlace {
  label: string
  lat: number
  lng: number
}

interface Stored {
  marketSlug: string | null
  area: string | null
  onboarded: boolean
  place: ChosenPlace | null
  radiusMiles: number
}

/**
 * Where discovery is centred, and how we describe it to the user:
 *  device — the device location the user just shared ("Near me")
 *  place  — a city/address the user searched for or picked
 *  market — no choice made yet: a launch market's centre, labelled with its name (never "Near me")
 */
export interface SearchCenter {
  kind: 'device' | 'place' | 'market'
  point: LatLng
  label: string
}

interface LocationState {
  center: SearchCenter | null
  radiusMiles: number
  setRadius: (miles: number) => void
  /** The launch market the centre falls in (for area chips), if any. */
  market: Market | undefined
  markets: Market[]
  area: string | null
  /** Coarsened device location, only after the user asked for "near me". Never persisted or sent. */
  origin: LatLng | null
  locating: boolean
  locationError: string | null
  onboarded: boolean
  setMarket: (slug: string) => void
  choosePlace: (place: ChosenPlace) => void
  setArea: (area: string | null) => void
  requestLocation: () => void
  clearLocation: () => void
  completeOnboarding: () => void
}

const Ctx = createContext<LocationState | null>(null)

const DEFAULTS: Stored = { marketSlug: null, area: null, onboarded: false, place: null, radiusMiles: DEFAULT_RADIUS_MILES }

function read(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const s = { ...DEFAULTS, ...JSON.parse(raw) } as Stored
      if (!(RADIUS_OPTIONS as readonly number[]).includes(s.radiusMiles)) s.radiusMiles = DEFAULT_RADIUS_MILES
      return s
    }
    // Carry over choices from the previous storage format.
    const old = localStorage.getItem('aour-place-v1')
    if (old) return { ...DEFAULTS, ...JSON.parse(old), place: null, radiusMiles: DEFAULT_RADIUS_MILES }
  } catch {
    /* ignore */
  }
  return DEFAULTS
}

/** The market whose area contains a point (within its configured radius, default 15 mi). */
export function marketFor(markets: readonly Market[], p: LatLng): Market | undefined {
  return markets
    .map((m) => ({ m, d: distanceMiles(p, m) }))
    .filter((x) => x.d <= (x.m.radiusMiles ?? 15))
    .sort((a, b) => a.d - b.d)[0]?.m
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
  // The default view is a curated launch city, never an automatically created area.
  const chosenMarket = list.find((m) => m.slug === stored.marketSlug) ?? list.find((m) => !m.autoCreated) ?? list[0]

  const center = useMemo<SearchCenter | null>(() => {
    if (origin) return { kind: 'device', point: origin, label: 'Near me' }
    if (stored.place) return { kind: 'place', point: { lat: stored.place.lat, lng: stored.place.lng }, label: stored.place.label }
    if (chosenMarket) return { kind: 'market', point: { lat: chosenMarket.lat, lng: chosenMarket.lng }, label: chosenMarket.name }
    return null
  }, [origin, stored.place, chosenMarket])

  const market = center ? marketFor(list, center.point) : undefined

  const requestLocation = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setLocationError('Location is not available on this device. Search for a city or address instead.')
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
        setLocationError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission is off. Search for a city or address instead.'
            : 'Could not get your location. Search for a city or address instead.',
        )
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    )
  }, [])

  const value: LocationState = {
    center,
    radiusMiles: stored.radiusMiles,
    setRadius: (miles) => setStored((s) => ({ ...s, radiusMiles: miles })),
    market,
    markets: list,
    area: market && stored.area && market.areas.includes(stored.area) ? stored.area : null,
    origin,
    locating,
    locationError,
    onboarded: stored.onboarded,
    setMarket: (slug) => {
      setOrigin(null)
      setStored((s) => ({ ...s, marketSlug: slug, place: null, area: null }))
    },
    choosePlace: (p) => {
      setOrigin(null)
      const c = coarsen(p)
      setStored((s) => ({ ...s, place: { label: p.label.slice(0, 120), lat: c.lat, lng: c.lng }, area: null }))
    },
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

/** Reference point for distances: the current search centre. */
export function useReferencePoint(): LatLng | null {
  return useLocationState().center?.point ?? null
}
