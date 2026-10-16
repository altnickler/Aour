/**
 * Overture Maps Foundation — Places theme. The DEFAULT venue source.
 *
 * Licence: CDLA-Permissive-2.0 (plus Apache-2.0 / CC0 for some sources); attribution required,
 * no share-alike, storing and displaying is allowed. Overture publishes monthly GeoParquet
 * releases on public S3; we read ONLY the rows inside a market's bounding box with DuckDB
 * (predicate push-down on the bbox column), so a market costs a few MB of transfer and $0.
 *
 * Node only (DuckDB is a native module): runs in scripts/pipeline.ts on GitHub Actions,
 * not in the Cloudflare Worker.
 */
import { overtureToCandidate, type OvertureRow } from '@/core/ingest/providers'
import type { CandidatePlace } from '@/core/ingest/types'
import type { PlaceSource } from '../discover'

export const OVERTURE_BUCKET = 's3://overturemaps-us-west-2/release'

/** Pre-filter in SQL so we transfer only plausible happy-hour venues; kindFromCategories decides. */
const CATEGORY_RE = 'bar|pub|brew|taproom|beer|wine|winery|cocktail|lounge|tavern|saloon|night_?club|restaurant|grill|bistro|gastropub|tapas|oyster|seafood|steak|izakaya|tiki'

export function overtureSql(): string {
  return `
SELECT
  id,
  names.primary AS name,
  basic_category,
  list_concat(coalesce(taxonomy.hierarchy, []::VARCHAR[]), coalesce(taxonomy.alternates, []::VARCHAR[])) AS categories,
  (bbox.ymin + bbox.ymax) / 2 AS lat,
  (bbox.xmin + bbox.xmax) / 2 AS lng,
  addresses[1].freeform AS freeform,
  addresses[1].locality AS locality,
  addresses[1].region AS region,
  addresses[1].postcode AS postcode,
  websites[1] AS website,
  phones[1] AS phone,
  confidence,
  operating_status
FROM read_parquet($path, hive_partitioning = true)
WHERE bbox.xmin BETWEEN $west AND $east
  AND bbox.ymin BETWEEN $south AND $north
  AND coalesce(confidence, 0) >= 0.5
  AND regexp_matches(lower(coalesce(basic_category, '') || ' ' || array_to_string(coalesce(taxonomy.hierarchy, []::VARCHAR[]), ' ')), '${CATEGORY_RE}')`
}

interface DuckConnection {
  run(sql: string): Promise<unknown>
  runAndReadAll(sql: string, params?: Record<string, unknown>): Promise<{ getRowObjectsJS(): Record<string, unknown>[] }>
  closeSync?(): void
}

/**
 * @param path  Parquet glob. Defaults to the public release: `${OVERTURE_BUCKET}/<release>/theme=places/type=place/*`.
 */
export function overtureSource(opts: { release?: string; path?: string; connect?: () => Promise<DuckConnection> }): PlaceSource {
  const path = opts.path ?? (opts.release ? `${OVERTURE_BUCKET}/${opts.release}/theme=places/type=place/*` : null)
  return {
    provider: 'overture',
    budgetKey: 'overture',
    async fetchCandidates(bbox) {
      if (!path) throw new Error('OVERTURE_RELEASE is not set (e.g. 2026-09-17.0 — see https://docs.overturemaps.org/release/latest/)')
      const conn = await (opts.connect ?? defaultConnect)()
      try {
        // Public bucket: anonymous reads, no credentials needed.
        if (path.startsWith('s3://')) await conn.run("SET s3_region = 'us-west-2'")
        const reader = await conn.runAndReadAll(overtureSql(), { path, west: bbox.west, east: bbox.east, south: bbox.south, north: bbox.north })
        return reader
          .getRowObjectsJS()
          .map((r) => overtureToCandidate(toRow(r)))
          .filter((c): c is CandidatePlace => !!c)
      } finally {
        conn.closeSync?.()
      }
    },
  }
}

function toRow(r: Record<string, unknown>): OvertureRow {
  const s = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    id: String(r.id),
    name: s(r.name),
    basic_category: s(r.basic_category),
    categories: Array.isArray(r.categories) ? r.categories.filter((x): x is string => typeof x === 'string') : [],
    lat: Number(r.lat),
    lng: Number(r.lng),
    freeform: s(r.freeform),
    locality: s(r.locality),
    region: s(r.region),
    postcode: s(r.postcode),
    website: s(r.website),
    phone: s(r.phone),
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    operating_status: s(r.operating_status),
  }
}

async function defaultConnect(): Promise<DuckConnection> {
  const { DuckDBInstance } = await import('@duckdb/node-api')
  const instance = await DuckDBInstance.create(':memory:')
  return (await instance.connect()) as unknown as DuckConnection
}
