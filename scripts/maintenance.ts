/**
 * Data maintenance tasks for the discovery pipeline (run by .github/workflows/maintenance.yml).
 *
 *   npx tsx scripts/maintenance.ts diagnose       # READ-ONLY: Overture category breakdown for a market
 *   npx tsx scripts/maintenance.ts reclassify     # DRY RUN: what the strict classifier would change
 *   npx tsx scripts/maintenance.ts reclassify --apply
 *   npx tsx scripts/maintenance.ts robots         # READ-ONLY: venue domains robots.txt keeps us out of, and why
 *   npx tsx scripts/maintenance.ts robots --probe # …plus one request per problem domain to show the real error
 *
 * reclassify re-reads the market from Overture with the current classifier and, for imported
 * listings it no longer accepts, sets status = 'archived' (reversible; nothing is deleted) — only
 * when no person has touched them: origin 'import', automation-managed, no locked fields, no
 * ratings, saves, collection entries, happy-hour windows or findings. Accepted listings get their
 * venue type corrected unless an admin locked it. Every change is logged in listing_changes.
 * Never prints credentials.
 */
import { bboxAround, overtureToCandidate, type OvertureRow } from '../src/core/ingest/providers'
import { openOverture, overtureSql, primaryCategoryExpr } from '../src/pipeline/providers/overture'
import { isAllowed, robotsFromResponse } from '../src/core/ingest/robots'
import { USER_AGENT } from '../src/pipeline/fetcher'

const task = process.argv[2] ?? 'diagnose'
const MARKET = { lat: Number(process.env.MARKET_LAT ?? 27.1975), lng: Number(process.env.MARKET_LNG ?? -80.2528), radiusMiles: Number(process.env.MARKET_RADIUS ?? 15) }

async function diagnose() {
  const rel = await openOverture({ release: process.env.OVERTURE_RELEASE || undefined, path: process.env.OVERTURE_PATH || undefined })
  try {
    console.log(`Release path: ${rel.path}`)
    console.log('Columns:')
    for (const [k, v] of rel.cols) console.log(`  ${k}: ${v.length > 160 ? `${v.slice(0, 160)}…` : v}`)
    const b = bboxAround(MARKET.lat, MARKET.lng, MARKET.radiusMiles)
    const primary = primaryCategoryExpr(rel.cols)
    const basic = rel.cols.has('basic_category') ? 'basic_category' : "'-'"
    const conf = rel.cols.has('confidence') ? 'coalesce(confidence, 0)' : '1'
    const where = `bbox.xmin BETWEEN $west AND $east AND bbox.ymin BETWEEN $south AND $north AND ${conf} >= 0.5`
    const params = { path: rel.path, west: b.west, east: b.east, south: b.south, north: b.north }
    const total = await rel.conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet($path, hive_partitioning = true) WHERE ${where}`, params)
    console.log(`\nPlaces in the ${MARKET.radiusMiles} mi box (confidence ≥ 0.5): ${String(total.getRowObjectsJS()[0].n)}`)
    const hist = await rel.conn.runAndReadAll(
      `SELECT coalesce(${basic}, '-') AS basic, coalesce(${primary}, '-') AS primary_category, count(*) AS n
       FROM read_parquet($path, hive_partitioning = true) WHERE ${where}
       GROUP BY 1, 2 ORDER BY n DESC LIMIT 400`,
      params,
    )
    console.log('\nbasic_category | primary category | count')
    for (const r of hist.getRowObjectsJS()) console.log(`${r.basic} | ${r.primary_category} | ${String(r.n)}`)
    const samples = await rel.conn.runAndReadAll(
      `SELECT names.primary AS name, coalesce(${basic}, '-') AS basic, coalesce(${primary}, '-') AS primary_category
       FROM read_parquet($path, hive_partitioning = true)
       WHERE ${where} AND lower(names.primary) SIMILAR TO '.*(podiatr|claim|insurance|liquor|smoothie|sub shop|firefly|blue door).*'
       LIMIT 40`,
      params,
    )
    console.log('\nSamples of non-venues seen in the first import:')
    for (const r of samples.getRowObjectsJS()) console.log(`  ${r.name} | ${r.basic} | ${r.primary_category}`)
  } finally {
    rel.close()
  }
}

// ---------------------------------------------------------------------------
// Supabase REST (service role) — used only by maintenance tasks.
// ---------------------------------------------------------------------------
async function supabase() {
  let url = process.env.SUPABASE_URL
  if (!url && process.env.SITE_URL) {
    const v = (await (await fetch(`${process.env.SITE_URL.replace(/\/+$/, '')}/version.json`)).json()) as { supabase?: { url?: string } | null }
    url = v.supabase?.url
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL (or SITE_URL) and SUPABASE_SERVICE_ROLE_KEY are required')
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' }
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`
  const base = `${url.replace(/\/+$/, '')}/rest/v1`
  const req = async (method: string, path: string, body?: unknown, prefer?: string) => {
    const res = await fetch(`${base}/${path}`, { method, headers: prefer ? { ...headers, Prefer: prefer } : headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} failed: HTTP ${res.status} ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }
  /** GET every row (the API caps responses at 1,000). */
  const all = async <T>(path: string): Promise<T[]> => {
    const rows: T[] = []
    for (let offset = 0; ; offset += 1000) {
      const page = (await req('GET', `${path}${path.includes('?') ? '&' : '?'}limit=1000&offset=${offset}`)) as T[]
      rows.push(...page)
      if (page.length < 1000) return rows
    }
  }
  return { req, all }
}

async function reclassify() {
  const apply = process.argv.includes('--apply')
  const db = await supabase()
  const [market] = (await db.req('GET', `markets?select=id,name,lat,lng,radius_miles&slug=eq.${process.env.MARKET_SLUG ?? 'treasure-coast'}`)) as { id: string; name: string; lat: number; lng: number; radius_miles: number }[]
  if (!market) throw new Error('market not found')

  // 1. What the current classifier accepts from Overture for this market.
  const rel = await openOverture({ release: process.env.OVERTURE_RELEASE || undefined })
  const accepted = new Map<string, { kind: string; closed: boolean }>()
  try {
    const b = bboxAround(Number(market.lat), Number(market.lng), Number(market.radius_miles))
    const rows = await rel.conn.runAndReadAll(overtureSql(rel.cols), { path: rel.path, west: b.west, east: b.east, south: b.south, north: b.north })
    for (const r of rows.getRowObjectsJS()) {
      const c = overtureToCandidate({
        id: String(r.id), name: (r.name as string) ?? null, basic_category: (r.basic_category as string) ?? null, primary_category: (r.primary_category as string) ?? null,
        categories: Array.isArray(r.categories) ? (r.categories as string[]) : [], lat: Number(r.lat), lng: Number(r.lng),
        confidence: r.confidence == null ? null : Number(r.confidence), operating_status: (r.operating_status as string) ?? null,
      } as OvertureRow)
      if (c) accepted.set(c.externalId, { kind: c.kind, closed: c.closed })
    }
  } finally {
    rel.close()
  }
  console.log(`Overture places accepted by the current classifier in ${market.name}: ${accepted.size}`)
  if (accepted.size < 50) throw new Error(`Only ${accepted.size} accepted places: refusing to reclassify (looks like a bad Overture read)`)

  // 2. Imported listings in this market and their Overture ids.
  type Est = { id: string; name: string; kind: string; status: string; origin: string; hh_managed_by: string; locked_fields: string[] }
  const est = await db.all<Est>(`establishments?select=id,name,kind,status,origin,hh_managed_by,locked_fields&market_id=eq.${market.id}&origin=eq.import&status=neq.archived&order=id`)
  const links = await db.all<{ establishment_id: string; external_id: string }>('establishment_external_ids?select=establishment_id,external_id&provider=eq.overture&order=external_id')
  const ovtIds = new Map<string, string[]>()
  for (const l of links) ovtIds.set(l.establishment_id, [...(ovtIds.get(l.establishment_id) ?? []), l.external_id])

  // 3. Anything a person (or the venue's own website) has touched is protected.
  const touched = new Set<string>()
  for (const [table, col] of [['visits', 'establishment_id'], ['saved_places', 'establishment_id'], ['collection_items', 'establishment_id'], ['happy_hour_windows', 'establishment_id'], ['hh_findings', 'establishment_id']]) {
    for (const r of await db.all<Record<string, string>>(`${table}?select=${col}&order=${col}`)) touched.add(r[col])
  }

  const archive: Est[] = []
  const retype: { e: Est; kind: string }[] = []
  let protectedCount = 0
  for (const e of est) {
    const ids = ovtIds.get(e.id) ?? []
    if (!ids.length) continue
    const hit = ids.map((id) => accepted.get(id)).find(Boolean)
    if (hit && !hit.closed) {
      if (hit.kind !== e.kind && !(e.locked_fields ?? []).includes('kind')) retype.push({ e, kind: hit.kind })
      continue
    }
    const safe = e.hh_managed_by === 'auto' && !(e.locked_fields ?? []).length && !touched.has(e.id)
    if (safe) archive.push(e)
    else protectedCount++
  }
  console.log(`Imported listings checked: ${est.length}`)
  console.log(`Would archive (not a bar/restaurant per Overture, untouched): ${archive.length}`)
  console.log(`Kept because a person or website data touched them: ${protectedCount}`)
  console.log(`Venue type corrections: ${retype.length}`)
  console.log(`Remaining public listings after cleanup: ${est.length - archive.length}`)
  console.log('Examples to archive: ' + archive.slice(0, 40).map((e) => e.name).join(' · '))
  console.log('Examples kept: ' + est.filter((e) => !archive.includes(e)).slice(0, 40).map((e) => e.name).join(' · '))
  if (!apply) {
    console.log('\nDRY RUN — nothing was changed. Re-run with --apply to archive.')
    return
  }

  // 4. Apply in batches; log every change.
  for (let i = 0; i < archive.length; i += 100) {
    const batch = archive.slice(i, i + 100)
    const ids = batch.map((e) => e.id).join(',')
    await db.req('PATCH', `establishments?id=in.(${ids})&origin=eq.import&hh_managed_by=eq.auto`, { status: 'archived' }, 'return=minimal')
    await db.req('PATCH', `refresh_jobs?target_id=in.(${ids})&status=eq.queued`, { status: 'skipped', last_error: 'listing archived by reclassification' }, 'return=minimal')
    await db.req('POST', 'listing_changes', batch.map((e) => ({ establishment_id: e.id, actor: 'pipeline', summary: 'Archived automatically: Overture does not classify this place as a bar or restaurant (reversible)' })), 'return=minimal')
  }
  for (const { e, kind } of retype) {
    await db.req('PATCH', `establishments?id=eq.${e.id}`, { kind }, 'return=minimal')
  }
  console.log(`\nApplied: archived ${archive.length}, corrected type of ${retype.length}.`)
}

/** Read-only: which venue domains our robots.txt reading blocks, and the rule responsible. */
async function robots() {
  const db = await supabase()
  const rows = await db.all<{ domain: string; robots_status: number | null; robots_txt: string | null; blocked: boolean; blocked_reason: string | null }>(
    'source_domains?select=domain,robots_status,robots_txt,blocked,blocked_reason&order=domain',
  )
  const tally = new Map<string, number>()
  const add = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1)
  console.log(`${rows.length} domains checked\n`)
  for (const r of rows) {
    if (r.blocked) {
      add(`sticky block: ${r.blocked_reason}`)
      console.log(`BLOCKED  ${r.domain}: ${r.blocked_reason}`)
      continue
    }
    if (r.robots_status === null) continue
    const rules = robotsFromResponse(r.robots_status, r.robots_txt ?? '', USER_AGENT)
    if (isAllowed(rules, '/')) {
      add('homepage allowed')
      continue
    }
    if (rules.disallowAll) {
      add(`robots.txt unavailable (HTTP ${r.robots_status})`)
      console.log(`UNAVAILABLE ${r.domain}: robots.txt HTTP ${r.robots_status}`)
      continue
    }
    add('robots.txt disallows the homepage')
    const lines = (r.robots_txt ?? '').split(/\r?\n/).filter((l) => /^\s*(user-agent|allow|disallow)\s*:/i.test(l)).slice(0, 12)
    console.log(`DISALLOW ${r.domain} (HTTP ${r.robots_status}, ${(r.robots_txt ?? '').length} bytes):\n    ${lines.join('\n    ')}`)
  }
  console.log('\nSummary:')
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${k}`)

  // --probe: one robots.txt GET and one homepage GET per problem domain (no database writes), to
  // show the real network error or which anti-bot marker matched.
  if (!process.argv.includes('--probe')) return
  console.log('\nProbe (one request each, AourBot user agent):')
  const problem = rows.filter((r) => r.blocked || (r.robots_status ?? 0) >= 500)
  const describe = (e: unknown) => {
    const err = e as Error & { cause?: { code?: string; message?: string } }
    return `${err.name}: ${err.message}${err.cause ? ` (cause: ${err.cause.code ?? ''} ${err.cause.message ?? ''})` : ''}`
  }
  const get = (url: string) => fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  for (const r of problem) {
    const out: string[] = []
    try {
      const res = await get(`https://${r.domain}/robots.txt`)
      out.push(`robots ${res.status}`)
      await res.body?.cancel().catch(() => {})
    } catch (e) {
      out.push(`robots FAILED ${describe(e)}`)
    }
    try {
      const res = await get(`https://${r.domain}/`)
      const body = res.status >= 300 && res.status < 400 ? '' : await res.text()
      const title = /<title[^>]*>([^<]{0,80})/i.exec(body)?.[1]?.trim() ?? ''
      const markers = ['cf-mitigated header', 'just a moment', 'attention required', 'cf-chl-', 'cf_chl_opt', 'challenge-platform', 'g-recaptcha', 'hcaptcha.com', 'captcha-delivery.com', 'px-captcha', 'perimeterx', 'datadome']
        .filter((m) => (m === 'cf-mitigated header' ? res.headers.get('cf-mitigated') === 'challenge' : body.toLowerCase().includes(m)))
      out.push(`home ${res.status}${res.headers.get('location') ? ` -> ${res.headers.get('location')}` : ''}, ${body.length} bytes, server ${res.headers.get('server') ?? '?'}, title "${title}", markers [${markers.join(', ')}]`)
    } catch (e) {
      out.push(`home FAILED ${describe(e)}`)
    }
    console.log(`${r.blocked ? 'BLOCKED' : 'UNAVAILABLE'} ${r.domain}\n    ${out.join('\n    ')}`)
  }
}

const tasks: Record<string, () => Promise<void>> = { diagnose, reclassify, robots }
if (!tasks[task]) {
  console.error(`Unknown task "${task}". Tasks: ${Object.keys(tasks).join(', ')}`)
  process.exit(2)
}
await tasks[task]()
