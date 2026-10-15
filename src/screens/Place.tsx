import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { AlertTriangle, ChevronLeft, Clock, ExternalLink, FolderHeart, Globe, MapPin, Navigation, Phone, Share, Star } from 'lucide-react'
import { usePlace, usePlaceReviews, useRankings } from '@/data/hooks'
import { useAuth, useRequireAuth } from '@/app/auth'
import { useNow } from '@/app/useNow'
import { DAY_LONG, formatDays, formatRange, happyHourStatus } from '@/core/schedule'
import { KIND_LABEL, appleMapsUrl, priceLabel } from '@/core/listing'
import { AMENITY_BY_KEY, PRIMARY_CATEGORIES, TAG_BY_KEY, type PrimaryCategoryKey } from '@/core/categories'
import { confidenceLabel, formatScore, meanScore } from '@/core/rating'
import { api } from '@/data'
import { shareLink } from '@/lib/share'
import { cn } from '@/lib/cn'
import { DemoBadge, FreshnessBadge, HappyHourPill, PlaceThumb, SaveButton } from '@/components/place'
import { ScoreBadge, ScoreBar, Trend } from '@/components/score'
import { ReviewCard } from '@/components/review'
import { CollectionPicker } from '@/components/CollectionPicker'
import { Badge, Button, Chip, EmptyState, ErrorState, IconButton, Segmented, Sheet, Skeleton, Textarea } from '@/components/ui'
import { errorMessage, useToast } from '@/components/toast'
import type { Establishment } from '@/core/types'

export default function PlaceScreen() {
  const { slug = '' } = useParams()
  const place = usePlace(slug)
  const navigate = useNavigate()

  if (place.isError) return <ErrorState error={place.error} retry={() => place.refetch()} />
  if (place.isLoading && !place.data) return <PlaceSkeleton />
  if (!place.data)
    return (
      <EmptyState
        className="pt-safe mt-20"
        icon="🧭"
        title="Place not found"
        body="It may have been removed or isn't published yet."
        action={<Button onClick={() => navigate('/')}>Back to Discover</Button>}
      />
    )
  return <PlaceView place={place.data} />
}

function PlaceView({ place }: { place: Establishment }) {
  const navigate = useNavigate()
  const now = useNow()
  const toast = useToast()
  const requireAuth = useRequireAuth()
  const { user } = useAuth()
  const { byPlace, visits } = useRankings()
  const mine = byPlace.get(place.id)
  const [reviewTab, setReviewTab] = useState<'all' | 'friends'>('all')
  const reviews = usePlaceReviews(place.id, false)
  const friendReviews = usePlaceReviews(place.id, true)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)

  const friendsScore = useMemo(() => {
    const list = friendReviews.data ?? []
    const byUser = new Map<string, number[]>()
    for (const r of list) if (r.composite != null) byUser.set(r.user.id, [...(byUser.get(r.user.id) ?? []), r.composite])
    return { score: meanScore([...byUser.values()].map((v) => meanScore(v))), count: byUser.size }
  }, [friendReviews.data])

  const myVisits = visits.filter((v) => v.establishmentId === place.id)
  const conf = confidenceLabel(place.community.reviewers)
  const status = happyHourStatus(place.windows, place.exceptions, place.timezone, now)
  const shown = reviewTab === 'all' ? reviews : friendReviews

  return (
    <div className="pb-6">
      {/* Hero */}
      <div className="relative">
        {place.photos.length > 1 ? (
          <div className="no-scrollbar snap-x-row flex overflow-x-auto" aria-label="Photos">
            {place.photos.map((p) => (
              <figure key={p.id} className="relative w-full shrink-0">
                <img src={p.url} alt={p.alt ?? place.name} className="h-72 w-full object-cover" />
                {p.attribution && <figcaption className="absolute right-2 bottom-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">{p.attribution}</figcaption>}
              </figure>
            ))}
          </div>
        ) : (
          <PlaceThumb place={place} className="h-64 w-full text-5xl" rounded="rounded-none" />
        )}
        <div className="pt-safe absolute inset-x-0 top-0 flex items-center justify-between px-3 pt-2">
          <IconButton label="Back" variant="surface" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}>
            <ChevronLeft className="size-6" />
          </IconButton>
          <div className="flex gap-2">
            <IconButton
              label="Share"
              variant="surface"
              onClick={async () => {
                const r = await shareLink(`/place/${place.slug}`, place.name, mine ? `#${mine.rank} on my Aour list (${formatScore(mine.score)})` : `${place.name} on Aour`)
                if (r === 'copied') toast('Link copied')
              }}
            >
              <Share className="size-5" />
            </IconButton>
            <SaveButton placeId={place.id} list="favorite" />
            <SaveButton placeId={place.id} />
          </div>
        </div>
      </div>

      {/* Title */}
      <div className="relative -mt-6 rounded-t-[1.75rem] bg-cream px-5 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <HappyHourPill place={place} now={now} />
          <DemoBadge place={place} />
        </div>
        <h1 className="mt-2 text-[28px] leading-tight font-extrabold tracking-tight text-choc">{place.name}</h1>
        <p className="mt-1 text-[15px] text-muted">{[KIND_LABEL[place.kind], place.neighborhood ?? place.city, priceLabel(place.priceLevel)].filter(Boolean).join(' · ')}</p>

        {/* My · Friends · Community */}
        <div className="mt-5 grid grid-cols-3 gap-2" role="group" aria-label="Scores">
          <ScoreTile label="My rating" sub={mine ? `#${mine.rank} · ${mine.visitCount} ${mine.visitCount === 1 ? 'visit' : 'visits'}` : 'Not rated'}>
            <ScoreBadge score={mine?.score} kind="mine" size="lg" />
          </ScoreTile>
          <ScoreTile label="Friends" sub={user ? (friendsScore.count ? `${friendsScore.count} ${friendsScore.count === 1 ? 'friend' : 'friends'}` : 'None yet') : 'Sign in'}>
            <ScoreBadge score={friendsScore.score} kind="friends" size="lg" />
          </ScoreTile>
          <ScoreTile label="Community" sub={place.community.reviewers ? `${place.community.reviewers} ${place.community.reviewers === 1 ? 'rating' : 'ratings'}` : 'No ratings'}>
            <ScoreBadge score={place.community.average} size="lg" />
          </ScoreTile>
        </div>
        {conf === 'early' && <p className="mt-2 text-xs text-muted">Community score is early — based on very few ratings.</p>}
        {mine?.trend != null && Math.abs(mine.trend) >= 0.25 && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
            Your latest visit: <b className="text-choc">{formatScore(mine.latestScore)}</b> <Trend value={mine.trend} />
          </p>
        )}

        <div className="mt-5 flex gap-2">
          <Button size="lg" block onClick={() => navigate(`/rate/${place.slug}`)}>
            <Star className="size-5 fill-butter text-butter" /> {mine ? 'Rate another visit' : 'Rate this happy hour'}
          </Button>
          <IconButton
            label="Add to collection"
            variant="surface"
            className="size-14"
            onClick={() => requireAuth('collections') && setCollectionsOpen(true)}
          >
            <FolderHeart className="size-5" />
          </IconButton>
        </div>
      </div>

      {/* Happy hour (verified info) */}
      <section aria-labelledby="hh-title" className="mx-4 mt-6 overflow-hidden rounded-card bg-white shadow-card">
        <div className="flex items-center justify-between gap-2 bg-butter-soft px-4 py-3">
          <h2 id="hh-title" className="flex items-center gap-2 text-lg font-extrabold text-choc">
            <Clock className="size-5 text-gold-deep" /> Happy hour
          </h2>
          <FreshnessBadge place={place} now={now} />
        </div>
        <div className="p-4">
          {place.hhStatus === 'none' || place.windows.length === 0 ? (
            <p className="text-[15px] text-muted">We don't have a verified happy hour for this place.</p>
          ) : (
            <>
              {place.hhStatus !== 'verified' && (
                <p className="mb-3 flex gap-2 rounded-tile bg-gold/15 p-3 text-sm text-choc">
                  <AlertTriangle className="size-4 shrink-0 text-gold-deep" />
                  {place.hhStatus === 'outdated'
                    ? 'People reported these details may be out of date. Call ahead before you go.'
                    : 'These details haven’t been verified yet. Call ahead before you go.'}
                </p>
              )}
              <ul className="space-y-2">
                {place.windows.map((w) => (
                  <li key={w.id} className={cn('flex items-baseline justify-between gap-3 rounded-tile px-3 py-2', status.window?.id === w.id && status.state === 'now' ? 'bg-success/10' : 'bg-cream')}>
                    <span className="font-bold text-choc">
                      {formatDays(w.days)}
                      {w.label && <span className="ml-1.5 text-sm font-semibold text-muted">· {w.label}</span>}
                    </span>
                    <span className="tabular font-semibold text-choc">{formatRange(w.start, w.end)}</span>
                  </li>
                ))}
              </ul>
              {place.exceptions.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm text-muted">
                  {place.exceptions.map((x) => (
                    <li key={x.id}>
                      <b className="text-choc">{new Date(`${x.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}:</b>{' '}
                      {x.closed ? 'No happy hour' : `${formatRange(x.start!, x.end!)}`} {x.note && `· ${x.note}`}
                    </li>
                  ))}
                </ul>
              )}
              {place.specials.length > 0 && (
                <div className="mt-4">
                  <h3 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">Specials</h3>
                  <ul className="divide-y divide-line">
                    {place.specials.map((s) => (
                      <li key={s.id} className="flex items-baseline justify-between gap-3 py-2">
                        <span>
                          <span className="mr-1.5" aria-hidden>{s.kind === 'food' ? '🍽️' : s.kind === 'drink' ? '🍸' : '✨'}</span>
                          <span className="font-semibold text-choc">{s.title}</span>
                          {s.description && <span className="block pl-6 text-sm text-muted">{s.description}</span>}
                        </span>
                        {s.price && <span className="tabular shrink-0 font-bold text-choc">{s.price}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {place.hhSourceNote && <p className="mt-3 text-xs text-muted">Source: {place.hhSourceNote}</p>}
          <button type="button" onClick={() => requireAuth('report') && setReportOpen(true)} className="mt-3 text-sm font-semibold text-choc underline underline-offset-2">
            Report outdated info
          </button>
        </div>
      </section>

      {/* Community breakdown */}
      <section className="mx-4 mt-4 rounded-card bg-white p-4 shadow-card" aria-labelledby="breakdown-title">
        <div className="flex items-center justify-between">
          <h2 id="breakdown-title" className="text-lg font-extrabold text-choc">Ratings breakdown</h2>
          {mine && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <span className="inline-block h-3 w-1 rounded-full bg-choc" /> You
            </span>
          )}
        </div>
        {place.community.reviewers === 0 ? (
          <p className="mt-2 text-[15px] text-muted">No community ratings yet. Be the first!</p>
        ) : (
          <>
            <div className="mt-2">
              {PRIMARY_CATEGORIES.map((c) => (
                <ScoreBar key={c.key} label={c.label === 'Overall Experience' ? 'Overall' : c.label} value={place.community.categoryAverages[c.key as PrimaryCategoryKey]} mine={mine?.categoryAverages[c.key as PrimaryCategoryKey]} />
              ))}
            </div>
            <Distribution counts={place.community.distribution} />
          </>
        )}
        {place.community.topTags.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">What people say</h3>
            <div className="flex flex-wrap gap-1.5">
              {place.community.topTags.map((t) => (
                <span key={t.key} className="rounded-full bg-butter-soft px-2.5 py-1 text-sm font-semibold text-choc">
                  {TAG_BY_KEY[t.key]?.emoji} {TAG_BY_KEY[t.key]?.label ?? t.key} <span className="text-muted">{t.count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {place.amenities.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">Verified amenities</h3>
            <div className="flex flex-wrap gap-1.5">
              {place.amenities.map((a) => (
                <Badge key={a} tone="neutral" className="px-2.5 py-1 text-sm">
                  ✓ {AMENITY_BY_KEY[a] ?? a}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* My visits */}
      {myVisits.length > 0 && (
        <section className="mx-4 mt-4 rounded-card bg-white p-4 shadow-card">
          <h2 className="text-lg font-extrabold text-choc">Your visits</h2>
          <ul className="mt-2 divide-y divide-line">
            {myVisits.map((v) => (
              <li key={v.id}>
                <Link to={`/visit/${v.id}/edit`} className="flex items-center justify-between py-2.5">
                  <span>
                    <span className="font-semibold text-choc">{new Date(`${v.visitedOn}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    <span className="ml-2 text-sm text-muted">{v.visibility === 'private' ? 'Private' : 'Public'} · Edit</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Reviews */}
      <section className="mt-6" aria-labelledby="reviews-title">
        <div className="flex items-center justify-between px-5">
          <h2 id="reviews-title" className="text-lg font-extrabold text-choc">Reviews</h2>
        </div>
        <Segmented
          className="mx-4 mt-3"
          label="Reviews from"
          value={reviewTab}
          onChange={setReviewTab}
          options={[
            { value: 'all', label: 'Everyone' },
            { value: 'friends', label: 'People you follow' },
          ]}
        />
        <div className="mt-3 space-y-3 px-4">
          {reviewTab === 'friends' && !user ? (
            <EmptyState icon="👯" title="See what friends think" body="Sign in and follow people to see their ratings here." action={<Button onClick={() => requireAuth()}>Sign in</Button>} />
          ) : shown.isLoading ? (
            <Skeleton className="h-32" />
          ) : (shown.data ?? []).length === 0 ? (
            <EmptyState icon="💬" title={reviewTab === 'friends' ? 'No friends have rated this yet' : 'No public reviews yet'} body="Ratings show up here once people share them publicly." />
          ) : (
            shown.data!.map((r) => <ReviewCard key={r.visitId} review={r} />)
          )}
        </div>
      </section>

      {/* About (general establishment info) */}
      <section className="mx-4 mt-6 rounded-card bg-white p-4 shadow-card" aria-labelledby="about-title">
        <h2 id="about-title" className="text-lg font-extrabold text-choc">About</h2>
        {place.description && <p className="mt-2 text-[15px] leading-relaxed text-espresso">{place.description}</p>}
        <ul className="mt-3 space-y-1">
          <InfoRow icon={<MapPin className="size-4" />} href={appleMapsUrl(place.name, place.address, place)} label={place.address} sub={`${place.city}, ${place.state}`} />
          <InfoRow icon={<Navigation className="size-4" />} href={appleMapsUrl(place.name, place.address, place)} label="Directions" />
          {place.website && <InfoRow icon={<Globe className="size-4" />} href={place.website} label={place.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')} />}
          {place.phone && <InfoRow icon={<Phone className="size-4" />} href={`tel:${place.phone}`} label={place.phone} />}
        </ul>
        {place.isDemo && <p className="mt-3 rounded-tile bg-cream-deep p-3 text-xs text-muted">This is a fictional demo listing used for development. It is not a real business.</p>}
      </section>

      <p className="mt-6 px-6 text-center text-xs text-muted">
        Hours and specials can change. <Link className="underline" to="/suggest">Suggest an edit</Link>
      </p>

      <CollectionPicker open={collectionsOpen} onClose={() => setCollectionsOpen(false)} establishmentId={place.id} />
      <OutdatedSheet open={reportOpen} onClose={() => setReportOpen(false)} place={place} onDone={() => toast('Thanks! We’ll re-verify this listing.')} />
    </div>
  )
}

function ScoreTile({ label, sub, children }: { label: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-card bg-white px-2 py-3 text-center shadow-card">
      {children}
      <p className="mt-1.5 text-xs font-bold text-choc">{label}</p>
      <p className="text-[11px] text-muted">{sub}</p>
    </div>
  )
}

function Distribution({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts)
  return (
    <div className="mt-4" aria-label="Score distribution">
      <h3 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">Distribution</h3>
      <div className="flex h-16 items-end gap-1">
        {counts.map((c, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-1">
            <div className={cn('w-full rounded-t-md', i >= 7 ? 'bg-gold' : 'bg-beige')} style={{ height: `${Math.max(4, (c / max) * 48)}px` }} title={`${c} with ${i + 1}–${i + 2}`} />
            <span className="text-[10px] text-muted">{i + 1}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function InfoRow({ icon, href, label, sub }: { icon: ReactNode; href: string; label: string; sub?: string }) {
  const external = href.startsWith('http')
  return (
    <li>
      <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined} className="press -mx-2 flex items-center gap-3 rounded-tile px-2 py-2 hover:bg-cream">
        <span className="flex size-9 items-center justify-center rounded-full bg-cream-deep text-choc">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-choc">{label}</span>
          {sub && <span className="block text-sm text-muted">{sub}</span>}
        </span>
        {external && <ExternalLink className="size-4 text-muted" />}
      </a>
    </li>
  )
}

function OutdatedSheet({ open, onClose, place, onDone }: { open: boolean; onClose: () => void; place: Establishment; onDone: () => void }) {
  const [what, setWhat] = useState<string[]>([])
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const options = ['Times changed', 'Days changed', 'Specials changed', 'No longer offers happy hour', 'Place closed']
  return (
    <Sheet open={open} onClose={onClose} title="What's out of date?">
      <p className="text-sm text-muted">Tell us what changed at {place.name}. We verify before updating the listing.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {options.map((o) => (
          <Chip key={o} selected={what.includes(o)} onClick={() => setWhat((w) => (w.includes(o) ? w.filter((x) => x !== o) : [...w, o]))}>
            {o}
          </Chip>
        ))}
      </div>
      <Textarea className="mt-4" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} placeholder={`e.g. Happy hour is now ${DAY_LONG[1]}–Thursday 3–6pm`} aria-label="Details" />
      <Button
        className="mt-4"
        block
        loading={busy}
        disabled={!what.length && !details.trim()}
        onClick={async () => {
          setBusy(true)
          try {
            await api.submit('outdated', place.id, { issues: what.join(', '), details: details.trim() })
            onDone()
            onClose()
            setWhat([])
            setDetails('')
          } catch (e) {
            toast(errorMessage(e), 'error')
          } finally {
            setBusy(false)
          }
        }}
      >
        Send report
      </Button>
    </Sheet>
  )
}

function PlaceSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading place">
      <div className="skeleton h-64" />
      <div className="space-y-3 p-5">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <div className="grid grid-cols-3 gap-2">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-14" />
        <Skeleton className="h-48" />
      </div>
    </div>
  )
}
