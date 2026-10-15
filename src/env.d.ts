/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_ENABLE_APPLE_SIGNIN?: string
  readonly VITE_SITE_URL?: string
  readonly VITE_MAP_STYLE_URL?: string
  readonly VITE_CF_ANALYTICS_TOKEN?: string
}
