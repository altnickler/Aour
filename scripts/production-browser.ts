/**
 * Production check as an anonymous visitor (no service-role key anywhere in this script).
 *
 *   SITE_URL=https://aour.mute-frost-03a9.workers.dev npx tsx scripts/production-browser.ts
 *
 * 1. Calls the public API with the public anon key exactly as the web app does (same columns,
 *    embeds and filters) and prints HTTP status, row counts, real names and any error body.
 * 2. Opens the deployed site in Chromium with an iPhone 13 viewport, without location permission:
 *    welcome → Discover → Search for a real imported venue → reload. Then again with location
 *    shared at each launch town. Records every API response (status, error body), console errors,
 *    the visible text of each screen and a screenshot (saved to SHOT_DIR for the workflow artifact).
 *
 * Exits 1 when a visitor cannot see listings or find the searched venue (EXPECT_PASS=1).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, devices, type BrowserContext, type Page } from '@playwright/test'

const SITE = (process.env.SITE_URL || 'https://aour.mute-frost-03a9.workers.dev').replace(/\/+$/, '')
const SHOTS = process.env.SHOT_DIR || 'production-screenshots'
const SEARCH = process.env.SEARCH_NAME || 'Black Marlin'
const executablePath = process.env.CHROMIUM_PATH || undefined
mkdirSync(SHOTS, { recursive: true })

const TOWNS = [
  { name: 'Stuart', lat: 27.1975, lng: -80.2528 },
  { name: 'Palm City', lat: 27.1678, lng: -80.2662 },
  { name: 'Jensen Beach', lat: 27.2545, lng: -80.2298 },
  { name: 'Hobe Sound', lat: 27.0595, lng: -80.1364 },
]

// Must match src/data/supabase/supabaseApi.ts.
const EST_COLUMNS =
  'id, slug, name, kind, market_id, neighborhood, city, state, address, postal_code, lat, lng, timezone, phone, website, description, ' +
  'price_level, amenities, hh_status, hh_verified_at, hh_source_note, status, is_demo, created_at, updated_at, attribution, ' +
  'business_hours, hh_source_url, hh_last_confirmed_at, hh_restrictions'
const EST_SELECT = `${EST_COLUMNS}, happy_hour_windows(*), schedule_exceptions(*), happy_hour_specials(*), establishment_photos(*), establishment_stats(*)`

const failures: string[] = []
const out = (s = '') => console.log(s)

async function api() {
  out('## 1. Public API as the anonymous role')
  const v = (await (await fetch(`${SITE}/version.json`, { cache: 'no-store' })).json()) as { commit?: string; builtAt?: string; supabase?: { url: string; anonKey: string } | null }
  out(`- Deployed build: commit ${v.commit?.slice(0, 7)} built ${v.builtAt}`)
  if (!v.supabase) {
    failures.push('version.json has no Supabase settings (the app runs without a backend)')
    return null
  }
  const { url, anonKey } = v.supabase
  const headers: Record<string, string> = { apikey: anonKey, Accept: 'application/json', 'Content-Type': 'application/json' }
  if (anonKey.startsWith('eyJ')) headers.Authorization = `Bearer ${anonKey}`
  const call = async (label: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}/rest/v1/${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let rows: { name?: string }[] | null = null
    try {
      const j = JSON.parse(text)
      if (Array.isArray(j)) rows = j
    } catch {
      /* not JSON */
    }
    out(`- ${label}: HTTP ${res.status}${rows ? `, ${rows.length} rows${rows.length ? ` — ${rows.slice(0, 6).map((r) => r.name).join(' · ')}` : ''}` : `, body: ${text.slice(0, 400)}`}`)
    if (!res.ok) failures.push(`${label}: HTTP ${res.status} ${text.slice(0, 200)}`)
    return rows
  }
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const sel = encodeURIComponent(EST_SELECT.replace(/\s+/g, ''))
  await call('markets (app query)', 'markets?select=*&order=name')
  for (const t of TOWNS) {
    const rows = await call(
      `nearby ${t.name} 5 mi (exact app query)`,
      `rpc/nearby_establishments?select=${sel}&status=eq.published&schedule_exceptions.date=gte.${yesterday}`,
      { p_lat: t.lat, p_lng: t.lng, p_radius_m: Math.round(5 * 1609.34), p_limit: 300 },
    )
    if (rows && rows.length === 0) failures.push(`nearby ${t.name}: 0 rows`)
  }
  await call(`name search "${SEARCH}" (anon)`, `establishments?select=id,name,city,status,hh_status&name=ilike.*${encodeURIComponent(SEARCH)}*`)
  await call('search_establishments RPC (anon)', 'rpc/search_establishments?select=id,name,city,hh_status', { p_query: SEARCH, p_lat: null, p_lng: null, p_limit: 10 })
  return v
}

interface Log {
  responses: string[]
  errors: string[]
}

function watch(page: Page): Log {
  const log: Log = { responses: [], errors: [] }
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log.errors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`)
  })
  page.on('pageerror', (e) => log.errors.push(`page error: ${e.message.slice(0, 300)}`))
  page.on('requestfailed', (r) => log.errors.push(`request failed: ${r.method()} ${r.url().slice(0, 160)} — ${r.failure()?.errorText}`))
  page.on('response', async (r) => {
    const u = new URL(r.url())
    if (!/supabase\.co$/.test(u.hostname) && !u.pathname.startsWith('/api/')) return
    let detail = ''
    if (r.status() >= 400) detail = ` — ${(await r.text().catch(() => '')).slice(0, 300)}`
    else if (r.request().method() !== 'OPTIONS') {
      const body = await r.text().catch(() => '')
      try {
        const j = JSON.parse(body)
        if (Array.isArray(j)) detail = ` — ${j.length} rows`
      } catch {
        /* not JSON */
      }
    }
    log.responses.push(`${r.request().method()} ${u.pathname}${u.search.slice(0, 90)} → ${r.status()}${detail}`)
  })
  return log
}

async function snapshot(page: Page, log: Log, name: string) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const text = (await page.locator('main, body').first().innerText().catch(() => '')).replace(/\n{2,}/g, '\n').trim()
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
  out(`\n### ${name} — ${new URL(page.url()).pathname}`)
  out('Visible text:')
  out(text.slice(0, 1600).split('\n').map((l) => `    ${l}`).join('\n'))
  out('API responses:')
  out(log.responses.splice(0).map((l) => `    ${l}`).join('\n') || '    (none)')
  if (log.errors.length) out(`Errors:\n${log.errors.splice(0).map((l) => `    ${l}`).join('\n')}`)
  return text
}

async function newContext(geo?: { lat: number; lng: number }): Promise<BrowserContext> {
  const browser = await chromium.launch({ executablePath })
  return browser.newContext({
    ...devices['iPhone 13'],
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ...(geo ? { geolocation: { latitude: geo.lat, longitude: geo.lng }, permissions: ['geolocation'] } : {}),
  })
}

async function browser(expectCommit: string | undefined) {
  out('\n## 2. Deployed site in a browser (iPhone 13 viewport, signed out, no location)')
  const ctx = await newContext()
  const page = await ctx.newPage()
  const log = watch(page)
  await page.goto(SITE, { waitUntil: 'domcontentloaded' })
  const welcome = await snapshot(page, log, '01-first-visit')
  const sw = await page.evaluate(async () => (navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1))
  const bundle = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter(Boolean).join(', '))
  out(`Service workers registered: ${sw}; scripts: ${bundle}; expected build ${expectCommit?.slice(0, 7)}`)
  if (/show me happy hours/i.test(welcome)) {
    await page.getByRole('button', { name: /show me happy hours/i }).click()
  }
  const discover = await snapshot(page, log, '02-discover-no-location')
  if (!/mi\b|miles/i.test(discover) || /isn't in|No happy-hour details|0 places/i.test(discover)) {
    out('(check: Discover text above)')
  }

  await page.goto(`${SITE}/search`, { waitUntil: 'domcontentloaded' })
  const box = page.getByRole('searchbox').or(page.getByPlaceholder(/search/i)).first()
  await box.fill(SEARCH)
  const search = await snapshot(page, log, '03-search-no-location')
  if (!search.toLowerCase().includes(SEARCH.toLowerCase().split(' ')[0])) failures.push(`Search for "${SEARCH}" without location did not show it`)
  else if (!new RegExp(SEARCH, 'i').test(search.split('\n').slice(2).join('\n'))) failures.push(`Search for "${SEARCH}" shows only the query, not the venue`)

  await page.goto(SITE, { waitUntil: 'domcontentloaded' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  const reloaded = await snapshot(page, log, '04-discover-after-reload')
  if (/Aour isn't in|We don't have listings/i.test(reloaded)) failures.push('Discover after reload says there are no listings')
  await ctx.browser()?.close()

  out('\n## 3. With location shared, per launch town')
  for (const t of TOWNS) {
    const c = await newContext(t)
    const p = await c.newPage()
    const l = watch(p)
    await p.goto(SITE, { waitUntil: 'domcontentloaded' })
    await p.waitForTimeout(1000)
    const near = p.getByRole('button', { name: /use my location|near me|use your location/i }).first()
    if (await near.isVisible().catch(() => false)) await near.click()
    const start = p.getByRole('button', { name: /show me happy hours/i })
    if (await start.isVisible().catch(() => false)) await start.click()
    const text = await snapshot(p, l, `05-${t.name.toLowerCase().replace(/\s+/g, '-')}-located`)
    if (/Aour isn't in|We don't have listings/i.test(text)) failures.push(`${t.name}: Discover says no listings`)
    await c.browser()?.close()
  }
}

const v = await api()
await browser(v?.commit)
writeFileSync(join(SHOTS, 'README.txt'), `Screenshots of ${SITE} taken ${new Date().toISOString()} (iPhone 13 viewport).\n`)
out(`\n## Result\n${failures.length ? failures.map((f) => `- ❌ ${f}`).join('\n') : '- ✅ No failures detected'}`)
if (failures.length && process.env.EXPECT_PASS === '1') process.exit(1)
