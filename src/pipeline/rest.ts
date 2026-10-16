/**
 * Supabase PostgREST RPC transport for the pipeline (Worker and Node runner).
 * Uses the service-role key, which must only ever live in server-side secrets.
 */
import type { Rpc } from './store'

export function supabaseRpc(url: string, key: string, fetchImpl: typeof fetch = fetch): Rpc {
  const base = url.replace(/\/+$/, '')
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' }
  // Legacy service_role keys are JWTs and go in Authorization; new sb_secret_ keys go in apikey only.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`
  return async (fn, args) => {
    const res = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(30_000) })
    const text = await res.text()
    if (!res.ok) throw new Error(`rpc ${fn} failed: HTTP ${res.status} ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }
}

/** Call an RPC as the signed-in user (anon key + their access token), e.g. to check admin rights. */
export async function rpcAsUser(url: string, anonKey: string, accessToken: string, fn: string, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return null
  const text = await res.text()
  return text ? JSON.parse(text) : null
}
