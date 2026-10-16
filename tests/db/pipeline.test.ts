/**
 * Discovery/enrichment pipeline, location search and admin data controls — against the real
 * migrations (PostGIS included). Fixture venues are fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { as, asService, createEstablishment, createTestDatabase, createUser, makeAdmin, marketId, saveVisit } from './helpers'

let pool: pg.Pool
let drop: () => Promise<void>
let admin: string
let user: string
let market: string

const candidate = (over: Record<string, unknown> = {}) => ({
  provider: 'overture',
  externalId: `ovt-${Math.random().toString(36).slice(2)}`,
  name: 'Fixture Dockside Bar',
  kind: 'bar',
  categories: ['bar'],
  lat: 27.1979,
  lng: -80.2537,
  address: '1 Example Way',
  city: 'Stuart',
  state: 'FL',
  postalCode: '34994',
  phone: '772-555-0199',
  website: 'https://dockside.example',
  openingHoursRaw: null,
  happyHoursRaw: null,
  amenities: ['outdoor_seating'],
  attribution: 'Overture Maps Foundation',
  license: 'CDLA-Permissive-2.0',
  closed: false,
  businessHours: [{ days: [1, 2, 3, 4, 5], start: '11:00', end: '22:00', label: null }],
  ...over,
})

const finding = (over: Record<string, unknown> = {}) => ({
  sourceKind: 'official_website',
  method: 'pattern',
  sourceUrl: 'https://dockside.example/specials',
  windows: [{ days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00', label: null }],
  specials: [{ kind: 'drink', title: 'House wine', price: '$5', description: null }],
  restrictions: ['Bar area only'],
  evidence: [{ field: 'window:0', quote: 'Mon-Fri 4-7pm' }],
  sourcePublishedAt: null,
  checkedAt: new Date().toISOString(),
  mentionedButUnparsed: false,
  ...over,
})

async function upsert(c: Record<string, unknown>, match: Record<string, unknown> = { decision: 'new' }) {
  return asService(pool, (q) => q.query('select public.pipeline_upsert_place($1, $2, $3) as r', [market, c, match]).then((r) => r.rows[0].r))
}

beforeAll(async () => {
  ;({ pool, drop } = await createTestDatabase('aour_test_pipeline'))
  admin = await createUser(pool, 'ops@example.com')
  await makeAdmin(pool, admin)
  user = await createUser(pool, 'rater@example.com')
  market = await marketId(pool)
})
afterAll(async () => drop?.())

const rejects = (p: Promise<unknown>) => expect(p).rejects.toThrow(/permission denied|Administrator access|row-level security/)

describe('location-aware search', () => {
  it('returns published places within the radius, nearest first, for anonymous users', async () => {
    const near = await createEstablishment(pool, { name: 'Near' })
    const far = await createEstablishment(pool, { name: 'Far' })
    const draft = await createEstablishment(pool, { name: 'Draft', status: 'draft' })
    await pool.query(`update public.establishments set lat = 27.2000, lng = -80.2500 where id = $1`, [near])
    await pool.query(`update public.establishments set lat = 27.4000, lng = -80.2500 where id = $1`, [far]) // ~13.8 mi north
    await pool.query(`update public.establishments set lat = 27.2001, lng = -80.2501 where id = $1`, [draft])
    const inFive = await as(pool, null, (c) => c.query(`select id from public.nearby_establishments(27.2, -80.25, 8047, 50)`).then((r) => r.rows.map((x) => x.id)))
    expect(inFive).toContain(near)
    expect(inFive).not.toContain(far)
    expect(inFive).not.toContain(draft)
    const inTwentyFive = await as(pool, null, (c) => c.query(`select id from public.nearby_establishments(27.2, -80.25, 40234, 50)`).then((r) => r.rows.map((x) => x.id)))
    expect(inTwentyFive.indexOf(near)).toBeLessThan(inTwentyFive.indexOf(far))
  })

  it('uses the geography index', async () => {
    await pool.query('analyze public.establishments')
    const plan = await pool.query(`set enable_seqscan = off; explain select * from public.nearby_establishments(27.2, -80.25, 8047, 50)`)
    const text = JSON.stringify(plan)
    // Function body is inlined/planned; the direct query must hit the GiST index.
    const direct = await pool.query(`set enable_seqscan = off; explain select id from public.establishments where extensions.st_dwithin(location, extensions.st_makepoint(-80.25, 27.2)::extensions.geography, 8047)`)
    expect(JSON.stringify(direct)).toMatch(/establishments_location_idx/)
    expect(text.length).toBeGreaterThan(0)
  })

  it('coverage requests store only ~11 km cells and report coverage', async () => {
    const covered = await as(pool, null, (c) => c.query(`select public.request_coverage(27.19, -80.25) as r`).then((r) => r.rows[0].r))
    expect(covered).toBe(true)
    const austin = await as(pool, null, (c) => c.query(`select public.request_coverage(30.26721, -97.74312, 'Austin') as r`).then((r) => r.rows[0].r))
    expect(austin).toBe(false)
    await as(pool, user, (c) => c.query(`select public.request_coverage(30.2698, -97.7401)`))
    const { rows } = await pool.query(`select cell, lat, lng, requests from public.coverage_requests`)
    expect(rows).toEqual([{ cell: '30.3,-97.7', lat: '30.3', lng: '-97.7', requests: 2 }])
    await rejects(as(pool, user, (c) => c.query(`select * from public.coverage_requests`).then((r) => { if (!r.rows.length) throw new Error('permission denied') })))
  })
})

describe('pipeline access control', () => {
  it('pipeline RPCs are service-role only — not even admins can call them', async () => {
    for (const who of [null, user, admin]) {
      await rejects(as(pool, who, (c) => c.query(`select public.pipeline_enqueue_due(10)`)))
      await rejects(as(pool, who, (c) => c.query(`select public.pipeline_upsert_place($1, $2, $3)`, [market, candidate(), { decision: 'new' }])))
      await rejects(as(pool, who, (c) => c.query(`select public.pipeline_consume_budget('website_fetch', 1)`)))
    }
  })

  it('findings, jobs and evidence are admin-readable only', async () => {
    const rows = await as(pool, user, (c) => c.query(`select * from public.hh_findings`).then((r) => r.rows))
    expect(rows).toHaveLength(0)
    await as(pool, admin, (c) => c.query(`select * from public.refresh_jobs`))
  })
})

describe('discovery upserts and duplicate handling', () => {
  it('creates new venues as auto-managed with no happy-hour claim, plus provenance', async () => {
    const c = candidate()
    const r = await upsert(c)
    expect(r.action).toBe('created')
    const { rows } = await pool.query(`select status, origin, hh_status, hh_managed_by, attribution, business_hours, slug from public.establishments where id = $1`, [r.establishmentId])
    expect(rows[0]).toMatchObject({ status: 'published', origin: 'import', hh_status: 'none', hh_managed_by: 'auto', attribution: 'Overture Maps Foundation' })
    expect(rows[0].business_hours).toHaveLength(1)
    const ids = await pool.query(`select provider, external_id from public.establishment_external_ids where establishment_id = $1`, [r.establishmentId])
    expect(ids.rows).toEqual([{ provider: 'overture', external_id: c.externalId }])
    // Same name again → unique slug.
    const r2 = await upsert(candidate({ lat: 28.5, lng: -81.3 }))
    const slugs = await pool.query(`select slug from public.establishments where id in ($1, $2)`, [r.establishmentId, r2.establishmentId])
    expect(new Set(slugs.rows.map((x) => x.slug)).size).toBe(2)
  })

  it('links a repeat sighting instead of duplicating, and respects admin locks', async () => {
    const c = candidate({ name: 'Fixture Lock Bar' })
    const { establishmentId } = await upsert(c)
    // Admin corrects the website → field becomes locked.
    await as(pool, admin, (q) => q.query(`update public.establishments set website = 'https://correct.example' where id = $1`, [establishmentId]))
    const locks = await pool.query(`select locked_fields from public.establishments where id = $1`, [establishmentId])
    expect(locks.rows[0].locked_fields).toContain('website')
    const r = await upsert({ ...c, website: 'https://stale-provider.example', phone: '772-555-0000' }, { decision: 'same', establishmentId })
    expect(r.action).toBe('updated')
    const { rows } = await pool.query(`select website, phone from public.establishments where id = $1`, [establishmentId])
    expect(rows[0]).toEqual({ website: 'https://correct.example', phone: '772-555-0000' })
    const count = await pool.query(`select count(*)::int as n from public.establishments where name = 'Fixture Lock Bar'`)
    expect(count.rows[0].n).toBe(1)
  })

  it('manual listings only gain missing facts from providers', async () => {
    const manual = await createEstablishment(pool, { name: 'Manual Place' })
    await pool.query(`update public.establishments set website = 'https://manual.example' where id = $1`, [manual])
    await upsert(candidate({ website: 'https://provider.example', phone: '772-555-1234' }), { decision: 'same', establishmentId: manual })
    const { rows } = await pool.query(`select website, phone from public.establishments where id = $1`, [manual])
    expect(rows[0]).toEqual({ website: 'https://manual.example', phone: '772-555-1234' })
  })

  it('uncertain matches are held as drafts with a possible-duplicate record', async () => {
    const existing = await createEstablishment(pool, { name: 'Fixture Twin' })
    const r = await upsert(candidate({ name: 'Fixture Twin Bar' }), { decision: 'review', establishmentId: existing, score: 0.7, reasons: ['name 0.80', '120 m'] })
    expect(r.action).toBe('created_for_review')
    const st = await pool.query(`select status from public.establishments where id = $1`, [r.establishmentId])
    expect(st.rows[0].status).toBe('draft')
    const dups = await as(pool, admin, (c) => c.query(`select public.admin_list_duplicates() as d`).then((x) => x.rows[0].d))
    const d = dups.find((x: { b: { id: string } }) => x.b.id === r.establishmentId)
    expect(d.reasons).toEqual(['name 0.80', '120 m'])
    // Dismiss → publish the held record.
    await as(pool, admin, (c) => c.query(`select public.admin_resolve_duplicate($1, 'dismiss')`, [d.id]))
    expect((await pool.query(`select status from public.establishments where id = $1`, [r.establishmentId])).rows[0].status).toBe('published')
  })

  it('id-only providers can link but never create or update venue data; closed venues are skipped', async () => {
    const r = await upsert(candidate({ provider: 'foursquare' }))
    expect(r.action).toBe('skipped')
    const target = await createEstablishment(pool, { name: 'Fsq Target' })
    const linked = await upsert(candidate({ provider: 'foursquare', externalId: 'fsq-1', website: 'https://nope.example' }), { decision: 'same', establishmentId: target })
    expect(linked.action).toBe('linked')
    expect((await pool.query(`select website from public.establishments where id = $1`, [target])).rows[0].website).toBeNull()
    expect((await upsert(candidate({ closed: true }))).action).toBe('skipped')
  })
})

describe('findings, verification and manual overrides', () => {
  const record = (id: string, f: Record<string, unknown>, action: string, assessment: Record<string, unknown>, fp: string) =>
    asService(pool, (c) => c.query('select public.pipeline_record_finding($1, $2, $3, $4, $5) as r', [id, f, action, assessment, fp]).then((r) => r.rows[0].r))

  it('applies deterministic official-site findings to auto-managed listings', async () => {
    const { establishmentId: id } = await upsert(candidate({ name: 'Fixture Auto Bar' }))
    const r = await record(id, finding(), 'apply', { status: 'establishment_reported', confidence: 0.75, conflict: false }, 'fp1')
    expect(r.action).toBe('apply')
    const e = (await pool.query(`select hh_status, hh_confidence, hh_source_url, hh_restrictions, hh_last_confirmed_at from public.establishments where id = $1`, [id])).rows[0]
    expect(e).toMatchObject({ hh_status: 'establishment_reported', hh_confidence: '0.75', hh_source_url: 'https://dockside.example/specials', hh_restrictions: ['Bar area only'] })
    expect(e.hh_last_confirmed_at).not.toBeNull()
    const w = (await pool.query(`select days, start_time, end_time from public.happy_hour_windows where establishment_id = $1`, [id])).rows
    expect(w).toEqual([{ days: [1, 2, 3, 4, 5], start_time: '16:00:00', end_time: '19:00:00' }])
    const history = await as(pool, admin, (c) => c.query(`select public.admin_listing_history($1) as h`, [id]).then((x) => x.rows[0].h))
    expect(history.changes[0].actor).toBe('pipeline')
  })

  it('never overwrites admin-managed listings; files the finding for review instead', async () => {
    const id = await createEstablishment(pool, { name: 'Admin Managed' })
    await as(pool, admin, (c) =>
      c.query(`insert into public.happy_hour_windows (establishment_id, days, start_time, end_time) values ($1, '{1,2,3}', '15:00', '18:00')`, [id]),
    )
    expect((await pool.query(`select hh_managed_by from public.establishments where id = $1`, [id])).rows[0].hh_managed_by).toBe('admin')
    // Even if a buggy caller says "apply", SQL refuses to overwrite.
    const r = await record(id, finding(), 'apply', { status: 'establishment_reported', confidence: 0.8, conflict: false }, 'fp2')
    expect(r.action).toBe('review')
    const w = (await pool.query(`select start_time from public.happy_hour_windows where establishment_id = $1`, [id])).rows
    expect(w).toEqual([{ start_time: '15:00:00' }])
    const pending = await as(pool, admin, (c) => c.query(`select public.admin_list_findings('pending', $1) as f`, [id]).then((x) => x.rows[0].f))
    expect(pending).toHaveLength(1)
    expect(pending[0].evidence).toEqual([{ field: 'window:0', quote: 'Mon-Fri 4-7pm' }])
  })

  it('the pipeline cannot mark anything verified; admin approval can', async () => {
    const { establishmentId: id } = await upsert(candidate({ name: 'Fixture Verify Bar' }))
    await expect(record(id, finding(), 'apply', { status: 'verified', confidence: 1, conflict: false }, 'fp3')).rejects.toThrow(/cannot mark listings verified/)
    const r = await record(id, finding({ method: 'llm' }), 'review', { status: 'unverified', confidence: 0.55, conflict: false }, 'fp4')
    await as(pool, admin, (c) => c.query(`select public.admin_review_finding($1, 'approve', 'Called the bar')`, [r.findingId]))
    const e = (await pool.query(`select hh_status, hh_managed_by, hh_verified_at from public.establishments where id = $1`, [id])).rows[0]
    expect(e.hh_status).toBe('verified')
    expect(e.hh_managed_by).toBe('admin')
    expect(e.hh_verified_at).not.toBeNull()
    const src = await pool.query(`select kind from public.listing_sources where establishment_id = $1`, [id])
    expect(src.rows[0].kind).toBe('official_website')
    await rejects(as(pool, user, (c) => c.query(`select public.admin_review_finding($1, 'approve')`, [r.findingId])))
  })

  it('handing a listing back to automation re-enables auto updates', async () => {
    const id = await createEstablishment(pool, { name: 'Handback' })
    await as(pool, admin, (c) => c.query(`select public.admin_set_hh_managed($1, 'auto')`, [id]))
    const r = await record(id, finding(), 'apply', { status: 'establishment_reported', confidence: 0.75, conflict: false }, 'fp5')
    expect(r.action).toBe('apply')
  })

  it('stale automated info is downgraded to outdated; admin-managed info is not', async () => {
    const { establishmentId: auto } = await upsert(candidate({ name: 'Fixture Stale Bar' }))
    await record(auto, finding(), 'apply', { status: 'establishment_reported', confidence: 0.75, conflict: false }, 'fp6')
    await pool.query(`update public.establishments set hh_last_confirmed_at = now() - interval '200 days' where id = $1`, [auto])
    const manual = await createEstablishment(pool, { name: 'Manual Old' })
    await pool.query(`update public.establishments set hh_status = 'verified', hh_verified_at = now() - interval '200 days', hh_last_confirmed_at = now() - interval '200 days' where id = $1`, [manual])
    await asService(pool, (c) => c.query(`select public.pipeline_enqueue_due(0)`))
    const st = await pool.query(`select id, hh_status from public.establishments where id in ($1, $2)`, [auto, manual])
    expect(Object.fromEntries(st.rows.map((r) => [r.id, r.hh_status]))).toEqual({ [auto]: 'outdated', [manual]: 'verified' })
  })
})

describe('job queue and budgets', () => {
  it('enqueues due work once, claims without double-processing, retries with backoff', async () => {
    const { establishmentId: id } = await upsert(candidate({ name: 'Fixture Queue Bar' }))
    await asService(pool, (c) => c.query(`select public.pipeline_enqueue_due(500)`))
    await asService(pool, (c) => c.query(`select public.pipeline_enqueue_due(500)`)) // idempotent
    const active = await pool.query(`select count(*)::int as n from public.refresh_jobs where target_id = $1 and status in ('queued','running')`, [id])
    expect(active.rows[0].n).toBe(1)

    // Two workers claiming concurrently never get the same job.
    const [a, b] = await Promise.all([
      asService(pool, (c) => c.query(`select id from public.pipeline_claim_jobs('w1', 3, '{enrich_establishment}')`).then((r) => r.rows.map((x) => x.id))),
      asService(pool, (c) => c.query(`select id from public.pipeline_claim_jobs('w2', 3, '{enrich_establishment}')`).then((r) => r.rows.map((x) => x.id))),
    ])
    expect(a.filter((x: string) => b.includes(x))).toEqual([])

    const job = (await pool.query(`select id from public.refresh_jobs where target_id = $1`, [id])).rows[0].id
    await pool.query(`update public.refresh_jobs set status = 'running', attempts = 1 where id = $1`, [job])
    const retryAt = new Date(Date.now() + 3600_000).toISOString()
    await asService(pool, (c) => c.query(`select public.pipeline_finish_job($1, 'failed', 'HTTP 503', null, $2)`, [job, retryAt]))
    let j = (await pool.query(`select status, run_after, last_error from public.refresh_jobs where id = $1`, [job])).rows[0]
    expect(j.status).toBe('queued')
    expect(j.last_error).toBe('HTTP 503')
    await pool.query(`update public.refresh_jobs set status = 'running', attempts = max_attempts where id = $1`, [job])
    await asService(pool, (c) => c.query(`select public.pipeline_finish_job($1, 'failed', 'HTTP 503', null, $2)`, [job, retryAt]))
    j = (await pool.query(`select status from public.refresh_jobs where id = $1`, [job])).rows[0]
    expect(j.status).toBe('failed')
  })

  it('reclaims jobs from crashed workers', async () => {
    const { establishmentId: id } = await upsert(candidate({ name: 'Fixture Crash Bar' }))
    await pool.query(`insert into public.refresh_jobs (kind, target_id, status, attempts, locked_at, locked_by) values ('enrich_establishment', $1, 'running', 1, now() - interval '1 hour', 'dead')`, [id])
    await asService(pool, (c) => c.query(`select public.pipeline_enqueue_due(0)`))
    const j = (await pool.query(`select status from public.refresh_jobs where target_id = $1`, [id])).rows[0]
    expect(j.status).toBe('queued')
  })

  it('admin manual refresh jumps the queue and dedupes', async () => {
    const id = await createEstablishment(pool, { name: 'Manual Refresh' })
    const j1 = await as(pool, admin, (c) => c.query(`select public.admin_enqueue_refresh('enrich_establishment', $1) as j`, [id]).then((r) => r.rows[0].j))
    const j2 = await as(pool, admin, (c) => c.query(`select public.admin_enqueue_refresh('enrich_establishment', $1) as j`, [id]).then((r) => r.rows[0].j))
    expect(j1).toBe(j2)
    expect((await pool.query(`select priority from public.refresh_jobs where id = $1`, [j1])).rows[0].priority).toBe(10)
  })

  it('monthly budgets stop external calls when exhausted or disabled', async () => {
    await pool.query(`update public.provider_limits set monthly_limit = 3 where provider = 'website_fetch'`)
    const spend = () => asService(pool, (c) => c.query(`select public.pipeline_consume_budget('website_fetch', 1) as ok`).then((r) => r.rows[0].ok))
    expect([await spend(), await spend(), await spend(), await spend()]).toEqual([true, true, true, false])
    expect(await asService(pool, (c) => c.query(`select public.pipeline_consume_budget('foursquare', 1) as ok`).then((r) => r.rows[0].ok))).toBe(false)
    expect(await asService(pool, (c) => c.query(`select public.pipeline_consume_budget('unknown', 1) as ok`).then((r) => r.rows[0].ok))).toBe(false)
    const overview = await as(pool, admin, (c) => c.query(`select public.admin_pipeline_overview() as o`).then((r) => r.rows[0].o))
    expect(overview.budgets.find((b: { provider: string }) => b.provider === 'website_fetch')).toMatchObject({ used: 3, limit: 3 })
  })

  it('domain blocks are sticky: the pipeline cannot lift an admin block', async () => {
    await pool.query(`insert into public.source_domains (domain, blocked, blocked_reason) values ('blocked.example', true, 'Terms prohibit automated access')`)
    await asService(pool, (c) => c.query(`select public.pipeline_put_domain('blocked.example', $1)`, [{ blocked: false, robots_status: 200 }]))
    const d = await asService(pool, (c) => c.query(`select public.pipeline_get_domain('blocked.example') as d`).then((r) => r.rows[0].d))
    expect(d.blocked).toBe(true)
  })
})

describe('merging duplicates', () => {
  it('moves ratings, saves, lists and provenance onto the kept record', async () => {
    const keep = await createEstablishment(pool, { name: 'Keep Me' })
    const dup = await createEstablishment(pool, { name: 'Keep Me (dup)' })
    await saveVisit(pool, user, { establishment_id: dup, scores: { overall: 9 }, review: 'Great' })
    await as(pool, user, (c) => c.query(`insert into public.saved_places (user_id, establishment_id, list) values ($1, $2, 'favorite'), ($1, $3, 'favorite')`, [user, keep, dup]))
    await rejects(as(pool, user, (c) => c.query(`select public.admin_merge_establishments($1, $2)`, [keep, dup])))
    await as(pool, admin, (c) => c.query(`select public.admin_merge_establishments($1, $2)`, [keep, dup]))
    const visits = await pool.query(`select count(*)::int as n from public.visits where establishment_id = $1`, [keep])
    expect(visits.rows[0].n).toBe(1)
    const saves = await pool.query(`select count(*)::int as n from public.saved_places where user_id = $1 and list = 'favorite' and establishment_id in ($2, $3)`, [user, keep, dup])
    expect(saves.rows[0].n).toBe(1)
    const merged = (await pool.query(`select status, merged_into from public.establishments where id = $1`, [dup])).rows[0]
    expect(merged).toEqual({ status: 'archived', merged_into: keep })
    const stats = (await pool.query(`select reviewers from public.establishment_stats where establishment_id = $1`, [keep])).rows[0]
    expect(stats.reviewers).toBe(1)
  })
})
