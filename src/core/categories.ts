/**
 * Rating category definitions.
 *
 * This file is the canonical list. The `rating_categories` table seeded in
 * supabase/migrations mirrors it, and tests/db/parity.test.ts fails if they drift.
 * New optional metrics are added as rows/entries — never as new columns.
 */

export const PRIMARY_CATEGORY_KEYS = [
  'ambience',
  'drinks',
  'food',
  'value',
  'service',
  'overall',
] as const

export type PrimaryCategoryKey = (typeof PRIMARY_CATEGORY_KEYS)[number]

export type CategoryGroup = 'primary' | 'drinks' | 'food' | 'atmosphere' | 'experience' | 'happy_hour'

export interface CategoryDef {
  key: string
  label: string
  description: string
  group: CategoryGroup
  /** Integer percent. Only primary categories carry weight in the composite score. */
  defaultWeight: number
  sortOrder: number
}

export const PRIMARY_CATEGORIES: readonly CategoryDef[] = [
  { key: 'ambience', label: 'Ambience', description: 'Atmosphere, decor, lighting, music, and general vibe', group: 'primary', defaultWeight: 20, sortOrder: 1 },
  { key: 'drinks', label: 'Drinks', description: 'Cocktail quality, selection, consistency, and presentation', group: 'primary', defaultWeight: 20, sortOrder: 2 },
  { key: 'food', label: 'Food', description: 'Food quality, selection, and execution', group: 'primary', defaultWeight: 15, sortOrder: 3 },
  { key: 'value', label: 'Value', description: 'Overall experience relative to happy-hour pricing', group: 'primary', defaultWeight: 20, sortOrder: 4 },
  { key: 'service', label: 'Service', description: 'Friendliness, attentiveness, and speed', group: 'primary', defaultWeight: 15, sortOrder: 5 },
  { key: 'overall', label: 'Overall Experience', description: 'Personal enjoyment and desire to return', group: 'primary', defaultWeight: 10, sortOrder: 6 },
]

const d = (group: CategoryGroup, start: number, items: [string, string][]): CategoryDef[] =>
  items.map(([key, label], i) => ({ key, label, description: '', group, defaultWeight: 0, sortOrder: start + i }))

/** Optional "Detailed Rating" metrics. Displayed in breakdowns; never part of the composite. */
export const DETAIL_CATEGORIES: readonly CategoryDef[] = [
  ...d('drinks', 100, [
    ['cocktail_quality', 'Cocktail quality'],
    ['beer_selection', 'Beer selection'],
    ['wine_selection', 'Wine selection'],
    ['drink_pricing', 'Drink pricing'],
    ['drink_specials', 'Drink specials'],
  ]),
  ...d('food', 200, [
    ['food_quality', 'Food quality'],
    ['portion_sizes', 'Portion sizes'],
    ['food_selection', 'Food selection'],
    ['food_pricing', 'Food pricing'],
    ['food_specials', 'Happy-hour food specials'],
  ]),
  ...d('atmosphere', 300, [
    ['interior_design', 'Interior design'],
    ['outdoor_seating', 'Outdoor seating'],
    ['view', 'View / scenery'],
    ['music', 'Music'],
    ['noise_level', 'Noise level'],
    ['energy', 'Energy / vibe'],
    ['cleanliness', 'Cleanliness'],
  ]),
  ...d('experience', 400, [
    ['service_speed', 'Service speed'],
    ['staff_friendliness', 'Staff friendliness'],
    ['crowding', 'Crowding'],
    ['wait_time', 'Wait time'],
    ['seating_availability', 'Seating availability'],
    ['parking', 'Ease of parking'],
    ['walkability', 'Walkability'],
  ]),
  ...d('happy_hour', 500, [
    ['hh_length', 'Length of happy hour'],
    ['hh_specials_count', 'Number of specials'],
    ['hh_discount_quality', 'Quality of discounts'],
    ['hh_weekend', 'Weekend availability'],
    ['hh_consistency', 'Consistency of deals'],
    ['hh_offer_value', 'Overall value of the offers'],
  ]),
]

export const ALL_CATEGORIES: readonly CategoryDef[] = [...PRIMARY_CATEGORIES, ...DETAIL_CATEGORIES]

export const CATEGORY_BY_KEY: Readonly<Record<string, CategoryDef>> = Object.fromEntries(
  ALL_CATEGORIES.map((c) => [c.key, c]),
)

export const DETAIL_GROUP_LABELS: Record<Exclude<CategoryGroup, 'primary'>, string> = {
  drinks: 'Drinks',
  food: 'Food',
  atmosphere: 'Atmosphere',
  experience: 'Experience',
  happy_hour: 'Happy hour',
}

export function isPrimaryKey(key: string): key is PrimaryCategoryKey {
  return (PRIMARY_CATEGORY_KEYS as readonly string[]).includes(key)
}

/** User-applied descriptive tags (subjective). Distinct from verified amenities. */
export const TAGS: readonly { key: string; label: string; emoji: string }[] = [
  { key: 'best-cocktails', label: 'Best cocktails', emoji: '🍸' },
  { key: 'great-wine', label: 'Great wine', emoji: '🍷' },
  { key: 'cheap-drinks', label: 'Cheap drinks', emoji: '💸' },
  { key: 'great-food', label: 'Great food', emoji: '🍤' },
  { key: 'date-night', label: 'Date night', emoji: '🕯️' },
  { key: 'girls-night', label: "Girls' night", emoji: '💃' },
  { key: 'waterfront', label: 'Waterfront', emoji: '🌊' },
  { key: 'rooftop', label: 'Rooftop', emoji: '🌇' },
  { key: 'outdoor-seating', label: 'Outdoor seating', emoji: '🌴' },
  { key: 'lively', label: 'Lively', emoji: '🎉' },
  { key: 'relaxed', label: 'Relaxed', emoji: '😌' },
  { key: 'upscale', label: 'Upscale', emoji: '✨' },
  { key: 'casual', label: 'Casual', emoji: '👟' },
  { key: 'hidden-gem', label: 'Hidden gem', emoji: '💎' },
  { key: 'great-views', label: 'Great views', emoji: '🌅' },
  { key: 'good-for-groups', label: 'Good for groups', emoji: '👯' },
  { key: 'quiet', label: 'Quiet', emoji: '🤫' },
  { key: 'local-favorite', label: 'Local favorite', emoji: '📍' },
]

export const TAG_BY_KEY: Readonly<Record<string, (typeof TAGS)[number]>> = Object.fromEntries(TAGS.map((t) => [t.key, t]))

/** Objective amenities set only by administrators (verified). */
export const AMENITIES: readonly { key: string; label: string }[] = [
  { key: 'waterfront', label: 'Waterfront' },
  { key: 'rooftop', label: 'Rooftop' },
  { key: 'outdoor_seating', label: 'Outdoor seating' },
  { key: 'full_bar', label: 'Full bar' },
  { key: 'beer_wine_only', label: 'Beer & wine only' },
  { key: 'live_music', label: 'Live music' },
  { key: 'dog_friendly', label: 'Dog friendly' },
  { key: 'parking_lot', label: 'Parking lot' },
  { key: 'boat_docking', label: 'Boat docking' },
  { key: 'tvs', label: 'Sports on TV' },
  { key: 'wheelchair_accessible', label: 'Wheelchair accessible' },
]

export const AMENITY_BY_KEY: Readonly<Record<string, string>> = Object.fromEntries(AMENITIES.map((a) => [a.key, a.label]))
