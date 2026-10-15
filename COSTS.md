# Costs

Pricing was researched in October 2026 from official pricing pages. Re-check before committing: vendors change prices, and items marked *(verify)* had conflicting sources. All figures are USD per month unless stated.

## Estimates by stage

MAU = monthly active *signed-in* users. Anonymous browsers cost almost nothing: static files are free, and listing reads are tiny and cached.

| Stage | MAU | Supabase | Cloudflare | Email (sign-in codes) | Maps | Other | **Total / month** |
|---|---|---|---|---|---|---|---|
| Build & beta | < 500 | Free $0 | Free $0 | Resend Free $0 (3k/mo, 100/day) | OpenFreeMap $0 | Domain ~$1 | **≈ $1** |
| Public launch (recommended) | ≤ 5k | **Pro $25** | $0 | $0–20 | $0 | ~$1 | **≈ $26–46** |
| Regional traction | ~25k | Pro $25 (+ compute upgrade ~$15–50 if needed) | $0 | Resend Pro $20 (50k/mo) | $0 (or MapTiler Flex ~$25–30 for an SLA) | ~$1 | **≈ $46–125** |
| Multi-city | ~100k | Pro $25 + compute ~$50–110 + modest egress | $0–5 | ~$20–35 | ~$30 | Sentry Team ~$26 (optional) | **≈ $125–230** |
| Large | ~250k | $25 + MAU overage (150k × $0.00325 ≈ $490) + compute ~$110+ | ~$5 | ~$90 | $100+ or self-host tiles | ~$30 | **≈ $850–1,000** |

**One-time / annual:** Apple Developer Program $99/year (only for the native app); domain ~$12/year.

### Why it stays cheap

- **Static hosting is free and unlimited** on Cloudflare Workers static assets: no Worker code runs.
- **One request per market** loads all discovery data, and the service worker and React Query cache it.
- Personal rankings are computed on the device. Community stats are precomputed rows, not live aggregates.
- Photos are compressed to ~200–400 kB before upload and served via the Supabase CDN, whose cached egress is cheaper. The service worker caches them on the phone.
- No paid place-data APIs: listings are our own data.
- Map tiles from OpenFreeMap cost $0, and the map library loads only on the Map screen.

## Service reference (as researched)

| Service | Free tier | Paid | Notes |
|---|---|---|---|
| **Supabase** | 500 MB DB, 50k MAU, 1 GB storage, 5 GB egress (+5 GB cached), 2 projects. **Pauses after 7 days idle**; no backups | **Pro $25/org**: 100k MAU, 8 GB disk, 250 GB egress, 100 GB storage, daily backups, $10 compute credit | Overage: MAU $0.00325, egress $0.09/GB, storage ~$0.021/GB. Spend cap on by default |
| **Supabase Auth email** | Built-in sender ~2/hour, team addresses only | — | **Custom SMTP required** for real users |
| **Cloudflare Workers** | 100k Worker requests/day; **static asset requests free and unlimited** | $5/mo (10M requests) | We run no Worker code |
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
