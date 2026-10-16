/**
 * READ-ONLY production status report. Never writes to the database and never prints keys.
 *
 *   SITE_URL=https://aour.mute-frost-03a9.workers.dev [SUPABASE_SERVICE_ROLE_KEY=…] npx tsx scripts/production-status.ts
 *
 * 1. Reads the deployed build (/version.json) and Worker health (/api/health).
 * 2. With the public anon key (from /version.json): checks which database migrations are
 *    present (by probing the columns/functions each one adds) and counts what the public sees
 *    near Stuart, FL through the same nearby query the app uses.
 * 3. With the service-role key (GitHub secret, optional): pipeline jobs, budgets, imported venues,
 *    happy-hour findings and fetch outcomes.
 * Writes Markdown to $GITHUB_STEP_SUMMARY when run in GitHub Actions. Exits 1 if migrations are missing.
 */
import { appendFileSync } from 'node:fs'

const SITE = (process.env.SITE_URL || 'https://aour.mute-frost-03a9.workers.dev').replace(/\/+$/, '')
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const TOWNS: Record<string, { lat: number; lng: number }> = {
  Stuart: { lat: 27.1975, lng: -80.2528 },
  'Palm City': { lat: 27.1678, lng: -80.2662 },
  'Jensen Beach': { lat: 27.2545, lng: -80.2298 },
  'Hobe Sound': { lat: 27.0595, lng: -80.1364 },
}

const lines: string[] = []
const out = (s = '') => {
  lines.push(s)
  console.log(s)
}
let failed = false

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  return { status: res.status, body }
}

function headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: key, Accept: 'application/json', ...extra }
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`
  return h
}

function tally<T>(rows: T[], key: (r: T) => string): string {
  const m = new Map<string, number>()
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(', ') || 'none'
}

async function main() {
  out('# Aour production status')
  out(`_Read-only check of ${SITE} at ${new Date().toISOString()}_`)
  out()

  // 1. Deployed build and Worker ----------------------------------------------------------
  // After a push, wait (up to 10 min) for Cloudflare to finish deploying that commit.
  const expect = process.env.EXPECT_COMMIT
  let version = await getJson(`${SITE}/version.json`).catch((e) => ({ status: 0, body: String(e) }))
  for (let i = 0; expect && i < 20 && (version.body as { commit?: string })?.commit !== expect; i++) {
    await new Promise((r) => setTimeout(r, 30_000))
    version = await getJson(`${SITE}/version.json`).catch((e) => ({ status: 0, body: String(e) }))
  }
  const v = version.body as { commit?: string; branch?: string; backend?: string; builtAt?: string; supabase?: { url: string; anonKey: string } | null }
  const health = await getJson(`${SITE}/api/health`).catch((e) => ({ status: 0, body: String(e) }))
  const h = health.body as { pipeline?: boolean; missing?: string[]; ai?: boolean }
  out('## Deployment')
  out(`- Build: commit \`${v?.commit?.slice(0, 7) ?? '?'}\` on \`${v?.branch ?? '?'}\`, built ${v?.builtAt ?? '?'}, backend **${v?.backend ?? 'unknown'}**`)
  out(`- Worker health: HTTP ${health.status}, pipeline **${h?.pipeline}**, missing settings: ${JSON.stringify(h?.missing ?? '?')}`)

  const url = (process.env.SUPABASE_URL || v?.supabase?.url || '').replace(/\/+$/, '')
  const anon = process.env.SUPABASE_ANON_KEY || v?.supabase?.anonKey || ''
  if (!url || !anon) {
    out('- ❌ Could not find the public Supabase settings (version.json has no `supabase` block yet — redeploy the latest commit).')
    failed = true
    return
  }
  out(`- Database project: \`${new URL(url).hostname.split('.')[0]}\``)
  out()

  // 2. Migrations (anon probes) -------------------------------------------------------------
  const rest = (path: string, key: string, init?: RequestInit) => getJson(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers(key), ...(init?.headers as Record<string, string>) } })
  const probe = async (label: string, path: string, init?: RequestInit, expectDenied = false) => {
    const r = await rest(path, anon, init)
    const code = (r.body as { code?: string })?.code
    const ok = expectDenied ? r.status >= 400 && (code === '42501' || /permission/i.test(JSON.stringify(r.body))) : r.status < 300
    out(`| ${label} | ${ok ? '✅ applied' : '❌ missing'} |`)
    if (!ok) failed = true
    return r
  }
  out('## Database migrations (detected by the features each one adds)')
  out('| Migration | Status |')
  out('|---|---|')
  await probe('2026-10-15 core schema, RLS, rating engine', 'rating_categories?select=key&limit=1')
  await probe('2026-10-15 storage, admin & social helpers', 'rpc/featured_collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  await probe('2026-10-16 discovery (PostGIS, pipeline, markets)', 'markets?select=radius_miles,discovery_enabled,next_discovery_at&limit=1')
  await probe('2026-10-17 discovery catch-up (privacy + venue-import fixes)', 'establishments?select=hh_confidence&limit=1', undefined, true)
  await probe('2026-10-17 automatic areas', 'markets?select=auto_created&limit=1')
  out()

  // 3. Markets and what the public sees -------------------------------------------------------
  const markets = await rest('markets?select=slug,name,lat,lng,timezone,areas,radius_miles,discovery_enabled,last_discovered_at,next_discovery_at,is_active&order=name', anon)
  out('## Markets')
  if (Array.isArray(markets.body)) {
    for (const m of markets.body as Record<string, unknown>[]) {
      out(`- **${m.name}** (\`${m.slug}\`), centre ${m.lat}, ${m.lng}, radius ${m.radius_miles ?? '?'} mi, ${m.timezone}, discovery ${m.discovery_enabled ? 'on' : 'off'}, last discovered ${m.last_discovered_at ?? 'never'}, next ${m.next_discovery_at ?? 'due now'}`)
      if (Array.isArray(m.areas)) out(`  - areas: ${(m.areas as string[]).join(', ')}`)
    }
    if (!(markets.body as unknown[]).length) out('- ❌ No markets exist.')
  } else out(`- ❌ Could not read markets: ${JSON.stringify(markets.body).slice(0, 200)}`)
  out()

  out('## What users see (public nearby query, same as the app)')
  for (const [town, c] of Object.entries(TOWNS)) {
    const r = await rest('rpc/nearby_establishments?select=id,name,hh_status,city', anon, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_lat: c.lat, p_lng: c.lng, p_radius_m: 8047, p_limit: 500 }),
    })
    if (!Array.isArray(r.body)) {
      out(`- ${town}: ❌ query failed (${JSON.stringify(r.body).slice(0, 160)})`)
      failed = true
      continue
    }
    const rows = r.body as { name: string; hh_status: string }[]
    const withHh = rows.filter((x) => x.hh_status !== 'none')
    out(`- **${town}** (5 mi): ${rows.length} published places; with happy-hour info: ${withHh.length} (${tally(withHh, (x) => x.hh_status)})`)
    if (rows.length) out(`  - nearest: ${rows.slice(0, 5).map((x) => x.name).join(' · ')}`)
  }
  out()

  if (!SERVICE) {
    out('## Pipeline internals')
    out('- ⚠️ Not checked: the `SUPABASE_SERVICE_ROLE_KEY` secret is not available to this workflow (GitHub → Settings → Environments → production).')
    return
  }

  // 4. Pipeline internals (service role, read-only selects) -------------------------------------
  const svc = (path: string) => rest(path, SERVICE)
  const all = async <T>(path: string): Promise<T[]> => {
    const r = await svc(path)
    if (!Array.isArray(r.body)) throw new Error(`${path.split('?')[0]}: ${JSON.stringify(r.body).slice(0, 200)}`)
    return r.body as T[]
  }
  out('## Pipeline internals (service role, read-only)')
  try {
    const est = await all<{ status: string; origin: string; hh_status: string; website: string | null; market_id: string }>('establishments?select=status,origin,hh_status,website,market_id&limit=10000')
    out(`- Establishments: ${est.length} total — status: ${tally(est, (e) => e.status)}; origin: ${tally(est, (e) => e.origin)}`)
    out(`- Happy-hour status: ${tally(est, (e) => e.hh_status)}`)
    out(`- With a website to check: ${est.filter((e) => e.website).length}`)
    const ids = await all<{ provider: string }>('establishment_external_ids?select=provider&limit=10000')
    out(`- Provider links: ${tally(ids, (x) => x.provider)}`)
    const jobs = await all<{ kind: string; status: string; attempts: number; last_error: string | null; created_at: string; finished_at: string | null; result: Record<string, unknown> | null }>(
      'refresh_jobs?select=kind,status,attempts,last_error,created_at,finished_at,result&order=created_at.desc&limit=200',
    )
    out(`- Jobs (latest 200): ${tally(jobs, (j) => `${j.kind}/${j.status}`)}`)
    for (const j of jobs.filter((x) => x.kind === 'discover_market').slice(0, 3)) {
      const r = j.result as { created?: number; updated?: number; createdForReview?: number; sources?: unknown } | null
      out(`  - discovery ${j.status} at ${j.finished_at ?? j.created_at}: created ${r?.created ?? '-'}, for review ${r?.createdForReview ?? '-'}, updated ${r?.updated ?? '-'}, sources ${JSON.stringify(r?.sources ?? null)}${j.last_error ? `, error: ${j.last_error}` : ''}`)
    }
    const errors = jobs.filter((j) => j.last_error).slice(0, 5)
    for (const j of errors) out(`  - ⚠️ ${j.kind} ${j.status}: ${j.last_error}`)
    const findings = await all<{ status: string; method: string; source_kind: string }>('hh_findings?select=status,method,source_kind&limit=10000')
    out(`- Happy-hour findings: ${findings.length} — ${tally(findings, (f) => `${f.source_kind}/${f.method}/${f.status}`)}`)
    const docs = await all<{ outcome: string | null }>('source_documents?select=outcome&limit=10000')
    out(`- Website pages checked: ${docs.length} — ${tally(docs, (d) => d.outcome ?? 'pending')}`)
    const limits = await all<{ provider: string; monthly_limit: number; enabled: boolean }>('provider_limits?select=provider,monthly_limit,enabled&order=provider')
    const period = new Date().toISOString().slice(0, 7)
    const usage = await all<{ provider: string; used: number }>(`provider_usage?select=provider,used&period=eq.${period}`)
    out(`- Budgets ${period}: ${limits.map((l) => `${l.provider} ${usage.find((u) => u.provider === l.provider)?.used ?? 0}/${l.monthly_limit}${l.enabled ? '' : ' (off)'}`).join(', ')}`)
  } catch (e) {
    out(`- ❌ ${(e as Error).message}`)
    failed = true
  }
}

main()
  .catch((e) => {
    out(`❌ Status check crashed: ${(e as Error).message}`)
    failed = true
  })
  .finally(() => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
    process.exit(failed ? 1 : 0)
  })
