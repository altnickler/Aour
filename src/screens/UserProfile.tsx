import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Lock, MapPin, Share, UserCheck, UserPlus } from 'lucide-react'
import { useAuth, useRequireAuth } from '@/app/auth'
import { useLocationState } from '@/app/location'
import { useFollow, useListingIndex, useProfile, useProfileCollections, useProfileFavorites, useProfileReviews, useRankings } from '@/data/hooks'
import { buildRankings } from '@/core/rating'
import { shareLink } from '@/lib/share'
import { PlaceThumb } from '@/components/place'
import { ScoreBadge } from '@/components/score'
import { ReviewCard } from '@/components/review'
import { Avatar, Button, EmptyState, IconButton, PageHeader, Segmented, Skeleton } from '@/components/ui'
import { errorMessage, useToast } from '@/components/toast'

export default function UserProfileScreen() {
  const { username = '' } = useParams()
  const profile = useProfile(username)
  const { user } = useAuth()
  const requireAuth = useRequireAuth()
  const follow = useFollow()
  const toast = useToast()
  const navigate = useNavigate()
  const p = profile.data
  const visible = !!p && !p.isPrivate
  const reviews = useProfileReviews(visible ? p.id : undefined)
  const favorites = useProfileFavorites(visible ? p.id : undefined)
  const collections = useProfileCollections(visible ? p.id : undefined)
  const { market } = useLocationState()
  const { index } = useListingIndex(market?.id)
  const mine = useRankings()
  const [tab, setTab] = useState<'ranked' | 'recent' | 'lists'>('ranked')

  // Their public ranking, computed with default weights from their public visits.
  const ranking = useMemo(
    () => buildRankings((reviews.data ?? []).map((r) => ({ id: r.visitId, establishmentId: r.establishmentId, visitedOn: r.visitedOn, createdAt: r.createdAt, scores: r.scores }))),
    [reviews.data],
  )

  if (profile.isLoading) {
    return (
      <div>
        <PageHeader title="" back />
        <div className="space-y-3 px-5">
          <Skeleton className="size-20 rounded-full" />
          <Skeleton className="h-6 w-1/2" />
        </div>
      </div>
    )
  }
  if (!p) {
    return (
      <div>
        <PageHeader title="Profile" back />
        <EmptyState icon="🙈" title="Profile not found" action={<Button onClick={() => navigate('/')}>Discover</Button>} />
      </div>
    )
  }

  const isMe = user?.id === p.id
  return (
    <div>
      <PageHeader
        title={`@${p.username}`}
        back
        actions={
          visible && (
            <IconButton
              label="Share profile"
              onClick={async () => {
                const r = await shareLink(`/u/${p.username}`, `${p.displayName} on Aour`, `${p.displayName}'s happy hour rankings`)
                if (r === 'copied') toast('Link copied')
              }}
            >
              <Share className="size-5" />
            </IconButton>
          )
        }
      />
      <div className="px-5">
        <div className="flex items-center gap-4">
          <Avatar name={p.displayName} url={p.avatarUrl} size={72} className="ring-4 ring-white shadow-card" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-extrabold text-choc">{p.displayName}</h1>
            {p.homeCity && (
              <p className="flex items-center gap-1 text-sm text-muted">
                <MapPin className="size-3.5" /> {p.homeCity}
              </p>
            )}
          </div>
        </div>
        {p.bio && <p className="mt-3 text-[15px] text-espresso">{p.bio}</p>}
        <dl className="mt-4 flex gap-5 text-sm">
          <div><dd className="inline font-extrabold text-choc">{p.placesRated}</dd> <dt className="inline text-muted">places</dt></div>
          <div><dd className="inline font-extrabold text-choc">{p.followers}</dd> <dt className="inline text-muted">followers</dt></div>
          <div><dd className="inline font-extrabold text-choc">{p.following}</dd> <dt className="inline text-muted">following</dt></div>
        </dl>
        {!isMe ? (
          !p.isPrivate && (
            <Button
              className="mt-4"
              block
              variant={p.isFollowing ? 'secondary' : 'primary'}
              loading={follow.isPending}
              onClick={() => {
                if (!requireAuth('follow')) return
                follow.mutate(
                  { userId: p.id, follow: !p.isFollowing, username: p.username },
                  { onSuccess: () => toast(p.isFollowing ? 'Unfollowed' : `Following ${p.displayName}`), onError: (e) => toast(errorMessage(e), 'error') },
                )
              }}
            >
              {p.isFollowing ? <><UserCheck className="size-4" /> Following</> : <><UserPlus className="size-4" /> Follow</>}
            </Button>
          )
        ) : (
          <Button className="mt-4" block variant="secondary" onClick={() => navigate('/me/edit')}>
            Edit profile
          </Button>
        )}
      </div>

      {p.isPrivate ? (
        <EmptyState icon={<Lock className="size-7" />} title="This profile is private" body="Their ratings and lists are only visible to them." />
      ) : (
        <>
          {(favorites.data ?? []).length > 0 && (
            <section className="mt-6">
              <h2 className="px-5 text-lg font-extrabold text-choc">Favorites</h2>
              <ul className="no-scrollbar mt-2 flex gap-3 overflow-x-auto px-5 pb-1">
                {favorites.data!.map((id) => {
                  const e = index.get(id)
                  return e ? (
                    <li key={id}>
                      <Link to={`/place/${e.slug}`} className="press block w-24">
                        <PlaceThumb place={e} className="size-24 text-xl" />
                        <p className="mt-1 truncate text-xs font-bold text-choc">{e.name}</p>
                      </Link>
                    </li>
                  ) : null
                })}
              </ul>
            </section>
          )}
          <Segmented
            className="mx-4 mt-6"
            label="Profile sections"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'ranked', label: 'Rankings' },
              { value: 'recent', label: 'Recent' },
              { value: 'lists', label: 'Collections' },
            ]}
          />
          <div className="mt-3 px-4">
            {tab === 'ranked' &&
              (ranking.length === 0 ? (
                <EmptyState icon="🏆" title="No public ratings yet" />
              ) : (
                <ol className="space-y-2">
                  {ranking.map((r) => {
                    const e = index.get(r.establishmentId)
                    if (!e) return null
                    const myScore = mine.byPlace.get(e.id)?.score
                    return (
                      <li key={r.establishmentId}>
                        <Link to={`/place/${e.slug}`} className="press flex items-center gap-3 rounded-card bg-white p-3 shadow-card">
                          <span className="tabular w-6 text-center font-extrabold text-muted">{r.rank}</span>
                          <PlaceThumb place={e} className="size-12 text-sm" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-bold text-choc">{e.name}</p>
                            <p className="text-xs text-muted">{r.visitCount} {r.visitCount === 1 ? 'visit' : 'visits'}{myScore !== undefined && !isMe ? ` · you: ${myScore.toFixed(1)}` : ''}</p>
                          </div>
                          <ScoreBadge score={r.score} kind="friends" size="sm" label={`${p.displayName}'s score ${r.score.toFixed(1)}`} />
                        </Link>
                      </li>
                    )
                  })}
                </ol>
              ))}
            {tab === 'recent' &&
              ((reviews.data ?? []).length === 0 ? (
                <EmptyState icon="💬" title="No public ratings yet" />
              ) : (
                <div className="space-y-3">
                  {reviews.data!.map((r) => {
                    const e = index.get(r.establishmentId)
                    return <ReviewCard key={r.visitId} review={r} showPlace placeName={e?.name} placeSlug={e?.slug} />
                  })}
                </div>
              ))}
            {tab === 'lists' &&
              ((collections.data ?? []).length === 0 ? (
                <EmptyState icon="📚" title="No public collections" />
              ) : (
                <ul className="space-y-2">
                  {collections.data!.map((c) => (
                    <li key={c.id}>
                      <Link to={`/c/${c.shareId}`} className="press flex items-center justify-between rounded-card bg-white p-4 shadow-card">
                        <span className="font-bold text-choc">{c.name}</span>
                        <span className="text-sm text-muted">{c.items.length} places</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        </>
      )}
    </div>
  )
}
