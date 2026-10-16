/**
 * One scheduler tick: queue due work, claim a bounded batch (SKIP LOCKED, so overlapping ticks
 * never process the same job), run it with limited concurrency, and record the outcome.
 * Retries use exponential backoff; a job that keeps failing stops after max_attempts.
 */
import type { DiscoverResult } from './discover'
import type { EnrichResult } from './enrich'
import type { Job, PipelineStore } from './store'

export interface TickOptions {
  store: PipelineStore
  worker: string
  kinds: Job['kind'][]
  handlers: {
    enrich?: (id: string) => Promise<EnrichResult>
    discover?: (id: string) => Promise<DiscoverResult>
  }
  /** Max jobs claimed per tick. */
  limit?: number
  concurrency?: number
  /** Max new enrichment jobs queued per tick. */
  enqueueLimit?: number
  now?: () => Date
  log?: (msg: string, data?: unknown) => void
}

export interface TickReport {
  /** Discovery areas created from coverage requests this tick. */
  newAreas: number
  queued: { enrich: number; discover: number; stale: number }
  claimed: number
  succeeded: number
  failed: number
  skipped: number
  results: { job: string; kind: Job['kind']; target: string; status: string; summary: string }[]
}

/** 5 min, 20 min, 80 min … capped at 12 h. */
export function retryDelayMs(attempts: number): number {
  return Math.min(12 * 3_600_000, 5 * 60_000 * 4 ** Math.max(0, attempts - 1))
}

export async function runTick(opts: TickOptions): Promise<TickReport> {
  const { store } = opts
  const now = opts.now ?? (() => new Date())
  const log = opts.log ?? (() => {})
  // Areas people asked for become discovery areas (budget-capped) before due work is queued.
  const newAreas = await store.promoteCoverage(1).catch((e) => {
    log('coverage promotion failed', { message: (e as Error).message })
    return 0
  })
  const queued = await store.enqueueDue(opts.enqueueLimit ?? 50)
  const kinds = opts.kinds.filter((k) => (k === 'enrich_establishment' ? opts.handlers.enrich : opts.handlers.discover))
  const report: TickReport = { newAreas, queued, claimed: 0, succeeded: 0, failed: 0, skipped: 0, results: [] }
  if (!kinds.length) return report

  const jobs = await store.claimJobs(opts.worker, opts.limit ?? 10, kinds)
  report.claimed = jobs.length
  const queue = [...jobs]

  const work = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        if (job.kind === 'enrich_establishment') {
          const r = await opts.handlers.enrich!(job.target_id)
          // Per-venue backoff is already recorded on the establishment; the job itself is done.
          const status = r.outcome === 'skipped' ? 'skipped' : r.outcome === 'error' ? 'failed' : 'succeeded'
          await store.finishJob(job.id, status, status === 'failed' ? r.reason : null, r, null)
          tally(report, status)
          report.results.push({ job: job.id, kind: job.kind, target: job.target_id, status, summary: `${r.outcome}: ${r.reason}` })
        } else {
          const r = await opts.handlers.discover!(job.target_id)
          const allFailed = r.sources.length > 0 && r.sources.every((s) => s.status === 'error')
          const status = r.skipped ? 'skipped' : allFailed ? 'failed' : 'succeeded'
          const retryAt = status === 'failed' ? new Date(now().getTime() + retryDelayMs(job.attempts)) : null
          await store.finishJob(job.id, status, allFailed ? r.sources.map((s) => s.error).join('; ') : null, r, retryAt)
          tally(report, status)
          report.results.push({
            job: job.id, kind: job.kind, target: job.target_id, status,
            summary: r.skipped ?? `created ${r.created}, review ${r.createdForReview}, updated ${r.updated}`,
          })
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        log('job failed', { job: job.id, kind: job.kind, message })
        await store.finishJob(job.id, 'failed', message, null, new Date(now().getTime() + retryDelayMs(job.attempts))).catch(() => {})
        report.failed++
        report.results.push({ job: job.id, kind: job.kind, target: job.target_id, status: 'failed', summary: message.slice(0, 200) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, jobs.length)) }, work))
  return report
}

function tally(r: TickReport, status: 'succeeded' | 'failed' | 'skipped') {
  r[status]++
}
