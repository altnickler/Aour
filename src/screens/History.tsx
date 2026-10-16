import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router'
import { Lock } from 'lucide-react'
import { useListingIndex, useMyVisits, useVisitScore } from '@/data/hooks'
import { TAG_BY_KEY } from '@/core/categories'
import { ScoreBadge } from '@/components/score'
import { PlaceThumb } from '@/components/place'
import { Button, EmptyState, PageHeader, Skeleton } from '@/components/ui'

/** Every rated visit, newest first, grouped by month. Tap to edit or delete. */
export default function HistoryScreen() {
  const visits = useMyVisits()
  const { index } = useListingIndex()
  const score = useVisitScore()
  const navigate = useNavigate()

  const groups = useMemo(() => {
    const sorted = [...(visits.data ?? [])].sort((a, b) => b.visitedOn.localeCompare(a.visitedOn) || b.createdAt.localeCompare(a.createdAt))
    const map = new Map<string, typeof sorted>()
    for (const v of sorted) {
      const key = new Date(`${v.visitedOn}T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      map.set(key, [...(map.get(key) ?? []), v])
    }
    return [...map]
  }, [visits.data])

  return (
    <div>
      <PageHeader title="Rating history" subtitle={visits.data ? `${visits.data.length} visits logged` : undefined} back />
      {visits.isLoading ? (
        <div className="space-y-3 px-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState icon="🗓️" title="No visits yet" action={<Button onClick={() => navigate('/rate')}>Rate a happy hour</Button>} />
      ) : (
        groups.map(([month, list]) => (
          <section key={month} className="mt-2">
            <h2 className="sticky top-[calc(env(safe-area-inset-top)+3.5rem)] z-10 bg-cream/95 px-5 py-2 text-sm font-bold tracking-wide text-muted uppercase backdrop-blur">{month}</h2>
            <ul className="space-y-2 px-4">
              {list.map((v) => {
                const place = index.get(v.establishmentId)
                return (
                  <li key={v.id}>
                    <Link to={`/visit/${v.id}/edit`} className="press flex items-center gap-3 rounded-card bg-white p-3 shadow-card">
                      {place && <PlaceThumb place={place} className="size-12 shrink-0 text-sm" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold text-choc">{place?.name ?? 'Unknown place'}</p>
                        <p className="flex items-center gap-1 truncate text-xs text-muted">
                          {new Date(`${v.visitedOn}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                          {' · '}
                          {v.mode === 'detailed' ? 'Detailed' : 'Quick'}
                          {v.visibility === 'private' && <Lock className="size-3" aria-label="private" />}
                        </p>
                        {v.tags.length > 0 && (
                          <p className="mt-0.5 truncate text-xs text-choc">{v.tags.map((t) => TAG_BY_KEY[t]?.label).filter(Boolean).join(' · ')}</p>
                        )}
                      </div>
                      <ScoreBadge score={score(v)} kind="mine" size="sm" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}
