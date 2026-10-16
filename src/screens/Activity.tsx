import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router'
import { FolderHeart, Heart } from 'lucide-react'
import { useAuth } from '@/app/auth'
import { useFeed, useFollowing, useListingIndex } from '@/data/hooks'
import { ReviewCard, relativeDate } from '@/components/review'
import { PlaceThumb } from '@/components/place'
import { Avatar, Button, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui'

/** Lightweight following feed: new ratings, favorites and public collections. */
export default function ActivityScreen() {
  const { user, loading } = useAuth()
  const feed = useFeed()
  const following = useFollowing()
  const feedIds = useMemo(
    () => (feed.data ?? []).flatMap((i) => (i.kind === 'visit' ? [i.review.establishmentId] : i.kind === 'favorite' ? [i.establishmentId] : [])),
    [feed.data],
  )
  const { index } = useListingIndex(feedIds)
  const navigate = useNavigate()

  if (!loading && !user) {
    return (
      <div>
        <PageHeader title="Friends" back />
        <EmptyState icon="👯" title="See where friends go" body="Follow people to see their latest ratings and favorites." action={<Button onClick={() => navigate('/signin?next=/activity')}>Sign in</Button>} />
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="Friends" subtitle="Activity from people you follow" back />
      {(following.data ?? []).length > 0 && (
        <ul className="no-scrollbar flex gap-4 overflow-x-auto px-5 pb-3" aria-label="People you follow">
          {following.data!.map((u) => (
            <li key={u.id}>
              <Link to={`/u/${u.username}`} className="flex w-16 flex-col items-center gap-1">
                <Avatar name={u.displayName} url={u.avatarUrl} size={52} className="ring-2 ring-butter" />
                <span className="w-full truncate text-center text-xs font-semibold text-choc">{u.displayName.split(' ')[0]}</span>
              </Link>
            </li>
          ))}
          <li>
            <Link to="/people" className="flex w-16 flex-col items-center gap-1">
              <span className="flex size-[52px] items-center justify-center rounded-full bg-white text-2xl text-choc ring-1 ring-line">+</span>
              <span className="text-xs font-semibold text-muted">Find</span>
            </Link>
          </li>
        </ul>
      )}
      <div className="space-y-3 px-4">
        {feed.isLoading ? (
          <>
            <Skeleton className="h-36" />
            <Skeleton className="h-36" />
          </>
        ) : feed.isError ? (
          <ErrorState error={feed.error} retry={() => feed.refetch()} />
        ) : (feed.data ?? []).length === 0 ? (
          <EmptyState
            icon="🌅"
            title="It's quiet here"
            body="Follow a few people and their ratings will show up here. Aour works great solo too!"
            action={<Button onClick={() => navigate('/people')}>Find people</Button>}
          />
        ) : (
          feed.data!.map((item) => {
            if (item.kind === 'visit') {
              const e = index.get(item.review.establishmentId)
              return <ReviewCard key={item.id} review={item.review} showPlace placeName={e?.name ?? 'a happy hour'} placeSlug={e?.slug ?? item.review.establishmentId} />
            }
            if (item.kind === 'favorite') {
              const e = index.get(item.establishmentId)
              if (!e) return null
              return (
                <Link key={item.id} to={`/place/${e.slug}`} className="press flex items-center gap-3 rounded-card bg-white p-4 shadow-card">
                  <PlaceThumb place={e} className="size-12 text-sm" />
                  <p className="min-w-0 flex-1 text-[15px] text-espresso">
                    <b className="text-choc">{item.user.displayName}</b> added <b className="text-choc">{e.name}</b> to favorites
                    <span className="block text-xs text-muted">{relativeDate(item.at)}</span>
                  </p>
                  <Heart className="size-5 fill-danger text-danger" aria-hidden />
                </Link>
              )
            }
            return (
              <Link key={item.id} to={`/c/${item.collection.shareId}`} className="press flex items-center gap-3 rounded-card bg-white p-4 shadow-card">
                <span className="flex size-12 items-center justify-center rounded-tile bg-butter text-choc">
                  <FolderHeart className="size-6" />
                </span>
                <p className="min-w-0 flex-1 text-[15px] text-espresso">
                  <b className="text-choc">{item.user.displayName}</b> made a list: <b className="text-choc">{item.collection.name}</b>
                  <span className="block text-xs text-muted">
                    {item.collection.itemCount} places · {relativeDate(item.at)}
                  </span>
                </p>
              </Link>
            )
          })
        )}
      </div>
    </div>
  )
}
