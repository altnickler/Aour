import { useDeferredValue, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Map as MapIcon, Search as SearchIcon, SlidersHorizontal, X } from 'lucide-react'
import { useDiscovery } from '@/app/useDiscovery'
import { useFilterState } from '@/app/filters'
import { activeFilterCount, filterEstablishments, sortEstablishments } from '@/core/discovery'
import { api } from '@/data'
import { FiltersSheet } from '@/components/FiltersSheet'
import { PlaceRow } from '@/components/place'
import { ScoreBadge } from '@/components/score'
import { Avatar, Chip, EmptyState, ErrorState, IconButton, Segmented, Skeleton } from '@/components/ui'
import { TAG_BY_KEY } from '@/core/categories'

export default function SearchScreen() {
  const { listings, ctx, personal, now, origin } = useDiscovery()
  const [{ filters, sort }, setState] = useFilterState()
  const [tab, setTab] = useState<'places' | 'people'>('places')
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const query = useDeferredValue(filters.query)

  const results = useMemo(
    () => sortEstablishments(filterEstablishments(listings.data ?? [], { ...filters, query }, ctx), sort, ctx, personal),
    [listings.data, filters, query, sort, ctx, personal],
  )
  const people = useQuery({
    queryKey: ['people-search', query],
    queryFn: () => api.searchProfiles(query),
    enabled: tab === 'people' && query.trim().length >= 2,
  })
  const count = activeFilterCount(filters)

  return (
    <div>
      <header className="pt-safe sticky top-0 z-20 bg-cream/92 px-4 pb-3 backdrop-blur-xl">
        <h1 className="pt-3 pb-3 text-[28px] font-extrabold tracking-tight text-choc">Search</h1>
        <div className="flex items-center gap-2">
          <label className="flex h-12 flex-1 items-center gap-2 rounded-full bg-white px-4 shadow-press ring-1 ring-line focus-within:ring-2 focus-within:ring-gold">
            <SearchIcon className="size-5 shrink-0 text-muted" aria-hidden />
            <span className="sr-only">Search places, neighborhoods or people</span>
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              value={filters.query}
              onChange={(e) => setState({ filters: { ...filters, query: e.target.value } })}
              placeholder={tab === 'places' ? 'Bars, restaurants, neighborhoods' : 'Name or @username'}
              className="h-full min-w-0 flex-1 bg-transparent text-espresso placeholder:text-muted-soft focus:outline-none"
            />
            {filters.query && (
              <button type="button" aria-label="Clear search" onClick={() => setState({ filters: { ...filters, query: '' } })} className="text-muted">
                <X className="size-4" />
              </button>
            )}
          </label>
          {tab === 'places' && (
            <>
              <IconButton label={`Filters${count ? ` (${count} active)` : ''}`} variant="surface" onClick={() => setOpen(true)} className="relative">
                <SlidersHorizontal className="size-5" />
                {count > 0 && <span className="absolute -top-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full bg-gold text-[11px] font-extrabold text-choc">{count}</span>}
              </IconButton>
              <IconButton label="Show on map" variant="surface" onClick={() => navigate('/map')}>
                <MapIcon className="size-5" />
              </IconButton>
            </>
          )}
        </div>
        <Segmented
          className="mt-3"
          label="Search for"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'places', label: 'Places' },
            { value: 'people', label: 'People' },
          ]}
        />
      </header>

      {tab === 'places' ? (
        <>
          {count > 0 && (
            <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-2">
              {filters.when !== 'any' && <Chip selected onClick={() => setState({ filters: { ...filters, when: 'any' } })}>{filters.when === 'now' ? 'Now' : filters.when === 'today' ? 'Today' : 'Selected day'} ✕</Chip>}
              {filters.tags.map((t) => (
                <Chip key={t} selected onClick={() => setState({ filters: { ...filters, tags: filters.tags.filter((x) => x !== t) } })}>
                  {TAG_BY_KEY[t]?.label} ✕
                </Chip>
              ))}
              {filters.area && <Chip selected onClick={() => setState({ filters: { ...filters, area: null } })}>{filters.area} ✕</Chip>}
              {filters.minRating && <Chip selected onClick={() => setState({ filters: { ...filters, minRating: null } })}>{filters.minRating}+ ✕</Chip>}
            </div>
          )}
          <p className="px-5 pt-1 pb-1 text-sm text-muted" aria-live="polite">
            {listings.isLoading ? 'Loading…' : `${results.length} ${results.length === 1 ? 'place' : 'places'}`}
          </p>
          {listings.isError ? (
            <ErrorState error={listings.error} retry={() => listings.refetch()} />
          ) : listings.isLoading ? (
            <div className="space-y-3 px-4">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
            </div>
          ) : results.length === 0 ? (
            <EmptyState icon="🔍" title="No matches" body="Try fewer filters or a different search. Can't find a place? Suggest it." action={<Link className="font-bold text-choc underline" to="/suggest">Suggest a place</Link>} />
          ) : (
            <ul className="px-3">
              {results.map((e) => (
                <li key={e.id}>
                  <PlaceRow
                    place={e}
                    origin={origin}
                    now={now}
                    trailing={
                      <div className="flex flex-col items-center gap-1">
                        <ScoreBadge score={e.community.average} size="sm" />
                        {personal.has(e.id) && <ScoreBadge score={personal.get(e.id)} kind="mine" size="sm" className="size-7 text-[11px]" />}
                      </div>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="px-3">
          {query.trim().length < 2 ? (
            <EmptyState icon="👋" title="Find friends" body="Search by name or username to follow people and see their rankings." />
          ) : people.isLoading ? (
            <Skeleton className="mx-2 h-16" />
          ) : (people.data ?? []).length === 0 ? (
            <EmptyState icon="🤷" title="No one found" body="Only public profiles appear in search." />
          ) : (
            <ul>
              {people.data!.map((u) => (
                <li key={u.id}>
                  <Link to={`/u/${u.username}`} className="press flex items-center gap-3 rounded-tile px-2 py-2.5 hover:bg-white">
                    <Avatar name={u.displayName} url={u.avatarUrl} size={44} />
                    <div>
                      <p className="font-bold text-choc">{u.displayName}</p>
                      <p className="text-sm text-muted">@{u.username}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <FiltersSheet open={open} onClose={() => setOpen(false)} filters={filters} sort={sort} onApply={(f, s) => setState({ filters: f, sort: s })} />
    </div>
  )
}
