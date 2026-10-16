import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Lock, Plus, SlidersHorizontal } from 'lucide-react'
import { useAuth, useRequireAuth } from '@/app/auth'
import { useListingIndex, useMyCollections, useCollectionMutations, useRankings, useSaved } from '@/data/hooks'
import { RANKING_SORTS, sortRankings, formatScore, type RankingEntry, type RankingSort } from '@/core/rating'
import { CATEGORY_BY_KEY } from '@/core/categories'
import type { Establishment, SavedList } from '@/core/types'
import { cn } from '@/lib/cn'
import { PlaceRow, PlaceThumb, SaveButton } from '@/components/place'
import { ScoreBadge, Trend } from '@/components/score'
import { Button, Chip, EmptyState, IconButton, Input, PageHeader, Segmented, Sheet, Skeleton, Textarea } from '@/components/ui'
import { Mark } from '@/components/brand'
import { errorMessage, useToast } from '@/components/toast'
import { relativeDate } from '@/components/review'
import { useNow } from '@/app/useNow'

type Tab = 'ranked' | 'want' | 'favorites' | 'collections'

export default function RankingsScreen() {
  const { user, loading } = useAuth()
  const requireAuth = useRequireAuth()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'ranked'
  const setTab = (t: Tab) => setParams(t === 'ranked' ? {} : { tab: t }, { replace: true })
  const navigate = useNavigate()

  if (!loading && !user) {
    return (
      <div>
        <PageHeader title="My Rankings" />
        <EmptyState
          icon={<Mark size={40} />}
          title="Your happy hours, ranked"
          body="Rate the places you visit and Aour keeps a living, personal ranking — plus lists of favorites and places to try."
          action={<Button size="lg" onClick={() => requireAuth('rankings')}>Sign in to start</Button>}
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="My Rankings"
        actions={
          <IconButton label="Ranking preferences" onClick={() => navigate('/settings#weights')}>
            <SlidersHorizontal className="size-5" />
          </IconButton>
        }
      />
      <div className="px-4 pb-2">
        <Segmented
          label="Lists"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'ranked', label: 'Ranked' },
            { value: 'want', label: 'Want to Try' },
            { value: 'favorites', label: 'Favorites' },
            { value: 'collections', label: 'Lists' },
          ]}
        />
      </div>
      {tab === 'ranked' && <Ranked />}
      {tab === 'want' && <SavedList list="want_to_try" />}
      {tab === 'favorites' && <SavedList list="favorite" />}
      {tab === 'collections' && <Collections />}
    </div>
  )
}

function Ranked() {
  const { index, isLoading: listingsLoading } = useListingIndex()
  const { rankings, visits, isLoading } = useRankings()
  const [sort, setSort] = useState<RankingSort>('overall')
  const sorted = useMemo(() => sortRankings(rankings, sort), [rankings, sort])
  const navigate = useNavigate()

  if (isLoading || listingsLoading) {
    return (
      <div className="space-y-3 px-4 pt-2">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}
      </div>
    )
  }
  if (!rankings.length) {
    return (
      <EmptyState
        icon="🏆"
        title="Nothing ranked yet"
        body="Rate your first happy hour and it'll appear here. Every rating updates your list instantly."
        action={<Button size="lg" onClick={() => navigate('/rate')}><Plus className="size-5" /> Rate a happy hour</Button>}
      />
    )
  }

  return (
    <>
      <div className="mx-4 mt-2 grid grid-cols-3 gap-2 text-center">
        <Stat value={rankings.length} label="Places" />
        <Stat value={visits.length} label="Visits" />
        <Stat value={formatScore(rankings[0]?.score)} label="Top score" />
      </div>
      <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto px-4 pb-2" role="group" aria-label="Sort rankings">
        {RANKING_SORTS.map((s) => (
          <Chip key={s.key} selected={sort === s.key} onClick={() => setSort(s.key)}>
            {s.label}
          </Chip>
        ))}
      </div>
      <ol className="space-y-2.5 px-4 pt-1" aria-label="Your ranked happy hours">
        {sorted.map((r) => {
          const place = index.get(r.establishmentId)
          return place ? <RankRow key={r.establishmentId} entry={r} place={place} sort={sort} /> : null
        })}
      </ol>
      <p className="mt-6 px-8 text-center text-xs text-muted">
        Place score = average of your visits, weighted by your <Link to="/settings#weights" className="underline">category preferences</Link>.
      </p>
      <div className="mt-4 text-center">
        <Link to="/me/history" className="text-sm font-bold text-choc underline">
          See full rating history
        </Link>
      </div>
    </>
  )
}

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="rounded-card bg-white py-3 shadow-card">
      <p className="tabular text-xl font-extrabold text-choc">{value}</p>
      <p className="text-xs font-semibold text-muted">{label}</p>
    </div>
  )
}

function RankRow({ entry, place, sort }: { entry: RankingEntry; place: Establishment; sort: RankingSort }) {
  const categorySort = !['overall', 'recent', 'frequent'].includes(sort)
  const shownScore = categorySort ? entry.categoryAverages[sort as keyof RankingEntry['categoryAverages']] : entry.score
  const medal = entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : null
  return (
    <li>
      <Link to={`/place/${place.slug}`} className="press flex items-center gap-3 rounded-card bg-white p-3 shadow-card">
        <span className={cn('tabular flex w-8 shrink-0 flex-col items-center text-lg font-extrabold', entry.rank <= 3 ? 'text-choc' : 'text-muted')} aria-label={`Rank ${entry.rank}`}>
          {medal ? <span aria-hidden className="text-xl">{medal}</span> : entry.rank}
        </span>
        <PlaceThumb place={place} className="size-14 shrink-0 text-base" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-extrabold text-choc">{place.name}</p>
          <p className="truncate text-xs text-muted">
            {relativeDate(entry.lastVisitedOn)} · {entry.visitCount} {entry.visitCount === 1 ? 'visit' : 'visits'}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {entry.highlights.map((h) => (
              <span key={h} className="rounded-full bg-butter-soft px-2 py-0.5 text-[11px] font-bold text-choc">
                {CATEGORY_BY_KEY[h].label}
              </span>
            ))}
            <Trend value={entry.trend} />
          </div>
        </div>
        <div className="flex flex-col items-center">
          <ScoreBadge score={shownScore} kind="mine" />
          {categorySort && <span className="mt-0.5 text-[10px] font-semibold text-muted">{CATEGORY_BY_KEY[sort].label}</span>}
        </div>
      </Link>
    </li>
  )
}

function SavedList({ list }: { list: SavedList }) {
  const { index, isLoading } = useListingIndex()
  const saved = useSaved()
  const { byPlace } = useRankings()
  const now = useNow()
  const navigate = useNavigate()
  const items = useMemo(
    () => (saved.data ?? []).filter((s) => s.list === list).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => index.get(s.establishmentId)).filter((e): e is Establishment => !!e),
    [saved.data, list, index],
  )
  if (saved.isLoading || isLoading) return <Skeleton className="mx-4 mt-2 h-24" />
  if (!items.length) {
    return list === 'want_to_try' ? (
      <EmptyState icon="🔖" title="Nothing saved yet" body="Tap the bookmark on any place to save it for later." action={<Button variant="secondary" onClick={() => navigate('/')}>Discover places</Button>} />
    ) : (
      <EmptyState icon="❤️" title="No favorites yet" body="Tap the heart on a place you love. Favorites appear on your profile." action={<Button variant="secondary" onClick={() => navigate('/')}>Discover places</Button>} />
    )
  }
  return (
    <ul className="px-3 pt-2">
      {items.map((e) => {
        const mine = byPlace.get(e.id)
        return (
          <li key={e.id} className="flex items-center">
            <div className="min-w-0 flex-1">
              <PlaceRow place={e} now={now} trailing={mine ? <ScoreBadge score={mine.score} kind="mine" size="sm" /> : <ScoreBadge score={e.community.average} size="sm" />} />
            </div>
            {list === 'want_to_try' && !mine && (
              <Button size="sm" variant="butter" onClick={() => navigate(`/rate/${e.slug}`)} className="mr-1">
                Been
              </Button>
            )}
            <SaveButton placeId={e.id} list={list} variant="plain" />
          </li>
        )
      })}
    </ul>
  )
}

function Collections() {
  const collections = useMyCollections()
  const collectionIds = useMemo(() => (collections.data ?? []).flatMap((c) => c.items.map((i) => i.establishmentId)), [collections.data])
  const { index } = useListingIndex(collectionIds)
  const [editing, setEditing] = useState(false)
  if (collections.isLoading) return <Skeleton className="mx-4 mt-2 h-24" />
  return (
    <div className="px-4 pt-2">
      <Button variant="secondary" block onClick={() => setEditing(true)}>
        <Plus className="size-4" /> New collection
      </Button>
      {(collections.data ?? []).length === 0 ? (
        <EmptyState icon="📚" title="Make your own lists" body='Group places your way — "Best in Stuart", "Date nights", "Waterfront".' />
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-3">
          {collections.data!.map((c) => {
            const covers = c.items.slice(0, 4).map((i) => index.get(i.establishmentId)).filter((e): e is Establishment => !!e)
            return (
              <li key={c.id}>
                <Link to={`/collections/${c.shareId}`} className="press block overflow-hidden rounded-card bg-white shadow-card">
                  <div className="grid aspect-square grid-cols-2 gap-0.5 bg-beige">
                    {[0, 1, 2, 3].map((i) => (covers[i] ? <PlaceThumb key={i} place={covers[i]} className="h-full w-full text-base" rounded="rounded-none" /> : <div key={i} className="bg-cream-deep" />))}
                  </div>
                  <div className="p-3">
                    <p className="truncate font-extrabold text-choc">{c.name}</p>
                    <p className="flex items-center gap-1 text-xs text-muted">
                      {c.items.length} places {c.visibility === 'private' && <Lock className="size-3" aria-label="private" />}
                    </p>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      <CollectionEditor open={editing} onClose={() => setEditing(false)} />
    </div>
  )
}

export function CollectionEditor({
  open,
  onClose,
  initial,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  initial?: { id: string; name: string; description: string | null; visibility: 'public' | 'private' }
  onSaved?: () => void
}) {
  const { save } = useCollectionMutations()
  const toast = useToast()
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [visibility, setVisibility] = useState<'public' | 'private'>(initial?.visibility ?? 'private')
  return (
    <Sheet open={open} onClose={onClose} title={initial ? 'Edit collection' : 'New collection'}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(
            { id: initial?.id, name, description: description.trim() || null, visibility },
            {
              onSuccess: () => {
                toast(initial ? 'Saved' : 'Collection created')
                onSaved?.()
                onClose()
                if (!initial) {
                  setName('')
                  setDescription('')
                }
              },
              onError: (err) => toast(errorMessage(err), 'error'),
            },
          )
        }}
      >
        <div>
          <label htmlFor="col-name" className="text-sm font-semibold text-choc">Name</label>
          <Input id="col-name" className="mt-1.5" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Best Waterfront Spots" required />
        </div>
        <div>
          <label htmlFor="col-desc" className="text-sm font-semibold text-choc">Description</label>
          <Textarea id="col-desc" className="mt-1.5 min-h-16" value={description} maxLength={280} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
        </div>
        <Segmented
          label="Visibility"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: 'private', label: 'Private' },
            { value: 'public', label: 'Public · shareable' },
          ]}
        />
        <Button type="submit" block loading={save.isPending} disabled={!name.trim()}>
          {initial ? 'Save' : 'Create collection'}
        </Button>
      </form>
    </Sheet>
  )
}

