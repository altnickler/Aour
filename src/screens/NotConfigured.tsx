import { Mark } from '@/components/brand'

/** Shown on a public hostname when the build has no Supabase settings (see src/lib/config.ts). */
export function NotConfigured() {
  return (
    <main className="pt-safe flex min-h-dvh flex-col items-center justify-center bg-cream px-8 text-center">
      <Mark size={56} />
      <h1 className="mt-6 text-2xl font-extrabold text-choc">Aour is almost ready</h1>
      <p className="mt-2 max-w-sm text-[15px] text-muted">
        This deployment isn't connected to its database yet, so there are no listings to show. Please check back soon.
      </p>
      <p className="mt-6 max-w-sm text-xs text-muted">
        For the site owner: set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> as build variables and redeploy (DEPLOYMENT.md). Build details: <a className="underline" href="/version.json">/version.json</a>
      </p>
    </main>
  )
}
