import { config } from './config'

/** Share via the native share sheet when available, else copy to clipboard. Returns what happened. */
export async function shareLink(path: string, title: string, text?: string): Promise<'shared' | 'copied' | 'cancelled'> {
  const url = `${config.siteUrl}${path}`
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url })
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled'
    }
  }
  await navigator.clipboard?.writeText(url)
  return 'copied'
}

/** Light haptic tick where supported (Android/Chrome). iOS Safari ignores it harmlessly. */
export function haptic(ms = 10) {
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* ignore */
  }
}
