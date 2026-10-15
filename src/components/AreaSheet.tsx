import { LocateFixed, MapPin } from 'lucide-react'
import { useLocationState } from '@/app/location'
import { Button, Chip, Sheet } from './ui'

/** Choose market + area manually, or share (coarse) location for "near me". */
export function AreaSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { markets, market, area, setMarket, setArea, origin, requestLocation, clearLocation, locating, locationError } = useLocationState()
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
              <p className="text-sm text-muted">Only used on this device to sort by distance. Never stored or shared.</p>
              {locationError && <p className="mt-1 text-sm text-danger">{locationError}</p>}
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

        {markets.length > 1 && (
          <div>
            <h3 className="mb-2 text-sm font-bold text-muted uppercase">City</h3>
            <div className="flex flex-wrap gap-2">
              {markets.map((m) => (
                <Chip key={m.id} selected={m.id === market?.id} onClick={() => setMarket(m.slug)}>
                  {m.name}
                </Chip>
              ))}
            </div>
          </div>
        )}

        {market && (
          <div>
            <h3 className="mb-2 text-sm font-bold text-muted uppercase">{market.name}</h3>
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
            <p className="mt-3 text-xs text-muted">Aour is launching on Florida's Treasure Coast first. More cities soon.</p>
          </div>
        )}
        <Button block onClick={onClose}>
          Done
        </Button>
      </div>
    </Sheet>
  )
}
