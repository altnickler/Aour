import { useDeferredValue, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api } from '@/data'
import { useFollowing } from '@/data/hooks'
import { Avatar, EmptyState, PageHeader, Skeleton } from '@/components/ui'

export default function FindPeopleScreen() {
  const [q, setQ] = useState('')
  const query = useDeferredValue(q.trim())
  const following = useFollowing()
  const results = useQuery({ queryKey: ['people-search', query], queryFn: () => api.searchProfiles(query), enabled: query.length >= 2 })
  const followingIds = new Set((following.data ?? []).map((u) => u.id))

  return (
    <div>
      <PageHeader title="Find people" back />
      <div className="px-4">
        <label className="flex h-12 items-center gap-2 rounded-full bg-white px-4 shadow-press ring-1 ring-line focus-within:ring-2 focus-within:ring-gold">
          <Search className="size-5 text-muted" aria-hidden />
          <span className="sr-only">Search people</span>
          <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or @username" className="h-full flex-1 bg-transparent focus:outline-none" />
        </label>
        <p className="mt-2 px-1 text-xs text-muted">Only public profiles appear. Aour never uploads your contacts.</p>
      </div>
      <div className="mt-2 px-3">
        {query.length < 2 ? (
          (following.data ?? []).length > 0 ? (
            <>
              <h2 className="px-2 pt-3 pb-1 text-sm font-bold tracking-wide text-muted uppercase">Following</h2>
              <PeopleList people={following.data!} followingIds={followingIds} />
            </>
          ) : (
            <EmptyState icon="👋" title="Search for friends" body="Follow people to see their rankings and favorites." />
          )
        ) : results.isLoading ? (
          <Skeleton className="mx-2 h-16" />
        ) : (results.data ?? []).length === 0 ? (
          <EmptyState icon="🤷" title="No one found" />
        ) : (
          <PeopleList people={results.data!} followingIds={followingIds} />
        )}
      </div>
    </div>
  )
}

function PeopleList({ people, followingIds }: { people: { id: string; username: string; displayName: string; avatarUrl: string | null }[]; followingIds: Set<string> }) {
  return (
    <ul>
      {people.map((u) => (
        <li key={u.id}>
          <Link to={`/u/${u.username}`} className="press flex items-center gap-3 rounded-tile px-2 py-2.5 hover:bg-white">
            <Avatar name={u.displayName} url={u.avatarUrl} size={44} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold text-choc">{u.displayName}</p>
              <p className="text-sm text-muted">@{u.username}</p>
            </div>
            {followingIds.has(u.id) && <span className="text-xs font-bold text-muted">Following</span>}
          </Link>
        </li>
      ))}
    </ul>
  )
}
