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

/** Column name → DuckDB type, from DESCRIBE on the release being read. */
export type OvertureColumns = Map<string, string>

/**
 * Overture's places columns change between releases (e.g. `categories {primary, alternate}`
 * → `taxonomy {hierarchy, alternates}` + `basic_category`). Build the query from the columns
 * the release actually has, so a schema change degrades gracefully instead of failing.
 */
export function overtureSql(cols: OvertureColumns): string {
  const type = (c: string) => (cols.get(c) ?? '').toLowerCase()
  const parts: string[] = []
  if (type('taxonomy').includes('hierarchy')) parts.push('coalesce(taxonomy.hierarchy, []::VARCHAR[])')
  if (type('taxonomy').includes('alternates')) parts.push('coalesce(taxonomy.alternates, []::VARCHAR[])')
  if (type('categories').includes('primary')) parts.push("coalesce([categories.primary], []::VARCHAR[])")
  if (type('categories').includes('alternate')) parts.push('coalesce(categories.alternate, []::VARCHAR[])')
  const categories = parts.length ? parts.reduce((a, b) => `list_concat(${a}, ${b})`) : '[]::VARCHAR[]'
  const basic = cols.has('basic_category') ? 'basic_category' : 'NULL::VARCHAR'
  const status = cols.has('operating_status') ? 'operating_status' : 'NULL::VARCHAR'
  const confidence = cols.has('confidence') ? 'confidence' : '1.0'
  return `
SELECT
  id,
  names.primary AS name,
  ${basic} AS basic_category,
  list_filter(${categories}, x -> x IS NOT NULL) AS categories,
  (bbox.ymin + bbox.ymax) / 2 AS lat,
  (bbox.xmin + bbox.xmax) / 2 AS lng,
  addresses[1].freeform AS freeform,
  addresses[1].locality AS locality,
  addresses[1].region AS region,
  addresses[1].postcode AS postcode,
  websites[1] AS website,
  phones[1] AS phone,
  ${confidence} AS confidence,
  ${status} AS operating_status
FROM read_parquet($path, hive_partitioning = true)
WHERE bbox.xmin BETWEEN $west AND $east
  AND bbox.ymin BETWEEN $south AND $north
  AND coalesce(${confidence}, 0) >= 0.5
  AND regexp_matches(lower(coalesce(${basic}, '') || ' ' || array_to_string(${categories}, ' ')), '${CATEGORY_RE}')`
}

export interface DuckConnection {
  run(sql: string): Promise<unknown>
  runAndReadAll(sql: string, params?: Record<string, unknown>): Promise<{ getRowObjectsJS(): Record<string, unknown>[] }>
  closeSync?(): void
}

/** Releases are named YYYY-MM-DD.N, so the newest sorts last. */
export function newestRelease(files: string[]): string | null {
  const names = new Set<string>()
  for (const f of files) {
    const m = /\/release\/(\d{4}-\d{2}-\d{2}\.\d+)\/theme=places\//.exec(f.replace(/\\/g, '/'))
    if (m) names.add(m[1])
  }
  return [...names].sort().at(-1) ?? null
}

/**
 * @param release  Overture release (e.g. 2026-09-17.0). When omitted, the newest release in `root` is used.
 * @param root     Release root; defaults to the public bucket (tests point it at a local directory).
 * @param path     Explicit Parquet glob (overrides release/root).
 */
export interface OvertureOptions {
  release?: string
  root?: string
  path?: string
  connect?: () => Promise<DuckConnection>
}

export interface OpenRelease {
  conn: DuckConnection
  path: string
  cols: OvertureColumns
  close(): void
}

/** Connect, resolve the release (newest unless pinned) and read its column layout. */
export async function openOverture(opts: OvertureOptions): Promise<OpenRelease> {
  const root = (opts.root ?? OVERTURE_BUCKET).replace(/\/+$/, '')
  let path: string | null = opts.path ?? (opts.release ? `${root}/${opts.release}/theme=places/type=place/*` : null)
  const conn = await (opts.connect ?? defaultConnect)()
  try {
    // Public bucket: anonymous reads, no credentials needed.
    if ((path ?? root).startsWith('s3://')) await conn.run("SET s3_region = 'us-west-2'")
    if (!path) {
      const listing = await conn.runAndReadAll('SELECT file FROM glob($pattern)', { pattern: `${root}/*/theme=places/type=place/*` })
      const latest = newestRelease(listing.getRowObjectsJS().map((r) => String(r.file)))
      if (!latest) throw new Error(`No Overture places release found under ${root}; set OVERTURE_RELEASE (https://docs.overturemaps.org/release/latest/)`)
      path = `${root}/${latest}/theme=places/type=place/*`
    }
    const described = await conn.runAndReadAll('DESCRIBE SELECT * FROM read_parquet($path, hive_partitioning = true)', { path })
    const cols: OvertureColumns = new Map(described.getRowObjectsJS().map((r) => [String(r.column_name), String(r.column_type)]))
    return { conn, path, cols, close: () => conn.closeSync?.() }
  } catch (e) {
    conn.closeSync?.()
    throw e
  }
}

/** SQL expression for a place's primary (most specific) category in this release. */
export function primaryCategoryExpr(cols: OvertureColumns): string {
  const t = (cols.get('taxonomy') ?? '').toLowerCase()
  const c = (cols.get('categories') ?? '').toLowerCase()
  if (/"?primary"? varchar/.test(t)) return 'taxonomy.primary'
  if (t.includes('hierarchy')) return 'taxonomy.hierarchy[-1]'
  if (/"?primary"? varchar/.test(c)) return 'categories.primary'
  return 'NULL::VARCHAR'
}

export function overtureSource(opts: OvertureOptions): PlaceSource {
  return {
    provider: 'overture',
    budgetKey: 'overture',
    async fetchCandidates(bbox) {
      const rel = await openOverture(opts)
      try {
        const reader = await rel.conn.runAndReadAll(overtureSql(rel.cols), { path: rel.path, west: bbox.west, east: bbox.east, south: bbox.south, north: bbox.north })
        return reader
          .getRowObjectsJS()
          .map((r) => overtureToCandidate(toRow(r)))
          .filter((c): c is CandidatePlace => !!c)
      } finally {
        rel.close()
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
