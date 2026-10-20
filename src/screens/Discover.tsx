import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ChevronDown, LocateFixed, MapPin, Map as MapIcon, Users, Plus, SlidersHorizontal } from 'lucide-react'
import { useDiscovery } from '@/app/useDiscovery'
import { useAuth } from '@/app/auth'
import {
  buildShelves,
  filterEstablishments,
  hasHappyHourInfo,
  sortEstablishments,
  DEFAULT_FILTERS,
  RADIUS_OPTIONS,
  SORT_LABEL,
  type DiscoveryFilters,
  type DiscoveryShelf,
  type DiscoverySort,
  type WhenFilter,
} from '@/core/discovery'
import { useFeaturedCollections, useFriendActivity, useMyVisits, usePreferences, useRequestCoverage } from '@/data/hooks'
import { Logo } from '@/components/brand'
import { AreaSheet } from '@/components/AreaSheet'
import { HappyHourPill, PlaceCard, PlaceCardSkeleton, PlaceRow, PlaceThumb } from '@/components/place'
import { ScoreBadge } from '@/components/score'
import { Button, Chip, EmptyState, ErrorState, IconButton, Section } from '@/components/ui'
import { useToast } from '@/components/toast'
import { KIND_LABEL } from '@/core/listing'
import type { Establishment } from '@/core/types'

const PAGE = 10

const WHEN: [WhenFilter, string][] = [
  ['any', 'Any time'],
  ['now', 'Happening now'],
  ['later', 'Later today'],
  ['tomorrow', 'Tomorrow'],
  ['weekend', 'This weekend'],
]
const QUICK_SORTS: DiscoverySort[] = ['distance', 'rating', 'drinks', 'food', 'value']
const QUICK_TAGS: [string, string][] = [
  ['outdoor-seating', 'Outdoor seating'],
  ['waterfront', 'Waterfront'],
  ['date-night', 'Date night'],
]

function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

function greeting(now: Date) {
  const h = now.getHours()
  if (h < 11) return 'Good morning'
  if (h < 16) return 'Good afternoon'
  return 'Good evening'
}

export default function DiscoverScreen() {
  const { center, radiusMiles, setRadius, area, setArea, listings, personal, ctx, now, onboarded, locationError } = useDiscovery()
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const myVisits = useMyVisits()
  const prefs = usePreferences()
  const friendActivity = useFriendActivity()
  const featured = useFeaturedCollections()
  const coverage = useRequestCoverage()
  const [when, setWhen] = useState<WhenFilter>('any')
  const [sort, setSort] = useState<DiscoverySort>('recommended')
  const [tags, setTags] = useState<string[]>([])
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [areaOpen, setAreaOpen] = useState(false)
  // Venues without confirmed happy-hour details are listed by default (labelled Unconfirmed), so an
  // area is never shown as empty just because no happy hour has been confirmed there yet.
  const [showCandidates, setShowCandidates] = useState(true)
  const [candidateLimit, setCandidateLimit] = useState(30)
  const [limit, setLimit] = useState(PAGE)

  // First launch: a lightweight welcome (skippable), never a wall.
  useEffect(() => {
    if (!onboarded && !user) navigate('/welcome', { replace: true })
  }, [onboarded, user, navigate])

  const inRange = useMemo(() => filterEstablishments(listings.data ?? [], { ...DEFAULT_FILTERS, area }, ctx), [listings.data, area, ctx])
  const withInfo = useMemo(() => inRange.filter(hasHappyHourInfo), [inRange])

  // Nothing near the user's real location: tell Aour (anonymously, ~11 km cell, at most daily)
  // so venue discovery can start there automatically.
  const coverageMutate = coverage.mutate
  const emptyNearDevice = center?.kind === 'device' && listings.isSuccess && !listings.isPlaceholderData && inRange.length === 0
  useEffect(() => {
    if (!emptyNearDevice || !center) return
    const key = `aour-coverage-${center.point.lat.toFixed(1)},${center.point.lng.toFixed(1)}`
    try {
      const last = Number(localStorage.getItem(key) ?? 0)
      if (Date.now() - last < 86_400_000) return
      localStorage.setItem(key, String(Date.now()))
    } catch {
      /* storage unavailable: still send once per page view */
    }
    coverageMutate({ center: center.point, label: null, timezone: deviceTimeZone() })
  }, [emptyNearDevice, center, coverageMutate])
  const candidates = useMemo(() => sortEstablishments(inRange.filter((e) => !hasHappyHourInfo(e)), 'distance', ctx), [inRange, ctx])
  const filters: DiscoveryFilters = { ...DEFAULT_FILTERS, when, tags, verifiedOnly }
  const filtering = when !== 'any' || tags.length > 0 || verifiedOnly || sort !== 'recommended'
  const shelves = useMemo(
    () => buildShelves({ listings: withInfo, ctx, myVisits: myVisits.data, myWeights: prefs.data?.weights, friendVisits: friendActivity.data }),
    [withInfo, ctx, myVisits.data, prefs.data, friendActivity.data],
  )
  const results = useMemo(
    () => sortEstablishments(filterEstablishments(withInfo, filters, ctx), sort, ctx, personal),
    [withInfo, when, tags, verifiedOnly, sort, ctx, personal], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const nowCount = useMemo(() => filterEstablishments(withInfo, { ...DEFAULT_FILTERS, when: 'now' }, ctx).length, [withInfo, ctx])

  const reset = () => {
    setWhen('any')
    setSort('recommended')
    setTags([])
    setVerifiedOnly(false)
    setLimit(PAGE)
  }
  const where = center ? (center.kind === 'device' ? 'you' : center.label) : 'here'
  const nextRadius = RADIUS_OPTIONS.find((r) => r > radiusMiles)

  return (
    <div>
      <header className="pt-safe sticky top-0 z-20 bg-cream/90 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-2 px-4">
          <Logo size={26} />
          <button
            type="button"
            onClick={() => setAreaOpen(true)}
            className="press ml-1 flex min-w-0 items-center gap-1 rounded-full bg-white px-3 py-1.5 text-sm font-bold text-choc shadow-press ring-1 ring-line"
            aria-label={`Location: ${area ?? center?.label ?? 'not set'}, within ${radiusMiles} miles. Change`}
          >
            {center?.kind === 'device' ? <LocateFixed className="size-3.5 shrink-0 text-gold-deep" /> : <MapPin className="size-3.5 shrink-0 text-gold-deep" />}
            <span className="truncate">{area ?? center?.label ?? 'Choose a location'}</span>
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
        {center?.kind === 'market' && (
          <p className="mt-1 text-sm text-muted">
            Showing {center.label}.{' '}
            <button type="button" className="font-bold text-choc underline" onClick={() => setAreaOpen(true)}>
              Use your location or search a city
            </button>
          </p>
        )}
        {locationError && <p className="mt-1 text-sm text-danger" role="status">{locationError}</p>}
      </div>

      <div className="no-scrollbar mt-4 flex items-center gap-2 overflow-x-auto px-5" role="group" aria-label="Search radius">
        <span className="shrink-0 text-xs font-bold text-muted uppercase">Within</span>
        {RADIUS_OPTIONS.map((r) => (
          <Chip key={r} selected={!area && radiusMiles === r} onClick={() => { setRadius(r); setArea(null); setLimit(PAGE) }} aria-label={`${r} miles`}>
            {r} mi
          </Chip>
        ))}
      </div>

      <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto px-5" role="group" aria-label="When">
        {WHEN.map(([k, label]) => (
          <Chip key={k} selected={when === k} onClick={() => { setWhen(k); setLimit(PAGE) }}>
            {k === 'now' && <span className="size-2 rounded-full bg-success" aria-hidden />}
            {label}
          </Chip>
        ))}
      </div>

      <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto px-5" role="group" aria-label="Sort and filter">
        {QUICK_SORTS.map((k) => (
          <Chip key={k} selected={sort === k} aria-pressed={sort === k} onClick={() => { setSort(sort === k ? 'recommended' : k); setLimit(PAGE) }}>
            {SORT_LABEL[k]}
          </Chip>
        ))}
        {QUICK_TAGS.map(([k, label]) => (
          <Chip key={k} selected={tags.includes(k)} aria-pressed={tags.includes(k)} onClick={() => setTags(tags.includes(k) ? tags.filter((t) => t !== k) : [...tags, k])}>
            {label}
          </Chip>
        ))}
        <Chip selected={verifiedOnly} aria-pressed={verifiedOnly} onClick={() => setVerifiedOnly(!verifiedOnly)}>
          ✓ Verified only
        </Chip>
        <Chip onClick={() => navigate('/search')}>
          <SlidersHorizontal className="size-3.5" /> More
        </Chip>
      </div>

      {listings.isError ? (
        <ErrorState title="Couldn't load places" error={listings.error} retry={() => listings.refetch()} />
      ) : listings.isLoading || !center ? (
        <div className="mt-6 space-y-4 px-5">
          <PlaceCardSkeleton />
          <PlaceCardSkeleton />
        </div>
      ) : (
        <>
          {!filtering &&
            shelves
              .filter((s) => s.key !== 'now')
              .slice(0, 6)
              .map((s) => <Shelf key={s.key} shelf={s} personal={personal} now={now} />)}

          {!filtering && (featured.data?.length ?? 0) > 0 && (
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

          <Section
            title={when !== 'any' ? WHEN.find(([k]) => k === when)![1] : area ? `Happy hours in ${area}` : `Happy hours within ${radiusMiles} mi`}
            action={<span className="text-sm text-muted">{results.length}</span>}
          >
            {results.length === 0 ? (
              withInfo.length === 0 ? (
                <EmptyState
                  icon="🧭"
                  title={inRange.length ? `No happy-hour details near ${where} yet` : `Aour isn't in ${center.kind === 'device' ? 'your area' : center.label} yet`}
                  body={
                    inRange.length
                      ? `We know ${inRange.length} ${inRange.length === 1 ? 'venue' : 'venues'} within ${radiusMiles} mi — listed below as unconfirmed until we find their happy-hour details.`
                      : center.kind === 'device'
                        ? `We don't have listings within ${radiusMiles} mi yet. We've noted this area (anonymously) so venue discovery can start here. Try a wider radius meanwhile.`
                        : `We don't have listings within ${radiusMiles} mi. Try a wider radius, or tell us you'd like Aour here.`
                  }
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      {nextRadius && (
                        <Button variant="secondary" onClick={() => setRadius(nextRadius)}>
                          Search {nextRadius} mi
                        </Button>
                      )}
                      {center.kind !== 'market' && (
                        <Button
                          variant="secondary"
                          loading={coverage.isPending}
                          disabled={coverage.isSuccess}
                          onClick={() =>
                            coverage.mutate(
                              { center: center.point, label: center.kind === 'place' ? center.label : null, timezone: center.kind === 'device' ? deviceTimeZone() : null },
                              { onSuccess: () => toast(`Thanks! We'll use this to decide where Aour goes next.`) },
                            )
                          }
                        >
                          {coverage.isSuccess ? 'Request sent' : 'Bring Aour here'}
                        </Button>
                      )}
                      <Button variant="secondary" onClick={() => navigate('/suggest')}>
                        <Plus className="size-4" /> Suggest a place
                      </Button>
                    </div>
                  }
                />
              ) : (
                <EmptyState
                  icon="🍹"
                  title={when === 'now' ? 'Nothing on right now' : 'Nothing matches'}
                  body={when === 'now' ? 'Try "Later today" to see what starts soon.' : 'Try fewer filters or a wider radius.'}
                  action={
                    when === 'now' ? (
                      <Button variant="secondary" onClick={() => setWhen('later')}>Show later today</Button>
                    ) : (
                      <Button variant="secondary" onClick={reset}>Clear filters</Button>
                    )
                  }
                />
              )
            ) : (
              <div className="space-y-4 px-5">
                {results.slice(0, limit).map((e) => (
                  <PlaceCard key={e.id} place={e} origin={center.point} myScore={personal.get(e.id)} now={now} />
                ))}
                {limit < results.length && (
                  <Button variant="secondary" block onClick={() => setLimit((l) => l + PAGE)}>
                    Show more
                  </Button>
                )}
              </div>
            )}
          </Section>

          {candidates.length > 0 && (
            <section className="mx-5 mt-8 rounded-card bg-white p-4 shadow-card" aria-labelledby="candidates-title">
              <h2 id="candidates-title" className="font-extrabold text-choc">
                {withInfo.length ? 'More venues nearby' : 'Venues nearby'} <span className="font-semibold text-muted">({candidates.length})</span>
              </h2>
              <p className="mt-1 text-sm text-muted">
                Bars and restaurants from open map data. Happy hour unconfirmed — we haven't found details for them yet, and some may not have one. Know their deal? Tell us.
              </p>
              <Button className="mt-3" size="sm" variant="secondary" aria-expanded={showCandidates} onClick={() => setShowCandidates(!showCandidates)}>
                {showCandidates ? 'Hide' : 'Show'} unconfirmed venues
              </Button>
              {showCandidates && (
                <div className="mt-2 -mx-2">
                  {candidates.slice(0, candidateLimit).map((e) => (
                    <PlaceRow key={e.id} place={e} origin={center.point} now={now} trailing={<span className="text-xs font-semibold text-muted">Unconfirmed</span>} />
                  ))}
                  {candidateLimit < candidates.length && (
                    <Button className="mx-2 mt-2" size="sm" variant="secondary" onClick={() => setCandidateLimit((n) => n + 30)}>
                      Show more venues
                    </Button>
                  )}
                </div>
              )}
            </section>
          )}

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
