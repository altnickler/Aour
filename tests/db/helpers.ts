import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

const ROOT = join(import.meta.dirname, '..', '..')
export const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'

/**
 * Create a throwaway database, apply the Supabase shim + every migration in order,
 * and return a pool connected as the superuser (bypasses RLS — for fixtures only).
 */
export async function createTestDatabase(name: string): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query(`drop database if exists ${name} with (force)`)
  await admin.query(`create database ${name}`)
  await admin.end()

  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  await pool.query(readFileSync(join(ROOT, 'tests/db/supabase-shim.sql'), 'utf8'))
  const dir = join(ROOT, 'supabase/migrations')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(join(dir, file), 'utf8'))
  }

  return {
    pool,
    drop: async () => {
      await pool.end()
      const c = new pg.Client({ connectionString: ADMIN_URL })
      await c.connect()
      await c.query(`drop database if exists ${name} with (force)`)
      await c.end()
    },
  }
}

/**
 * Run `fn` exactly as PostgREST would for a request: role anon/authenticated and the
 * JWT claims set for the transaction. Commits on success, rolls back on error.
 */
export async function as<T>(pool: pg.Pool, userId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query(`set local role ${userId ? 'authenticated' : 'anon'}`)
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(userId ? { sub: userId, role: 'authenticated' } : { role: 'anon' }),
    ])
    const result = await fn(c)
    await c.query('commit')
    return result
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

export async function createUser(pool: pg.Pool, email: string, meta: Record<string, string> = {}): Promise<string> {
  const { rows } = await pool.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, meta])
  return rows[0].id
}

export async function makeAdmin(pool: pg.Pool, userId: string) {
  await pool.query(`update public.profiles set role = 'admin' where id = $1`, [userId])
}

export async function marketId(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query(`select id from public.markets where slug = 'treasure-coast'`)
  return rows[0].id
}

let n = 0
export async function createEstablishment(pool: pg.Pool, overrides: Partial<{ status: string; name: string }> = {}): Promise<string> {
  n++
  const { rows } = await pool.query(
    `insert into public.establishments (slug, name, market_id, city, address, lat, lng, status)
     values ($1, $2, $3, 'Stuart', '1 Test St', 27.19, -80.25, $4) returning id`,
    [`test-place-${n}-${Date.now()}`, overrides.name ?? `Test Place ${n}`, await marketId(pool), overrides.status ?? 'published'],
  )
  return rows[0].id
}

export async function saveVisit(pool: pg.Pool, userId: string, body: Record<string, unknown>): Promise<string> {
  return as(pool, userId, async (c) => {
    const { rows } = await c.query('select public.save_visit($1) as id', [body])
    return rows[0].id as string
  })
}

export async function stats(pool: pg.Pool, establishmentId: string) {
  const { rows } = await pool.query(`select * from public.establishment_stats where establishment_id = $1`, [establishmentId])
  return rows[0]
}

/** Run as the Supabase service role (what the Worker / CI pipeline uses). Bypasses RLS. */
export async function asService<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('set local role service_role')
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })])
    const result = await fn(c)
    await c.query('commit')
    return result
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}
