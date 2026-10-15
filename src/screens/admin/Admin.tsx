import { lazy, Suspense, useMemo, useState } from 'react'
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, Plus, Search } from 'lucide-react'
import { useAuth } from '@/app/auth'
import { api } from '@/data'
import { freshness, freshnessLabel, KIND_LABEL } from '@/core/listing'
import { cn } from '@/lib/cn'
import { Badge, Button, EmptyState, IconButton, Spinner } from '@/components/ui'
import type { Establishment } from '@/core/types'

const ListingEditor = lazy(() => import('./ListingEditor'))
const Queues = lazy(() => import('./Queues'))
const People = lazy(() => import('./People'))

export const adminKeys = {
  stats: ['admin', 'stats'] as const,
  listings: ['admin', 'listings'] as const,
}

const NAV = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/listings', label: 'Listings' },
  { to: '/admin/submissions', label: 'Submissions' },
  { to: '/admin/reports', label: 'Reports' },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/collections', label: 'Featured' },
]

export default function AdminScreen() {
  const { isAdmin, loading } = useAuth()
  const navigate = useNavigate()
  if (loading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
  if (!isAdmin) {
    return <EmptyState className="pt-safe mt-20" icon="🔒" title="Administrators only" action={<Button onClick={() => navigate('/')}>Go home</Button>} />
  }
  return (
    <div className="min-h-dvh bg-cream pb-16">
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-cream/95 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-1 px-2">
          <IconButton label="Exit admin" onClick={() => navigate('/me')}>
            <ChevronLeft className="size-6" />
          </IconButton>
          <h1 className="text-xl font-extrabold text-choc">Admin</h1>
        </div>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-2" aria-label="Admin sections">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => cn('rounded-full px-3.5 py-1.5 text-sm font-bold whitespace-nowrap', isActive ? 'bg-choc text-cream' : 'text-choc hover:bg-beige/60')}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="listings" element={<Listings />} />
          <Route path="listings/new" element={<ListingEditor />} />
          <Route path="listings/:id" element={<ListingEditor />} />
          <Route path="submissions" element={<Queues kind="submissions" />} />
          <Route path="reports" element={<Queues kind="reports" />} />
          <Route path="users" element={<People kind="users" />} />
          <Route path="collections" element={<People kind="collections" />} />
        </Routes>
      </Suspense>
    </div>
  )
}

function Overview() {
  const stats = useQuery({ queryKey: adminKeys.stats, queryFn: () => api.admin.stats() })
  const listings = useQuery({ queryKey: adminKeys.listings, queryFn: () => api.admin.listEstablishments() })
  const s = stats.data
  const attention = useMemo(
    () => (listings.data ?? []).filter((e) => e.status === 'published' && e.hhStatus !== 'none' && freshness(e.hhStatus, e.hhVerifiedAt) !== 'fresh').slice(0, 10),
    [listings.data],
  )
  return (
    <div className="space-y-5 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile label="Users" value={s?.users} sub={s ? `+${s.newUsers7d} this week` : ''} />
        <Tile label="Ratings" value={s?.visits} sub={s ? `+${s.visits7d} this week` : ''} />
        <Tile label="Published listings" value={s?.published} sub={s ? `${s.establishments} total` : ''} />
        <Tile label="Pending submissions" value={s?.pendingSubmissions} to="/admin/submissions" alert={!!s?.pendingSubmissions} />
        <Tile label="Open reports" value={s?.openReports} to="/admin/reports" alert={!!s?.openReports} />
        <Tile label="Need re-verifying" value={s?.staleListings} to="/admin/listings" alert={!!s?.staleListings} />
      </div>
      <section className="rounded-card bg-white p-4 shadow-card">
        <div className="flex items-center justify-between">
          <h2 className="font-extrabold text-choc">Needs verification</h2>
          <Link to="/admin/listings/new" className="text-sm font-bold text-choc">+ New listing</Link>
        </div>
        <p className="text-sm text-muted">Published happy hours not verified in the last 90 days. Call or visit, then mark verified.</p>
        {attention.length === 0 ? (
          <p className="mt-3 text-sm font-semibold text-success">All published listings are fresh. 🎉</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {attention.map((e) => (
              <li key={e.id}>
                <Link to={`/admin/listings/${e.id}`} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0 truncate font-semibold text-choc">{e.name}</span>
                  <FreshTag e={e} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Tile({ label, value, sub, to, alert }: { label: string; value?: number; sub?: string; to?: string; alert?: boolean }) {
  const body = (
    <div className={cn('rounded-card bg-white p-4 shadow-card', alert && 'ring-2 ring-gold')}>
      <p className="tabular text-3xl font-extrabold text-choc">{value ?? '–'}</p>
      <p className="text-sm font-semibold text-choc">{label}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

export function FreshTag({ e }: { e: Establishment }) {
  if (e.hhStatus === 'none') return <Badge>No happy hour</Badge>
  const f = freshness(e.hhStatus, e.hhVerifiedAt)
  return <Badge tone={f === 'fresh' ? 'success' : f === 'aging' ? 'warn' : f === 'stale' ? 'danger' : 'neutral'}>{freshnessLabel(f, e.hhVerifiedAt)}</Badge>
}

function Listings() {
  const listings = useQuery({ queryKey: adminKeys.listings, queryFn: () => api.admin.listEstablishments() })
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | Establishment['status']>('all')
  const navigate = useNavigate()
  const shown = (listings.data ?? []).filter((e) => (status === 'all' || e.status === status) && e.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="p-4">
      <div className="flex gap-2">
        <label className="flex h-11 flex-1 items-center gap-2 rounded-full bg-white px-4 ring-1 ring-line">
          <Search className="size-4 text-muted" aria-hidden />
          <span className="sr-only">Search listings</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search listings" className="flex-1 bg-transparent focus:outline-none" />
        </label>
        <Button onClick={() => navigate('/admin/listings/new')}>
          <Plus className="size-4" /> New
        </Button>
      </div>
      <div className="mt-3 flex gap-2">
        {(['all', 'published', 'draft', 'archived'] as const).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)} aria-pressed={status === s} className={cn('rounded-full px-3 py-1 text-sm font-bold capitalize', status === s ? 'bg-choc text-cream' : 'bg-white text-choc ring-1 ring-line')}>
            {s}
          </button>
        ))}
      </div>
      {listings.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-card bg-white shadow-card">
          {shown.map((e) => (
            <li key={e.id}>
              <Link to={`/admin/listings/${e.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-cream">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold text-choc">
                    {e.name} {e.isDemo && <Badge tone="dark">Demo</Badge>}
                  </p>
                  <p className="text-xs text-muted">{KIND_LABEL[e.kind]} · {e.neighborhood ?? e.city} · {e.windows.length} windows · {e.specials.length} specials</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge tone={e.status === 'published' ? 'success' : e.status === 'draft' ? 'warn' : 'neutral'}>{e.status}</Badge>
                  <FreshTag e={e} />
                </div>
              </Link>
            </li>
          ))}
          {shown.length === 0 && <li className="p-6 text-center text-muted">No listings</li>}
        </ul>
      )}
    </div>
  )
}
