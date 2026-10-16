/**
 * Integration tests against a REAL Supabase STAGING project (never production).
 *
 * They create throwaway users and one temporary, clearly-labelled test listing, and delete
 * everything they created afterwards. They refuse to run unless the project is explicitly
 * confirmed as staging and differs from PRODUCTION_SUPABASE_URL.
 *
 *   STAGING_SUPABASE_URL=https://<staging-ref>.supabase.co \
 *   STAGING_SUPABASE_ANON_KEY=... STAGING_SUPABASE_SERVICE_ROLE_KEY=... \
 *   STAGING_CONFIRM=i-understand-this-writes-test-data \
 *   PRODUCTION_SUPABASE_URL=https://<prod-ref>.supabase.co \
 *   npm run test:staging
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL_ = process.env.STAGING_SUPABASE_URL?.replace(/\/+$/, '')
const ANON = process.env.STAGING_SUPABASE_ANON_KEY
const SERVICE = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY
const PROD = process.env.PRODUCTION_SUPABASE_URL?.replace(/\/+$/, '')
const CONFIRMED = process.env.STAGING_CONFIRM === 'i-understand-this-writes-test-data'
const enabled = !!(URL_ && ANON && SERVICE && CONFIRMED)

if (enabled && (!PROD || PROD === URL_)) {
  throw new Error('Refusing to run: set PRODUCTION_SUPABASE_URL to the production project so staging can be told apart from it.')
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const run = `aour-staging-${Date.now().toString(36)}`

describe.skipIf(!enabled)('Supabase staging integration', () => {
  let service: SupabaseClient
  let anon: SupabaseClient
  const users: { id: string; email: string; client: SupabaseClient }[] = []
  let placeId = ''
  let marketId = ''

  async function newUser(label: string) {
    const email = `${run}-${label}@example.com`
    const password = `pw-${crypto.randomUUID()}`
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw error
    const client = createClient(URL_!, ANON!, opts)
    const s = await client.auth.signInWithPassword({ email, password })
    if (s.error) throw s.error
    const u = { id: data.user.id, email, client }
    users.push(u)
    return u
  }

  beforeAll(async () => {
    service = createClient(URL_!, SERVICE!, opts)
    anon = createClient(URL_!, ANON!, opts)
    const m = await service.from('markets').select('id, lat, lng').limit(1).single()
    if (m.error) throw m.error
    marketId = m.data.id
    const ins = await service
      .from('establishments')
      .insert({
        slug: run, name: `[Staging test] ${run}`, kind: 'bar', market_id: marketId, city: 'Test', state: 'FL', address: 'Staging test record',
        lat: m.data.lat, lng: m.data.lng, timezone: 'America/New_York', status: 'published', is_demo: true, hh_status: 'none',
      })
      .select('id')
      .single()
    if (ins.error) throw ins.error
    placeId = ins.data.id
  })

  afterAll(async () => {
    if (!service) return
    for (const u of users) await service.auth.admin.deleteUser(u.id)
    if (placeId) await service.from('establishments').delete().eq('id', placeId)
  })

  it('anonymous visitors read published listings via the indexed nearby RPC, with relations embedded', async () => {
    const m = await anon.from('markets').select('lat, lng').eq('id', marketId).single()
    const res = await anon
      .rpc('nearby_establishments', { p_lat: m.data!.lat, p_lng: m.data!.lng, p_radius_m: 2000, p_limit: 50 })
      .select('id, name, hh_status, happy_hour_windows(*), establishment_stats(*)')
    expect(res.error).toBeNull()
    expect((res.data as { id: string }[]).some((r) => r.id === placeId)).toBe(true)
  })

  it('internal pipeline columns and tables are not readable by the public', async () => {
    const col = await anon.from('establishments').select('hh_confidence').eq('id', placeId)
    expect(col.error?.code).toBe('42501')
    const findings = await anon.from('hh_findings').select('id').limit(1)
    expect(findings.data ?? []).toEqual([])
    const rpc = await anon.rpc('pipeline_enqueue_due', { p_limit: 1 })
    expect(rpc.error).not.toBeNull()
    const admin = await anon.rpc('admin_pipeline_overview')
    expect(admin.error).not.toBeNull()
  })

  it('signed-in users rate, set weights, and community scores update', async () => {
    const a = await newUser('a')
    const scores = { ambience: 8, drinks: 9, food: 7, value: 8, service: 9, overall: 8 }
    const saved = await a.client.rpc('save_visit', { p: { establishment_id: placeId, scores, tags: ['lively'], visibility: 'public' } })
    expect(saved.error).toBeNull()
    const prefs = await a.client.from('user_preferences').upsert({ user_id: a.id, weights: { ambience: 10, drinks: 40, food: 10, value: 20, service: 10, overall: 10 } })
    expect(prefs.error).toBeNull()
    const stats = await anon.from('establishment_stats').select('reviewers, average').eq('establishment_id', placeId).single()
    expect(stats.data?.reviewers).toBe(1)
    expect(Number(stats.data?.average)).toBeGreaterThan(7)
  })

  it('row-level security keeps private visits and notes private', async () => {
    const a = await newUser('owner')
    const b = await newUser('other')
    const priv = await a.client.rpc('save_visit', { p: { establishment_id: placeId, scores: { overall: 6 }, note: 'secret', visibility: 'private' } })
    expect(priv.error).toBeNull()
    const seen = await b.client.from('visits').select('id').eq('id', priv.data as string)
    expect(seen.data).toEqual([])
    const notes = await b.client.from('visit_notes').select('body')
    expect((notes.data ?? []).some((n) => n.body === 'secret')).toBe(false)
  })

  it('non-admins cannot use admin RPCs', async () => {
    const u = await newUser('plain')
    const r = await u.client.rpc('admin_stats')
    expect(r.error).not.toBeNull()
  })

  it('uploads go only to the user’s own folder and are publicly readable', async () => {
    const u = await newUser('upload')
    // 1×1 PNG
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const own = await u.client.storage.from('avatars').upload(`${u.id}/${run}.png`, png, { contentType: 'image/png' })
    expect(own.error).toBeNull()
    const other = await u.client.storage.from('avatars').upload(`${crypto.randomUUID()}/${run}.png`, png, { contentType: 'image/png' })
    expect(other.error).not.toBeNull()
    const pub = u.client.storage.from('avatars').getPublicUrl(`${u.id}/${run}.png`).data.publicUrl
    expect((await fetch(pub)).status).toBe(200)
    await service.storage.from('avatars').remove([`${u.id}/${run}.png`])
  })

  it('sessions end on sign-out', async () => {
    const u = await newUser('session')
    expect((await u.client.auth.getUser()).data.user?.id).toBe(u.id)
    await u.client.auth.signOut()
    expect((await u.client.auth.getSession()).data.session).toBeNull()
  })
})
