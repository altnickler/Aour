import { Link, useNavigate } from 'react-router'
import { Activity, CalendarDays, ChevronRight, FolderHeart, Heart, MapPin, Plus, Settings, Shield, Trophy, UserPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAuth } from '@/app/auth'
import { useListingIndex, useProfile, useRankings, useSaved } from '@/data/hooks'
import { PRIMARY_CATEGORIES } from '@/core/categories'
import { meanScore, formatScore } from '@/core/rating'
import { Logo } from '@/components/brand'
import { InstallCard } from '@/components/InstallCard'
import { PlaceThumb } from '@/components/place'
import { Avatar, Button, IconButton, Section, Skeleton } from '@/components/ui'

export default function MeScreen() {
  const { user, profile, loading, isAdmin } = useAuth()
  const navigate = useNavigate()

  if (loading) {
    return (
      <div className="pt-safe space-y-4 p-5">
        <Skeleton className="size-20 rounded-full" />
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24" />
      </div>
    )
  }

  if (!user || !profile) {
    return (
      <div className="pt-safe px-5">
        <div className="flex h-14 items-center justify-between">
          <Logo size={26} />
          <IconButton label="Settings" onClick={() => navigate('/settings')}>
            <Settings className="size-5" />
          </IconButton>
        </div>
        <div className="mt-10 text-center">
          <h1 className="text-[26px] font-extrabold tracking-tight text-choc">Make Aour yours</h1>
          <p className="mx-auto mt-2 max-w-xs text-muted">Sign in to rate happy hours, keep your rankings, and save places to try.</p>
          <Button size="lg" className="mt-6" onClick={() => navigate('/signin?next=/me')}>
            Sign in or create account
          </Button>
        </div>
        <div className="mt-10">
          <InstallCard />
        </div>
      </div>
    )
  }

  return <SignedIn isAdmin={isAdmin} />
}

function SignedIn({ isAdmin }: { isAdmin: boolean }) {
  const { profile } = useAuth()
  const p = profile!
  const navigate = useNavigate()
  const stats = useProfile(p.username)
  const { rankings, visits } = useRankings()
  const saved = useSaved()
  const { index } = useListingIndex()
  const top = rankings.slice(0, 3)
  const favorites = (saved.data ?? []).filter((s) => s.list === 'favorite').map((s) => index.get(s.establishmentId)).filter(Boolean)

  // "Taste profile": the user's average per category across all visits.
  const taste = PRIMARY_CATEGORIES.map((c) => ({ c, v: meanScore(visits.map((v) => v.scores[c.key])) })).filter((x) => x.v !== null)
  const best = [...taste].sort((a, b) => b.v! - a.v!)[0]

  return (
    <div>
      <header className="pt-safe flex h-[calc(env(safe-area-inset-top)+3.5rem)] items-center justify-end gap-1 px-2">
        <IconButton label="Find people" onClick={() => navigate('/people')}>
          <UserPlus className="size-5" />
        </IconButton>
        <IconButton label="Settings" onClick={() => navigate('/settings')}>
          <Settings className="size-5" />
        </IconButton>
      </header>

      <div className="px-5">
        <div className="flex items-center gap-4">
          <Avatar name={p.displayName} url={p.avatarUrl} size={76} className="ring-4 ring-white shadow-card" />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-extrabold tracking-tight text-choc">{p.displayName}</h1>
            <p className="text-muted">@{p.username}</p>
            {p.homeCity && (
              <p className="mt-0.5 flex items-center gap-1 text-sm text-muted">
                <MapPin className="size-3.5" /> {p.homeCity}
              </p>
            )}
          </div>
        </div>
        {p.bio && <p className="mt-3 text-[15px] text-espresso">{p.bio}</p>}
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/me/edit')}>
            Edit profile
          </Button>
          <Button variant="secondary" size="sm" onClick={() => navigate(`/u/${p.username}`)}>
            View public profile
          </Button>
        </div>

        <dl className="mt-5 grid grid-cols-4 gap-2 text-center">
          <ProfileStat label="Places" value={rankings.length} />
          <ProfileStat label="Visits" value={visits.length} />
          <ProfileStat label="Followers" value={stats.data?.followers ?? '–'} />
          <ProfileStat label="Following" value={stats.data?.following ?? '–'} />
        </dl>
      </div>

      {top.length > 0 ? (
        <Section title="Your top 3" action={<Link to="/rankings" className="text-sm font-bold text-choc">See all</Link>}>
          <ol className="grid grid-cols-3 gap-2 px-5">
            {top.map((r) => {
              const place = index.get(r.establishmentId)
              if (!place) return null
              return (
                <li key={r.establishmentId}>
                  <Link to={`/place/${place.slug}`} className="press block overflow-hidden rounded-card bg-white shadow-card">
                    <div className="relative">
                      <PlaceThumb place={place} className="h-20 w-full text-lg" rounded="rounded-none" />
                      <span className="absolute top-1.5 left-1.5 text-lg" aria-label={`Rank ${r.rank}`}>{['🥇', '🥈', '🥉'][r.rank - 1]}</span>
                    </div>
                    <div className="p-2">
                      <p className="truncate text-sm font-bold text-choc">{place.name}</p>
                      <p className="tabular text-xs font-bold text-muted">{formatScore(r.score)}</p>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ol>
          {best && (
            <p className="mt-3 px-5 text-sm text-muted">
              You score <b className="text-choc">{best.c.label.toLowerCase()}</b> highest on average ({formatScore(best.v)}).
            </p>
          )}
        </Section>
      ) : (
        <div className="mx-5 mt-6 rounded-card bg-butter-soft p-5">
          <p className="font-extrabold text-choc">Rate your first happy hour</p>
          <p className="mt-1 text-sm text-choc/80">It takes about 30 seconds, and your rankings start building right away.</p>
          <Button className="mt-3" size="sm" onClick={() => navigate('/rate')}>
            <Plus className="size-4" /> Rate now
          </Button>
        </div>
      )}

      {favorites.length > 0 && (
        <Section title="Favorites">
          <ul className="no-scrollbar flex gap-3 overflow-x-auto px-5 pb-1">
            {favorites.map((e) => (
              <li key={e!.id}>
                <Link to={`/place/${e!.slug}`} className="press block w-28">
                  <PlaceThumb place={e!} className="h-28 w-28 text-xl" />
                  <p className="mt-1 truncate text-sm font-bold text-choc">{e!.name}</p>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <nav className="mx-5 mt-6 overflow-hidden rounded-card bg-white shadow-card" aria-label="Profile">
        <MenuLink to="/rankings" icon={<Trophy className="size-5" />} label="My rankings" />
        <MenuLink to="/me/history" icon={<CalendarDays className="size-5" />} label="Rating history" />
        <MenuLink to="/rankings?tab=favorites" icon={<Heart className="size-5" />} label="Favorites & Want to Try" />
        <MenuLink to="/rankings?tab=collections" icon={<FolderHeart className="size-5" />} label="Collections" />
        <MenuLink to="/activity" icon={<Activity className="size-5" />} label="Friends activity" />
        <MenuLink to="/suggest" icon={<Plus className="size-5" />} label="Suggest a place" />
        {isAdmin && <MenuLink to="/admin" icon={<Shield className="size-5" />} label="Admin dashboard" />}
      </nav>

      <div className="mx-5 mt-6">
        <InstallCard />
      </div>
      {stats.isLoading && <span className="sr-only">Loading stats</span>}
    </div>
  )
}

function ProfileStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-card bg-white py-2.5 shadow-card">
      <dd className="tabular text-lg font-extrabold text-choc">{value}</dd>
      <dt className="text-[11px] font-semibold text-muted">{label}</dt>
    </div>
  )
}

export function MenuLink({ to, icon, label, sub }: { to: string; icon: ReactNode; label: string; sub?: string }) {
  return (
    <Link to={to} className="flex items-center gap-3 border-b border-line px-4 py-3.5 last:border-0 hover:bg-cream">
      <span className="text-choc">{icon}</span>
      <span className="flex-1">
        <span className="block font-semibold text-choc">{label}</span>
        {sub && <span className="block text-sm text-muted">{sub}</span>}
      </span>
      <ChevronRight className="size-4 text-muted" />
    </Link>
  )
}

