# Costs

Pricing was researched in October 2026 from official pricing pages. Re-check before committing: vendors change prices, and items marked *(verify)* had conflicting sources. All figures are USD per month unless stated.

## Projections for 100, 1,000 and 10,000 active users

"Active users" means monthly active people using the app, signed in or not. The target is **under $50/month at low traffic**, and it is met.

| Line item | 100 users | 1,000 users | 10,000 users | Notes |
|---|---|---|---|---|
| Supabase | $25 (Pro) — or $0 on Free while in beta | $25 | $25 (+ $10–50 compute add-on if CPU climbs) | Pro recommended from launch: Free pauses after 7 idle days and has no backups |
| Cloudflare Workers Paid | $5 | $5 | $5 | Needed for cron CPU time; includes 10M requests / 30M CPU-ms. Static assets stay free |
| Email (sign-in codes) | $0 | $0 | $20 (Resend Pro) | Free tier is 3,000 emails/month |
| Geocoding (Photon public) | $0 | $0 | $0 (or ~$0–25 for a paid geocoder) | Edge-cached; budget 30k/month |
| Map tiles (OpenFreeMap) | $0 | $0 | $0 | No SLA; MapTiler ~$25–30 if one is needed |
| Venue discovery (Overture via GitHub Actions) | $0 | $0 | $0 | ~1–3 min per market per week; public repos are free, private repos use the free 2,000 min/month |
| Website enrichment (Worker cron) | $0 | $0 | $0 | Inside the Workers Paid allowance (see below) |
| AI-assisted extraction (optional, **off by default**) | $0–6 | $0–6 | $0–6 | Capped by the `llm_extract` budget (300/month) |
| Foursquare Places API (optional, off) | $0 | $0 | $0 | Not used |
| Domain | ~$1 | ~$1 | ~$1 | |
| **Total** | **≈ $31** (≈ $6 on Supabase Free) | **≈ $31** | **≈ $51–107** | Add up to $6 when AI extraction is enabled |

### Assumptions

- **Per active user per month:**
  - about 8 sessions;
  - about 15 nearby queries of roughly 40 KB each (5-minute client cache);
  - about 10 place pages;
  - about 2 city/address searches.

  That is roughly 1 MB of database egress per user per month: about 10 GB at 10,000 users, against 250 GB included in Pro.
- **Signed-in share** is 30–50% of users, with a sign-in email every few weeks. 10,000 users therefore send more than Resend's free 3,000 emails/month.
- **Pipeline cost scales with venues, not users:**
  - a market of ~300 venues is re-checked every 14–60 days, about 10 venues/day;
  - each check is at most 4 pages, so about 1,200 page fetches per market per month;
  - the default `website_fetch` budget of 20,000/month covers about 15 such markets;
  - CPU is roughly 5–30 ms per page, so about 0.6M CPU-ms/month, against 30M included.
- **AI extraction**, when enabled, runs only on pages that mention happy hour but can't be parsed deterministically. Each call is about 3.5k input and 0.3k output tokens. At $4 / $20 per million tokens (Claude Opus 5.5) that is about $0.02 per call.
- **Page loads never trigger paid calls.** External APIs are reached only by:
  - the scheduler;
  - an admin's "refresh now";
  - a user typing a search, which then goes through the edge cache, a per-IP rate limit and a monthly budget.

### Budgets (database-enforced)

`provider_limits` caps every external provider per calendar month. Calls stop when a budget is spent or disabled; change them in **Admin → Data pipeline**.

| Provider | Default | State |
|---|---|---|
| `website_fetch` | 20,000 pages | on |
| `overture` | 60 queries | on |
| `geocode` | 30,000 | on |
| `osm_overpass` | 0 | off, until ODbL review |
| `foursquare` | 0 | off |
| `llm_extract` | 300 | off |

### Why it stays cheap

- **Static hosting is free and unlimited** on Cloudflare Workers static assets. Only `/api/*` runs Worker code.
- **One request per area** loads discovery data: an indexed PostGIS radius query. The service worker and React Query cache it.
- Personal rankings are computed on the device. Community stats are precomputed rows, not live aggregates.
- Photos are compressed to ~200–400 kB before upload and served via the Supabase CDN.
- Venue data comes from free open datasets. Happy-hour data comes from the venues' own sites, re-checked only when due, with conditional requests that make unchanged pages almost free.
- Map tiles from OpenFreeMap cost $0, and the map library loads only on the Map screen.

### Larger scale (earlier MVP estimates, still valid)

| Stage | MAU | Approx. total / month |
|---|---|---|
| Multi-city | ~100k | ≈ $130–235 (Supabase compute, egress, email, an SLA map provider) |
| Large | ~250k | ≈ $855–1,005 (Supabase MAU overage dominates) |

**One-time / annual:** Apple Developer Program $99/year (only for the native app); domain ~$12/year.

## Service reference (as researched)

| Service | Free tier | Paid | Notes |
|---|---|---|---|
| **Supabase** | 500 MB DB, 50k MAU, 1 GB storage, 5 GB egress (+5 GB cached), 2 projects. **Pauses after 7 days idle**; no backups | **Pro $25/org**: 100k MAU, 8 GB disk, 250 GB egress, 100 GB storage, daily backups, $10 compute credit | Overage: MAU $0.00325, egress $0.09/GB, storage ~$0.021/GB. Spend cap on by default |
| **Supabase Auth email** | Built-in sender ~2/hour, team addresses only | — | **Custom SMTP required** for real users |
| **Cloudflare Workers** | 100k Worker requests/day, 10 ms CPU per invocation; **static asset requests free and unlimited** | $5/mo (10M requests, 30M CPU-ms, cron included) | Paid plan needed for the pipeline's CPU time |
| GitHub Actions | Public repos free; private 2,000 min/mo (Free plan) | per-minute after | Runs Overture discovery |
| Overture Maps | Free (AWS Open Data) | — | CDLA-Permissive-2.0 |
| Photon (komoot) | Free public instance, fair use | Self-host or a paid geocoder | No SLA |
| Claude API | — | Opus 5.5: $4 / $20 per million input / output tokens | Optional, off by default |
| Cloudflare Web Analytics | Free, unlimited, cookie-free | — | |
| **Resend** | 3,000 emails/mo, 100/day | Pro $20 (50k/mo) | SMTP on free plan *(verify)* |
| **OpenFreeMap** | Free, no key, no limits | Donations | No SLA; attribution required (MapLibre adds it) |
| MapTiler | 5k sessions — **non-commercial only** | Flex ~$25–30 *(verify)* | Fallback if we need an SLA |
| Mapbox GL | 50k loads/mo | $5/1k after | Proprietary SDK + token |
| Google Maps | 10k Essentials/SKU/mo | ~$7/1k Dynamic Maps | Places data can't be stored and must show on a Google map |
| Apple MapKit JS | 250k map views/day with the developer program | — | Option once we pay for the Apple program anyway |
| Sentry | Developer: 1 user, ~5k errors *(verify)* | Team ~$26 | Optional |
| Cloudflare D1 (not used) | 5M rows read/day, 100k written/day, 500 MB | Workers Paid $5: 25B reads, 50M writes, 5 GB | No auth or RLS: we would have to build it |

## Why not cheaper or "single vendor"?

An all-Cloudflare stack (Workers + D1 + R2 + a third-party auth) could run at $0–5 at small scale. But it means writing and securing our own API layer, auth integration, authorization for every query, and email delivery. Supabase Pro costs $25/month for auth, RLS, storage, backups and a dashboard a non-engineer can use, which is a better trade for a solo founder. The data layer is isolated behind `src/data/api.ts`, so a later migration is possible without touching screens.

## Cost guardrails

- Keep the Supabase **spend cap** on until revenue justifies otherwise.
- Watch the **Usage** page monthly. Egress and MAU are the levers.
- Images are capped at 4 per visit and 3 MB each by the bucket limits, and are already compressed client-side.
- If tile traffic ever becomes significant, self-host OpenFreeMap or move to a paid provider via `VITE_MAP_STYLE_URL`.
- Provider budgets in **Admin → Data pipeline** cap every external call per month. Set `PIPELINE_ENABLED=false` on the Worker to pause the scheduler entirely.
