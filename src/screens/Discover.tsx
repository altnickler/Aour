import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ChevronDown, MapPin, Map as MapIcon, Users, Plus } from 'lucide-react'
import { useDiscovery } from '@/app/useDiscovery'
import { useAuth } from '@/app/auth'
import { buildShelves, filterEstablishments, sortEstablishments, DEFAULT_FILTERS, type DiscoveryShelf, type WhenFilter } from '@/core/discovery'
import { useFeaturedCollections, useFriendActivity, useMyVisits, usePreferences } from '@/data/hooks'
import { Logo } from '@/components/brand'
import { AreaSheet } from '@/components/AreaSheet'
import { HappyHourPill, PlaceCard, PlaceCardSkeleton, PlaceThumb } from '@/components/place'
import { ScoreBadge } from '@/components/score'
import { Button, Chip, EmptyState, ErrorState, IconButton, Section } from '@/components/ui'
import { KIND_LABEL } from '@/core/listing'
import type { Establishment } from '@/core/types'

const PAGE = 10

function greeting(now: Date) {
  const h = now.getHours()
  if (h < 11) return 'Good morning'
  if (h < 16) return 'Good afternoon'
  return 'Good evening'
}

export default function DiscoverScreen() {
  const { market, area, origin: deviceOrigin, listings, personal, ctx, now, onboarded } = useDiscovery()
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const myVisits = useMyVisits()
  const prefs = usePreferences()
  const friendActivity = useFriendActivity()
  const featured = useFeaturedCollections()
  const [when, setWhen] = useState<WhenFilter>('any')
  const [areaOpen, setAreaOpen] = useState(false)
  const [limit, setLimit] = useState(PAGE)

  // First launch: a lightweight welcome (skippable), never a wall.
  useEffect(() => {
    if (!onboarded && !user) navigate('/welcome', { replace: true })
  }, [onboarded, user, navigate])

  const inArea = useMemo(
    () => filterEstablishments(listings.data ?? [], { ...DEFAULT_FILTERS, area }, ctx),
    [listings.data, area, ctx],
  )
  const shelves = useMemo(
    () =>
      buildShelves({
        listings: inArea,
        ctx,
        myVisits: myVisits.data,
        myWeights: prefs.data?.weights,
        friendVisits: friendActivity.data,
      }),
    [inArea, ctx, myVisits.data, prefs.data, friendActivity.data],
  )
  const all = useMemo(
    () => sortEstablishments(filterEstablishments(inArea, { ...DEFAULT_FILTERS, when }, ctx), 'recommended', ctx, personal),
    [inArea, when, ctx, personal],
  )
  const nowCount = useMemo(() => filterEstablishments(inArea, { ...DEFAULT_FILTERS, when: 'now' }, ctx).length, [inArea, ctx])

  return (
    <div>
      <header className="pt-safe sticky top-0 z-20 bg-cream/90 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-2 px-4">
          <Logo size={26} />
          <button
            type="button"
            onClick={() => setAreaOpen(true)}
            className="press ml-1 flex min-w-0 items-center gap-1 rounded-full bg-white px-3 py-1.5 text-sm font-bold text-choc shadow-press ring-1 ring-line"
            aria-label={`Location: ${deviceOrigin ? 'Near me' : (area ?? market?.name ?? 'Choose')}. Change`}
          >
            <MapPin className="size-3.5 shrink-0 text-gold-deep" />
            <span className="truncate">{deviceOrigin ? 'Near me' : (area ?? market?.name ?? '…')}</span>
            <ChevronDown className="size-3.5 shrink-0" />
          </button>
          <div className="ml-auto flex">
            <IconButton label="Friends activity" onClick={() => navigate('/activity')}>
              <Users className="size-5" />
            </IconButton>
            <IconButton label="Map" onClick={() => navigate('/map')}>
              <MapIcon className="size-5" />
            </IconButton>
          </div>
        </div>
      </header>

      <div className="px-5 pt-2">
        <p className="text-sm font-semibold text-muted">
          {greeting(now)}
          {profile ? `, ${profile.displayName.split(' ')[0]}` : ''} 👋
        </p>
        <h1 className="mt-0.5 text-[28px] leading-[1.15] font-extrabold tracking-tight text-choc">
          {nowCount > 0 ? (
            <>
              <span className="rounded-lg bg-butter px-1.5">{nowCount} happy {nowCount === 1 ? 'hour' : 'hours'}</span> on right now
            </>
          ) : (
            'Find your next happy hour'
          )}
        </h1>
      </div>

      <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto px-5" role="group" aria-label="When">
        {(
          [
            ['any', 'All'],
            ['now', 'Happening now'],
            ['today', 'Today'],
          ] as const
        ).map(([k, label]) => (
          <Chip key={k} selected={when === k} onClick={() => { setWhen(k); setLimit(PAGE) }}>
            {k === 'now' && <span className="size-2 rounded-full bg-success" aria-hidden />}
            {label}
          </Chip>
        ))}
        <Chip onClick={() => navigate('/search')}>More filters</Chip>
      </div>

      {listings.isError ? (
        <ErrorState error={listings.error} retry={() => listings.refetch()} />
      ) : listings.isLoading || !market ? (
        <div className="mt-6 space-y-4 px-5">
          <PlaceCardSkeleton />
          <PlaceCardSkeleton />
        </div>
      ) : (
        <>
          {when === 'any' &&
            shelves
              .filter((s) => s.key !== 'now')
              .slice(0, 6)
              .map((s) => <Shelf key={s.key} shelf={s} personal={personal} now={now} />)}

          {when === 'any' && (featured.data?.length ?? 0) > 0 && (
            <Section title="Featured collections">
              <div className="no-scrollbar snap-x-row flex gap-3 overflow-x-auto px-5 pb-2">
                {featured.data!.map((c) => (
                  <Link key={c.id} to={`/c/${c.shareId}`} className="press w-56 shrink-0 rounded-card bg-choc p-4 text-cream shadow-card">
                    <p className="text-xs font-bold text-butter uppercase">Collection</p>
                    <p className="mt-1 text-lg leading-tight font-extrabold">{c.name}</p>
                    <p className="mt-1 text-sm text-cream/80">{c.items.length} places{c.ownerUsername ? ` · @${c.ownerUsername}` : ''}</p>
                  </Link>
                ))}
              </div>
            </Section>
          )}

          <Section title={when === 'now' ? 'Happening now' : when === 'today' ? 'Happy hours today' : 'All happy hours'} action={<span className="text-sm text-muted">{all.length}</span>}>
            {all.length === 0 ? (
              <EmptyState
                icon="🍹"
                title={when === 'now' ? 'Nothing on right now' : 'No happy hours here yet'}
                body={when === 'now' ? 'Try "Today" to see what starts later.' : "Know a great one? Suggest it and we'll verify the details."}
                action={
                  when === 'now' ? (
                    <Button variant="secondary" onClick={() => setWhen('today')}>Show today</Button>
                  ) : (
                    <Button variant="secondary" onClick={() => navigate('/suggest')}><Plus className="size-4" /> Suggest a place</Button>
                  )
                }
              />
            ) : (
              <div className="space-y-4 px-5">
                {all.slice(0, limit).map((e) => (
                  <PlaceCard key={e.id} place={e} origin={deviceOrigin} myScore={personal.get(e.id)} now={now} />
                ))}
                {limit < all.length && (
                  <Button variant="secondary" block onClick={() => setLimit((l) => l + PAGE)}>
                    Show more
                  </Button>
                )}
              </div>
            )}
          </Section>

          <div className="mx-5 mt-8 rounded-card bg-butter-soft p-5">
            <p className="font-extrabold text-choc">Missing a spot?</p>
            <p className="mt-1 text-sm text-choc/80">Suggest a happy hour. Our team verifies every listing before it goes live.</p>
            <Button className="mt-3" size="sm" onClick={() => navigate('/suggest')}>
              Suggest a place
            </Button>
          </div>
        </>
      )}
      <AreaSheet open={areaOpen} onClose={() => setAreaOpen(false)} />
    </div>
  )
}

function Shelf({ shelf, personal, now }: { shelf: DiscoveryShelf; personal: Map<string, number>; now: Date }) {
  return (
    <Section title={shelf.title}>
      <p className="-mt-2 mb-2.5 px-5 text-sm text-muted">{shelf.subtitle}</p>
      <ul className="no-scrollbar snap-x-row flex gap-3 overflow-x-auto px-5 pb-2">
        {shelf.items.map((e) => (
          <li key={e.id}>
            <MiniCard place={e} myScore={personal.get(e.id)} now={now} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

function MiniCard({ place, myScore, now }: { place: Establishment; myScore?: number; now: Date }) {
  return (
    <Link to={`/place/${place.slug}`} className="press block w-44 shrink-0 overflow-hidden rounded-card bg-white shadow-card">
      <div className="relative">
        <PlaceThumb place={place} className="h-28 w-full text-xl" rounded="rounded-none" />
        <ScoreBadge score={place.community.average} size="sm" className="absolute right-2 bottom-2 shadow-press" />
      </div>
      <div className="p-3">
        <p className="truncate font-extrabold text-choc">{place.name}</p>
        <p className="truncate text-xs text-muted">
          {place.neighborhood ?? place.city} · {KIND_LABEL[place.kind]}
        </p>
        <div className="mt-1.5 flex items-center justify-between gap-1">
          <HappyHourPill place={place} now={now} className="max-w-full truncate" />
          {myScore !== undefined && <ScoreBadge score={myScore} kind="mine" size="sm" className="size-7 text-[11px]" />}
        </div>
      </div>
    </Link>
  )
}

