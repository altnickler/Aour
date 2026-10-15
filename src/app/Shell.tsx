import { Suspense } from 'react'
import { NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router'
import { Compass, Plus, Search, Trophy, User } from 'lucide-react'
import { cn } from '@/lib/cn'
import { isDemoMode } from '@/lib/config'
import { Spinner } from '@/components/ui'

const TABS = [
  { to: '/', label: 'Discover', icon: Compass, end: true },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/rate', label: 'Rate', icon: Plus, primary: true },
  { to: '/rankings', label: 'Rankings', icon: Trophy },
  { to: '/me', label: 'Profile', icon: User },
] as const

/** Routes rendered full-screen without the tab bar (focused flows). */
const FULL_SCREEN = [/^\/rate\/.+/, /^\/visit\/.+/, /^\/signin/, /^\/welcome/, /^\/admin/]

export function TabBar() {
  return (
    <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-cream/92 backdrop-blur-xl">
      <ul className="mx-auto grid h-[4.75rem] max-w-lg grid-cols-5 items-center px-2">
        {TABS.map((t) => (
          <li key={t.to} className="flex justify-center">
            <NavLink
              to={t.to}
              end={'end' in t ? t.end : false}
              aria-label={t.label}
              className={({ isActive }) =>
                cn(
                  'press flex min-w-16 flex-col items-center gap-1 rounded-2xl py-1.5 text-[11px] font-bold',
                  'primary' in t ? 'text-choc' : isActive ? 'text-choc' : 'text-muted',
                )
              }
            >
              {({ isActive }) =>
                'primary' in t ? (
                  <>
                    <span className="-mt-7 flex size-15 items-center justify-center rounded-full bg-choc text-butter shadow-float ring-4 ring-cream">
                      <Plus className="size-7" strokeWidth={2.75} />
                    </span>
                    <span>{t.label}</span>
                  </>
                ) : (
                  <>
                    <t.icon className={cn('size-6', isActive && 'fill-butter')} strokeWidth={isActive ? 2.4 : 2} />
                    <span>{t.label}</span>
                  </>
                )
              }
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function PageFallback() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center text-choc">
      <Spinner />
    </div>
  )
}

export function Shell() {
  const { pathname } = useLocation()
  const fullScreen = FULL_SCREEN.some((r) => r.test(pathname))
  return (
    <div className="mx-auto min-h-dvh max-w-lg bg-cream">
      {isDemoMode && !fullScreen && (
        <div className="pt-safe bg-choc px-4 text-center text-[11px] font-semibold text-butter">
          <p className="py-1">Demo mode · fictional listings · data stays on this device</p>
        </div>
      )}
      <main id="main" className={cn(!fullScreen && 'pb-tabbar')}>
        <div key={pathname.split('/').slice(0, 3).join('/')} className="animate-fade">
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
      {!fullScreen && <TabBar />}
      <ScrollRestoration />
    </div>
  )
}
