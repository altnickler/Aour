/**
 * Admin: the automated data pipeline — what it found, what it changed, what it costs.
 * Nothing here publishes "verified" data automatically: approving a finding is an admin action.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Link, NavLink, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Play, RefreshCw } from 'lucide-react'
import { api } from '@/data'
import type { CoverageRequest, DuplicatePair, Finding, PipelineBudget, PipelineJob } from '@/data/api'
import { formatWindow } from '@/core/schedule'
import { slugify } from '@/core/listing'
import { cn } from '@/lib/cn'
import { Badge, Button, Chip, EmptyState, Input, Spinner, Textarea } from '@/components/ui'
import { errorMessage, useToast } from '@/components/toast'

const TABS = [
  { key: 'overview', label: 'Jobs & budgets' },
  { key: 'findings', label: 'Findings' },
  { key: 'duplicates', label: 'Duplicates' },
  { key: 'coverage', label: 'Coverage requests' },
] as const

const pipelineKeys = {
  overview: ['admin', 'pipeline'] as const,
  findings: (status: string) => ['admin', 'findings', status] as const,
  duplicates: ['admin', 'duplicates'] as const,
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')

export default function Pipeline() {
  const { tab = 'overview' } = useParams()
  return (
    <div className="space-y-4 p-4">
      {api.mode === 'demo' && (
        <p className="rounded-tile bg-gold/15 p-3 text-sm text-choc">
          Demo mode: the automated pipeline only runs against the Supabase backend, so this area is empty here.
        </p>
      )}
      <nav className="no-scrollbar flex gap-2 overflow-x-auto" aria-label="Data pipeline">
        {TABS.map((t) => (
          <NavLink
            key={t.key}
            to={`/admin/data/${t.key}`}
            className={({ isActive }) => cn('rounded-full px-3 py-1.5 text-sm font-bold whitespace-nowrap ring-1 ring-line', isActive || (tab === t.key) ? 'bg-butter text-choc' : 'bg-white text-choc')}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      {tab === 'findings' ? <Findings /> : tab === 'duplicates' ? <Duplicates /> : tab === 'coverage' ? <Coverage /> : <Overview />}
    </div>
  )
}

function useAct() {
  const qc = useQueryClient()
  const toast = useToast()
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: ['admin'] })
      toast(ok)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
}

function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-card bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-extrabold text-choc">{title}</h2>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  )
}

// ---------------------------------------------------------------------------

function Overview() {
  const ov = useQuery({ queryKey: pipelineKeys.overview, queryFn: () => api.admin.pipeline.overview() })
  const act = useAct()
  const toast = useToast()
  if (ov.isLoading) return <Spinner />
  if (!ov.data) return <EmptyState title="Could not load the pipeline" />
  const d = ov.data
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Findings to review" value={d.pendingFindings} to="/admin/data/findings" alert={d.pendingFindings > 0} />
        <Stat label="Possible duplicates" value={d.openDuplicates} to="/admin/data/duplicates" alert={d.openDuplicates > 0} />
        <Stat label="Jobs queued" value={(d.jobs.queued ?? 0) + (d.jobs.running ?? 0)} />
        <Stat label="Jobs failed" value={d.jobs.failed ?? 0} alert={(d.jobs.failed ?? 0) > 0} />
      </div>

      <Card
        title="Run now"
        action={
          <Button
            size="sm"
            onClick={async () => {
              const started = await api.admin.pipeline.runNow()
              toast(started ? 'Running queued jobs now' : 'Queued jobs will run on the next scheduled tick (every 15 minutes)')
            }}
          >
            <Play className="size-4" /> Run queued jobs
          </Button>
        }
      >
        <p className="text-sm text-muted">The scheduler runs every 15 minutes and only does work that is due. Use this after queueing a manual refresh.</p>
      </Card>

      <Card title="Markets">
        {d.markets.length === 0 ? (
          <p className="text-sm text-muted">No markets yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.markets.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="font-semibold text-choc">{m.name}</p>
                  <p className="text-xs text-muted">
                    {m.places} published · {m.radiusMiles} mi · discovered {when(m.lastDiscoveredAt)} · next {m.discoveryEnabled ? when(m.nextDiscoveryAt) : 'off'}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => act(() => api.admin.pipeline.enqueueRefresh('discover_market', m.id), 'Discovery queued')}>
                  <RefreshCw className="size-4" /> Discover now
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Monthly budgets">
        <p className="mb-2 text-sm text-muted">External calls stop when a budget is spent or disabled. Nothing runs on page views.</p>
        <ul className="divide-y divide-line">
          {d.budgets.map((b) => (
            <BudgetRow key={b.provider} b={b} />
          ))}
        </ul>
      </Card>

      <Card title="Recent jobs">
        {d.recentJobs.length === 0 ? <p className="text-sm text-muted">No jobs yet.</p> : <JobList jobs={d.recentJobs} />}
      </Card>
    </div>
  )
}

function Stat({ label, value, to, alert }: { label: string; value: number; to?: string; alert?: boolean }) {
  const body = (
    <div className={cn('rounded-card bg-white p-3 shadow-card', alert && 'ring-2 ring-gold')}>
      <p className="tabular text-2xl font-extrabold text-choc">{value}</p>
      <p className="text-xs font-semibold text-choc">{label}</p>
    </div>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

function BudgetRow({ b }: { b: PipelineBudget }) {
  const act = useAct()
  const [limit, setLimit] = useState(String(b.limit))
  const pct = b.limit ? Math.min(100, Math.round((b.used / b.limit) * 100)) : 0
  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-choc">{b.provider}</p>
        <Badge tone={b.enabled ? 'success' : 'neutral'}>{b.enabled ? 'On' : 'Off'}</Badge>
      </div>
      {b.note && <p className="text-xs text-muted">{b.note}</p>}
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-beige" aria-hidden>
        <div className={cn('h-full', pct >= 90 ? 'bg-danger' : 'bg-gold')} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted">
        {b.used} / {b.limit} this month
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`limit-${b.provider}`}>Monthly limit for {b.provider}</label>
        <Input id={`limit-${b.provider}`} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} className="h-10 w-28" />
        <Button size="sm" variant="secondary" onClick={() => act(() => api.admin.pipeline.setProviderLimit(b.provider, Number(limit || 0), b.enabled), 'Limit saved')}>
          Save limit
        </Button>
        <Button size="sm" variant="secondary" onClick={() => act(() => api.admin.pipeline.setProviderLimit(b.provider, Number(limit || 0), !b.enabled), b.enabled ? 'Disabled' : 'Enabled')}>
          {b.enabled ? 'Disable' : 'Enable'}
        </Button>
      </div>
    </li>
  )
}

export function JobList({ jobs }: { jobs: PipelineJob[] }) {
  return (
    <ul className="divide-y divide-line">
      {jobs.map((j) => (
        <li key={j.id} className="py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-semibold text-choc">
              {j.kind === 'discover_market' ? 'Discover' : 'Refresh'} · {j.target_name ?? j.target_id.slice(0, 8)}
            </p>
            <Badge tone={j.status === 'succeeded' ? 'success' : j.status === 'failed' ? 'danger' : j.status === 'running' ? 'butter' : 'neutral'}>{j.status}</Badge>
          </div>
          <p className="text-xs text-muted">
            {when(j.created_at)} · attempt {j.attempts}
            {j.result && typeof j.result.outcome === 'string' ? ` · ${j.result.outcome}: ${String(j.result.reason ?? '')}` : ''}
          </p>
          {j.last_error && <p className="text-xs text-danger">{j.last_error}</p>}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------

function Findings() {
  const [status, setStatus] = useState<'pending' | 'all'>('pending')
  const list = useQuery({ queryKey: pipelineKeys.findings(status), queryFn: () => api.admin.pipeline.listFindings(status) })
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Happy-hour facts the pipeline extracted but did not publish (AI-assisted, conflicting, or for admin-managed listings), plus history. Approving copies them to the listing and marks it
        Verified and admin-managed.
      </p>
      <div className="flex gap-2">
        <Chip selected={status === 'pending'} onClick={() => setStatus('pending')}>Needs review</Chip>
        <Chip selected={status === 'all'} onClick={() => setStatus('all')}>All recent</Chip>
      </div>
      {list.isLoading ? <Spinner /> : !list.data?.length ? <EmptyState icon="✅" title="Nothing to review" /> : list.data.map((f) => <FindingCard key={f.id} f={f} />)}
    </div>
  )
}

export function FindingCard({ f }: { f: Finding }) {
  const act = useAct()
  const [note, setNote] = useState('')
  const pending = f.status === 'pending'
  return (
    <article className="rounded-card bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={`/admin/listings/${f.establishment_id}`} className="font-extrabold text-choc underline-offset-2 hover:underline">
            {f.establishmentName}
          </Link>
          <p className="text-xs text-muted">
            {f.source_kind.replace('_', ' ')} · {f.method === 'llm' ? 'AI-assisted' : f.method.replace('_', ' ')} · checked {when(f.checked_at)}
            {f.source_published_at ? ` · source dated ${when(f.source_published_at)}` : ''}
            {f.confidence != null ? ` · confidence ${Math.round(f.confidence * 100)}%` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge tone={pending ? 'butter' : f.status === 'rejected' ? 'danger' : 'neutral'}>{f.status}</Badge>
          {f.managedBy === 'admin' && <Badge tone="dark">Admin-managed listing</Badge>}
          {f.method === 'llm' && <Badge tone="warn">AI-assisted</Badge>}
        </div>
      </div>
      {f.decision_reason && <p className="mt-1 text-xs text-muted">Why it's here: {f.decision_reason}</p>}
      {f.source_url && (
        <a href={f.source_url} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-choc underline">
          Open source <ExternalLink className="size-3.5" />
        </a>
      )}

      {f.mentioned_but_unparsed && !f.windows.length && !f.specials.length ? (
        <p className="mt-3 rounded-tile bg-gold/15 p-3 text-sm text-choc">The page mentions a happy hour but the details could not be read automatically. Check the source and update the listing by hand.</p>
      ) : (
        <div className="mt-3 space-y-2 text-sm">
          {f.windows.length > 0 && (
            <ul>
              {f.windows.map((w, i) => (
                <li key={i} className="font-semibold text-choc">🕒 {formatWindow(w)}{w.label ? ` · ${w.label}` : ''}</li>
              ))}
            </ul>
          )}
          {f.specials.length > 0 && (
            <ul>
              {f.specials.map((s, i) => (
                <li key={i} className="text-choc">
                  {s.kind === 'food' ? '🍽️' : s.kind === 'drink' ? '🍸' : '✨'} {s.title} {s.price && <b>{s.price}</b>}
                </li>
              ))}
            </ul>
          )}
          {f.restrictions.length > 0 && <p className="text-muted">Restrictions: {f.restrictions.join(' · ')}</p>}
        </div>
      )}

      {f.evidence.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-bold text-choc">Evidence from the source ({f.evidence.length})</summary>
          <ul className="mt-2 space-y-1.5">
            {f.evidence.map((e, i) => (
              <li key={i} className="border-l-2 border-gold pl-2 text-xs text-choc">
                <span className="font-bold text-muted">{e.field}</span> “{e.quote}”
              </li>
            ))}
          </ul>
        </details>
      )}

      {pending && (
        <div className="mt-3 space-y-2">
          <Textarea rows={2} placeholder="Note (optional) — e.g. confirmed by phone" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Review note" />
          <div className="flex flex-wrap gap-2">
            {(f.windows.length > 0 || f.specials.length > 0) && (
              <Button size="sm" onClick={() => act(() => api.admin.pipeline.reviewFinding(f.id, 'approve', note.trim() || null), 'Approved and verified')}>
                Approve &amp; verify
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => act(() => api.admin.pipeline.reviewFinding(f.id, 'reject', note.trim() || null), 'Rejected')}>
              Reject
            </Button>
          </div>
        </div>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------

function Duplicates() {
  const list = useQuery({ queryKey: pipelineKeys.duplicates, queryFn: () => api.admin.pipeline.listDuplicates() })
  const listings = useQuery({ queryKey: ['admin', 'listings'], queryFn: () => api.admin.listEstablishments() })
  const act = useAct()
  const [keep, setKeep] = useState('')
  const [merge, setMerge] = useState('')
  const options = useMemo(() => [...(listings.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [listings.data])
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Imported places that look like an existing listing are held as drafts until you decide. Merging moves ratings, saves, lists and provenance to the kept listing.</p>
      {list.isLoading ? <Spinner /> : !list.data?.length ? <EmptyState icon="🧩" title="No possible duplicates" /> : list.data.map((d) => <DuplicateCard key={d.id} d={d} />)}

      <Card title="Merge two listings">
        <div className="space-y-2">
          <ListingSelect label="Keep" value={keep} onChange={setKeep} options={options} />
          <ListingSelect label="Merge into it (archived afterwards)" value={merge} onChange={setMerge} options={options} />
          <Button size="sm" disabled={!keep || !merge || keep === merge} onClick={() => act(() => api.admin.pipeline.mergeEstablishments(keep, merge), 'Merged')}>
            Merge
          </Button>
        </div>
      </Card>
    </div>
  )
}

function ListingSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { id: string; name: string; city: string; status: string }[] }) {
  return (
    <label className="block text-sm font-semibold text-choc">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 h-11 w-full rounded-tile bg-white px-3 ring-1 ring-line">
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} · {o.city} ({o.status})
          </option>
        ))}
      </select>
    </label>
  )
}

function DuplicateCard({ d }: { d: DuplicatePair }) {
  const act = useAct()
  const side = (s: DuplicatePair['a'], tag: string) => (
    <div className="min-w-0 flex-1 rounded-tile bg-cream p-3">
      <p className="text-xs font-bold text-muted uppercase">{tag}</p>
      <Link to={`/admin/listings/${s.id}`} className="font-bold text-choc underline-offset-2 hover:underline">{s.name}</Link>
      <p className="text-xs text-muted">{s.address}</p>
      <p className="text-xs text-muted">{s.website ?? 'no website'} · {s.status} · {s.origin} · {s.visits} ratings</p>
    </div>
  )
  return (
    <article className="rounded-card bg-white p-4 shadow-card">
      <p className="text-sm font-semibold text-choc">Match score {Math.round(d.score * 100)}% <span className="font-normal text-muted">· {d.reasons.join(', ')}</span></p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        {side(d.a, 'Existing')}
        {side(d.b, 'New import')}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => act(() => api.admin.pipeline.resolveDuplicate(d.id, 'merge'), 'Merged into the existing listing')}>Same place — merge</Button>
        <Button size="sm" variant="secondary" onClick={() => act(() => api.admin.pipeline.resolveDuplicate(d.id, 'dismiss'), 'Kept both')}>Different places</Button>
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------

const US_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu']

function Coverage() {
  const ov = useQuery({ queryKey: pipelineKeys.overview, queryFn: () => api.admin.pipeline.overview() })
  const act = useAct()
  const [open, setOpen] = useState<string | null>(null)
  const requests = ov.data?.coverageRequests ?? []
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Anonymous signals from people who searched where Aour has no listings (rounded to ~11 km). Creating a market starts venue discovery there on the next run.</p>
      {ov.isLoading ? <Spinner /> : !requests.length ? <EmptyState icon="📍" title="No open requests" /> : requests.map((r) => (
        <article key={r.cell} className="rounded-card bg-white p-4 shadow-card">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="font-bold text-choc">{r.label ?? `Near ${r.lat}, ${r.lng}`}</p>
              <p className="text-xs text-muted">{r.requests} requests · last {when(r.last_requested_at)}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setOpen(open === r.cell ? null : r.cell)}>Create market</Button>
              <Button size="sm" variant="secondary" onClick={() => act(() => api.admin.pipeline.dismissCoverage(r.cell), 'Dismissed')}>Dismiss</Button>
            </div>
          </div>
          {open === r.cell && <MarketForm request={r} onDone={() => setOpen(null)} />}
        </article>
      ))}
    </div>
  )
}

function MarketForm({ request, onDone }: { request: CoverageRequest; onDone: () => void }) {
  const act = useAct()
  const [name, setName] = useState(request.label ?? '')
  const [region, setRegion] = useState('')
  const [tz, setTz] = useState('America/New_York')
  const [radius, setRadius] = useState('15')
  const [autoPublish, setAutoPublish] = useState(false)
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void act(
          () =>
            api.admin.pipeline.saveMarket({
              slug: slugify(name), name: name.trim(), region: region.trim(), lat: Number(request.lat), lng: Number(request.lng),
              timezone: tz, radiusMiles: Number(radius) || 15, autoPublish, coverageCell: request.cell,
            }),
          'Market created; discovery will run next',
        ).then(onDone)
      }}
    >
      <Input required placeholder="Market name, e.g. Vero Beach" value={name} onChange={(e) => setName(e.target.value)} aria-label="Market name" />
      <Input placeholder="Region, e.g. Florida" value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region" />
      <label className="block text-sm font-semibold text-choc">
        Time zone
        <select value={tz} onChange={(e) => setTz(e.target.value)} className="mt-1 h-11 w-full rounded-tile bg-white px-3 ring-1 ring-line">
          {US_ZONES.map((z) => <option key={z}>{z}</option>)}
        </select>
      </label>
      <Input inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value.replace(/\D/g, ''))} aria-label="Radius in miles" />
      <label className="flex items-center gap-2 text-sm text-choc">
        <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} /> Publish discovered venues automatically (otherwise they wait as drafts)
      </label>
      <Button size="sm" type="submit" disabled={!name.trim()}>Save market</Button>
    </form>
  )
}
