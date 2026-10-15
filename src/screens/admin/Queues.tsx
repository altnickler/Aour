import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/data'
import type { SubmissionStatus } from '@/core/types'
import { Badge, Button, Chip, EmptyState, Input, Spinner } from '@/components/ui'
import { ReviewCard } from '@/components/review'
import { errorMessage, useToast } from '@/components/toast'

const KIND_LABEL = { new_place: 'New place', correction: 'Correction', outdated: 'Outdated info' }

export default function Queues({ kind }: { kind: 'submissions' | 'reports' }) {
  return kind === 'submissions' ? <Submissions /> : <Reports />
}

function Submissions() {
  const [status, setStatus] = useState<SubmissionStatus>('pending')
  const subs = useQuery({ queryKey: ['admin', 'submissions', status], queryFn: () => api.admin.listSubmissions(status) })
  const listings = useQuery({ queryKey: ['admin', 'listings'], queryFn: () => api.admin.listEstablishments() })
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [notes, setNotes] = useState<Record<string, string>>({})

  const act = async (id: string, next: SubmissionStatus) => {
    try {
      await api.admin.reviewSubmission(id, next, notes[id]?.trim() || null)
      await qc.invalidateQueries({ queryKey: ['admin'] })
      toast(next === 'approved' ? 'Marked approved' : 'Rejected')
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted">User suggestions are never published automatically. Verify the details, then update the listing yourself.</p>
      <div className="flex gap-2">
        {(['pending', 'approved', 'rejected'] as const).map((s) => (
          <Chip key={s} selected={status === s} onClick={() => setStatus(s)} className="capitalize">{s}</Chip>
        ))}
      </div>
      {subs.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (subs.data ?? []).length === 0 ? (
        <EmptyState icon="📭" title={`No ${status} submissions`} />
      ) : (
        subs.data!.map((s) => {
          const place = s.establishmentId ? listings.data?.find((e) => e.id === s.establishmentId) : undefined
          return (
            <article key={s.id} className="rounded-card bg-white p-4 shadow-card">
              <header className="flex flex-wrap items-center gap-2">
                <Badge tone={s.kind === 'new_place' ? 'butter' : s.kind === 'outdated' ? 'danger' : 'neutral'}>{KIND_LABEL[s.kind]}</Badge>
                {place && <b className="text-choc">{place.name}</b>}
                <span className="text-xs text-muted">
                  {new Date(s.createdAt).toLocaleString()} {s.submitterUsername && `· @${s.submitterUsername}`}
                </span>
              </header>
              <dl className="mt-2 space-y-1 text-sm">
                {Object.entries(s.payload).map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[7rem_1fr] gap-2">
                    <dt className="font-semibold text-muted capitalize">{k.replace(/([A-Z])/g, ' $1')}</dt>
                    <dd className="break-words text-espresso">{v}</dd>
                  </div>
                ))}
              </dl>
              {s.adminNote && <p className="mt-2 text-sm text-muted">Note: {s.adminNote}</p>}
              {status === 'pending' && (
                <div className="mt-3 space-y-2">
                  <Input placeholder="Internal note (optional)" value={notes[s.id] ?? ''} onChange={(e) => setNotes({ ...notes, [s.id]: e.target.value })} aria-label="Internal note" />
                  <div className="flex flex-wrap gap-2">
                    {s.kind === 'new_place' && (
                      <Button
                        size="sm"
                        onClick={() => {
                          sessionStorage.setItem('aour-admin-prefill', JSON.stringify(s.payload))
                          navigate('/admin/listings/new')
                        }}
                      >
                        Create draft listing
                      </Button>
                    )}
                    {place && (
                      <Button size="sm" variant="secondary" onClick={() => navigate(`/admin/listings/${place.id}`)}>
                        Open listing
                      </Button>
                    )}
                    <Button size="sm" variant="butter" onClick={() => act(s.id, 'approved')}>Approve</Button>
                    <Button size="sm" variant="ghost" onClick={() => act(s.id, 'rejected')}>Reject</Button>
                  </div>
                </div>
              )}
            </article>
          )
        })
      )}
    </div>
  )
}

function Reports() {
  const reports = useQuery({ queryKey: ['admin', 'reports'], queryFn: () => api.admin.listReports() })
  const qc = useQueryClient()
  const toast = useToast()
  const run = async (fn: () => Promise<void>, msg: string) => {
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: ['admin'] })
      await qc.invalidateQueries({ queryKey: ['reviews'] })
      await qc.invalidateQueries({ queryKey: ['listings'] })
      toast(msg)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted">Reviews with 3+ reports are hidden automatically until you decide.</p>
      {reports.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (reports.data ?? []).length === 0 ? (
        <EmptyState icon="✅" title="No open reports" />
      ) : (
        reports.data!.map((r) => (
          <article key={r.id} className="space-y-3 rounded-card bg-cream-deep p-3">
            <p className="text-sm">
              <Badge tone="danger">{r.reason.replace('_', ' ')}</Badge> <span className="text-muted">by @{r.reporterUsername ?? 'deleted'} · {new Date(r.createdAt).toLocaleDateString()}</span>
            </p>
            {r.details && <p className="text-sm text-espresso">“{r.details}”</p>}
            {r.review ? <ReviewCard review={r.review} /> : <p className="text-sm text-muted">The review no longer exists.</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => run(() => api.admin.moderateReview(r.visitId, 'hidden'), 'Review hidden')}>Hide text</Button>
              <Button size="sm" variant="danger" onClick={() => run(() => api.admin.moderateReview(r.visitId, 'removed'), 'Review removed')}>Remove text</Button>
              <Button size="sm" variant="danger" onClick={() => run(() => api.admin.excludeVisit(r.visitId, true), 'Excluded from scores')}>Exclude scores</Button>
              <Button size="sm" variant="ghost" onClick={() => run(() => api.admin.moderateReview(r.visitId, 'published'), 'Review restored')}>Keep / restore</Button>
              <Button size="sm" variant="ghost" onClick={() => run(() => api.admin.dismissReport(r.id), 'Report dismissed')}>Dismiss</Button>
            </div>
          </article>
        ))
      )}
    </div>
  )
}
