/**
 * Privacy-friendly analytics + minimal error visibility.
 *  - Cloudflare Web Analytics (free, cookie-free) when VITE_CF_ANALYTICS_TOKEN is set.
 *  - Unhandled errors are logged with context; plug in Sentry later if needed (see ARCHITECTURE.md).
 */
export function initMonitoring() {
  const token = import.meta.env.VITE_CF_ANALYTICS_TOKEN
  if (token && import.meta.env.PROD) {
    const s = document.createElement('script')
    s.defer = true
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js'
    s.dataset.cfBeacon = JSON.stringify({ token, spa: true })
    document.head.appendChild(s)
  }
  window.addEventListener('unhandledrejection', (e) => console.error('[aour] unhandled rejection', e.reason))
  window.addEventListener('error', (e) => console.error('[aour] error', e.message, e.filename, e.lineno))
}
