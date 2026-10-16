import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Map as MapLibre, Marker, NavigationControl, LngLatBounds, setWorkerUrl } from 'maplibre-gl'
// MapLibre 6 resolves its worker relative to its own module; point it at the emitted asset instead.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { ChevronLeft, List, LocateFixed, SlidersHorizontal } from 'lucide-react'
import { useDiscovery } from '@/app/useDiscovery'
import { useFilterState } from '@/app/filters'
import { activeFilterCount, filterEstablishments, hasHappyHourInfo } from '@/core/discovery'
import { happyHourStatus } from '@/core/schedule'
import { formatScore } from '@/core/rating'
import { config } from '@/lib/config'
import { FiltersSheet } from '@/components/FiltersSheet'
import { PlaceRow, SaveButton } from '@/components/place'
import { Chip, EmptyState, IconButton } from '@/components/ui'
import type { Establishment } from '@/core/types'

setWorkerUrl(workerUrl)

export default function MapScreen() {
  const { listings, ctx, center, radiusMiles, now, requestLocation, locating } = useDiscovery()
  const origin = center?.point ?? null
  const hasCenter = !!center
  const [{ filters, sort }, setState] = useFilterState()
  const [selected, setSelected] = useState<Establishment | null>(null)
  const [failed, setFailed] = useState(() => !supportsWebGL())
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibre | null>(null)
  const markers = useRef<Marker[]>([])
  const mapCenterRef = useRef(origin)
  const navigate = useNavigate()
  // Runs before the map-creation effect below (effects run in declaration order).
  useEffect(() => {
    mapCenterRef.current = origin
  })

  // The map shows places with happy-hour details; venues without any are listed on Discover only.
  const results = useMemo(() => filterEstablishments((listings.data ?? []).filter(hasHappyHourInfo), filters, ctx), [listings.data, filters, ctx])

  // Create the map once.
  useEffect(() => {
    if (!container.current || !hasCenter || failed) return
    const start = mapCenterRef.current!
    let map: MapLibre
    try {
      map = new MapLibre({
        container: container.current,
        style: config.mapStyleUrl,
        center: [start.lng, start.lat],
        zoom: 12,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
      })
    } catch {
      // Construction can still fail on exotic GPUs; report it after this effect.
      queueMicrotask(() => setFailed(true))
      return
    }
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    map.on('error', (e) => {
      // Style/tile failures (offline, blocked) shouldn't leave a blank screen.
      if (!map.isStyleLoaded() && /style|Failed to fetch/i.test(String(e.error?.message))) setFailed(true)
    })
    map.on('click', () => setSelected(null))
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [hasCenter, failed])

  // Sync markers with filtered results.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markers.current.forEach((m) => m.remove())
    markers.current = results.map((e) => {
      const el = document.createElement('button')
      const live = happyHourStatus(e.windows, e.exceptions, e.timezone, now).state === 'now'
      el.type = 'button'
      el.setAttribute('aria-label', `${e.name}, ${e.community.average ? `score ${formatScore(e.community.average)}` : 'not yet rated'}`)
      el.className = `flex h-8 min-w-8 items-center justify-center gap-1 rounded-full px-2 text-[13px] font-extrabold shadow-float ring-2 ring-white ${live ? 'bg-success text-white' : 'bg-choc text-butter'}`
      el.textContent = e.community.average ? formatScore(e.community.average) : '•'
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        setSelected(e)
        map.easeTo({ center: [e.lng, e.lat], duration: 350 })
      })
      return new Marker({ element: el }).setLngLat([e.lng, e.lat]).addTo(map)
    })
    if (results.length > 1) {
      const b = new LngLatBounds()
      results.forEach((e) => b.extend([e.lng, e.lat]))
      map.fitBounds(b, { padding: { top: 140, bottom: 220, left: 40, right: 40 }, maxZoom: 14, duration: 0 })
    }
  }, [results, now])

  // Follow the search centre (device location, searched place or market).
  useEffect(() => {
    if (origin && mapRef.current) mapRef.current.easeTo({ center: [origin.lng, origin.lat], zoom: radiusMiles <= 2 ? 14 : radiusMiles <= 5 ? 12.5 : radiusMiles <= 10 ? 11.5 : 10 })
  }, [origin?.lat, origin?.lng, radiusMiles]) // eslint-disable-line react-hooks/exhaustive-deps

  const count = activeFilterCount(filters)

  return (
    <div className="relative h-[calc(100dvh-4.75rem-env(safe-area-inset-bottom))]">
      {failed ? (
        <div className="pt-safe h-full overflow-y-auto pt-16">
          <EmptyState icon="🗺️" title="Map unavailable" body="We couldn't load the map right now. Here are the places as a list." />
          <ul className="px-3">
            {results.map((e) => (
              <li key={e.id}>
                <PlaceRow place={e} origin={origin} now={now} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div ref={container} className="absolute inset-0" role="region" aria-label="Map of happy hours" />
      )}

      <div className="pt-safe pointer-events-none absolute inset-x-0 top-0 z-10">
        <div className="pointer-events-auto flex items-center gap-2 px-3 pt-2">
          <IconButton label="Back" variant="surface" onClick={() => navigate(-1)}>
            <ChevronLeft className="size-6" />
          </IconButton>
          <div className="no-scrollbar flex flex-1 gap-2 overflow-x-auto">
            {(
              [
                ['any', 'All'],
                ['now', 'Now'],
                ['later', 'Later today'],
                ['tomorrow', 'Tomorrow'],
                ['weekend', 'Weekend'],
              ] as const
            ).map(([k, label]) => (
              <Chip key={k} selected={filters.when === k} onClick={() => setState({ filters: { ...filters, when: k } })} className="shadow-press">
                {label}
              </Chip>
            ))}
          </div>
          <IconButton label={`Filters${count ? ` (${count} active)` : ''}`} variant="surface" onClick={() => setOpen(true)}>
            <SlidersHorizontal className="size-5" />
          </IconButton>
        </div>
      </div>

      <div className="absolute right-3 bottom-4 z-10 flex flex-col gap-2" style={{ bottom: selected ? '11rem' : '1rem' }}>
        <IconButton label="Use my location" variant="surface" onClick={requestLocation} aria-busy={locating}>
          <LocateFixed className="size-5" />
        </IconButton>
        <IconButton label="Show as list" variant="surface" onClick={() => navigate('/search')}>
          <List className="size-5" />
        </IconButton>
      </div>

      {selected && (
        <div className="animate-rise absolute inset-x-3 bottom-3 z-10 rounded-card bg-cream p-2 shadow-float">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <PlaceRow place={selected} origin={origin} now={now} />
            </div>
            <SaveButton placeId={selected.id} variant="plain" />
          </div>
        </div>
      )}
      {!failed && !listings.isLoading && results.length === 0 && (
        <div className="absolute inset-x-6 top-1/3 z-10 rounded-card bg-white/95 p-4 text-center shadow-float">
          <p className="font-bold text-choc">No happy hours within {radiusMiles} mi match these filters</p>
        </div>
      )}
      <FiltersSheet open={open} onClose={() => setOpen(false)} filters={filters} sort={sort} onApply={(f, s) => setState({ filters: f, sort: s })} />
    </div>
  )
}

function supportsWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}
