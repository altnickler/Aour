/** Wiring shared by the Cloudflare Worker cron and the Node runner. */
import { discoverMarket, type PlaceSource } from './discover'
import { enrichEstablishment } from './enrich'
import { createFetcher } from './fetcher'
import type { LlmExtractor } from './llm'
import { runTick, type TickReport } from './runner'
import { createStore, type Job, type Rpc } from './store'

export interface PipelineConfig {
  rpc: Rpc
  fetch: typeof fetch
  worker: string
  kinds: Job['kind'][]
  sources: PlaceSource[]
  llm?: LlmExtractor | null
  limit?: number
  concurrency?: number
  log?: (msg: string, data?: unknown) => void
}

export function runPipelineTick(cfg: PipelineConfig): Promise<TickReport> {
  const store = createStore(cfg.rpc)
  const fetcher = createFetcher({ store, fetch: cfg.fetch })
  return runTick({
    store,
    worker: cfg.worker,
    kinds: cfg.kinds,
    limit: cfg.limit,
    concurrency: cfg.concurrency,
    log: cfg.log,
    handlers: {
      enrich: (id) => enrichEstablishment(id, { store, fetcher, llm: cfg.llm }),
      discover: cfg.sources.length ? (id) => discoverMarket(id, { store, sources: cfg.sources }) : undefined,
    },
  })
}
