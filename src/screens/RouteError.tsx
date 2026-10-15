import { isRouteErrorResponse, Link, useRouteError } from 'react-router'
import { Logo } from '@/components/brand'

export function RouteError() {
  const error = useRouteError()
  const chunkFailed = error instanceof Error && /dynamically imported module|Loading chunk/i.test(error.message)
  return (
    <div className="pt-safe flex min-h-dvh flex-col items-center justify-center gap-4 bg-cream px-8 text-center">
      <Logo size={32} />
      <h1 className="text-xl font-extrabold text-choc">{chunkFailed ? 'Aour was updated' : 'Something went wrong'}</h1>
      <p className="text-muted">
        {chunkFailed ? 'Reload to get the latest version.' : isRouteErrorResponse(error) ? error.statusText : 'Please try again.'}
      </p>
      <div className="flex gap-2">
        <button className="press h-11 rounded-full bg-choc px-5 font-semibold text-cream" onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link to="/" className="press flex h-11 items-center rounded-full bg-white px-5 font-semibold text-choc ring-1 ring-line">
          Home
        </Link>
      </div>
    </div>
  )
}
