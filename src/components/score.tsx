import { TrendingDown, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/cn'
import { confidenceLabel, formatScore } from '@/core/rating'

/** Visual tier for a 1–10 score. */
function tier(score: number | null | undefined) {
  if (score === null || score === undefined) return 'none'
  if (score >= 8.5) return 'top'
  if (score >= 7) return 'good'
  return 'ok'
}

/**
 * Circular score badge. `kind` distinguishes My / Friends / Community scores
 * consistently across the app: mine = chocolate, community = butter, friends = outlined.
 */
export function ScoreBadge({
  score,
  size = 'md',
  kind = 'community',
  className,
  label,
}: {
  score: number | null | undefined
  size?: 'sm' | 'md' | 'lg' | 'xl'
  kind?: 'mine' | 'community' | 'friends'
  className?: string
  label?: string
}) {
  const t = tier(score)
  const dims = { sm: 'size-9 text-[13px]', md: 'size-11 text-[15px]', lg: 'size-14 text-lg', xl: 'size-20 text-[26px]' }[size]
  return (
    <span
      role="img"
      aria-label={label ?? (score == null ? 'Not rated yet' : `${kind === 'mine' ? 'My score' : kind === 'friends' ? "Friends' score" : 'Community score'} ${formatScore(score)} out of 10`)}
      className={cn(
        'tabular inline-flex shrink-0 items-center justify-center rounded-full font-extrabold tracking-tight',
        dims,
        kind === 'mine' && (t === 'none' ? 'bg-beige text-muted' : 'bg-choc text-butter'),
        kind === 'community' && (t === 'top' ? 'bg-butter text-choc ring-2 ring-gold' : t === 'good' ? 'bg-butter-soft text-choc' : t === 'ok' ? 'bg-beige text-choc' : 'bg-beige/70 text-muted'),
        kind === 'friends' && 'bg-white text-choc ring-2 ring-choc/80',
        className,
      )}
    >
      {formatScore(score)}
    </span>
  )
}

export function CommunityScore({ average, reviewers, compact }: { average: number | null; reviewers: number; compact?: boolean }) {
  const conf = confidenceLabel(reviewers)
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <ScoreBadge score={average} size="sm" />
      {!compact && (
        <span className="text-muted">
          {reviewers === 0 ? 'No ratings yet' : `${reviewers} ${reviewers === 1 ? 'rating' : 'ratings'}`}
          {conf === 'early' && <span className="sr-only"> — early score, few ratings</span>}
        </span>
      )}
    </span>
  )
}

export function Trend({ value }: { value: number | null }) {
  if (value === null || Math.abs(value) < 0.25) return null
  const up = value > 0
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs font-bold', up ? 'text-success' : 'text-danger')} aria-label={`${up ? 'Up' : 'Down'} ${Math.abs(value).toFixed(1)} since last visit`}>
      {up ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
      {Math.abs(value).toFixed(1)}
    </span>
  )
}

/** Horizontal bar for category breakdowns. */
export function ScoreBar({ label, value, mine }: { label: string; value: number | null | undefined; mine?: number | null }) {
  const pct = value == null ? 0 : (value / 10) * 100
  return (
    <div className="grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-3 py-1.5 text-sm">
      <span className="truncate font-semibold text-choc">{label}</span>
      <span className="relative h-2.5 overflow-hidden rounded-full bg-beige">
        <span className="absolute inset-y-0 left-0 rounded-full bg-gold" style={{ width: `${pct}%` }} />
        {mine != null && <span className="absolute inset-y-[-3px] w-1 rounded-full bg-choc" style={{ left: `calc(${(mine / 10) * 100}% - 2px)` }} title={`You: ${mine.toFixed(1)}`} />}
      </span>
      <span className="tabular text-right font-bold text-choc">{formatScore(value)}</span>
    </div>
  )
}
