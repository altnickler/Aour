import { registerSW } from 'virtual:pwa-register'

/** Register the service worker (production builds only). Updates apply on next launch. */
export function registerServiceWorker() {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return
  registerSW({ immediate: true })
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

let deferred: BeforeInstallPromptEvent | null = null
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
  })
}

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/** Android/desktop Chrome can prompt; iOS needs Share → Add to Home Screen instructions. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  await deferred.prompt()
  deferred = null
  return true
}
