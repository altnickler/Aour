const env = import.meta.env

export const config = {
  supabaseUrl: (env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? '',
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
  appleSignIn: env.VITE_ENABLE_APPLE_SIGNIN === 'true',
  siteUrl: ((env.VITE_SITE_URL as string | undefined) || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, ''),
  mapStyleUrl: (env.VITE_MAP_STYLE_URL as string | undefined) || 'https://tiles.openfreemap.org/styles/positron',
}

export const isDemoMode = !config.supabaseUrl || !config.supabaseAnonKey
