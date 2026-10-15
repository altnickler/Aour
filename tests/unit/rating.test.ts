import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WEIGHTS,
  bayesianScore,
  buildRankings,
  communityStats,
  isValidScore,
  meanScore,
  round2,
  sanitizeWeights,
  sortRankings,
  validateWeights,
  visitComposite,
  type RatedVisit,
  type Weights,
} from '@/core/rating'
import { PRIMARY_CATEGORIES, PRIMARY_CATEGORY_KEYS } from '@/core/categories'

const full = { ambience: 8, drinks: 9, food: 7, value: 8.5, service: 7.5, overall: 8 }

function visit(id: string, establishmentId: string, visitedOn: string, scores: Record<string, number | null>): RatedVisit {
  return { id, establishmentId, visitedOn, createdAt: `${visitedOn}T18:00:00Z`, scores }
}

describe('default weights', () => {
  it('match the product spec and sum to 100', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ ambience: 20, drinks: 20, food: 15, value: 20, service: 15, overall: 10 })
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100)
    expect(PRIMARY_CATEGORIES.map((c) => c.key)).toEqual([...PRIMARY_CATEGORY_KEYS])
  })
})

describe('score validation', () => {
  it('accepts 1.0–10.0 in 0.5 steps only', () => {
    expect(isValidScore(1)).toBe(true)
    expect(isValidScore(10)).toBe(true)
    expect(isValidScore(7.5)).toBe(true)
    expect(isValidScore(0.5)).toBe(false)
    expect(isValidScore(10.5)).toBe(false)
    expect(isValidScore(7.3)).toBe(false)
    expect(isValidScore(Number.NaN)).toBe(false)
    expect(isValidScore('8')).toBe(false)
  })

  it('throws on invalid scores rather than silently computing', () => {
    expect(() => visitComposite({ drinks: 11 })).toThrow(RangeError)
    expect(() => visitComposite({ drinks: 6.25 })).toThrow(RangeError)
  })
})

describe('visitComposite', () => {
  it('computes the weighted average with default weights', () => {
    // (20·8 + 20·9 + 15·7 + 20·8.5 + 15·7.5 + 10·8) / 100 = 807.5/100
    expect(visitComposite(full)).toBe(8.08)
  })

  it('returns the score itself when all categories are equal', () => {
    const s = Object.fromEntries(PRIMARY_CATEGORY_KEYS.map((k) => [k, 6.5]))
    expect(visitComposite(s)).toBe(6.5)
  })

  it('excludes N/A categories and renormalises remaining weights (no zero-filling)', () => {
    const drinksOnly = { ...full, food: null }
    // (160 + 180 + 170 + 112.5 + 80) / 85 = 8.2647… → 8.26
    expect(visitComposite(drinksOnly)).toBe(8.26)
    // A zero-filled implementation would give 7.03 — make sure we never do that.
    expect(visitComposite(drinksOnly)).not.toBe(7.03)
  })

  it('treats absent categories the same as explicit N/A', () => {
    const { food: _food, ...absent } = full
    expect(visitComposite(absent)).toBe(visitComposite({ ...full, food: null }))
  })

  it('handles a single scored category', () => {
    expect(visitComposite({ drinks: 9.5 })).toBe(9.5)
    expect(visitComposite({ overall: 3 })).toBe(3)
  })

  it('returns null when nothing weighted was scored', () => {
    expect(visitComposite({})).toBeNull()
    expect(visitComposite({ food: null, drinks: null })).toBeNull()
    // Detail-only metrics never affect the composite.
    expect(visitComposite({ cocktail_quality: 10, music: 2 })).toBeNull()
  })

  it('ignores detailed (non-primary) categories', () => {
    expect(visitComposite({ ...full, cocktail_quality: 1, music: 10 })).toBe(visitComposite(full))
  })

  it('is deterministic for half-way rounding cases', () => {
    // 8.125 is not representable exactly in binary; integer maths must still round half-up.
    const w: Weights = { ambience: 1, drinks: 0, food: 0, value: 0, service: 0, overall: 7 }
    // (1·10 + 7·8)/8 = 66/8 = 8.25 exactly
    expect(visitComposite({ ambience: 10, overall: 8 }, w)).toBe(8.25)
    const w2: Weights = { ambience: 3, drinks: 5, food: 0, value: 0, service: 0, overall: 0 }
    // (3·7.5 + 5·8.5)/8 = 65/8 = 8.125 → 8.13
    expect(visitComposite({ ambience: 7.5, drinks: 8.5 }, w2)).toBe(8.13)
    for (let i = 0; i < 50; i++) expect(visitComposite({ ambience: 7.5, drinks: 8.5 }, w2)).toBe(8.13)
  })
})

describe('custom weights', () => {
  const drinksAndValue: Weights = { ambience: 5, drinks: 40, food: 5, value: 40, service: 5, overall: 5 }

  it('validates weights', () => {
    expect(validateWeights(DEFAULT_WEIGHTS).ok).toBe(true)
    expect(validateWeights(drinksAndValue).ok).toBe(true)
    expect(validateWeights({ ...DEFAULT_WEIGHTS, drinks: -1 }).ok).toBe(false)
    expect(validateWeights({ ...DEFAULT_WEIGHTS, drinks: 2.5 }).ok).toBe(false)
    expect(validateWeights({ ...DEFAULT_WEIGHTS, drinks: 101 }).ok).toBe(false)
    expect(validateWeights({ ambience: 0, drinks: 0, food: 0, value: 0, service: 0, overall: 0 }).ok).toBe(false)
    expect(validateWeights({ drinks: 10 }).ok).toBe(false)
  })

  it('sanitizes malformed weights back to defaults', () => {
    expect(sanitizeWeights(null)).toEqual(DEFAULT_WEIGHTS)
    expect(sanitizeWeights({ drinks: 'lots' })).toEqual(DEFAULT_WEIGHTS)
    expect(sanitizeWeights(drinksAndValue)).toEqual(drinksAndValue)
  })

  it('does not require weights to sum to 100', () => {
    const doubled = Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => [k, v * 2])) as Weights
    expect(visitComposite(full, doubled)).toBe(visitComposite(full))
  })

  it('zero-weight categories are ignored even when scored', () => {
    const onlyDrinks: Weights = { ambience: 0, drinks: 100, food: 0, value: 0, service: 0, overall: 0 }
    expect(visitComposite(full, onlyDrinks)).toBe(9)
    expect(visitComposite({ food: 7 }, onlyDrinks)).toBeNull()
  })

  it('reorders rankings when weights change', () => {
    const visits = [
      visit('1', 'cocktail-bar', '2026-09-01', { ambience: 6, drinks: 10, food: 5, value: 9, service: 6, overall: 7 }),
      visit('2', 'fancy-bistro', '2026-09-02', { ambience: 10, drinks: 7, food: 10, value: 5, service: 9, overall: 8 }),
    ]
    expect(buildRankings(visits)[0].establishmentId).toBe('fancy-bistro')
    expect(buildRankings(visits, drinksAndValue)[0].establishmentId).toBe('cocktail-bar')
  })
})

describe('meanScore / round2 / bayesian', () => {
  it('averages two-decimal scores deterministically', () => {
    expect(meanScore([8.08, 8.26])).toBe(8.17)
    expect(meanScore([7, 8])).toBe(7.5)
    expect(meanScore([7.01, 7.02])).toBe(7.02) // 7.015 → half-up
    expect(meanScore([null, undefined, 9])).toBe(9)
    expect(meanScore([])).toBeNull()
  })

  it('round2 is half-up and float-safe', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(8.125)).toBe(8.13)
    expect(round2(2.675)).toBe(2.68)
  })

  it('pulls low-count averages toward the prior', () => {
    expect(bayesianScore(null, 0)).toBe(7)
    expect(bayesianScore(10, 1)).toBe(7.75) // (3·7 + 10)/4
    expect(bayesianScore(10, 100)).toBeGreaterThan(9.9)
    // A single 10 should rank below many 9s.
    expect(bayesianScore(10, 1)).toBeLessThan(bayesianScore(9, 20))
  })
})

describe('buildRankings — multiple visits', () => {
  const visits = [
    visit('a1', 'A', '2026-08-01', { ...full, overall: 6 }),
    visit('a2', 'A', '2026-09-15', { ...full, overall: 10 }),
    visit('a3', 'A', '2026-07-01', { ...full, food: null }),
    visit('b1', 'B', '2026-09-20', { drinks: 9, value: 9 }),
    visit('c1', 'C', '2026-09-21', { cocktail_quality: 9 }), // nothing primary → not ranked
  ]

  it('scores a place as the arithmetic mean of its visit composites', () => {
    const a = buildRankings(visits).find((r) => r.establishmentId === 'A')!
    const composites = [visitComposite({ ...full, food: null })!, visitComposite({ ...full, overall: 6 })!, visitComposite({ ...full, overall: 10 })!]
    expect(a.score).toBe(meanScore(composites))
    expect(a.visitCount).toBe(3)
  })

  it('tracks latest score, previous score and trend chronologically', () => {
    const a = buildRankings(visits).find((r) => r.establishmentId === 'A')!
    expect(a.lastVisitedOn).toBe('2026-09-15')
    expect(a.latestScore).toBe(visitComposite({ ...full, overall: 10 }))
    expect(a.previousScore).toBe(visitComposite({ ...full, overall: 6 }))
    expect(a.trend).toBeCloseTo(0.4, 5)
  })

  it('ranks by score with deterministic tie-breaks', () => {
    const r = buildRankings(visits)
    expect(r.map((e) => e.establishmentId)).toEqual(['B', 'A'])
    expect(r.map((e) => e.rank)).toEqual([1, 2])
  })

  it('omits places with no scored primary category', () => {
    expect(buildRankings(visits).some((r) => r.establishmentId === 'C')).toBe(false)
  })

  it('computes per-category averages excluding N/A', () => {
    const a = buildRankings(visits).find((r) => r.establishmentId === 'A')!
    expect(a.categoryAverages.food).toBe(7)
    expect(a.categoryAverages.overall).toBe(8)
    const b = buildRankings(visits).find((r) => r.establishmentId === 'B')!
    expect(b.categoryAverages.food).toBeUndefined()
    expect(b.highlights).toEqual(['drinks', 'value'])
  })

  it('reflects deletions and edits immediately (pure function of visits)', () => {
    const withoutB = visits.filter((v) => v.establishmentId !== 'B')
    expect(buildRankings(withoutB)[0].establishmentId).toBe('A')
    const edited = visits.map((v) => (v.id === 'b1' ? { ...v, scores: { drinks: 2, value: 2 } } : v))
    expect(buildRankings(edited)[0].establishmentId).toBe('A')
  })

  it('sorts by category, recency and frequency while keeping overall rank', () => {
    const r = buildRankings(visits)
    expect(sortRankings(r, 'food').map((e) => e.establishmentId)).toEqual(['A', 'B'])
    expect(sortRankings(r, 'recent').map((e) => e.establishmentId)).toEqual(['B', 'A'])
    expect(sortRankings(r, 'frequent').map((e) => e.establishmentId)).toEqual(['A', 'B'])
    expect(sortRankings(r, 'food')[0].rank).toBe(2)
  })
})

describe('communityStats', () => {
  it('averages per-reviewer means so frequent visitors do not dominate', () => {
    const stats = communityStats([
      { userId: 'u1', scores: { overall: 10 } },
      { userId: 'u1', scores: { overall: 10 } },
      { userId: 'u1', scores: { overall: 10 } },
      { userId: 'u2', scores: { overall: 4 } },
    ])
    expect(stats.average).toBe(7)
    expect(stats.reviewers).toBe(2)
    expect(stats.visits).toBe(4)
    expect(stats.distribution[9]).toBe(1)
    expect(stats.distribution[3]).toBe(1)
  })

  it('handles empty input and counts tags', () => {
    expect(communityStats([]).average).toBeNull()
    const s = communityStats([
      { userId: 'u1', scores: { drinks: 8 }, tags: ['rooftop', 'lively'] },
      { userId: 'u2', scores: { drinks: 9 }, tags: ['rooftop'] },
    ])
    expect(s.topTags).toEqual([
      { key: 'rooftop', count: 2 },
      { key: 'lively', count: 1 },
    ])
    expect(s.categoryAverages).toEqual({ drinks: 8.5 })
  })
})
