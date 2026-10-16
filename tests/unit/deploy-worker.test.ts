/** The deploy script must ship a full Worker and keep server secrets out of the public app. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkConfig, collectSettings, findLeaks, parseJsonc } from '../../scripts/deploy-worker'

const tmp = mkdtempSync(join(tmpdir(), 'aour-deploy-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('wrangler.jsonc', () => {
  const cfg = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'))

  it('describes a full Worker: script entry, assets binding, /api routing and a Cron Trigger', () => {
    expect(checkConfig(cfg)).toEqual([])
    expect(cfg).toMatchObject({ name: 'aour', main: 'worker/index.ts', keep_vars: true, assets: { directory: './dist', binding: 'ASSETS', run_worker_first: ['/api/*'] } })
    expect((cfg.triggers as { crons: string[] }).crons).toEqual(['*/15 * * * *'])
  })

  it('flags an assets-only configuration', () => {
    const assetsOnly = { name: 'aour', assets: { directory: './dist', not_found_handling: 'single-page-application' } }
    const problems = checkConfig(assetsOnly)
    expect(problems.join('\n')).toMatch(/no "main".*assets-only/)
    expect(problems.join('\n')).toMatch(/Cron Trigger/)
  })

  it('parses comments without touching URLs inside strings', () => {
    expect(parseJsonc('{ // c\n "a": "https://x.example/*not a comment*/", /* b */ "b": [1,], }')).toEqual({ a: 'https://x.example/*not a comment*/', b: [1] })
  })
})

describe('runtime settings', () => {
  it('reuses the public build variables for the Worker and keeps the service-role key a secret', () => {
    const s = collectSettings({ VITE_SUPABASE_URL: 'https://abc.supabase.co/', VITE_SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret' })
    expect(s.vars).toEqual({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' })
    expect(s.secrets).toEqual({ SUPABASE_SERVICE_ROLE_KEY: 'service-secret' })
    expect(s.vars).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY')
    expect(s.problems).toEqual([])
  })

  it('refuses server secrets in VITE_ variables and an anon key posing as the service role', () => {
    expect(collectSettings({ VITE_SUPABASE_SERVICE_ROLE_KEY: 'x' }).problems.join()).toMatch(/must never be VITE_/)
    expect(collectSettings({ VITE_SUPABASE_ANON_KEY: 'same', SUPABASE_SERVICE_ROLE_KEY: 'same' }).problems.join()).toMatch(/equals the anon key/)
  })

  it('detects a secret compiled into the client files', () => {
    const dist = join(tmp, 'dist')
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'assets', 'app.js'), 'const k = "sb_secret_abcdefghijklmnop"')
    expect(findLeaks(dist, { SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abcdefghijklmnop' })[0]).toMatch(/SUPABASE_SERVICE_ROLE_KEY found in .*app\.js/)
    expect(findLeaks(dist, { SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_somethingelse123' })).toEqual([])
  })
})
