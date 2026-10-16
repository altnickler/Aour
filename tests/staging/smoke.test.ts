/**
 * Read-only smoke test of a DEPLOYED site (safe against production: GET requests only, and
 * no call that spends a provider budget).
 *
 *   SITE_URL=https://aour.app npm run test:smoke
 */
import { describe, expect, it } from 'vitest'

const SITE = process.env.SITE_URL?.replace(/\/+$/, '')

describe.skipIf(!SITE)(`deployed site ${SITE ?? '(SITE_URL not set)'}`, () => {
  const get = (path: string, init?: RequestInit) => fetch(`${SITE}${path}`, { redirect: 'manual', ...init })

  it('serves the app shell with security headers', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toMatch(/default-src 'self'/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const html = await res.text()
    expect(html).toContain('<div id="root">')
    expect(html).not.toMatch(/service_role|sb_secret_|SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('falls back to the SPA for client routes', async () => {
    const res = await get('/place/does-not-exist', { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
  })

  it('ships a valid PWA manifest and service worker', async () => {
    const m = await (await get('/manifest.webmanifest')).json()
    expect(m.name).toMatch(/Aour/)
    expect(m.display).toBe('standalone')
    expect((await get('/sw.js')).status).toBe(200)
  })

  it('reports Worker health without leaking configuration', async () => {
    const res = await get('/api/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Object.keys(body).sort()).toEqual(['ai', 'ok', 'pipeline', 'time'])
  })

  it('validates geocoding input before spending anything', async () => {
    expect((await get('/api/geocode?q=a')).status).toBe(400)
    expect((await get('/api/admin/run', { method: 'POST' })).status).toBeGreaterThanOrEqual(401)
    expect((await get('/api/nope')).status).toBe(404)
  })

  it('does not bundle server secrets into client JavaScript', async () => {
    const html = await (await get('/')).text()
    const scripts = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) {
      const js = await (await get(s)).text()
      expect(js).not.toMatch(/sb_secret_[A-Za-z0-9]/)
      expect(js).not.toMatch(/"role":"service_role"/)
    }
  })
})
