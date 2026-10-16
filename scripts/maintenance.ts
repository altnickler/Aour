/**
 * Data maintenance tasks for the discovery pipeline (run by .github/workflows/maintenance.yml).
 *
 *   npx tsx scripts/maintenance.ts diagnose     # READ-ONLY: Overture category breakdown for a market
 *
 * Never prints credentials.
 */
import { bboxAround } from '../src/core/ingest/providers'
import { openOverture, primaryCategoryExpr } from '../src/pipeline/providers/overture'

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

const tasks: Record<string, () => Promise<void>> = { diagnose }
if (!tasks[task]) {
  console.error(`Unknown task "${task}". Tasks: ${Object.keys(tasks).join(', ')}`)
  process.exit(2)
}
await tasks[task]()
