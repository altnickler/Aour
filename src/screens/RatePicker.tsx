import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Search as SearchIcon } from 'lucide-react'
import { useAuth, useRequireAuth } from '@/app/auth'
import { useDiscovery } from '@/app/useDiscovery'
import { useSaved } from '@/data/hooks'
import { filterEstablishments, sortEstablishments, DEFAULT_FILTERS } from '@/core/discovery'
import { happyHourStatus } from '@/core/schedule'
import { PlaceRow } from '@/components/place'
import { ScoreBadge } from '@/components/score'
import { Button, EmptyState, PageHeader, Skeleton } from '@/components/ui'
import { Mark } from '@/components/brand'
import type { Establishment } from '@/core/types'

export default function RatePickerScreen() {
  const { user, loading } = useAuth()
  const requireAuth = useRequireAuth()
  const { listings, ctx, now, rankingByPlace, origin } = useDiscovery()
  const saved = useSaved()
  const [q, setQ] = useState('')

  const all = useMemo(() => listings.data ?? [], [listings.data])
  const results = useMemo(
    () => (q.trim() ? sortEstablishments(filterEstablishments(all, { ...DEFAULT_FILTERS, query: q }, ctx), 'name', ctx) : []),
    [all, q, ctx],
  )
  const suggestions = useMemo(() => {
    const seen = new Set<string>()
    const pick = (list: Establishment[]) => list.filter((e) => !seen.has(e.id) && seen.add(e.id))
    const live = pick(all.filter((e) => ['now', 'later_today'].includes(happyHourStatus(e.windows, e.exceptions, e.timezone, now).state)))
    const wants = pick(all.filter((e) => saved.has('want_to_try', e.id)))
    const again = pick(
      [...rankingByPlace.values()].sort((a, b) => b.lastVisitedOn.localeCompare(a.lastVisitedOn)).map((r) => all.find((e) => e.id === r.establishmentId)).filter((e): e is Establishment => !!e),
    )
    return { live: live.slice(0, 5), wants: wants.slice(0, 5), again: again.slice(0, 5) }
  }, [all, now, saved, rankingByPlace])

  if (!loading && !user) {
    return (
      <div>
        <PageHeader title="Rate" />
        <EmptyState
          icon={<Mark size={40} />}
          title="Start your ranked list"
          body="Rate a happy hour in about 30 seconds. Aour builds your personal ranking automatically."
          action={<Button size="lg" onClick={() => requireAuth('rate')}>Sign in to rate</Button>}
        />
      </div>
    )
  }

  const trailing = (e: Establishment) => {
    const r = rankingByPlace.get(e.id)
    return r ? <ScoreBadge score={r.score} kind="mine" size="sm" /> : undefined
  }

  return (
    <div>
      <PageHeader title="Where did you go?" subtitle="Pick the place you want to rate" />
      <div className="sticky top-[calc(env(safe-area-inset-top)+3.5rem)] z-10 bg-cream/92 px-4 pb-3 backdrop-blur-xl">
        <label className="flex h-12 items-center gap-2 rounded-full bg-white px-4 shadow-press ring-1 ring-line focus-within:ring-2 focus-within:ring-gold">
          <SearchIcon className="size-5 text-muted" aria-hidden />
          <span className="sr-only">Search places</span>
          <input
            autoFocus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or neighborhood"
            className="h-full min-w-0 flex-1 bg-transparent placeholder:text-muted-soft focus:outline-none"
          />
        </label>
      </div>

      {listings.isLoading ? (
        <div className="space-y-3 px-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : q.trim() ? (
        results.length ? (
          <ul className="px-3">
            {results.map((e) => (
              <li key={e.id}>
                <PlaceRow place={e} origin={origin} now={now} to={`/rate/${e.slug}`} trailing={trailing(e)} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="🤔" title="Not on Aour yet" body="Suggest it and we'll add it once the details are verified." action={<Link to="/suggest" className="font-bold text-choc underline">Suggest a place</Link>} />
        )
      ) : (
        <div className="space-y-2">
          <Group title="Rate again" items={suggestions.again} trailing={trailing} now={now} />
          <Group title="On your Want to Try list" items={suggestions.wants} trailing={trailing} now={now} />
          <Group title="Happy hour today" items={suggestions.live} trailing={trailing} now={now} />
          {!suggestions.again.length && !suggestions.wants.length && !suggestions.live.length && (
            <EmptyState icon="🍸" title="Search for a place" body="Type a name above to find the happy hour you visited." />
          )}
        </div>
      )}
    </div>
  )
}

function Group({ title, items, trailing, now }: { title: string; items: Establishment[]; trailing: (e: Establishment) => ReactNode; now: Date }) {
  if (!items.length) return null
  return (
    <section className="pt-2">
      <h2 className="px-5 pb-1 text-sm font-bold tracking-wide text-muted uppercase">{title}</h2>
      <ul className="px-3">
        {items.map((e) => (
          <li key={e.id}>
            <PlaceRow place={e} now={now} to={`/rate/${e.slug}`} trailing={trailing(e)} />
          </li>
        ))}
      </ul>
    </section>
  )
}
