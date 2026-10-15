import { useState } from 'react'
import { Link } from 'react-router'
import { Flag } from 'lucide-react'
import type { PublicReview, ReviewReport } from '@/core/types'
import { PRIMARY_CATEGORIES, TAG_BY_KEY } from '@/core/categories'
import { api } from '@/data'
import { useAuth, useRequireAuth } from '@/app/auth'
import { ScoreBadge } from './score'
import { Avatar, Button, Chip, Sheet, Textarea } from './ui'
import { errorMessage, useToast } from './toast'

export function relativeDate(iso: string, now = new Date()): string {
  const days = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined })
}

export function ReviewCard({ review, placeName, placeSlug, showPlace }: { review: PublicReview; placeName?: string; placeSlug?: string; showPlace?: boolean }) {
  const { user } = useAuth()
  const [reporting, setReporting] = useState(false)
  const scored = PRIMARY_CATEGORIES.filter((c) => typeof review.scores[c.key] === 'number')
  return (
    <article className="rounded-card bg-white p-4 shadow-card">
      <header className="flex items-center gap-3">
        <Link to={`/u/${review.user.username}`} aria-label={`${review.user.displayName}'s profile`} className="shrink-0">
          <Avatar name={review.user.displayName} url={review.user.avatarUrl} size={40} />
        </Link>
        <div className="min-w-0 flex-1">
          <Link to={`/u/${review.user.username}`} className="block truncate font-bold text-choc">
            {review.user.displayName}
          </Link>
          <p className="truncate text-xs text-muted">
            {showPlace && placeName ? (
              <>
                at{' '}
                <Link to={`/place/${placeSlug}`} className="font-semibold text-choc underline-offset-2 hover:underline">
                  {placeName}
                </Link>{' '}
                ·{' '}
              </>
            ) : null}
            Visited {relativeDate(review.visitedOn)}
          </p>
        </div>
        <ScoreBadge score={review.composite} kind="friends" size="md" label={`${review.user.displayName}'s score ${review.composite?.toFixed(1) ?? 'not available'}`} />
      </header>
      {review.review && <p className="mt-3 text-[15px] leading-relaxed text-espresso">{review.review}</p>}
      {review.photoUrls.length > 0 && (
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto">
          {review.photoUrls.map((u) => (
            <img key={u} src={u} alt={`Photo from ${review.user.displayName}'s visit`} loading="lazy" className="h-28 w-28 shrink-0 rounded-tile object-cover" />
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {scored.map((c) => (
          <span key={c.key} className="rounded-full bg-cream-deep px-2 py-0.5 text-xs text-choc">
            {c.label.split(' ')[0]} <b className="tabular">{(review.scores[c.key] as number).toFixed(1)}</b>
          </span>
        ))}
        {review.tags.map((t) => (
          <span key={t} className="rounded-full bg-butter-soft px-2 py-0.5 text-xs font-semibold text-choc">
            {TAG_BY_KEY[t]?.emoji} {TAG_BY_KEY[t]?.label ?? t}
          </span>
        ))}
      </div>
      {user?.id !== review.user.id && (
        <div className="mt-2 flex justify-end">
          <button type="button" onClick={() => setReporting(true)} className="flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold text-muted hover:bg-cream-deep">
            <Flag className="size-3" /> Report
          </button>
        </div>
      )}
      <ReportReviewSheet open={reporting} onClose={() => setReporting(false)} visitId={review.visitId} />
    </article>
  )
}

const REASONS: { key: ReviewReport['reason']; label: string }[] = [
  { key: 'spam', label: 'Spam or ads' },
  { key: 'offensive', label: 'Offensive' },
  { key: 'fake', label: 'Fake review' },
  { key: 'not_relevant', label: 'Not about this place' },
  { key: 'other', label: 'Something else' },
]

function ReportReviewSheet({ open, onClose, visitId }: { open: boolean; onClose: () => void; visitId: string }) {
  const requireAuth = useRequireAuth()
  const toast = useToast()
  const [reason, setReason] = useState<ReviewReport['reason'] | null>(null)
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Sheet open={open} onClose={onClose} title="Report review">
      <p className="text-sm text-muted">Reports are anonymous to the reviewer. Our team reviews every report.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {REASONS.map((r) => (
          <Chip key={r.key} selected={reason === r.key} onClick={() => setReason(r.key)}>
            {r.label}
          </Chip>
        ))}
      </div>
      <Textarea className="mt-4" placeholder="Anything else we should know? (optional)" maxLength={500} value={details} onChange={(e) => setDetails(e.target.value)} aria-label="Details" />
      <Button
        className="mt-4"
        block
        disabled={!reason}
        loading={busy}
        onClick={async () => {
          if (!requireAuth('report')) return
          setBusy(true)
          try {
            await api.reportReview(visitId, reason!, details.trim() || null)
            toast('Thanks — we’ll take a look')
            onClose()
          } catch (e) {
            toast(errorMessage(e), 'error')
          } finally {
            setBusy(false)
          }
        }}
      >
        Submit report
      </Button>
    </Sheet>
  )
}
