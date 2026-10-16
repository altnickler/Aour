/**
 * Node runner for the data pipeline (GitHub Actions: .github/workflows/discovery.yml, or locally).
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… OVERTURE_RELEASE=2026-09-17.0 npx tsx scripts/pipeline.ts discover
 *   … npx tsx scripts/pipeline.ts enrich
 *
 * discover  – runs due market-discovery jobs with Overture (default) and, if enabled, OSM.
 * enrich    – runs due website-enrichment jobs (same code as the Worker cron).
 *
 * Never point this at production with test data: it only reads real providers and writes real
 * facts through the service-role RPCs, which enforce budgets, locks and admin overrides.
 */
import { runPipelineTick } from '../src/pipeline'
import type { PlaceSource } from '../src/pipeline/discover'
import { anthropicClient, createLlmExtractor } from '../src/pipeline/llm'
import { overpassSource } from '../src/pipeline/providers/overpass'
import { overtureSource } from '../src/pipeline/providers/overture'
import { supabaseRpc } from '../src/pipeline/rest'
import { createStore } from '../src/pipeline/store'

const mode = process.argv[2] ?? 'enrich'
const { SUPABASE_SERVICE_ROLE_KEY, OVERTURE_RELEASE, DISCOVERY_SOURCES, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, SITE_URL } = process.env
let SUPABASE_URL = process.env.SUPABASE_URL
// The project URL is public: when not configured, read it from the deployed site's /version.json.
if (!SUPABASE_URL && SITE_URL) {
  try {
    const res = await fetch(`${SITE_URL.replace(/\/+$/, '')}/version.json`, { signal: AbortSignal.timeout(20_000) })
    const v = (await res.json()) as { supabase?: { url?: string } | null }
    SUPABASE_URL = v.supabase?.url
  } catch (e) {
    console.error(`Could not read ${SITE_URL}/version.json: ${(e as Error).message}`)
  }
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL (or SITE_URL) and SUPABASE_SERVICE_ROLE_KEY are required (server-side secrets; never ship them to the client).')
  process.exit(2)
}
console.log(`Pipeline ${mode} against project ${new URL(SUPABASE_URL).hostname.split('.')[0]}`)

const rpc = supabaseRpc(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const wanted = (DISCOVERY_SOURCES ?? 'overture').split(',').map((s) => s.trim())
const sources: PlaceSource[] = []
if (mode === 'discover') {
  if (wanted.includes('overture')) sources.push(overtureSource({ release: OVERTURE_RELEASE }))
  if (wanted.includes('osm')) sources.push(overpassSource({ fetch }))
}
const llm = ANTHROPIC_API_KEY ? createLlmExtractor({ client: anthropicClient(ANTHROPIC_API_KEY), store: createStore(rpc), model: ANTHROPIC_MODEL }) : null

const maxTicks = Number(process.env.MAX_TICKS ?? (mode === 'discover' ? 3 : 20))
let total = 0
for (let i = 0; i < maxTicks; i++) {
  const report = await runPipelineTick({
    rpc, fetch, worker: `gha-${mode}-${process.pid}`,
    kinds: mode === 'discover' ? ['discover_market'] : ['enrich_establishment'],
    sources, llm, limit: mode === 'discover' ? 2 : 8, concurrency: mode === 'discover' ? 1 : 4,
    log: (msg, data) => console.log(msg, JSON.stringify(data)),
  })
  for (const r of report.results) console.log(`${r.kind} ${r.target} → ${r.status}: ${r.summary}`)
  total += report.claimed
  if (!report.claimed) break
}
console.log(`done: ${total} job(s)`)
