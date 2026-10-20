/**
 * Data maintenance tasks for the discovery pipeline (run by .github/workflows/maintenance.yml).
 *
 *   npx tsx scripts/maintenance.ts diagnose       # READ-ONLY: Overture category breakdown for a market
 *   npx tsx scripts/maintenance.ts reclassify     # DRY RUN: what the strict classifier would change
 *   npx tsx scripts/maintenance.ts reclassify --apply
 *   npx tsx scripts/maintenance.ts robots         # READ-ONLY: venue domains robots.txt keeps us out of, and why
 *   npx tsx scripts/maintenance.ts robots --probe # …plus one request per problem domain to show the real error
 *   npx tsx scripts/maintenance.ts robots --recheck [--apply]  # lift blocks caused by our own detection mistakes
 *   npx tsx scripts/maintenance.ts refresh-outdated [--apply]  # re-read venues wrongly marked outdated
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
import { looksLikeChallenge, USER_AGENT } from '../src/pipeline/fetcher'

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

/**
 * Undo crawl pauses caused by our own earlier mistakes (never by a site's wishes):
 *  - "anti-bot challenge" blocks whose homepage now loads normally (one polite GET per domain);
 *  - robots.txt answers cached after a network/server error (the fetcher no longer caches those).
 * Venues on those domains are rescheduled for a website check now. Genuine challenges, robots.txt
 * disallows and 401/403 refusals are left alone. Nothing is deleted; every change is printed.
 */
async function recheck() {
  const apply = process.argv.includes('--apply')
  const db = await supabase()
  const domains = await db.all<{ domain: string; robots_status: number | null; blocked: boolean; blocked_reason: string | null }>(
    'source_domains?select=domain,robots_status,blocked,blocked_reason&order=domain',
  )
  const unblock: string[] = []
  for (const d of domains.filter((x) => x.blocked && x.blocked_reason === 'anti-bot challenge')) {
    try {
      const res = await fetch(`https://${d.domain}/`, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
      const body = res.status >= 300 && res.status < 400 ? '' : await res.text()
      const ok = res.status < 400 && !looksLikeChallenge(res.status, res.headers, body)
      console.log(`${ok ? 'UNBLOCK' : 'keep   '} ${d.domain}: HTTP ${res.status}${ok ? '' : looksLikeChallenge(res.status, res.headers, body) ? ' (challenge page)' : ''}`)
      if (ok) unblock.push(d.domain)
    } catch (e) {
      console.log(`keep    ${d.domain}: ${(e as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  const unreachable = domains.filter((x) => !x.blocked && (x.robots_status ?? 0) >= 500).map((x) => x.domain)
  console.log(`\n${unblock.length} challenge blocks to lift; ${unreachable.length} domains whose robots.txt was unreachable will be asked again.`)

  const hosts = new Set([...unblock, ...unreachable])
  const venues = (
    await db.all<{ id: string; name: string; website: string | null; next_enrich_at: string | null }>(
      'establishments?select=id,name,website,next_enrich_at&status=in.(published,draft)&website=not.is.null&order=id',
    )
  ).filter((e) => {
    try {
      return hosts.has(new URL(e.website!).hostname.toLowerCase()) && (!e.next_enrich_at || Date.parse(e.next_enrich_at) > Date.now() + 3_600_000)
    } catch {
      return false
    }
  })
  console.log(`${venues.length} venues to re-check now: ${venues.slice(0, 30).map((v) => v.name).join(' · ')}${venues.length > 30 ? ' …' : ''}`)
  if (!apply) {
    console.log('\nDry run: nothing changed. Run "robots --recheck --apply" to apply.')
    return
  }
  for (const d of unblock) await db.req('PATCH', `source_domains?domain=eq.${encodeURIComponent(d)}`, { blocked: false, blocked_reason: null }, 'return=minimal')
  for (const d of unreachable) await db.req('PATCH', `source_domains?domain=eq.${encodeURIComponent(d)}`, { robots_fetched_at: null }, 'return=minimal')
  const now = new Date().toISOString()
  for (let i = 0; i < venues.length; i += 100) {
    const ids = venues.slice(i, i + 100).map((v) => v.id).join(',')
    await db.req('PATCH', `establishments?id=in.(${ids})`, { next_enrich_at: now }, 'return=minimal')
  }
  console.log(`\nApplied: lifted ${unblock.length} blocks, cleared ${unreachable.length} cached robots.txt errors, rescheduled ${venues.length} venues.`)
}

/**
 * Undo "outdated" labels caused by page-wide CMS dates (article:modified_time etc.), which the
 * extractor no longer uses: clears that date on official-website text findings and re-reads the
 * pages of automation-managed listings marked outdated, now. Admin-managed listings are untouched.
 */
async function refreshOutdated() {
  const apply = process.argv.includes('--apply')
  const db = await supabase()
  const findings = await db.all<{ id: string }>('hh_findings?select=id&source_kind=eq.official_website&method=eq.pattern&source_published_at=not.is.null&order=id')
  const outdated = await db.all<{ id: string; name: string }>("establishments?select=id,name&hh_status=eq.outdated&hh_managed_by=eq.auto&status=in.(published,draft)&order=id")
  console.log(`${findings.length} website findings carry a page-wide date; ${outdated.length} listings marked outdated: ${outdated.map((e) => e.name).join(' · ') || 'none'}`)
  if (!apply) {
    console.log('\nDry run: nothing changed. Run "refresh-outdated --apply" to apply.')
    return
  }
  for (let i = 0; i < findings.length; i += 100) {
    await db.req('PATCH', `hh_findings?id=in.(${findings.slice(i, i + 100).map((f) => f.id).join(',')})`, { source_published_at: null }, 'return=minimal')
  }
  const now = new Date().toISOString()
  for (let i = 0; i < outdated.length; i += 100) {
    const ids = outdated.slice(i, i + 100).map((e) => e.id).join(',')
    // Forget cached validators so every page is read again with the current extractor.
    await db.req('PATCH', `source_documents?establishment_id=in.(${ids})`, { etag: null, last_modified: null, content_hash: null }, 'return=minimal')
    await db.req('PATCH', `establishments?id=in.(${ids})`, { next_enrich_at: now }, 'return=minimal')
  }
  console.log(`\nApplied: cleared ${findings.length} page-wide dates, scheduled ${outdated.length} listings for an immediate re-check.`)
}

/** Read-only: every listing showing happy-hour details, with the page text each fact came from. */
async function hhAudit() {
  const db = await supabase()
  type W = { days: number[]; start: string; end: string; label: string | null }
  type S = { kind: string; title: string; price: string | null }
  const findings = await db.all<{ establishment_id: string; source_url: string | null; windows: W[]; specials: S[]; evidence: { field: string; quote: string }[]; status: string; checked_at: string }>(
    "hh_findings?select=establishment_id,source_url,windows,specials,evidence,status,checked_at&status=in.(applied,approved)&order=checked_at.desc",
  )
  const ests = await db.all<{ id: string; name: string; city: string; hh_status: string; status: string }>(
    "establishments?select=id,name,city,hh_status,status&hh_status=neq.none&order=name",
  )
  const latest = new Map<string, (typeof findings)[number]>()
  for (const f of findings) if (!latest.has(f.establishment_id)) latest.set(f.establishment_id, f)
  const day = (d: number[]) => d.map((x) => 'SuMoTuWeThFrSa'.slice(x * 2, x * 2 + 2)).join(',')
  for (const e of ests) {
    const f = latest.get(e.id)
    console.log(`\n## ${e.name} (${e.city}) — ${e.hh_status}, listing ${e.status}${f?.source_url ? ` — ${f.source_url}` : ''}`)
    if (!f) continue
    for (const [i, w] of f.windows.entries()) {
      const q = f.evidence.find((x) => x.field === `window:${i}`)?.quote ?? ''
      console.log(`  window ${day(w.days)} ${w.start}-${w.end}${w.label ? ` (${w.label})` : ''}  ⟵ "${q.replace(/\s+/g, ' ').slice(0, 140)}"`)
    }
    for (const [i, sp] of f.specials.entries()) {
      const q = f.evidence.find((x) => x.field === `special:${i}`)?.quote ?? ''
      console.log(`  special [${sp.kind}] ${sp.title} — ${sp.price ?? ''}  ⟵ "${q.replace(/\s+/g, ' ').slice(0, 140)}"`)
    }
  }
}

const tasks: Record<string, () => Promise<void>> = {
  'hh-audit': hhAudit,
  'refresh-outdated': refreshOutdated,
  diagnose,
  reclassify,
  robots: () => (process.argv.includes('--recheck') ? recheck() : robots()),
}
if (!tasks[task]) {
  console.error(`Unknown task "${task}". Tasks: ${Object.keys(tasks).join(', ')}`)
  process.exit(2)
}
await tasks[task]()
