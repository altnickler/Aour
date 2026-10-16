/**
 * The pipeline's only view of the database: a thin typed wrapper over service-role RPCs
 * (supabase/migrations/*_discovery.sql). Runs unchanged in the Cloudflare Worker, the Node
 * runner (GitHub Actions) and tests (backed by a real Postgres).
 */
import type { CandidatePlace, HappyHourFinding } from '@/core/ingest/types'
import type { ExtractedWindow } from '@/core/ingest/types'

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>

export interface Job {
  id: string
  kind: 'discover_market' | 'enrich_establishment'
  target_id: string
  attempts: number
  max_attempts: number
  priority: number
}

export interface MatchCandidate {
  id: string
  name: string
  lat: number
  lng: number
  website: string | null
  phone: string | null
  externalIds: { provider: string; externalId: string }[]
}

export interface EnrichmentTarget {
  id: string
  name: string
  website: string | null
  timezone: string
  managedBy: 'auto' | 'admin'
  fingerprint: string | null
  hasData: boolean
  adminVerifiedAt: string | null
  priority: boolean
  failures: number
  lastSuccessAt: string | null
  findings: HappyHourFinding[]
  documents: { url: string; etag: string | null; lastModified: string | null; contentHash: string | null }[]
}

export interface MarketInfo {
  id: string
  name: string
  lat: number
  lng: number
  radiusMiles: number
  timezone: string
  discoveryEnabled: boolean
}

export interface DomainState {
  domain: string
  robots_txt: string | null
  robots_status: number | null
  robots_fetched_at: string | null
  crawl_delay_sec: number | null
  next_allowed_at: string | null
  blocked: boolean
  blocked_reason: string | null
}

export interface DocumentRecord {
  outcome: 'changed' | 'unchanged' | 'not_found' | 'blocked' | 'error'
  status: number | null
  etag?: string | null
  lastModified?: string | null
  contentHash?: string | null
}

export interface Assessed {
  status: string
  confidence: number
  conflict: boolean
  reason: string
}

export function createStore(rpc: Rpc) {
  return {
    promoteCoverage: async (limit = 1) => Number(await rpc('pipeline_promote_coverage', { p_limit: limit })) || 0,
    enqueueDue: (limit = 50) => rpc('pipeline_enqueue_due', { p_limit: limit }) as Promise<{ enrich: number; discover: number; stale: number }>,
    claimJobs: (worker: string, limit: number, kinds: Job['kind'][]) =>
      rpc('pipeline_claim_jobs', { p_worker: worker, p_limit: limit, p_kinds: kinds }) as Promise<Job[]>,
    finishJob: (id: string, status: 'succeeded' | 'failed' | 'skipped', error: string | null, result: unknown, retryAt: Date | null) =>
      rpc('pipeline_finish_job', { p_job: id, p_status: status, p_error: error, p_result: result ?? null, p_retry_at: retryAt?.toISOString() ?? null }),
    consumeBudget: async (provider: string, units = 1) => (await rpc('pipeline_consume_budget', { p_provider: provider, p_units: units })) === true,
    getMarket: (id: string) => rpc('pipeline_get_market', { p_market: id }) as Promise<MarketInfo | null>,
    markMarketDiscovered: (id: string, ok: boolean) => rpc('pipeline_mark_market_discovered', { p_market: id, p_ok: ok }),
    nearbyForMatch: (lat: number, lng: number, radiusM: number) =>
      rpc('pipeline_nearby_for_match', { p_lat: lat, p_lng: lng, p_radius_m: Math.round(radiusM) }) as Promise<MatchCandidate[]>,
    upsertPlace: (market: string, candidate: CandidatePlace & { businessHours: ExtractedWindow[] | null }, match: { decision: string; establishmentId: string | null; score: number; reasons: string[] }) =>
      rpc('pipeline_upsert_place', { p_market: market, p_candidate: candidate, p_match: match }) as Promise<{ action: string; establishmentId?: string; reason?: string }>,
    enrichmentTarget: (id: string) => rpc('pipeline_enrichment_target', { p_establishment: id }) as Promise<EnrichmentTarget | null>,
    recordFinding: (id: string, finding: HappyHourFinding, action: string, assessment: Assessed, fingerprint: string) =>
      rpc('pipeline_record_finding', { p_establishment: id, p_finding: finding, p_action: action, p_assessment: assessment, p_fingerprint: fingerprint }) as Promise<{ action: string; findingId?: string }>,
    recordDocument: (id: string, url: string, doc: DocumentRecord) => rpc('pipeline_record_document', { p_establishment: id, p_url: url, p_doc: doc }),
    markOutdated: (id: string, reason: string) => rpc('pipeline_mark_outdated', { p_establishment: id, p_reason: reason }),
    getDomain: (domain: string) => rpc('pipeline_get_domain', { p_domain: domain }) as Promise<DomainState | null>,
    putDomain: (domain: string, state: Partial<DomainState>) => rpc('pipeline_put_domain', { p_domain: domain, p_state: state }),
    scheduleEstablishment: (id: string, ok: boolean, nextAt: Date) =>
      rpc('pipeline_schedule_establishment', { p_establishment: id, p_ok: ok, p_next_at: nextAt.toISOString() }),
  }
}

export type PipelineStore = ReturnType<typeof createStore>
