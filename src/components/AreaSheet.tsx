import { LocateFixed, MapPin } from 'lucide-react'
import { useLocationState } from '@/app/location'
import { RADIUS_OPTIONS } from '@/core/discovery'
import { Button, Chip, Sheet } from './ui'
import { PlaceSearch } from './PlaceSearch'

/** Share (coarse) location for "near me", search any city/address, or pick a launch city. */
export function AreaSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { markets, market, area, center, radiusMiles, setRadius, setMarket, choosePlace, setArea, origin, requestLocation, clearLocation, locating, locationError } = useLocationState()
  return (
    <Sheet open={open} onClose={onClose} title="Where are you headed?">
      <div className="space-y-5 pb-2">
        <div className="rounded-card bg-white p-4 shadow-card">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-butter-soft text-choc">
              <LocateFixed className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-choc">{origin ? 'Using your location' : 'Use my location'}</p>
              <p className="text-sm text-muted">Rounded to about 1 km and used only on this device. Never stored or sent to Aour.</p>
              {locationError && <p className="mt-1 text-sm text-danger" role="alert">{locationError}</p>}
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            {origin ? (
              <Button variant="secondary" size="sm" onClick={clearLocation}>
                Stop using location
              </Button>
            ) : (
              <Button size="sm" loading={locating} onClick={requestLocation}>
                Share location
              </Button>
            )}
          </div>
        </div>

        <PlaceSearch
          onPick={(r) => {
            choosePlace(r)
            onClose()
          }}
        />

        <div>
          <h3 className="mb-2 text-sm font-bold text-muted uppercase">Within</h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Search radius">
            {RADIUS_OPTIONS.map((r) => (
              <Chip key={r} selected={radiusMiles === r} onClick={() => setRadius(r)}>
                {r} mi
              </Chip>
            ))}
          </div>
          {center && <p className="mt-2 text-xs text-muted">Currently: {center.kind === 'device' ? 'near you' : center.label}</p>}
        </div>

        {markets.some((m) => !m.autoCreated) && (
          <div>
            <h3 className="mb-2 text-sm font-bold text-muted uppercase">Launch cities</h3>
            <div className="flex flex-wrap gap-2">
              {markets.filter((m) => !m.autoCreated).map((m) => (
                <Chip key={m.id} selected={center?.kind === 'market' && m.id === market?.id} onClick={() => setMarket(m.slug)}>
                  {m.name}
                </Chip>
              ))}
            </div>
          </div>
        )}

        {market && market.areas.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-bold text-muted uppercase">Areas in {market.name}</h3>
            <div className="flex flex-wrap gap-2">
              <Chip selected={!area} onClick={() => setArea(null)}>
                <MapPin className="size-3.5" /> Everywhere
              </Chip>
              {market.areas.map((a) => (
                <Chip key={a} selected={area === a} onClick={() => setArea(a)}>
                  {a}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <Button block onClick={onClose}>
          Done
        </Button>
      </div>
    </Sheet>
  )
}
