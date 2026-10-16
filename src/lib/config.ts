const env = import.meta.env

export const config = {
  supabaseUrl: (env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? '',
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
  appleSignIn: env.VITE_ENABLE_APPLE_SIGNIN === 'true',
  siteUrl: ((env.VITE_SITE_URL as string | undefined) || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, ''),
  mapStyleUrl: (env.VITE_MAP_STYLE_URL as string | undefined) || 'https://tiles.openfreemap.org/styles/positron',
}

export const isDemoMode = !config.supabaseUrl || !config.supabaseAnonKey

/**
 * Demo mode (fictional listings, code 123456, first account = admin) is for development only.
 * It runs on localhost / private networks, or when a build explicitly opts in with
 * VITE_ALLOW_DEMO=true. A production build that is missing its Supabase settings shows a
 * "not configured" screen instead of silently serving fictional data on a public site.
 */
export function demoAllowedOn(hostname: string, allowFlag = env.VITE_ALLOW_DEMO === 'true'): boolean {
  if (allowFlag) return true
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    /^(10|127)\.\d+\.\d+\.\d+$/.test(hostname) ||
    /^192\.168\.\d+\.\d+$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
    hostname.endsWith('.local')
  )
}

export const demoBlocked = isDemoMode && typeof window !== 'undefined' && !demoAllowedOn(window.location.hostname)
