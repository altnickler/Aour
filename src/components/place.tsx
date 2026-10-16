import { memo, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Bookmark, BookmarkCheck, Clock, Heart } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { Establishment, SavedList } from '@/core/types'
import { happyHourStatus, statusLabel, formatRange, windowsForDay } from '@/core/schedule'
import { KIND_EMOJI, KIND_LABEL, distanceMiles, formatMiles, priceLabel, verificationInfo, type LatLng } from '@/core/listing'
import { TAG_BY_KEY, AMENITY_BY_KEY } from '@/core/categories'
import { ScoreBadge } from './score'
import { Badge } from './ui'
import { useAuth, useRequireAuth } from '@/app/auth'
import { useSaved, useToggleSaved } from '@/data/hooks'
import { useToast } from './toast'

const GRADIENTS = [
  'from-[#FFDE75] to-[#F4B942]',
  'from-[#F6E3C2] to-[#E9C38A]',
  'from-[#FFE9A8] to-[#F2C46B]',
  'from-[#EFD9BD] to-[#D9B48A]',
  'from-[#FFF0BF] to-[#F4B942]',
]

function hash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Licensed photo when available; otherwise a warm generated tile (never a scraped image). */
export function PlaceThumb({ place, className, rounded = 'rounded-tile' }: { place: Establishment; className?: string; rounded?: string }) {
  const photo = place.photos[0]
  if (photo) {
    return <img src={photo.url} alt={photo.alt ?? ''} loading="lazy" decoding="async" className={cn('bg-beige object-cover', rounded, className)} />
  }
  return (
    <div aria-hidden className={cn('relative flex items-center justify-center overflow-hidden bg-gradient-to-br', GRADIENTS[hash(place.id) % GRADIENTS.length], rounded, className)}>
      <span className="text-[2.2em] drop-shadow-sm">{KIND_EMOJI[place.kind] ?? '✨'}</span>
      <span className="absolute -right-3 -bottom-4 text-[4.5em] font-extrabold text-choc/8">{place.name[0]}</span>
    </div>
  )
}

export function HappyHourPill({ place, now = new Date(), className }: { place: Establishment; now?: Date; className?: string }) {
  if (place.hhStatus === 'none') return <Badge className={className}>No happy-hour info yet</Badge>
  const s = happyHourStatus(place.windows, place.exceptions, place.timezone, now)
  if (s.state === 'none') return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold whitespace-nowrap',
        s.state === 'now' ? 'bg-success text-white' : s.state === 'later_today' ? 'bg-butter text-choc' : 'bg-beige text-choc',
        className,
      )}
    >
      {s.state === 'now' ? <span className="size-1.5 animate-pulse rounded-full bg-white" aria-hidden /> : <Clock className="size-3" aria-hidden />}
      {s.state === 'now' ? `Now · ${statusLabel(s)}` : statusLabel(s)}
    </span>
  )
}

/** Where the happy-hour details come from: Verified / Reported by venue / Community reported / Needs verification / Outdated. */
export function VerificationBadge({ place, now = new Date(), className }: { place: Establishment; now?: Date; className?: string }) {
  if (place.hhStatus === 'none') return null
  const v = verificationInfo(place, now)
  return (
    <Badge tone={v.tone === 'info' ? 'butter' : v.tone} className={className}>
      {place.hhStatus === 'verified' && v.tone === 'success' ? '✓ ' : ''}
      {v.label}
    </Badge>
  )
}

/** Kept for existing call sites. */
export const FreshnessBadge = VerificationBadge

/** "Today 3–6pm, 9pm–close" in the venue's own time zone. */
export function todaySchedule(place: Establishment, now: Date): string | null {
  if (place.hhStatus === 'none' || place.windows.length === 0) return null
  const today = windowsForDay(place.windows, place.exceptions, place.timezone, now, 0)
  if (!today.length) return 'No happy hour today'
  return `Today ${today.map((w) => formatRange(w.start, w.end)).join(', ')}`
}

export function DemoBadge({ place }: { place: Establishment }) {
  return place.isDemo ? (
    <Badge tone="dark" className="uppercase tracking-wide">
      Demo listing
    </Badge>
  ) : null
}

export function SaveButton({ placeId, list = 'want_to_try', className, variant = 'surface' }: { placeId: string; list?: SavedList; className?: string; variant?: 'surface' | 'plain' }) {
  const { user } = useAuth()
  const requireAuth = useRequireAuth()
  const saved = useSaved()
  const toggle = useToggleSaved()
  const toast = useToast()
  const on = !!user && saved.has(list, placeId)
  const Icon = list === 'favorite' ? Heart : on ? BookmarkCheck : Bookmark
  const label = list === 'favorite' ? (on ? 'Remove from favorites' : 'Add to favorites') : on ? 'Remove from Want to Try' : 'Save to Want to Try'
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!requireAuth('save')) return
        toggle.mutate(
          { id: placeId, list, saved: !on },
          { onSuccess: () => toast(on ? 'Removed' : list === 'favorite' ? 'Added to favorites' : 'Saved to Want to Try') },
        )
      }}
      className={cn(
        'press inline-flex size-11 shrink-0 items-center justify-center rounded-full',
        variant === 'surface' && 'bg-white/90 shadow-press ring-1 ring-line backdrop-blur',
        on ? 'text-choc' : 'text-muted',
        className,
      )}
    >
      <Icon className={cn('size-5', on && 'animate-pop', on && list === 'favorite' && 'fill-danger text-danger', on && list !== 'favorite' && 'fill-butter')} />
    </button>
  )
}

/** One or two highlights for a card: real published specials first, then community tags / amenities. */
function highlights(place: Establishment): string[] {
  const out: string[] = []
  if (place.hhStatus !== 'none') {
    for (const sp of place.specials.slice(0, 2)) out.push(`${sp.price ? `${sp.price} ` : ''}${sp.title}`)
  }
  const tag = place.community.topTags[0]
  if (out.length < 2 && tag && TAG_BY_KEY[tag.key]) out.push(`${TAG_BY_KEY[tag.key].emoji} ${TAG_BY_KEY[tag.key].label}`)
  const amenity = place.amenities.find((a) => ['waterfront', 'rooftop', 'outdoor_seating', 'live_music'].includes(a))
  if (amenity && out.length < 2 && !out.some((x) => x.toLowerCase().includes(AMENITY_BY_KEY[amenity].toLowerCase()))) out.push(AMENITY_BY_KEY[amenity])
  return out.slice(0, 2)
}

/** Main discovery card. */
export const PlaceCard = memo(function PlaceCard({
  place,
  origin,
  myScore,
  now,
  className,
}: {
  place: Establishment
  origin?: LatLng | null
  myScore?: number | null
  now?: Date
  className?: string
}) {
  const hl = highlights(place)
  const today = todaySchedule(place, now ?? new Date())
  return (
    <Link to={`/place/${place.slug}`} className={cn('press group block overflow-hidden rounded-card bg-white shadow-card', className)}>
      <div className="relative">
        <PlaceThumb place={place} className="h-36 w-full text-2xl" rounded="rounded-none" />
        <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
          <HappyHourPill place={place} now={now} className="shadow-press" />
        </div>
        <div className="absolute top-2 right-2">
          <SaveButton placeId={place.id} />
        </div>
      </div>
      <div className="flex gap-3 p-4">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[17px] font-extrabold tracking-tight text-choc">{place.name}</h3>
          <p className="mt-0.5 truncate text-sm text-muted">
            {[place.neighborhood ?? place.city, KIND_LABEL[place.kind], priceLabel(place.priceLevel), origin ? formatMiles(distanceMiles(origin, place)) : null].filter(Boolean).join(' · ')}
          </p>
          {today && (
            <p className={cn('mt-1.5 flex items-center gap-1 truncate text-sm font-semibold', today.startsWith('No ') ? 'text-muted' : 'text-choc')}>
              <Clock className="size-3.5 shrink-0 text-gold-deep" aria-hidden />
              {today}
            </p>
          )}
          <div className="mt-1.5">
            <VerificationBadge place={place} now={now} />
          </div>
          {hl.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {hl.map((h) => (
                <span key={h} className="truncate rounded-full bg-cream-deep px-2 py-0.5 text-xs font-semibold text-choc">
                  {h}
                </span>
              ))}
              {place.isDemo && <span className="rounded-full bg-choc px-2 py-0.5 text-[10px] font-bold tracking-wide text-cream uppercase">Demo</span>}
            </div>
          )}
        </div>
        <div className="flex flex-col items-center gap-1">
          <ScoreBadge score={place.community.average} />
          <span className="text-[11px] text-muted">{place.community.reviewers ? `${place.community.reviewers} rated` : 'New'}</span>
          {myScore != null && <ScoreBadge score={myScore} kind="mine" size="sm" />}
        </div>
      </div>
    </Link>
  )
})

/** Compact row used in search results, lists and the map sheet. */
export const PlaceRow = memo(function PlaceRow({
  place,
  origin,
  trailing,
  subtitle,
  to,
  now,
}: {
  place: Establishment
  origin?: LatLng | null
  trailing?: ReactNode
  subtitle?: ReactNode
  to?: string
  now?: Date
}) {
  return (
    <Link to={to ?? `/place/${place.slug}`} className="press flex items-center gap-3 rounded-tile px-2 py-2.5 hover:bg-white">
      <PlaceThumb place={place} className="size-14 shrink-0 text-base" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold text-choc">{place.name}</p>
        <p className="truncate text-sm text-muted">
          {subtitle ?? [place.neighborhood ?? place.city, KIND_LABEL[place.kind], origin ? formatMiles(distanceMiles(origin, place)) : null].filter(Boolean).join(' · ')}
        </p>
        <div className="mt-1">
          <HappyHourPill place={place} now={now} />
        </div>
      </div>
      {trailing ?? <ScoreBadge score={place.community.average} size="sm" />}
    </Link>
  )
})

export function PlaceCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-card bg-white shadow-card" aria-hidden>
      <div className="skeleton h-36" />
      <div className="space-y-2 p-4">
        <div className="skeleton h-5 w-2/3 rounded-full" />
        <div className="skeleton h-4 w-1/2 rounded-full" />
        <div className="skeleton h-4 w-1/3 rounded-full" />
      </div>
    </div>
  )
}
