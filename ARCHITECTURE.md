# Architecture

## Overview

```
 iPhone (Safari / Home-Screen PWA)
 ┌──────────────────────────────────────────────┐
 │ React 19 + React Router + TanStack Query     │
 │  screens/ ── data/hooks ── data/api (Api)    │
 │                 │            ├─ SupabaseApi  │──── HTTPS (anon key + user JWT) ────┐
 │  core/ (pure TS: rating, schedule, discovery)│                                     │
 │  Service worker (precache + image cache)     │                                     ▼
 └──────────────────────────────────────────────┘                   ┌──────────────────────────────┐
          ▲ static files (free, unlimited)                          │ Supabase                     │
 ┌────────┴─────────────┐   tiles   ┌───────────────┐               │  Postgres 17 + RLS + RPCs    │
 │ Cloudflare Workers   │◀──────────│ OpenFreeMap   │               │  Auth (email OTP, Apple)     │
 │ static assets + CDN  │           │ (vector tiles)│               │  Storage (photos, CDN)       │
 └──────────────────────┘           └───────────────┘               └──────────────────────────────┘
```

There is no custom server. The browser talks straight to Supabase, and **every permission is enforced in Postgres** through row-level security, column grants and `SECURITY DEFINER` RPCs that check the caller. Cloudflare only serves static files.

## Key decisions

| Decision | Choice | Why / alternatives |
|---|---|---|
| App type | Mobile-first **PWA** | Fastest to ship, one codebase, installable on iOS. A native shell comes later (IOS_RELEASE_PLAN.md). |
| UI | React + TS + Vite + Tailwind v4; custom accessible components | Small dependency surface. No component framework to fight; sheets, segmented controls and toggles are built in `components/ui.tsx` with ARIA semantics. |
| Data fetching | TanStack Query | Caching, optimistic updates and request dedupe for ~13 kB. |
| Backend | **Supabase** (Postgres, Auth, Storage) | Auth, RLS and storage are built in, so there's no server to write or maintain. Free tier to start, then $25/mo Pro. |
| Not chosen | Cloudflare D1 + Workers | Cheap at rest, but D1 has no auth or row-level security, so we'd build and own JWT verification, authorization for every endpoint, storage and email auth. That's more code and more risk for a solo founder, for savings of about $0–25/month. |
| Hosting | Cloudflare **Workers static assets** | Static requests are free and unlimited, with a global CDN. Cloudflare recommends Workers over Pages for new projects. |
| Maps | **MapLibre GL** + **OpenFreeMap** tiles | No API key, no usage fees, OSM attribution. Lazy-loaded on the Map screen only. Free tiers of MapTiler and Stadia forbid commercial use; Google/Mapbox bill per load. Swap via `VITE_MAP_STYLE_URL`. Directions link to Apple Maps (free, native on iPhone). |
| Place data | **Our own establishment database**, entered and verified by admins | Google Places and Yelp terms forbid storing their content (place IDs only) and require their maps and branding. Scraping is out. Users can suggest places and report outdated details, and admins verify before publishing. |
| Auth | Supabase **email one-time code** (+ magic link), optional **Sign in with Apple** | No passwords to store or reset. Codes work inside the installed PWA, where magic links would open Safari instead. |
| Analytics | Cloudflare Web Analytics (optional token) | Free, cookie-free, no consent banner needed. |
| Errors | Error boundary + console logging; Sentry free tier optional | Keeps the MVP dependency-light. Add `@sentry/react` when traffic justifies it. |

## Rating engine (`src/core/rating.ts`)

There is one canonical implementation. It's deterministic and fully unit-tested, and mirrored in SQL with a parity test.

1. **Scores:** 1.0–10.0 in 0.5 steps. `null` = explicit N/A. A missing key = not rated. Both are excluded, **never treated as 0**.
2. **Visit composite** = `Σ wᵢ·sᵢ / Σ wᵢ` over the six **primary** categories that were scored and have weight > 0. Weights renormalise automatically.
   - Default weights: Ambience 20, Drinks 20, Food 15, Value 20, Service 15, Overall 10.
   - Detailed metrics (beer selection, music, parking…) are stored and shown, but never enter the composite.
3. **Personal place score** = arithmetic mean of the user's visit composites, using the user's own weights. The latest visit score and the trend (latest − previous) are shown separately.
4. **Community average** = mean over reviewers of each reviewer's place score, using default weights. Someone who logs 20 visits counts once.
5. **Discovery order** uses a Bayesian-smoothed score, `(C·m + n·avg)/(C+n)` with `m = 7.0`, `C = 3`, so one perfect 10 doesn't outrank twenty 9s. The **raw average and reviewer count are always displayed**, and "early score" is noted under 3 reviewers.
6. **Determinism:** integer weights and half-point scores let us compute in integers and round half-up to 2 decimals. `public.aour_composite()` and `aour_refresh_establishment_stats()` do the same in SQL, and `tests/db/rating-integrity.test.ts` checks 300 random cases plus random visit sets for **exact** equality.

Personal rankings are computed **on the client** from the user's visits. That's a few hundred rows at most, so weight changes re-rank instantly with no server round trip. Community stats are **server-maintained** in `establishment_stats` by statement-level triggers, so discovery reads one small row per place.

## Discovery

- A launch market has hundreds of listings at most. The app loads the whole market in **one cached request** (listings + schedules + specials + stats) and filters and sorts locally: instant filters and minimal database reads.
- When a market passes ~1,500 listings, move `filterEstablishments` into an RPC with a bounding-box query (the lat/lng index already exists) or enable PostGIS.
- "Happening now" uses the **establishment's time zone** (`Intl`), handles windows that cross midnight, and respects schedule exceptions.
- **Freshness:** a listing is fresh if verified within 90 days, aging until 180, stale after that. Unverified and outdated listings show a warning; a happy hour is never shown as fact without a verification source.
- Shelves (Happening now, Picked for you, Highest rated, Trending with friends, Best cocktails/value/food, Waterfront, Date night, Hidden gems, New) are pure functions in `core/discovery.ts`.

## Security model

- The client only ever holds the **anon key** and the user's JWT. The service role key is never used by the app.
- **RLS on every table.** Highlights:
  - Visits are visible to the owner, or to everyone if the visit is public **and** the owner's profile is public.
  - Private notes live in a separate owner-only table.
  - Profiles rows are self/admin only; public profile data is served by RPCs that apply the privacy rules in one place.
- **Column grants** stop users writing `role`, `suspended_at`, `reviews.status`, `visits.excluded_from_community` or `collections.featured_at`, even on their own rows.
- **Admin actions** are `SECURITY DEFINER` RPCs that call `aour_require_admin()` and write to `moderation_actions`.
- **Abuse controls:**
  - Per-user rate limits (40 visits/day, 20 reports/day, 10 submissions/day, 200 follows/day, 30 collections/day).
  - Link-spam guard on reviews.
  - Three reports auto-hide a review until an admin decides.
  - Three distinct "outdated" reports downgrade a verified listing. It can only become *less* authoritative this way.
  - Suspended users can't write and disappear from public views.
- **Location privacy:** device location is requested only on demand, rounded to about 1 km, used on-device, and never sent or stored.
- **Photos:** re-encoded client-side (resized, EXIF/GPS stripped) and stored under `<user_id>/<uuid>.jpg`. Buckets are public-read with unguessable names, a cost tradeoff documented in `supabase/migrations/…_storage.sql`.
- **Account deletion:** in-app (Settings), cascades every user-owned row, deletes storage objects and refreshes community stats.
- **CSP and security headers:** `public/_headers`.

`tests/db/security.test.ts` runs these rules through the real roles and grants, and was mutation-tested: deliberately weakening a policy makes it fail.

## Performance

- Discover is eagerly loaded; every other screen is code-split. MapLibre (~280 kB gz) loads only on `/map` and is cached by the service worker on first use.
- The production build drops the unused backend: the demo dataset never ships with Supabase builds.
- One request per market for discovery, a 5-minute stale time, optimistic saves, and skeletons everywhere.
- Images use `loading="lazy"`, are compressed before upload, and are served from the Supabase CDN. The SW cache-first strategy keeps repeat views free.

## Native iOS path

Everything in `src/core` is framework-free TypeScript, and `src/data/api.ts` is a narrow contract. A Capacitor shell can reuse the whole app; a SwiftUI rewrite can port `core/` directly, since its behaviour is pinned by the tests. See IOS_RELEASE_PLAN.md.

## Key technical risks

| Risk | Mitigation |
|---|---|
| **Listing data goes stale** (the #1 business risk) | Verification dates and sources, freshness badges, user "outdated" reports with auto-downgrade, and an admin "Needs verification" queue. Budget operator time: about 1 call per listing per quarter. |
| Supabase built-in email is limited to ~2/hour and team addresses only | **Custom SMTP (Resend) is required before launch** (DEPLOYMENT.md). |
| Free Supabase projects pause after 7 days idle | Move to Pro ($25) at public launch, which also adds daily backups. |
| OpenFreeMap has no SLA | The map screen degrades to a list. Switching providers is one env var (MapTiler Flex ~$25–30/mo). |
| Apple rejects a thin web wrapper (4.2) | The native plan adds real native value: push for saved places, Sign in with Apple, widgets, offline. |
| Thin community at launch | The product is personal-first and useful with zero friends; shelves only appear when there's data. |
