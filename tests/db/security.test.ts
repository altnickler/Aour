/**
 * Authorization tests: every assertion runs through the same roles, grants and RLS
 * policies that Supabase's API uses in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { as, createEstablishment, createTestDatabase, createUser, makeAdmin, saveVisit } from './helpers'

let pool: pg.Pool
let drop: () => Promise<void>
let alice: string
let bob: string
let carol: string
let admin: string
let place: string
let draft: string

const scores = { ambience: 8, drinks: 9, food: null, value: 8.5, service: 7, overall: 8 }

beforeAll(async () => {
  ;({ pool, drop } = await createTestDatabase('aour_test_security'))
  alice = await createUser(pool, 'alice@example.com', { display_name: 'Alice' })
  bob = await createUser(pool, 'bob@example.com')
  carol = await createUser(pool, 'carol@example.com')
  admin = await createUser(pool, 'ops@example.com')
  await makeAdmin(pool, admin)
  place = await createEstablishment(pool)
  draft = await createEstablishment(pool, { status: 'draft' })
})

afterAll(async () => drop?.())

const rejects = (p: Promise<unknown>, pattern: RegExp = /permission denied|violates row-level security|Administrator access/) =>
  expect(p).rejects.toThrow(pattern)

describe('profiles', () => {
  it('creates a profile with a unique username on sign-up', async () => {
    const { rows } = await pool.query(`select username, display_name, role from public.profiles where id = $1`, [alice])
    expect(rows[0]).toEqual({ username: 'alice', display_name: 'Alice', role: 'user' })
    const dupe = await createUser(pool, 'alice@another.com')
    const { rows: r2 } = await pool.query(`select username from public.profiles where id = $1`, [dupe])
    expect(r2[0].username).toMatch(/^alice\d{4}$/)
  })

  it('users cannot read other users\' full profile rows', async () => {
    const rows = await as(pool, alice, (c) => c.query(`select * from public.profiles`).then((r) => r.rows))
    expect(rows.map((r) => r.id)).toEqual([alice])
    await rejects(as(pool, null, (c) => c.query(`select * from public.profiles`)))
  })

  it('users can edit their own safe fields but not role or suspension', async () => {
    await as(pool, alice, (c) => c.query(`update public.profiles set bio = 'Rosé all day' where id = $1`, [alice]))
    await rejects(as(pool, alice, (c) => c.query(`update public.profiles set role = 'admin' where id = $1`, [alice])))
    await rejects(as(pool, alice, (c) => c.query(`update public.profiles set suspended_at = null where id = $1`, [alice])))
    // Updating someone else's row silently affects nothing.
    const r = await as(pool, alice, (c) => c.query(`update public.profiles set bio = 'hacked' where id = $1`, [bob]))
    expect(r.rowCount).toBe(0)
  })

  it('get_profile hides details of private profiles', async () => {
    await pool.query(`update public.profiles set visibility = 'private', bio = 'secret' where id = $1`, [carol])
    const p = await as(pool, alice, (c) => c.query(`select public.get_profile('carol') as p`).then((r) => r.rows[0].p))
    expect(p.isPrivate).toBe(true)
    expect(p.bio).toBeNull()
    const own = await as(pool, carol, (c) => c.query(`select public.get_profile('carol') as p`).then((r) => r.rows[0].p))
    expect(own.bio).toBe('secret')
    await pool.query(`update public.profiles set visibility = 'public' where id = $1`, [carol])
  })
})

describe('establishments', () => {
  it('anonymous visitors can browse published listings only', async () => {
    const ids = await as(pool, null, (c) => c.query(`select id from public.establishments`).then((r) => r.rows.map((x) => x.id)))
    expect(ids).toContain(place)
    expect(ids).not.toContain(draft)
  })

  it('only admins can create or edit listings and schedules', async () => {
    await rejects(
      as(pool, alice, (c) =>
        c.query(`insert into public.establishments (slug, name, market_id, city, address, lat, lng)
                 select 'x-bar', 'X', id, 'Stuart', '1', 27, -80 from public.markets limit 1`),
      ),
    )
    const r = await as(pool, alice, (c) => c.query(`update public.establishments set name = 'Pwned' where id = $1`, [place]))
    expect(r.rowCount).toBe(0)
    await rejects(
      as(pool, alice, (c) =>
        c.query(`insert into public.happy_hour_windows (establishment_id, days, start_time, end_time) values ($1, '{1}', '16:00', '18:00')`, [place]),
      ),
    )
    await as(pool, admin, (c) =>
      c.query(`insert into public.happy_hour_windows (establishment_id, days, start_time, end_time) values ($1, '{1,2,3,4,5}', '16:00', '19:00')`, [place]),
    )
    const ids = await as(pool, admin, (c) => c.query(`select id from public.establishments`).then((r) => r.rows.map((x) => x.id)))
    expect(ids).toContain(draft)
  })

  it('admin_save_establishment is atomic, admin-only and cannot self-verify', async () => {
    const market = (await pool.query(`select id from public.markets limit 1`)).rows[0].id
    const body = {
      slug: 'rpc-bar', name: 'RPC Bar', kind: 'bar', market_id: market, city: 'Stuart', address: '2 Test St',
      lat: 27.2, lng: -80.25, hh_status: 'verified', status: 'published', amenities: ['waterfront'],
      windows: [{ days: [1, 2, 3, 4, 5], start: '16:00', end: '19:00', label: 'Happy hour' }],
      specials: [{ kind: 'drink', title: '$5 house wine', price: '$5' }],
      exceptions: [],
    }
    await rejects(as(pool, alice, (c) => c.query(`select public.admin_save_establishment($1)`, [body])))
    const id = await as(pool, admin, (c) => c.query(`select public.admin_save_establishment($1) as id`, [body]).then((r) => r.rows[0].id))
    const est = (await pool.query(`select hh_status, amenities from public.establishments where id = $1`, [id])).rows[0]
    expect(est).toEqual({ hh_status: 'unverified', amenities: ['waterfront'] })
    // A bad window rolls back the whole save.
    await expect(
      as(pool, admin, (c) => c.query(`select public.admin_save_establishment($1)`, [{ ...body, id, name: 'Renamed', windows: [{ days: [9], start: '16:00', end: '19:00' }] }])),
    ).rejects.toThrow(/check constraint/)
    const after = (await pool.query(`select name, (select count(*)::int from public.happy_hour_windows where establishment_id = $1) as n from public.establishments where id = $1`, [id])).rows[0]
    expect(after).toEqual({ name: 'RPC Bar', n: 1 })
  })

  it('verification sources are admin-only', async () => {
    await as(pool, admin, (c) => c.query(`select public.admin_verify_listing($1, 'phone', 'Called the bar')`, [place]))
    const userView = await as(pool, alice, (c) => c.query(`select * from public.listing_sources`).then((r) => r.rows))
    expect(userView).toHaveLength(0)
    const { rows } = await pool.query(`select hh_status, hh_verified_at from public.establishments where id = $1`, [place])
    expect(rows[0].hh_status).toBe('verified')
    expect(rows[0].hh_verified_at).not.toBeNull()
  })

  it('stats rows are server-maintained and not writable by users', async () => {
    await rejects(as(pool, alice, (c) => c.query(`update public.establishment_stats set average = 10 where establishment_id = $1`, [place])))
  })
})

describe('visits and ratings', () => {
  let alicePublic: string
  let alicePrivate: string

  beforeAll(async () => {
    alicePublic = await saveVisit(pool, alice, { establishment_id: place, scores, tags: ['lively'], note: 'sat at the bar', review: 'Great espresso martinis', visibility: 'public' })
    alicePrivate = await saveVisit(pool, alice, { establishment_id: place, scores: { overall: 4 }, visibility: 'private' })
  })

  it('cannot rate drafts or rate as someone else', async () => {
    await rejects(saveVisit(pool, alice, { establishment_id: draft, scores }))
    await rejects(
      as(pool, alice, (c) =>
        c.query(`insert into public.visits (user_id, establishment_id, visited_on) values ($1, $2, current_date)`, [bob, place]),
      ),
    )
    await rejects(saveVisit(pool, null as unknown as string, { establishment_id: place, scores }), /Sign in|permission denied/)
  })

  it('others see public visits but never private visits or private notes', async () => {
    const ids = await as(pool, bob, (c) => c.query(`select id from public.visits`).then((r) => r.rows.map((x) => x.id)))
    expect(ids).toContain(alicePublic)
    expect(ids).not.toContain(alicePrivate)
    const anonIds = await as(pool, null, (c) => c.query(`select id from public.visits`).then((r) => r.rows.map((x) => x.id)))
    expect(anonIds).toEqual([alicePublic])
    const notes = await as(pool, bob, (c) => c.query(`select * from public.visit_notes`).then((r) => r.rows))
    expect(notes).toHaveLength(0)
    const privateScores = await as(pool, bob, (c) => c.query(`select * from public.rating_scores where visit_id = $1`, [alicePrivate]).then((r) => r.rows))
    expect(privateScores).toHaveLength(0)
    const own = await as(pool, alice, (c) => c.query(`select body from public.visit_notes`).then((r) => r.rows))
    expect(own).toEqual([{ body: 'sat at the bar' }])
  })

  it('others cannot edit or delete my visits or scores', async () => {
    await rejects(saveVisit(pool, bob, { id: alicePublic, establishment_id: place, scores }), /not found/)
    const del = await as(pool, bob, (c) => c.query(`delete from public.visits where id = $1`, [alicePublic]))
    expect(del.rowCount).toBe(0)
    const upd = await as(pool, bob, (c) => c.query(`update public.rating_scores set score = 1 where visit_id = $1`, [alicePublic]))
    expect(upd.rowCount).toBe(0)
    await rejects(as(pool, bob, (c) => c.query(`insert into public.rating_scores values ($1, 'food', 1)`, [alicePublic])))
  })

  it('users cannot moderate themselves', async () => {
    await rejects(as(pool, alice, (c) => c.query(`update public.reviews set status = 'published' where visit_id = $1`, [alicePublic])))
    await rejects(as(pool, alice, (c) => c.query(`update public.visits set excluded_from_community = false where id = $1`, [alicePublic])))
  })

  it('private profiles hide all visits from others', async () => {
    await pool.query(`update public.profiles set visibility = 'private' where id = $1`, [alice])
    const ids = await as(pool, bob, (c) => c.query(`select id from public.visits`).then((r) => r.rows))
    expect(ids).toHaveLength(0)
    const reviews = await as(pool, bob, (c) => c.query(`select public.establishment_reviews($1) as r`, [place]).then((r) => r.rows[0].r))
    expect(reviews).toHaveLength(0)
    await pool.query(`update public.profiles set visibility = 'public' where id = $1`, [alice])
  })

  it('users can edit and delete their own visits', async () => {
    const id = await saveVisit(pool, alice, { establishment_id: place, scores: { drinks: 5 } })
    await saveVisit(pool, alice, { id, establishment_id: place, scores: { drinks: 6 } })
    const { rows } = await pool.query(`select score from public.rating_scores where visit_id = $1`, [id])
    expect(rows).toEqual([{ score: '6.0' }])
    const del = await as(pool, alice, (c) => c.query(`delete from public.visits where id = $1`, [id]))
    expect(del.rowCount).toBe(1)
  })
})

describe('lists, collections and follows', () => {
  it('saved places are private to their owner', async () => {
    await as(pool, alice, (c) => c.query(`insert into public.saved_places (user_id, establishment_id, list) values ($1, $2, 'want_to_try')`, [alice, place]))
    const bobView = await as(pool, bob, (c) => c.query(`select * from public.saved_places`).then((r) => r.rows))
    expect(bobView).toHaveLength(0)
    await rejects(as(pool, bob, (c) => c.query(`insert into public.saved_places (user_id, establishment_id, list) values ($1, $2, 'favorite')`, [alice, place])))
  })

  it('private collections are hidden; public ones are shareable', async () => {
    const [priv, pub] = await as(pool, alice, async (c) => {
      const a = await c.query(`insert into public.collections (user_id, name) values ($1, 'Secret spots') returning id, share_id`, [alice])
      const b = await c.query(`insert into public.collections (user_id, name, visibility) values ($1, 'Best in Stuart', 'public') returning id, share_id`, [alice])
      await c.query(`insert into public.collection_items (collection_id, establishment_id) values ($1, $2)`, [b.rows[0].id, place])
      return [a.rows[0], b.rows[0]]
    })
    const seen = await as(pool, null, (c) => c.query(`select id from public.collections`).then((r) => r.rows.map((x) => x.id)))
    expect(seen).toEqual([pub.id])
    const shared = await as(pool, null, (c) => c.query(`select public.collection_by_share($1) as c`, [pub.share_id]).then((r) => r.rows[0].c))
    expect(shared.items).toHaveLength(1)
    expect(shared.ownerUsername).toBe('alice')
    const hidden = await as(pool, bob, (c) => c.query(`select public.collection_by_share($1) as c`, [priv.share_id]).then((r) => r.rows[0].c))
    expect(hidden).toBeNull()
    await rejects(as(pool, bob, (c) => c.query(`insert into public.collection_items (collection_id, establishment_id) values ($1, $2)`, [pub.id, draft])))
    await rejects(as(pool, alice, (c) => c.query(`update public.collections set featured_at = now() where id = $1`, [pub.id])))
  })

  it('follows: no self-follow, no following private profiles, feed shows public activity', async () => {
    await rejects(as(pool, bob, (c) => c.query(`insert into public.follows values ($1, $1)`, [bob])), /check constraint|row-level/)
    await pool.query(`update public.profiles set visibility = 'private' where id = $1`, [carol])
    await rejects(as(pool, bob, (c) => c.query(`insert into public.follows (follower_id, followee_id) values ($1, $2)`, [bob, carol])))
    await pool.query(`update public.profiles set visibility = 'public' where id = $1`, [carol])
    await as(pool, bob, (c) => c.query(`insert into public.follows (follower_id, followee_id) values ($1, $2)`, [bob, alice]))
    const feed = await as(pool, bob, (c) => c.query(`select public.following_feed() as f`).then((r) => r.rows[0].f))
    expect(feed.some((i: { kind: string }) => i.kind === 'visit')).toBe(true)
    expect(feed.every((i: { review?: { review: string } }) => !i.review || i.review.review !== 'sat at the bar')).toBe(true)
    const friends = await as(pool, bob, (c) => c.query(`select public.establishment_reviews($1, true) as r`, [place]).then((r) => r.rows[0].r))
    expect(friends.length).toBeGreaterThan(0)
    expect(friends[0].user.username).toBe('alice')
  })
})

describe('moderation and abuse prevention', () => {
  it('admin RPCs reject normal users', async () => {
    await rejects(as(pool, alice, (c) => c.query(`select public.admin_stats()`)))
    await rejects(as(pool, alice, (c) => c.query(`select public.admin_set_suspended($1, true)`, [bob])))
    await rejects(as(pool, alice, (c) => c.query(`select public.admin_set_role($1, 'admin')`, [alice])))
    await rejects(as(pool, null, (c) => c.query(`select public.admin_list_users()`)))
    const s = await as(pool, admin, (c) => c.query(`select public.admin_stats() as s`).then((r) => r.rows[0].s))
    expect(s.users).toBeGreaterThanOrEqual(4)
  })

  it('internal helpers are not callable by clients', async () => {
    await rejects(as(pool, alice, (c) => c.query(`select public.aour_refresh_establishment_stats($1)`, [place])))
    await rejects(as(pool, alice, (c) => c.query(`select public.aour_log('x', 'y', 'z')`)))
  })

  it('three reports hide a review; users cannot report their own', async () => {
    const visit = await saveVisit(pool, carol, { establishment_id: place, scores: { overall: 2 }, review: 'Buy cheap watches here' })
    await rejects(as(pool, carol, (c) => c.query(`insert into public.review_reports (visit_id, reporter_id, reason) values ($1, $2, 'spam')`, [visit, carol])))
    const extra = await createUser(pool, 'dave@example.com')
    for (const u of [alice, bob, extra]) {
      await as(pool, u, (c) => c.query(`insert into public.review_reports (visit_id, reporter_id, reason) values ($1, $2, 'spam')`, [visit, u]))
    }
    const { rows } = await pool.query(`select status, report_count from public.reviews where visit_id = $1`, [visit])
    expect(rows[0]).toEqual({ status: 'hidden', report_count: 3 })
    const pub = await as(pool, null, (c) => c.query(`select * from public.reviews where visit_id = $1`, [visit]).then((r) => r.rows))
    expect(pub).toHaveLength(0)
    await as(pool, admin, (c) => c.query(`select public.admin_moderate_review($1, 'removed')`, [visit]))
    const log = await pool.query(`select action from public.moderation_actions where target_id = $1`, [visit])
    expect(log.rows.map((r) => r.action)).toContain('review_removed')
  })

  it('rejects link spam in reviews', async () => {
    await rejects(
      saveVisit(pool, bob, { establishment_id: place, scores: { overall: 9 }, review: 'see http://a.co and http://b.co' }),
      /at most one link/,
    )
  })

  it('suspended users cannot write', async () => {
    await as(pool, admin, (c) => c.query(`select public.admin_set_suspended($1, true, 'spam')`, [carol]))
    await rejects(saveVisit(pool, carol, { establishment_id: place, scores: { overall: 9 } }))
    await rejects(as(pool, carol, (c) => c.query(`insert into public.saved_places (user_id, establishment_id, list) values ($1, $2, 'favorite')`, [carol, place])))
    const p = await as(pool, alice, (c) => c.query(`select public.get_profile('carol') as p`).then((r) => r.rows[0].p))
    expect(p).toBeNull()
    await as(pool, admin, (c) => c.query(`select public.admin_set_suspended($1, false)`, [carol]))
  })

  it('rate-limits submissions', async () => {
    const spammer = await createUser(pool, 'spam@example.com')
    for (let i = 0; i < 10; i++) {
      await as(pool, spammer, (c) =>
        c.query(`insert into public.establishment_submissions (kind, user_id, payload) values ('new_place', $1, '{"name":"x"}')`, [spammer]),
      )
    }
    await expect(
      as(pool, spammer, (c) => c.query(`insert into public.establishment_submissions (kind, user_id, payload) values ('new_place', $1, '{}')`, [spammer])),
    ).rejects.toThrow(/try again later/)
  })

  it('submissions cannot self-approve and do not publish listings', async () => {
    await rejects(
      as(pool, bob, (c) => c.query(`insert into public.establishment_submissions (kind, user_id, payload, status) values ('new_place', $1, '{}', 'approved')`, [bob])),
    )
    const before = await pool.query(`select count(*)::int as n from public.establishments`)
    await as(pool, bob, (c) => c.query(`insert into public.establishment_submissions (kind, user_id, payload) values ('new_place', $1, '{"name":"Shiny New Bar"}')`, [bob]))
    const after = await pool.query(`select count(*)::int as n from public.establishments`)
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('three outdated reports downgrade a verified listing', async () => {
    const users = await Promise.all(['o1', 'o2', 'o3'].map((u) => createUser(pool, `${u}@example.com`)))
    for (const u of users) {
      await as(pool, u, (c) => c.query(`insert into public.establishment_submissions (kind, establishment_id, user_id) values ('outdated', $1, $2)`, [place, u]))
    }
    const { rows } = await pool.query(`select hh_status from public.establishments where id = $1`, [place])
    expect(rows[0].hh_status).toBe('outdated')
  })
})

describe('storage', () => {
  it('users can upload only into their own folder', async () => {
    await as(pool, alice, (c) => c.query(`insert into storage.objects (bucket_id, name) values ('visit-photos', $1)`, [`${alice}/a.jpg`]))
    await rejects(as(pool, alice, (c) => c.query(`insert into storage.objects (bucket_id, name) values ('visit-photos', $1)`, [`${bob}/a.jpg`])))
    await rejects(as(pool, alice, (c) => c.query(`insert into storage.objects (bucket_id, name) values ('establishment-photos', 'x.jpg')`)))
    await as(pool, admin, (c) => c.query(`insert into storage.objects (bucket_id, name) values ('establishment-photos', 'x.jpg')`))
  })
})

describe('account deletion', () => {
  it('removes the user and all their data and refreshes community stats', async () => {
    const temp = await createUser(pool, 'leaving@example.com')
    const p2 = await createEstablishment(pool)
    await saveVisit(pool, temp, { establishment_id: p2, scores: { overall: 10 }, note: 'private', review: 'bye' })
    expect((await pool.query(`select reviewers from public.establishment_stats where establishment_id = $1`, [p2])).rows[0].reviewers).toBe(1)
    await as(pool, temp, (c) => c.query(`select public.delete_my_account()`))
    for (const t of ['profiles where id', 'visits where user_id', 'visit_notes where user_id', 'reviews where user_id']) {
      const { rows } = await pool.query(`select count(*)::int as n from public.${t} = $1`, [temp])
      expect(rows[0].n).toBe(0)
    }
    expect((await pool.query(`select count(*)::int as n from auth.users where id = $1`, [temp])).rows[0].n).toBe(0)
    const s = (await pool.query(`select reviewers, average from public.establishment_stats where establishment_id = $1`, [p2])).rows[0]
    expect(s).toEqual({ reviewers: 0, average: null })
  })

  it('anonymous callers cannot delete anything', async () => {
    await rejects(as(pool, null, (c) => c.query(`select public.delete_my_account()`)))
  })
})

describe('following list', () => {
  it('returns only the caller\'s followees', async () => {
    const list = await as(pool, bob, (c) => c.query(`select public.my_following() as f`).then((r) => r.rows[0].f))
    expect(list.map((u: { username: string }) => u.username)).toEqual(['alice'])
    await rejects(as(pool, null, (c) => c.query(`select public.my_following()`)))
  })
})

describe('review findings (regressions)', () => {
  it('a moderated review cannot be deleted and re-posted as published', async () => {
    const u = await createUser(pool, 'repost@example.com')
    const v = await saveVisit(pool, u, { establishment_id: place, scores: { overall: 5 }, review: 'buy my stuff' })
    await as(pool, admin, (c) => c.query(`select public.admin_moderate_review($1, 'removed')`, [v]))
    // Direct delete of the review row: blocked by RLS (0 rows).
    const del = await as(pool, u, (c) => c.query(`delete from public.reviews where visit_id = $1`, [v]))
    expect(del.rowCount).toBe(0)
    // Clearing the text via save_visit keeps the moderated row.
    await saveVisit(pool, u, { id: v, establishment_id: place, scores: { overall: 5 }, review: '' })
    await saveVisit(pool, u, { id: v, establishment_id: place, scores: { overall: 5 }, review: 'buy my stuff again' })
    const { rows } = await pool.query(`select status from public.reviews where visit_id = $1`, [v])
    expect(rows[0].status).toBe('removed')
    // Deleting the whole visit is blocked too.
    const delVisit = await as(pool, u, (c) => c.query(`delete from public.visits where id = $1`, [v]))
    expect(delVisit.rowCount).toBe(0)
  })

  it('a restored review is not re-hidden by a single new report', async () => {
    const author = await createUser(pool, 'restored@example.com')
    const v = await saveVisit(pool, author, { establishment_id: place, scores: { overall: 8 }, review: 'Legit review' })
    const reporters = await Promise.all(['r1', 'r2', 'r3', 'r4'].map((x) => createUser(pool, `${x}-restore@example.com`)))
    for (const r of reporters.slice(0, 3)) {
      await as(pool, r, (c) => c.query(`insert into public.review_reports (visit_id, reporter_id, reason) values ($1, $2, 'spam')`, [v, r]))
    }
    expect((await pool.query(`select status from public.reviews where visit_id = $1`, [v])).rows[0].status).toBe('hidden')
    await as(pool, admin, (c) => c.query(`select public.admin_moderate_review($1, 'published')`, [v]))
    await as(pool, reporters[3], (c) => c.query(`insert into public.review_reports (visit_id, reporter_id, reason) values ($1, $2, 'spam')`, [v, reporters[3]]))
    expect((await pool.query(`select status from public.reviews where visit_id = $1`, [v])).rows[0].status).toBe('published')
  })

  it('private ratings never feed public community stats', async () => {
    const p = await createEstablishment(pool)
    const u = await createUser(pool, 'privaterater@example.com')
    const v = await saveVisit(pool, u, { establishment_id: p, scores: { drinks: 3, food: 9.5 }, tags: ['quiet'], visibility: 'private' })
    const s = await as(pool, null, (c) => c.query(`select * from public.establishment_stats where establishment_id = $1`, [p]).then((r) => r.rows[0]))
    expect(s).toMatchObject({ reviewers: 0, visit_count: 0, average: null, category_averages: {}, top_tags: [] })
    await saveVisit(pool, u, { id: v, establishment_id: p, scores: { drinks: 3, food: 9.5 }, visibility: 'public' })
    expect((await pool.query(`select reviewers from public.establishment_stats where establishment_id = $1`, [p])).rows[0].reviewers).toBe(1)
  })

  it('suspended users cannot edit their profile or preferences', async () => {
    const u = await createUser(pool, 'suspendme@example.com')
    await as(pool, admin, (c) => c.query(`select public.admin_set_suspended($1, true, 'spam')`, [u]))
    await rejects(as(pool, u, (c) => c.query(`update public.profiles set bio = 'still here' where id = $1`, [u])))
    await rejects(
      as(pool, u, (c) => c.query(`insert into public.user_preferences (user_id, weights) values ($1, $2)`, [u, { ambience: 1, drinks: 1, food: 1, value: 1, service: 1, overall: 1 }])),
    )
  })

  it('rate limits cannot be reset by deleting and re-inserting', async () => {
    const u = await createUser(pool, 'churn@example.com')
    const target = await createUser(pool, 'churntarget@example.com')
    let blocked = false
    for (let i = 0; i < 205 && !blocked; i++) {
      try {
        await as(pool, u, async (c) => {
          await c.query(`insert into public.follows (follower_id, followee_id) values ($1, $2)`, [u, target])
          await c.query(`delete from public.follows where follower_id = $1 and followee_id = $2`, [u, target])
        })
      } catch (e) {
        expect(String(e)).toMatch(/try again later/)
        blocked = true
      }
    }
    expect(blocked).toBe(true)
    // The event log itself is invisible to clients.
    await rejects(as(pool, u, (c) => c.query(`select * from public.rate_limit_events`)))
  })

  it('users cannot report or collect unpublished listings', async () => {
    const u = await createUser(pool, 'draftpoker@example.com')
    await rejects(as(pool, u, (c) => c.query(`insert into public.establishment_submissions (kind, establishment_id, user_id) values ('outdated', $1, $2)`, [draft, u])))
    const col = await as(pool, u, (c) => c.query(`insert into public.collections (user_id, name) values ($1, 'x') returning id`, [u]).then((r) => r.rows[0].id))
    await rejects(as(pool, u, (c) => c.query(`insert into public.collection_items (collection_id, establishment_id) values ($1, $2)`, [col, draft])))
    await rejects(as(pool, u, (c) => c.query(`update public.visit_tags set tag = 'quiet'`)))
  })
})
