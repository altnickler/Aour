/**
 * The Aour rating engine — the single source of truth for every score in the app.
 *
 * Model (documented in ARCHITECTURE.md → "Rating engine"):
 *
 *   1. Category scores are 1.0–10.0 in 0.5 steps, or N/A (null / absent).
 *   2. Visit composite = Σ(wᵢ·sᵢ) / Σ(wᵢ) over PRIMARY categories that were scored
 *      AND have weight > 0. Missing/N/A categories are excluded and the remaining
 *      weights renormalise automatically. Missing scores are never treated as 0.
 *   3. A user's place score = arithmetic mean of that user's visit composites.
 *   4. Community average = mean over reviewers of each reviewer's place score
 *      (computed with DEFAULT weights), so frequent visitors don't dominate.
 *   5. Discovery ordering uses a Bayesian-smoothed score:
 *         bayes = (C·m + n·avg) / (C + n),  m = 7.0, C = 3 reviewers.
 *      The raw community average is always displayed separately.
 *
 * Determinism: weights are integer percents and scores are multiples of 0.5, so we
 * compute with integers and round half-up to 2 decimals. The SQL mirror
 * (public.aour_visit_composite) rounds identically; tests/db/parity.test.ts enforces it.
 */

import { PRIMARY_CATEGORIES, PRIMARY_CATEGORY_KEYS, type PrimaryCategoryKey } from './categories'

export type Weights = Record<PrimaryCategoryKey, number>
/** Category key → score. `null` = explicit N/A. Absent = not rated. */
export type ScoreMap = Readonly<Record<string, number | null | undefined>>

export const DEFAULT_WEIGHTS: Readonly<Weights> = Object.freeze(
  Object.fromEntries(PRIMARY_CATEGORIES.map((c) => [c.key, c.defaultWeight])) as Weights,
)

export const MIN_SCORE = 1
export const MAX_SCORE = 10
export const SCORE_STEP = 0.5
export const BAYES_PRIOR_MEAN = 7.0
export const BAYES_PRIOR_WEIGHT = 3

export function isValidScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_SCORE &&
    value <= MAX_SCORE &&
    Number.isInteger(value * 2)
  )
}

/** Integer division rounded half-up (inputs must be non-negative, den > 0). */
function roundDiv(num: number, den: number): number {
  return Math.floor((2 * num + den) / (2 * den))
}

/** Round a non-negative number to 2 decimals, half-up, avoiding float artefacts. */
export function round2(value: number): number {
  return roundDiv(Math.round(value * 1e6), 1e4) / 100
}

export interface WeightValidation {
  ok: boolean
  error?: string
}

export function validateWeights(weights: Partial<Record<string, unknown>>): WeightValidation {
  let total = 0
  for (const key of PRIMARY_CATEGORY_KEYS) {
    const w = weights[key]
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 0 || w > 100) {
      return { ok: false, error: `Weight for ${key} must be a whole number from 0 to 100` }
    }
    total += w
  }
  if (total <= 0) return { ok: false, error: 'At least one category needs some weight' }
  return { ok: true }
}

/** Return valid weights, falling back to defaults for anything malformed. */
export function sanitizeWeights(weights: Partial<Record<string, unknown>> | null | undefined): Weights {
  if (weights && validateWeights(weights).ok) {
    return Object.fromEntries(PRIMARY_CATEGORY_KEYS.map((k) => [k, weights[k] as number])) as Weights
  }
  return { ...DEFAULT_WEIGHTS }
}

/** Weights as percentages of the total (for display), e.g. sliders that don't sum to 100. */
export function weightShares(weights: Weights): Weights {
  const total = PRIMARY_CATEGORY_KEYS.reduce((s, k) => s + weights[k], 0)
  return Object.fromEntries(
    PRIMARY_CATEGORY_KEYS.map((k) => [k, total > 0 ? Math.round((weights[k] / total) * 1000) / 10 : 0]),
  ) as Weights
}

/**
 * Composite score for a single visit, or null when no weighted primary category was scored.
 */
export function visitComposite(scores: ScoreMap, weights: Weights = DEFAULT_WEIGHTS): number | null {
  let num = 0 // Σ w · (2s)   — integers
  let den = 0 // Σ w
  for (const key of PRIMARY_CATEGORY_KEYS) {
    const s = scores[key]
    const w = weights[key]
    if (s === null || s === undefined || w <= 0) continue
    if (!isValidScore(s)) throw new RangeError(`Invalid score for ${key}: ${s}`)
    num += w * (s * 2)
    den += w
  }
  if (den === 0) return null
  // composite = num / (2·den); ×100 for two decimals.
  return roundDiv(num * 100, den * 2) / 100
}

/** Arithmetic mean of 2-decimal scores, rounded half-up to 2 decimals. null for empty input. */
export function meanScore(values: readonly (number | null | undefined)[]): number | null {
  let sum = 0
  let n = 0
  for (const v of values) {
    if (v === null || v === undefined) continue
    sum += Math.round(v * 100)
    n++
  }
  return n === 0 ? null : roundDiv(sum, n) / 100
}

/** Bayesian-smoothed score used for community ordering. */
export function bayesianScore(
  average: number | null,
  count: number,
  priorMean: number = BAYES_PRIOR_MEAN,
  priorWeight: number = BAYES_PRIOR_WEIGHT,
): number {
  if (average === null || count <= 0) return priorMean
  return round2((priorWeight * priorMean + count * average) / (priorWeight + count))
}

/** Human confidence label for a community average based on reviewer count. */
export function confidenceLabel(reviewers: number): 'none' | 'early' | 'growing' | 'solid' {
  if (reviewers <= 0) return 'none'
  if (reviewers < 3) return 'early'
  if (reviewers < 10) return 'growing'
  return 'solid'
}

// ---------------------------------------------------------------------------
// Personal rankings
// ---------------------------------------------------------------------------

export interface RatedVisit {
  id: string
  establishmentId: string
  visitedOn: string // YYYY-MM-DD
  createdAt: string // ISO, tie-breaker for same-day visits
  scores: ScoreMap
}

export interface RankingEntry {
  establishmentId: string
  rank: number
  /** Mean of visit composites (user's weights). */
  score: number
  latestScore: number | null
  previousScore: number | null
  /** latest − previous; null with fewer than two scored visits. */
  trend: number | null
  visitCount: number
  lastVisitedOn: string
  /** Mean per primary category across visits (N/A excluded). */
  categoryAverages: Partial<Record<PrimaryCategoryKey, number>>
  /** Up to two strongest categories (≥ 8.0), for "highlights". */
  highlights: PrimaryCategoryKey[]
}

export type RankingSort =
  | 'overall'
  | 'drinks'
  | 'food'
  | 'value'
  | 'ambience'
  | 'service'
  | 'recent'
  | 'frequent'

export const RANKING_SORTS: { key: RankingSort; label: string }[] = [
  { key: 'overall', label: 'Best overall' },
  { key: 'drinks', label: 'Best drinks' },
  { key: 'food', label: 'Best food' },
  { key: 'value', label: 'Best value' },
  { key: 'ambience', label: 'Best ambience' },
  { key: 'service', label: 'Best service' },
  { key: 'recent', label: 'Most recent' },
  { key: 'frequent', label: 'Most visited' },
]

function visitOrder(a: RatedVisit, b: RatedVisit): number {
  return a.visitedOn === b.visitedOn ? a.createdAt.localeCompare(b.createdAt) : a.visitedOn.localeCompare(b.visitedOn)
}

/**
 * Build a user's ranked list. Visits whose composite is null (nothing weighted was
 * scored) are kept in the visit count but do not affect the score; places with no
 * scored visits are omitted from the ranking.
 */
export function buildRankings(visits: readonly RatedVisit[], weights: Weights = DEFAULT_WEIGHTS): RankingEntry[] {
  const byPlace = new Map<string, RatedVisit[]>()
  for (const v of visits) {
    const list = byPlace.get(v.establishmentId)
    if (list) list.push(v)
    else byPlace.set(v.establishmentId, [v])
  }

  const entries: Omit<RankingEntry, 'rank'>[] = []
  for (const [establishmentId, list] of byPlace) {
    const ordered = [...list].sort(visitOrder)
    const composites = ordered.map((v) => visitComposite(v.scores, weights))
    const scored = composites.filter((c): c is number => c !== null)
    const score = meanScore(scored)
    if (score === null) continue

    const categoryAverages: Partial<Record<PrimaryCategoryKey, number>> = {}
    for (const key of PRIMARY_CATEGORY_KEYS) {
      const avg = meanScore(ordered.map((v) => v.scores[key]))
      if (avg !== null) categoryAverages[key] = avg
    }
    const highlights = (Object.entries(categoryAverages) as [PrimaryCategoryKey, number][])
      .filter(([k, v]) => k !== 'overall' && v >= 8)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([k]) => k)

    const latestScore = scored.at(-1) ?? null
    const previousScore = scored.length > 1 ? scored[scored.length - 2] : null
    entries.push({
      establishmentId,
      score,
      latestScore,
      previousScore,
      trend: latestScore !== null && previousScore !== null ? round2(Math.abs(latestScore - previousScore)) * Math.sign(latestScore - previousScore) : null,
      visitCount: ordered.length,
      lastVisitedOn: ordered[ordered.length - 1].visitedOn,
      categoryAverages,
      highlights,
    })
  }

  // Canonical rank: score desc, then more visits, then most recent, then id (stable & deterministic).
  entries.sort(
    (a, b) =>
      b.score - a.score ||
      b.visitCount - a.visitCount ||
      b.lastVisitedOn.localeCompare(a.lastVisitedOn) ||
      a.establishmentId.localeCompare(b.establishmentId),
  )
  return entries.map((e, i) => ({ ...e, rank: i + 1 }))
}

/** Re-order ranking entries for display. `rank` always remains the overall rank. */
export function sortRankings(entries: readonly RankingEntry[], sort: RankingSort): RankingEntry[] {
  const list = [...entries]
  const byRank = (a: RankingEntry, b: RankingEntry) => a.rank - b.rank
  switch (sort) {
    case 'overall':
      return list.sort(byRank)
    case 'recent':
      return list.sort((a, b) => b.lastVisitedOn.localeCompare(a.lastVisitedOn) || byRank(a, b))
    case 'frequent':
      return list.sort((a, b) => b.visitCount - a.visitCount || byRank(a, b))
    default: {
      // Category sorts: places without that category go last.
      const key = sort
      return list.sort((a, b) => {
        const av = a.categoryAverages[key]
        const bv = b.categoryAverages[key]
        if (av === undefined && bv === undefined) return byRank(a, b)
        if (av === undefined) return 1
        if (bv === undefined) return -1
        return bv - av || byRank(a, b)
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Community aggregation (mirrors SQL public.aour_refresh_establishment_stats)
// ---------------------------------------------------------------------------

export interface CommunityVisit {
  userId: string
  scores: ScoreMap
  tags?: readonly string[]
}

export interface CommunityStats {
  /** Mean of per-reviewer place scores (default weights). */
  average: number | null
  reviewers: number
  visits: number
  categoryAverages: Partial<Record<PrimaryCategoryKey, number>>
  /** Count of reviewers whose place score falls in bucket i (i = floor(score), 1..10 → index 0..9). */
  distribution: number[]
  /** Tag → number of visits that used it, most common first. */
  topTags: { key: string; count: number }[]
}

export const EMPTY_COMMUNITY_STATS: CommunityStats = Object.freeze({
  average: null,
  reviewers: 0,
  visits: 0,
  categoryAverages: {},
  distribution: Array(10).fill(0),
  topTags: [],
}) as CommunityStats

export function communityStats(visits: readonly CommunityVisit[]): CommunityStats {
  const byUser = new Map<string, CommunityVisit[]>()
  for (const v of visits) {
    const list = byUser.get(v.userId)
    if (list) list.push(v)
    else byUser.set(v.userId, [v])
  }

  const userScores: number[] = []
  const userCategoryMeans: Partial<Record<PrimaryCategoryKey, number[]>> = {}
  for (const list of byUser.values()) {
    const s = meanScore(list.map((v) => visitComposite(v.scores)))
    if (s === null) continue
    userScores.push(s)
    for (const key of PRIMARY_CATEGORY_KEYS) {
      const m = meanScore(list.map((v) => v.scores[key]))
      if (m !== null) (userCategoryMeans[key] ??= []).push(m)
    }
  }

  const categoryAverages: Partial<Record<PrimaryCategoryKey, number>> = {}
  for (const key of PRIMARY_CATEGORY_KEYS) {
    const m = meanScore(userCategoryMeans[key] ?? [])
    if (m !== null) categoryAverages[key] = m
  }

  const distribution = Array(10).fill(0) as number[]
  for (const s of userScores) distribution[Math.min(9, Math.max(0, Math.floor(s) - 1))]++

  const tagCounts = new Map<string, number>()
  for (const v of visits) for (const t of v.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  const topTags = [...tagCounts]
    .map(([key, count]) => ({ key, count }))
    // Byte-order tie-break (not localeCompare) so it matches SQL `collate "C"` exactly.
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, 8)

  return {
    average: meanScore(userScores),
    reviewers: userScores.length,
    visits: visits.length,
    categoryAverages,
    distribution,
    topTags,
  }
}

export function formatScore(score: number | null | undefined): string {
  return score === null || score === undefined ? '—' : score.toFixed(1)
}
