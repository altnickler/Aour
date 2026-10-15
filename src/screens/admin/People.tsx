import { useDeferredValue, useState } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api } from '@/data'
import { useAuth } from '@/app/auth'
import { Badge, Button, EmptyState, Spinner } from '@/components/ui'
import { errorMessage, useToast } from '@/components/toast'

export default function People({ kind }: { kind: 'users' | 'collections' }) {
  return kind === 'users' ? <Users /> : <Featured />
}

function Users() {
  const [q, setQ] = useState('')
  const query = useDeferredValue(q)
  const users = useQuery({ queryKey: ['admin', 'users', query], queryFn: () => api.admin.listUsers(query) })
  const { user } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const run = async (fn: () => Promise<void>, msg: string) => {
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: ['admin'] })
      toast(msg)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <div className="space-y-3 p-4">
      <label className="flex h-11 items-center gap-2 rounded-full bg-white px-4 ring-1 ring-line">
        <Search className="size-4 text-muted" aria-hidden />
        <span className="sr-only">Search users</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or username" className="flex-1 bg-transparent focus:outline-none" />
      </label>
      {users.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card bg-white shadow-card">
          {(users.data ?? []).map((u) => (
            <li key={u.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link to={`/u/${u.username}`} className="font-bold text-choc">{u.displayName}</Link>{' '}
                <span className="text-sm text-muted">@{u.username}</span>
                <p className="text-xs text-muted">
                  {u.visits} ratings · joined {new Date(u.createdAt).toLocaleDateString()}
                </p>
                <div className="mt-1 flex gap-1">
                  {u.role === 'admin' && <Badge tone="dark">Admin</Badge>}
                  {u.suspended && <Badge tone="danger">Suspended</Badge>}
                </div>
              </div>
              {u.id !== user?.id && (
                <div className="flex flex-col gap-1.5">
                  <Button
                    size="sm"
                    variant={u.suspended ? 'secondary' : 'danger'}
                    onClick={() => {
                      if (!u.suspended) {
                        const reason = window.prompt(`Suspend @${u.username}? Their content is hidden and they can't post. Reason:`)
                        if (reason === null) return
                        return run(() => api.admin.setSuspended(u.id, true, reason || null), 'User suspended')
                      }
                      return run(() => api.admin.setSuspended(u.id, false, null), 'User restored')
                    }}
                  >
                    {u.suspended ? 'Unsuspend' : 'Suspend'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => window.confirm(u.role === 'admin' ? `Remove admin from @${u.username}?` : `Make @${u.username} an admin? They'll have full access.`) && run(() => api.admin.setRole(u.id, u.role === 'admin' ? 'user' : 'admin'), 'Role updated')}
                  >
                    {u.role === 'admin' ? 'Remove admin' : 'Make admin'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Featured() {
  const cols = useQuery({ queryKey: ['admin', 'collections'], queryFn: () => api.admin.listPublicCollections() })
  const qc = useQueryClient()
  const toast = useToast()
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted">Featured public collections appear on the Discover screen.</p>
      {cols.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (cols.data ?? []).length === 0 ? (
        <EmptyState icon="📚" title="No public collections yet" />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card bg-white shadow-card">
          {cols.data!.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link to={`/c/${c.shareId}`} className="font-bold text-choc">{c.name}</Link>
                <p className="text-xs text-muted">{c.items.length} places {c.ownerUsername && `· @${c.ownerUsername}`}</p>
              </div>
              <Button
                size="sm"
                variant={c.featured ? 'butter' : 'secondary'}
                onClick={async () => {
                  try {
                    await api.admin.setFeatured(c.id, !c.featured)
                    await qc.invalidateQueries({ queryKey: ['admin', 'collections'] })
                    await qc.invalidateQueries({ queryKey: ['featured'] })
                    toast(c.featured ? 'Unfeatured' : 'Featured on Discover')
                  } catch (e) {
                    toast(errorMessage(e), 'error')
                  }
                }}
              >
                {c.featured ? '★ Featured' : 'Feature'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
