/**
 * Rating integrity: input validation, server-maintained aggregates, and exact parity
 * between the SQL implementation and the canonical TypeScript engine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { as, createEstablishment, createTestDatabase, createUser, saveVisit, stats } from './helpers'
import { communityStats, visitComposite, type Weights } from '@/core/rating'
import { ALL_CATEGORIES, PRIMARY_CATEGORY_KEYS, TAGS } from '@/core/categories'

let pool: pg.Pool
let drop: () => Promise<void>
let user: string
let place: string

beforeAll(async () => {
  ;({ pool, drop } = await createTestDatabase('aour_test_rating'))
  user = await createUser(pool, 'rater@example.com')
  place = await createEstablishment(pool)
})
afterAll(async () => drop?.())

describe('reference data parity', () => {
  it('rating_categories table matches src/core/categories.ts', async () => {
    const { rows } = await pool.query(`select key, label, description, group_key, default_weight, sort_order from public.rating_categories order by sort_order`)
    expect(rows).toEqual(
      [...ALL_CATEGORIES].sort((a, b) => a.sortOrder - b.sortOrder).map((c) => ({
        key: c.key, label: c.label, description: c.description, group_key: c.group, default_weight: c.defaultWeight, sort_order: c.sortOrder,
      })),
    )
  })

  it('tags table matches src/core/categories.ts', async () => {
    const { rows } = await pool.query(`select key, label, emoji from public.tags order by key`)
    expect(rows).toEqual([...TAGS].sort((a, b) => (a.key < b.key ? -1 : 1)))
  })
})

describe('save_visit validation', () => {
  it('rejects out-of-range and off-step scores', async () => {
    await expect(saveVisit(pool, user, { establishment_id: place, scores: { drinks: 11 } })).rejects.toThrow(/check constraint/)
    await expect(saveVisit(pool, user, { establishment_id: place, scores: { drinks: 0.5 } })).rejects.toThrow(/check constraint/)
    await expect(saveVisit(pool, user, { establishment_id: place, scores: { drinks: 7.3 } })).rejects.toThrow(/check constraint|numeric/)
  })

  it('requires at least one primary score (N/A everywhere is not a rating)', async () => {
    await expect(saveVisit(pool, user, { establishment_id: place, scores: { drinks: null, food: null } })).rejects.toThrow(/main categories/)
    await expect(saveVisit(pool, user, { establishment_id: place, scores: { cocktail_quality: 9 } })).rejects.toThrow(/main categories/)
  })

  it('rejects unknown categories and tags', async () => {
    await expect(saveVisit(pool, user, { establishment_id: place, scores: { drinks: 8, vibes: 9 } })).rejects.toThrow(/foreign key/)
    await expect(saveVisit(pool, user, { establishment_id: place, scores: { drinks: 8 }, tags: ['not-a-tag'] })).rejects.toThrow(/foreign key/)
  })

  it('rejects future visit dates and too many photos', async () => {
    await expect(saveVisit(pool, user, { establishment_id: place, scores: { drinks: 8 }, visited_on: '2099-01-01' })).rejects.toThrow(/check constraint/)
    const paths = [1, 2, 3, 4, 5].map((i) => `${user}/${i}.jpg`)
    await expect(saveVisit(pool, user, { establishment_id: place, scores: { drinks: 8 }, photo_paths: paths })).rejects.toThrow(/Up to 4/)
  })

  it('edits review and private note in place (upsert under column grants)', async () => {
    const id = await saveVisit(pool, user, { establishment_id: place, scores: { drinks: 8 }, review: 'First take', note: 'secret 1' })
    await saveVisit(pool, user, { id, establishment_id: place, scores: { drinks: 9 }, review: 'Second take', note: 'secret 2' })
    const r = await pool.query(`select (select body from public.reviews where visit_id = $1) as review, (select body from public.visit_notes where visit_id = $1) as note`, [id])
    expect(r.rows[0]).toEqual({ review: 'Second take', note: 'secret 2' })
    await saveVisit(pool, user, { id, establishment_id: place, scores: { drinks: 9 }, review: '', note: '' })
    const cleared = await pool.query(`select (select count(*)::int from public.reviews where visit_id = $1) as r, (select count(*)::int from public.visit_notes where visit_id = $1) as n`, [id])
    expect(cleared.rows[0]).toEqual({ r: 0, n: 0 })
    await as(pool, user, (c) => c.query(`delete from public.visits where id = $1`, [id]))
  })

  it('stores N/A as null and keeps detailed metrics', async () => {
    const id = await saveVisit(pool, user, { establishment_id: place, mode: 'detailed', scores: { drinks: 8.5, food: null, cocktail_quality: 9 } })
    const { rows } = await pool.query(`select category_key, score from public.rating_scores where visit_id = $1 order by category_key`, [id])
    expect(rows).toEqual([
      { category_key: 'cocktail_quality', score: '9.0' },
      { category_key: 'drinks', score: '8.5' },
      { category_key: 'food', score: null },
    ])
    await as(pool, user, (c) => c.query(`delete from public.visits where id = $1`, [id]))
  })
})

describe('user preferences', () => {
  it('validates custom weights', async () => {
    const ok = { ambience: 5, drinks: 40, food: 5, value: 40, service: 5, overall: 5 }
    await as(pool, user, (c) => c.query(`insert into public.user_preferences (user_id, weights) values ($1, $2)`, [user, ok]))
    for (const bad of [{ ...ok, drinks: -1 }, { ...ok, drinks: 2.5 }, { ...ok, drinks: 'x' }, { drinks: 50 }, { ambience: 0, drinks: 0, food: 0, value: 0, service: 0, overall: 0 }]) {
      await expect(as(pool, user, (c) => c.query(`update public.user_preferences set weights = $2 where user_id = $1`, [user, bad]))).rejects.toThrow(/weights_valid/)
    }
  })
})

describe('community stats maintenance', () => {
  it('updates on insert, edit and delete, and averages per reviewer', async () => {
    const p = await createEstablishment(pool)
    const u2 = await createUser(pool, 'second@example.com')
    const v1 = await saveVisit(pool, user, { establishment_id: p, scores: { overall: 10 }, tags: ['rooftop'] })
    await saveVisit(pool, user, { establishment_id: p, scores: { overall: 10 } })
    await saveVisit(pool, u2, { establishment_id: p, scores: { overall: 4 }, tags: ['rooftop', 'lively'] })
    let s = await stats(pool, p)
    expect(s.average).toBe('7.00')
    expect(s.reviewers).toBe(2)
    expect(s.visit_count).toBe(3)
    expect(s.top_tags).toEqual([{ key: 'rooftop', count: 2 }, { key: 'lively', count: 1 }])

    await saveVisit(pool, user, { id: v1, establishment_id: p, scores: { overall: 6 } })
    s = await stats(pool, p)
    expect(s.average).toBe('6.00') // user mean (6+10)/2=8, u2 4 → 6

    await as(pool, u2, (c) => c.query(`delete from public.visits where user_id = $1`, [u2]))
    s = await stats(pool, p)
    expect(s.average).toBe('8.00')
    expect(s.reviewers).toBe(1)
  })

  it('respects contribute_to_community and admin exclusion', async () => {
    const p = await createEstablishment(pool)
    const u3 = await createUser(pool, 'quiet@example.com')
    const v = await saveVisit(pool, u3, { establishment_id: p, scores: { overall: 9 } })
    expect((await stats(pool, p)).reviewers).toBe(1)
    await as(pool, u3, (c) => c.query(`update public.profiles set contribute_to_community = false where id = $1`, [u3]))
    expect((await stats(pool, p)).reviewers).toBe(0)
    await as(pool, u3, (c) => c.query(`update public.profiles set contribute_to_community = true where id = $1`, [u3]))
    await pool.query(`update public.visits set excluded_from_community = true where id = $1`, [v])
    expect((await stats(pool, p)).reviewers).toBe(0)
  })
})

// Deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

describe('SQL ↔ TypeScript parity', () => {
  const rand = rng(42)
  const randomScores = () => {
    const s: Record<string, number | null> = {}
    for (const k of PRIMARY_CATEGORY_KEYS) {
      const r = rand()
      if (r < 0.15) s[k] = null
      else if (r < 0.25) continue
      else s[k] = 1 + Math.floor(rand() * 19) / 2
    }
    if (Object.values(s).every((v) => v === null || v === undefined)) s.overall = 7.5
    return s
  }

  it('aour_composite matches visitComposite for random scores and weights', async () => {
    for (let i = 0; i < 300; i++) {
      const scores = randomScores()
      const weights = Object.fromEntries(PRIMARY_CATEGORY_KEYS.map((k) => [k, Math.floor(rand() * 101)])) as Weights
      if (Object.values(weights).every((w) => w === 0)) weights.overall = 1
      const { rows } = await pool.query(`select public.aour_composite($1) as d, public.aour_composite($1, $2) as w`, [scores, weights])
      const sqlDefault = rows[0].d === null ? null : Number(rows[0].d)
      const sqlWeighted = rows[0].w === null ? null : Number(rows[0].w)
      expect(sqlDefault, JSON.stringify(scores)).toBe(visitComposite(scores))
      expect(sqlWeighted, JSON.stringify({ scores, weights })).toBe(visitComposite(scores, weights))
    }
  })

  it('establishment_stats matches communityStats for random visit sets', async () => {
    const users = await Promise.all([1, 2, 3, 4, 5].map((i) => createUser(pool, `parity${i}@example.com`)))
    const tagKeys = TAGS.map((t) => t.key)
    for (let round = 0; round < 6; round++) {
      const p = await createEstablishment(pool)
      const visits: { userId: string; scores: Record<string, number | null>; tags: string[] }[] = []
      const count = 1 + Math.floor(rand() * 9)
      for (let i = 0; i < count; i++) {
        const userId = users[Math.floor(rand() * users.length)]
        const scores = randomScores()
        const tags = tagKeys.filter(() => rand() < 0.15)
        visits.push({ userId, scores, tags })
        await saveVisit(pool, userId, { establishment_id: p, scores, tags })
      }
      const s = await stats(pool, p)
      const ts = communityStats(visits)
      expect(s.average === null ? null : Number(s.average)).toBe(ts.average)
      expect(s.reviewers).toBe(ts.reviewers)
      expect(s.visit_count).toBe(ts.visits)
      expect(s.distribution).toEqual(ts.distribution)
      expect(s.top_tags).toEqual(ts.topTags)
      expect(Object.fromEntries(Object.entries(s.category_averages).map(([k, v]) => [k, Number(v)]))).toEqual(ts.categoryAverages)
    }
  })
})
