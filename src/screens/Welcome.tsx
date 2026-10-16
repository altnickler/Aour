import { useNavigate } from 'react-router'
import { LocateFixed, MapPin } from 'lucide-react'
import { useLocationState } from '@/app/location'
import { Mark } from '@/components/brand'
import { Button, Chip } from '@/components/ui'
import { PlaceSearch } from '@/components/PlaceSearch'

/**
 * One-screen welcome: pick an area (or share location) and start browsing.
 * No account, no friend-finding, no tutorial carousel.
 */
export default function WelcomeScreen() {
  const { market, markets, center, area, setArea, choosePlace, requestLocation, origin, locating, locationError, completeOnboarding } = useLocationState()
  const navigate = useNavigate()
  const start = () => {
    completeOnboarding()
    navigate('/', { replace: true })
  }

  return (
    <div className="pt-safe pb-safe flex min-h-dvh flex-col bg-cream">
      <div className="relative overflow-hidden bg-choc px-6 pt-14 pb-12 text-cream">
        <div className="absolute -top-16 -right-16 size-56 rounded-full bg-gold/30 blur-2xl" aria-hidden />
        <div className="absolute -bottom-20 -left-10 size-48 rounded-full bg-butter/20 blur-2xl" aria-hidden />
        <Mark size={56} className="relative ring-4 ring-cream/10 rounded-[18px]" />
        <h1 className="relative mt-6 text-[34px] leading-[1.08] font-extrabold tracking-tight">
          Your happy hours,
          <br />
          <span className="text-butter">ranked.</span>
        </h1>
        <p className="relative mt-3 max-w-xs text-[16px] text-cream/80">Discover great deals nearby, rate them in seconds, and keep a personal list of your favorites.</p>
      </div>

      <div className="flex-1 px-6 pt-7">
        <h2 className="text-lg font-extrabold text-choc">Where do you go for happy hour?</h2>
        <p className="mt-1 text-sm text-muted">Launching first in {markets.find((m) => !m.autoCreated)?.name ?? 'Stuart & Martin County'}, Florida. Search anywhere — we'll show what we know.</p>
        <Button variant="secondary" block className="mt-4" loading={locating} onClick={requestLocation}>
          <LocateFixed className="size-4" /> {origin ? 'Using your location ✓' : 'Use my location'}
        </Button>
        {locationError && <p className="mt-2 text-sm text-danger" role="alert">{locationError}</p>}
        <div className="mt-5">
          <PlaceSearch onPick={(r) => choosePlace(r)} />
          {center?.kind === 'place' && <p className="mt-2 text-sm font-semibold text-choc">Selected: {center.label} ✓</p>}
        </div>
        {market && center?.kind !== 'device' && (
          <div className="mt-5 flex flex-wrap gap-2">
            <Chip selected={!area} onClick={() => setArea(null)}>
              <MapPin className="size-3.5" /> All of {market.name}
            </Chip>
            {market.areas.map((a) => (
              <Chip key={a} selected={area === a} onClick={() => setArea(a)}>
                {a}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div className="px-6 pt-6 pb-6">
        <Button size="lg" block onClick={start}>
          Show me happy hours
        </Button>
        <button type="button" onClick={() => { completeOnboarding(); navigate('/signin') }} className="mt-3 w-full py-2 text-sm font-semibold text-muted">
          Already have an account? <span className="text-choc underline">Sign in</span>
        </button>
      </div>
    </div>
  )
}
