/**
 * Canonical Cloudflare deploy for Aour: the PWA (static assets) AND the Worker script
 * (/api/*, Cron Trigger pipeline) as one Worker, with its runtime settings attached.
 *
 *   npm run build && npm run deploy:worker            # production deploy
 *   npm run deploy:worker -- --upload                 # preview version (non-production branches)
 *   npm run deploy:worker -- --dry-run                # bundle + checks only, no upload
 *
 * Use it as the Cloudflare Workers Builds "Deploy command" (and it is what deploy.yml runs).
 *
 * Runtime settings, read from the build environment:
 *   - SUPABASE_URL / SUPABASE_ANON_KEY: public values (the same ones compiled into the web app),
 *     taken from VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY when not set separately → Worker vars.
 *   - SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, FOURSQUARE_API_KEY: server secrets, uploaded
 *     as encrypted Worker secrets via a temporary 0600 file that is deleted afterwards. They must
 *     never be VITE_ variables; this script refuses to deploy if one is, or if a secret value
 *     appears anywhere in the built client files.
 * Values are never printed. Secrets already on the Worker are kept when not provided here.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SECRET_NAMES = ['SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'FOURSQUARE_API_KEY'] as const
type Env = Record<string, string | undefined>

/** Strip // and /* *\/ comments outside strings so wrangler.jsonc parses as JSON. */
export function parseJsonc(text: string): Record<string, unknown> {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** The config must describe a full Worker, not an assets-only one. */
export function checkConfig(cfg: Record<string, unknown>, root = '.'): string[] {
  const problems: string[] = []
  const main = cfg.main as string | undefined
  if (!main) problems.push('wrangler config has no "main": Cloudflare would deploy an assets-only Worker (no API, no cron, no variables)')
  else if (!existsSync(join(root, main))) problems.push(`Worker entry point ${main} does not exist`)
  const assets = cfg.assets as { directory?: string; binding?: string; run_worker_first?: unknown } | undefined
  if (!assets?.directory) problems.push('wrangler config has no assets.directory for the web app')
  if (assets && !assets.binding) problems.push('assets.binding is required so the Worker can serve the app')
  if (assets && !assets.run_worker_first) problems.push('assets.run_worker_first must route /api/* to the Worker')
  const crons = (cfg.triggers as { crons?: string[] } | undefined)?.crons
  if (!crons?.length) problems.push('no Cron Trigger configured (triggers.crons): the discovery pipeline would never run')
  return problems
}

export interface Settings {
  vars: Record<string, string>
  secrets: Record<string, string>
  problems: string[]
}

export function collectSettings(env: Env): Settings {
  const problems: string[] = []
  for (const name of SECRET_NAMES) {
    if (env[`VITE_${name}`]) problems.push(`VITE_${name} is set: server secrets must never be VITE_ variables (they would be compiled into the public app). Remove it and rotate the key.`)
  }
  const vars: Record<string, string> = {}
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const anon = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  if (url) vars.SUPABASE_URL = url.replace(/\/+$/, '')
  if (anon) vars.SUPABASE_ANON_KEY = anon
  if (url && !/^https:\/\/[^\s/]+$/.test(vars.SUPABASE_URL)) problems.push('SUPABASE_URL must look like https://<ref>.supabase.co')
  const secrets: Record<string, string> = {}
  for (const name of SECRET_NAMES) if (env[name]) secrets[name] = env[name]!
  if (secrets.SUPABASE_SERVICE_ROLE_KEY && anon && secrets.SUPABASE_SERVICE_ROLE_KEY === anon) {
    problems.push('SUPABASE_SERVICE_ROLE_KEY equals the anon key; use the service-role / secret key')
  }
  return { vars, secrets, problems }
}

/** Abort if any secret value was compiled into the client files. */
export function findLeaks(dir: string, secrets: Record<string, string>): string[] {
  const leaks: string[] = []
  const values = Object.entries(secrets).filter(([, v]) => v.length >= 12)
  if (!values.length || !existsSync(dir)) return leaks
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(js|mjs|html|json|css|map|txt|webmanifest)$/.test(name)) {
        const text = readFileSync(p, 'utf8')
        for (const [k, v] of values) if (text.includes(v)) leaks.push(`${k} found in ${p}`)
      }
    }
  }
  walk(dir)
  return leaks
}

function main() {
  const args = process.argv.slice(2)
  const upload = args.includes('--upload')
  const dryRun = args.includes('--dry-run')
  const passthrough = args.filter((a) => a !== '--upload')

  const cfg = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'))
  const problems = checkConfig(cfg)
  const settings = collectSettings(process.env)
  problems.push(...settings.problems)
  const assetsDir = (cfg.assets as { directory: string }).directory
  if (!existsSync(join(assetsDir, 'index.html'))) problems.push(`${assetsDir}/index.html is missing: run "npm run build" first`)
  problems.push(...findLeaks(assetsDir, settings.secrets))
  if (problems.length) {
    console.error('Deploy aborted:\n- ' + problems.join('\n- '))
    process.exit(1)
  }

  const cmd = upload ? ['versions', 'upload'] : ['deploy']
  const flags = Object.entries(settings.vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])
  let tmp: string | null = null
  if (Object.keys(settings.secrets).length && !dryRun) {
    tmp = mkdtempSync(join(tmpdir(), 'aour-secrets-'))
    const file = join(tmp, 'secrets.json')
    writeFileSync(file, JSON.stringify(settings.secrets), { mode: 0o600 })
    chmodSync(file, 0o600)
    flags.push('--secrets-file', file)
  }
  console.log(
    `Deploying Worker "${cfg.name}" (${upload ? 'preview version' : 'production'}${dryRun ? ', dry run' : ''}) with entry ${cfg.main}, ` +
      `cron ${JSON.stringify((cfg.triggers as { crons: string[] }).crons)}, vars [${Object.keys(settings.vars).join(', ') || 'none'}], ` +
      `secrets [${Object.keys(settings.secrets).join(', ') || 'none (existing Worker secrets are kept)'}]`,
  )
  try {
    const res = spawnSync('npx', ['wrangler', ...cmd, ...flags, ...passthrough], { stdio: 'inherit', env: process.env })
    if (res.status !== 0) process.exit(res.status ?? 1)
    // With --dry-run --outdir <dir>: prove the bundle is a full Worker (API routes + cron handler).
    const outIdx = passthrough.indexOf('--outdir')
    if (dryRun && outIdx >= 0) {
      const bundle = readFileSync(join(passthrough[outIdx + 1], 'index.js'), 'utf8')
      const missing = ['/api/health', '/api/geocode', '/api/admin/run', 'scheduled'].filter((m) => !bundle.includes(m))
      if (missing.length) {
        console.error(`Bundle is not a full Worker; missing: ${missing.join(', ')}`)
        process.exit(1)
      }
      console.log('Bundle check passed: Worker script with /api/* routes and the scheduled() handler.')
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && /deploy-worker\.ts$/.test(process.argv[1])) main()
