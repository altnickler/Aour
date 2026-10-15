#!/usr/bin/env node
/**
 * Generates DEMO data for development:
 *   - src/data/demo-seed.json   (on-device demo mode)
 *   - supabase/seed.sql         (applied only by `supabase db reset` on a LOCAL stack)
 *
 * Every establishment here is FICTIONAL, flagged is_demo = true, and badged "Demo" in the
 * UI. Names were chosen to be clearly invented; addresses say "Demo listing". Do not load
 * this into production — real listings are entered by admins with verified sources.
 *
 * Usage: node scripts/generate-demo-seed.mjs
 */
import { writeFileSync } from 'node:fs'

let seed = 20261015
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const uuid = (prefix, n) => `${prefix}${String(n).padStart(24, '0')}`.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')

const WEEKDAYS = [1, 2, 3, 4, 5]
const DAILY = [0, 1, 2, 3, 4, 5, 6]

const places = [
  { name: 'Driftwood Social', kind: 'cocktail_lounge', area: 'Downtown Stuart', city: 'Stuart', lat: 27.1979, lng: -80.2537, price: 2, amenities: ['full_bar', 'outdoor_seating'],
    windows: [{ days: WEEKDAYS, start: '16:00', end: '19:00' }, { days: [6], start: '15:00', end: '18:00' }],
    specials: [['drink', 'Classic cocktails', '$7'], ['drink', 'House wine', '$5'], ['food', 'Half-price flatbreads', null]],
    verifiedDaysAgo: 12, bias: { drinks: 1.2, ambience: 0.8 },
    description: 'Breezy, plant-filled lounge with a short, sharp cocktail list.' },
  { name: 'The Pelican Pour', kind: 'bar', area: 'Jensen Beach', city: 'Jensen Beach', lat: 27.2551, lng: -80.2291, price: 1, amenities: ['waterfront', 'outdoor_seating', 'dog_friendly', 'beer_wine_only'],
    windows: [{ days: DAILY, start: '15:00', end: '18:00' }],
    specials: [['drink', 'Local drafts', '$4'], ['drink', 'Wine by the glass', '$5'], ['food', 'Peel-and-eat shrimp', '$9']],
    verifiedDaysAgo: 30, bias: { value: 1.5, ambience: 1 }, description: 'Dockside deck, cold beer and sunsets over the river.' },
  { name: 'Copper Heron Cocktail Club', kind: 'cocktail_lounge', area: 'Downtown Stuart', city: 'Stuart', lat: 27.1968, lng: -80.2521, price: 3, amenities: ['full_bar'],
    windows: [{ days: [2, 3, 4, 5, 6], start: '17:00', end: '19:00' }, { days: [5, 6], start: '22:00', end: '00:00', label: 'Late night' }],
    specials: [['drink', "Bartender's choice", '$9'], ['drink', 'Old fashioned', '$8'], ['food', 'Truffle fries', '$6']],
    verifiedDaysAgo: 5, bias: { drinks: 1.8, ambience: 1.4, value: -1 }, description: 'Moody speakeasy-style bar with serious craft cocktails.' },
  { name: 'Banyan & Brine', kind: 'raw_bar', area: 'Port Salerno', city: 'Port Salerno', lat: 27.1447, lng: -80.1899, price: 2, amenities: ['waterfront', 'outdoor_seating', 'boat_docking', 'full_bar'],
    windows: [{ days: WEEKDAYS, start: '15:00', end: '18:00' }],
    specials: [['food', 'Oysters on the half shell', '$1.50 ea'], ['drink', 'Margaritas', '$5'], ['food', 'Fish dip', '$7']],
    verifiedDaysAgo: 41, bias: { food: 1.6, value: 1 }, description: 'Fish-house raw bar on the water with boat slips out back.' },
  { name: 'Tidewater Tap House', kind: 'brewery', area: 'Stuart', city: 'Stuart', lat: 27.1903, lng: -80.2439, price: 1, amenities: ['beer_wine_only', 'tvs', 'parking_lot', 'dog_friendly'],
    windows: [{ days: WEEKDAYS, start: '15:00', end: '18:00' }],
    specials: [['drink', '$2 off all pints', null], ['food', 'Pretzel & beer cheese', '$6']],
    verifiedDaysAgo: 120, bias: { value: 1, service: 0.5 }, description: 'Neighborhood taproom pouring rotating local brews.' },
  { name: 'Little Lagoon Wine Bar', kind: 'wine_bar', area: 'Jensen Beach', city: 'Jensen Beach', lat: 27.2532, lng: -80.2312, price: 2, amenities: ['outdoor_seating'],
    windows: [{ days: [3, 4, 5, 6, 0], start: '16:00', end: '18:00' }],
    specials: [['drink', 'Featured wines by the glass', '$6'], ['food', 'Cheese board', '$12']],
    verifiedDaysAgo: 18, bias: { ambience: 1.5, service: 1 }, description: 'Cozy wine bar with a patio and small plates.' },
  { name: 'Golden Hour Rooftop', kind: 'bar', area: 'Downtown Stuart', city: 'Stuart', lat: 27.1985, lng: -80.2549, price: 3, amenities: ['rooftop', 'full_bar', 'live_music'],
    windows: [{ days: DAILY, start: '16:00', end: '19:00' }],
    specials: [['drink', 'Frozé', '$8'], ['drink', 'Rail drinks', '$6'], ['food', 'Ceviche', '$10']],
    verifiedDaysAgo: 3, bias: { ambience: 2, value: -0.8 }, description: 'Rooftop bar with skyline-and-river views.' },
  { name: 'Mangrove Mill Kitchen', kind: 'restaurant', area: 'Palm City', city: 'Palm City', lat: 27.1689, lng: -80.2655, price: 2, amenities: ['full_bar', 'parking_lot', 'wheelchair_accessible'],
    windows: [{ days: WEEKDAYS, start: '16:00', end: '18:30' }],
    specials: [['food', 'Smash sliders', '$8'], ['drink', 'Draft beers', '$4'], ['drink', 'House margarita', '$6']],
    verifiedDaysAgo: 60, bias: { food: 1.2, service: 0.8 }, description: 'Family-friendly kitchen and bar with a big patio.' },
  { name: 'Sandbar Social Club', kind: 'tiki_bar', area: 'Hutchinson Island', city: 'Stuart', lat: 27.2211, lng: -80.1638, price: 2, amenities: ['waterfront', 'outdoor_seating', 'live_music'],
    windows: [{ days: DAILY, start: '14:00', end: '17:00' }],
    specials: [['drink', 'Rum punch', '$6'], ['drink', 'Buckets of beer', '$15'], ['food', 'Conch fritters', '$8']],
    verifiedDaysAgo: 75, bias: { ambience: 1.7, food: -0.5 }, description: 'Sand-floor tiki bar steps from the beach.' },
  { name: 'Saltline Sports Grill', kind: 'sports_bar', area: 'Palm City', city: 'Palm City', lat: 27.1655, lng: -80.2701, price: 1, amenities: ['tvs', 'full_bar', 'parking_lot'],
    windows: [{ days: WEEKDAYS, start: '15:00', end: '19:00' }],
    specials: [['food', 'Wings', '$0.75 ea'], ['drink', 'Domestic drafts', '$3']],
    verifiedDaysAgo: 200, bias: { value: 1.6, ambience: -1 }, description: 'Game-day grill with wings and cheap drafts.' },
  { name: 'The Gilded Gator', kind: 'restaurant', area: 'Hobe Sound', city: 'Hobe Sound', lat: 27.0601, lng: -80.1371, price: 3, amenities: ['full_bar', 'outdoor_seating'],
    windows: [{ days: [2, 3, 4, 5], start: '16:00', end: '18:00' }],
    specials: [['drink', 'Martinis', '$9'], ['food', 'Half-price appetizers', null]],
    verifiedDaysAgo: 25, bias: { food: 1.4, service: 1.2 }, description: 'Polished Florida-modern bistro with a lively bar.' },
  { name: 'Seagrape Supper Club', kind: 'restaurant', area: "Sewall's Point", city: "Sewall's Point", lat: 27.1812, lng: -80.2003, price: 3, amenities: ['full_bar'],
    windows: [{ days: [4, 5], start: '17:00', end: '18:30' }],
    specials: [['drink', 'Wine pours', '$7']], hhStatus: 'unverified', bias: { ambience: 1, food: 1 },
    description: 'Retro supper club. Happy-hour details submitted by a user and awaiting verification.' },
  { name: 'Hobe Harbor Taproom', kind: 'bar', area: 'Hobe Sound', city: 'Hobe Sound', lat: 27.0577, lng: -80.1344, price: 1, amenities: ['beer_wine_only', 'dog_friendly'],
    windows: [{ days: WEEKDAYS, start: '16:00', end: '18:00' }],
    specials: [['drink', 'Pints', '$4']], hhStatus: 'outdated', verifiedDaysAgo: 400, bias: { value: 1 },
    description: 'Laid-back taproom. Users reported the happy hour may have changed.' },
  { name: 'Lighthouse Lane Cantina', kind: 'restaurant', area: 'Jensen Beach', city: 'Jensen Beach', lat: 27.2499, lng: -80.2276, price: 1, amenities: ['outdoor_seating', 'full_bar'],
    windows: [{ days: WEEKDAYS, start: '15:00', end: '18:00' }, { days: [2], start: '11:00', end: '22:00', label: 'Taco Tuesday' }],
    specials: [['food', 'Street tacos', '$2.50'], ['drink', 'Margaritas', '$5'], ['drink', 'Mexican lager', '$3.50']],
    verifiedDaysAgo: 9, bias: { value: 1.4, food: 0.8 }, createdDaysAgo: 14, description: 'Colorful cantina with a strong taco game.' },
]

const users = [
  { username: 'allie_k', displayName: 'Allie K.', bio: 'Professional happy-hour enthusiast. Espresso martinis > everything.', homeCity: 'Stuart' },
  { username: 'marco_r', displayName: 'Marco R.', bio: 'Oysters and IPAs.', homeCity: 'Port Salerno' },
  { username: 'jen_beachlife', displayName: 'Jen', bio: 'Sunsets, rosé, repeat.', homeCity: 'Jensen Beach' },
  { username: 'tcoast_tom', displayName: 'Tom B.', bio: 'Cheap wings, cold beer.', homeCity: 'Palm City' },
  { username: 'sunset_sam', displayName: 'Sam', bio: null, homeCity: 'Hobe Sound' },
  { username: 'rosie_wine', displayName: 'Rosie', bio: 'Wine first, questions later.', homeCity: 'Stuart' },
]

const TAG_POOL = {
  cocktail_lounge: ['best-cocktails', 'date-night', 'upscale', 'girls-night'],
  bar: ['lively', 'casual', 'good-for-groups', 'cheap-drinks'],
  raw_bar: ['great-food', 'waterfront', 'local-favorite', 'casual'],
  brewery: ['casual', 'good-for-groups', 'cheap-drinks', 'relaxed'],
  wine_bar: ['great-wine', 'date-night', 'quiet', 'relaxed'],
  restaurant: ['great-food', 'date-night', 'local-favorite', 'good-for-groups'],
  tiki_bar: ['waterfront', 'lively', 'great-views', 'outdoor-seating'],
  sports_bar: ['cheap-drinks', 'lively', 'good-for-groups', 'casual'],
}
const REVIEWS = [
  'Bartender remembered our order the second time. Great vibe at sunset.',
  'Specials were legit — we stayed way past happy hour.',
  'Solid value. Gets crowded after 5:30 so come early.',
  'Drinks were good, food was just okay.',
  'Perfect spot for a low-key weeknight.',
  'Loved the patio. Service was a little slow but friendly.',
  null, null, null,
]

const PRIMARY = ['ambience', 'drinks', 'food', 'value', 'service', 'overall']
const clamp = (x) => Math.min(10, Math.max(1, Math.round(x * 2) / 2))

const establishments = places.map((p, i) => ({
  id: uuid('e0de0000', i + 1),
  slug: p.name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  name: p.name,
  kind: p.kind,
  neighborhood: p.area,
  city: p.city,
  state: 'FL',
  address: `Demo listing · ${p.area}`,
  lat: p.lat,
  lng: p.lng,
  priceLevel: p.price,
  amenities: p.amenities,
  description: `${p.description} (Fictional demo listing.)`,
  hhStatus: p.hhStatus ?? 'verified',
  verifiedDaysAgo: p.hhStatus === 'unverified' ? null : p.verifiedDaysAgo,
  hhSourceNote: p.hhStatus === 'unverified' ? 'Submitted by a user' : 'Demo data — not a real source',
  createdDaysAgo: p.createdDaysAgo ?? 200,
  windows: p.windows.map((w, j) => ({ id: uuid('a0de0000', i * 10 + j + 1), label: w.label ?? null, notes: null, ...w })),
  specials: p.specials.map(([kind, title, price], j) => ({ id: uuid('b0de0000', i * 10 + j + 1), kind, title, price, description: null })),
  bias: p.bias,
}))

const demoUsers = users.map((u, i) => ({ id: uuid('c0de0000', i + 1), email: `${u.username}@demo.aour.app`, ...u }))

const visits = []
let vn = 0
for (const u of demoUsers) {
  const taste = Object.fromEntries(PRIMARY.map((k) => [k, (rand() - 0.5) * 1.2]))
  const count = 4 + Math.floor(rand() * 6)
  const chosen = [...establishments].sort(() => rand() - 0.5).slice(0, count)
  for (const e of chosen) {
    const repeats = rand() < 0.25 ? 2 : 1
    for (let r = 0; r < repeats; r++) {
      vn++
      const base = 6.6 + rand() * 1.6
      const scores = {}
      for (const k of PRIMARY) {
        if (k === 'food' && rand() < 0.25) { scores[k] = null; continue }
        scores[k] = clamp(base + (e.bias[k] ?? 0) + taste[k] + (rand() - 0.5) * 1.5)
      }
      scores.overall = clamp((scores.ambience + scores.drinks + scores.value) / 3 + (rand() - 0.4))
      const pool = TAG_POOL[e.kind] ?? []
      const tags = pool.filter(() => rand() < 0.35)
      if (e.amenities.includes('waterfront') && rand() < 0.5 && !tags.includes('waterfront')) tags.push('waterfront')
      visits.push({
        id: uuid('d0de0000', vn),
        userId: u.id,
        establishmentId: e.id,
        daysAgo: 2 + Math.floor(rand() * 120),
        mode: rand() < 0.3 ? 'detailed' : 'quick',
        scores,
        tags,
        review: pick(REVIEWS),
      })
    }
  }
}

for (const e of establishments) delete e.bias
writeFileSync('src/data/demo-seed.json', JSON.stringify({ establishments, users: demoUsers, visits }, null, 1) + '\n')

// ---------------------------------------------------------------------------
// SQL for a local Supabase stack
// ---------------------------------------------------------------------------
const q = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const arr = (a) => `array[${a.map(q).join(',')}]::text[]`
let sql = `-- GENERATED by scripts/generate-demo-seed.mjs — DEMO DATA FOR LOCAL DEVELOPMENT ONLY.
-- All establishments below are fictional (is_demo = true). Never run against production.
-- Applied automatically by \`supabase db reset\` on a local stack.

begin;

`
for (const u of demoUsers) {
  sql += `insert into auth.users (id, email, raw_user_meta_data) values (${q(u.id)}, ${q(u.email)}, jsonb_build_object('username', ${q(u.username)}, 'display_name', ${q(u.displayName)}));\n`
  sql += `update public.profiles set bio = ${q(u.bio)}, home_city = ${q(u.homeCity)} where id = ${q(u.id)};\n`
}
sql += `\n`
for (const e of establishments) {
  sql += `insert into public.establishments (id, slug, name, kind, market_id, neighborhood, city, state, address, lat, lng, price_level, amenities, description, hh_status, hh_verified_at, hh_source_note, status, is_demo, created_at)
select ${q(e.id)}, ${q(e.slug)}, ${q(e.name)}, ${q(e.kind)}, id, ${q(e.neighborhood)}, ${q(e.city)}, 'FL', ${q(e.address)}, ${e.lat}, ${e.lng}, ${e.priceLevel}, ${arr(e.amenities)}, ${q(e.description)}, ${q(e.hhStatus)}, ${e.verifiedDaysAgo === null ? 'null' : `now() - interval '${e.verifiedDaysAgo} days'`}, ${q(e.hhSourceNote)}, 'published', true, now() - interval '${e.createdDaysAgo} days'
from public.markets where slug = 'treasure-coast';\n`
  for (const [j, w] of e.windows.entries()) {
    sql += `insert into public.happy_hour_windows (id, establishment_id, days, start_time, end_time, label, sort_order) values (${q(w.id)}, ${q(e.id)}, array[${w.days.join(',')}]::smallint[], ${q(w.start)}, ${q(w.end)}, ${q(w.label)}, ${j});\n`
  }
  for (const [j, s] of e.specials.entries()) {
    sql += `insert into public.happy_hour_specials (id, establishment_id, kind, title, price, sort_order) values (${q(s.id)}, ${q(e.id)}, ${q(s.kind)}, ${q(s.title)}, ${q(s.price)}, ${j});\n`
  }
}
sql += `\n`
for (const v of visits) {
  sql += `insert into public.visits (id, user_id, establishment_id, visited_on, mode, created_at) values (${q(v.id)}, ${q(v.userId)}, ${q(v.establishmentId)}, current_date - ${v.daysAgo}, ${q(v.mode)}, now() - interval '${v.daysAgo} days');\n`
  const rows = Object.entries(v.scores).map(([k, s]) => `(${q(v.id)}, ${q(k)}, ${s === null ? 'null' : s})`)
  sql += `insert into public.rating_scores (visit_id, category_key, score) values ${rows.join(', ')};\n`
  if (v.tags.length) sql += `insert into public.visit_tags (visit_id, tag) values ${v.tags.map((t) => `(${q(v.id)}, ${q(t)})`).join(', ')};\n`
  if (v.review) sql += `insert into public.reviews (visit_id, user_id, establishment_id, body, created_at) values (${q(v.id)}, ${q(v.userId)}, ${q(v.establishmentId)}, ${q(v.review)}, now() - interval '${v.daysAgo} days');\n`
}
sql += `\ncommit;\n`
writeFileSync('supabase/seed.sql', sql)
console.log(`Wrote ${establishments.length} demo establishments, ${demoUsers.length} users, ${visits.length} visits.`)
