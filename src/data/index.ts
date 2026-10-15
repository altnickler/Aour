import { config } from '@/lib/config'
import type { Api } from './api'
import { DemoApi } from './demo/demoApi'
import { SupabaseApi } from './supabase/supabaseApi'

// Read env directly so the bundler can drop the unused backend (and the demo dataset) at build time.
const USE_SUPABASE = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)

/** The app-wide backend. Demo mode runs entirely on-device when Supabase isn't configured. */
export const api: Api = USE_SUPABASE ? new SupabaseApi(config.supabaseUrl, config.supabaseAnonKey, config.siteUrl) : new DemoApi()

export * from './api'
