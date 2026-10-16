/**
 * robots.txt (RFC 9309) — the subset we need to be a polite crawler.
 *  - Group matching by product token (case-insensitive), falling back to "*".
 *  - Longest matching rule wins; Allow wins ties. "*" wildcard and "$" end anchor.
 *  - 4xx robots.txt ⇒ everything allowed. 5xx/unreachable ⇒ treat as fully disallowed.
 *  - Crawl-delay is non-standard but honoured when present.
 */
export interface RobotsRules {
  rules: { allow: boolean; pattern: string }[]
  crawlDelaySec: number | null
  /** true when robots.txt could not be fetched due to a server error (crawl nothing). */
  disallowAll?: boolean
}

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const token = userAgent.split('/')[0].toLowerCase()
  const groups: { agents: string[]; rules: RobotsRules['rules']; delay: number | null }[] = []
  let current: (typeof groups)[number] | null = null
  let lastWasAgent = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!current) continue
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && value === '') continue // empty disallow = allow all
      current.rules.push({ allow: key === 'allow', pattern: value })
    } else if (key === 'crawl-delay') {
      const n = Number(value)
      if (Number.isFinite(n) && n >= 0) current.delay = n
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)))
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'))
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelaySec: chosen.map((g) => g.delay).find((d) => d !== null) ?? null,
  }
}

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$')
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}${anchored ? '$' : ''}`)
}

export function isAllowed(robots: RobotsRules, pathWithQuery: string): boolean {
  if (robots.disallowAll) return false
  let best: { allow: boolean; len: number } | null = null
  for (const r of robots.rules) {
    if (!toRegex(r.pattern).test(pathWithQuery)) continue
    const len = r.pattern.length
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len }
  }
  return best ? best.allow : true
}

/** Interpret a robots.txt HTTP response per RFC 9309 §2.3.1. */
export function robotsFromResponse(status: number, body: string, userAgent: string): RobotsRules {
  if (status >= 200 && status < 300) return parseRobots(body, userAgent)
  if (status >= 400 && status < 500) return { rules: [], crawlDelaySec: null }
  return { rules: [], crawlDelaySec: null, disallowAll: true }
}
