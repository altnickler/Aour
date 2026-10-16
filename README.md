# Aour — your happy hours, ranked

**Aour** (short for *Allie's Hour*) is a mobile-first app for discovering, rating, ranking and remembering happy hours. You **Discover** nearby happy hours, **Rate** one in about 30 seconds, and **Remember** it in a personal ranked list that updates instantly.

It's an installable **Progressive Web App** (React + TypeScript + Vite + Tailwind). The backend is **Supabase** (Postgres + PostGIS + Auth + Storage). The site is hosted on **Cloudflare Workers**: static assets, plus a small Worker for `/api/*` and the scheduled data pipeline. The launch market is **Stuart / Martin County, Florida**, but search works anywhere.

Venues are discovered from open map data (Overture Maps). Happy-hour details are refreshed from each venue's own website by a polite, robots.txt-respecting crawler. Only an Aour admin can mark details **Verified**; everything else is labelled by source ("Reported by venue", "Community reported", "Needs verification", "Outdated").

| | |
|---|---|
| Architecture & decisions | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Schema, RLS, functions | [DATABASE.md](DATABASE.md) |
| Going live step by step | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Monthly cost estimates | [COSTS.md](COSTS.md) |
| Venue & happy-hour data sources, licensing | [DATA_SOURCES.md](DATA_SOURCES.md) |
| What has been verified in production | [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) |
| Path to the App Store | [IOS_RELEASE_PLAN.md](IOS_RELEASE_PLAN.md) |

## Try it in 60 seconds (demo mode)

```bash
npm install
npm run dev          # http://localhost:5173 — open it on your phone via the LAN URL Vite prints
```

With no Supabase keys configured, Aour runs in **on-device demo mode**:
- It uses 14 **fictional** places around Stuart, FL. Each is badged "Demo listing".
- Your data stays in this browser's localStorage.
- Sign in with any email and the code **123456**. The first account you create on a device is an admin, so you can try `/admin`.

Demo data is never used by a production build. The deploy workflow refuses to ship without Supabase keys, and the demo dataset is tree-shaken out of production bundles.

## Run against a real backend

1. Create a Supabase project and apply the migrations (see [DEPLOYMENT.md](DEPLOYMENT.md)).
2. `cp .env.example .env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. `npm run dev`

If Docker is available, `supabase start` runs a full local stack with demo seed data from `supabase/seed.sql`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm test` | Unit tests (rating engine, schedules, discovery) |
| `npm run test:db` | Applies every migration to a throwaway Postgres and tests RLS, rating integrity and SQL↔TS parity. Needs `DATABASE_URL` (see [tests/db/README.md](tests/db/README.md)) |
| `npm run test:e2e` | Playwright on an iPhone viewport: core flows, location (granted/denied/far away), axe accessibility, PWA |
| `npm run test:smoke` | Read-only checks of a deployed site: `SITE_URL=https://…` (safe against production) |
| `npm run test:staging` | Integration tests against a Supabase **staging** project (see the header of `tests/staging/supabase.test.ts`) |
| `npm run pipeline -- discover` / `enrich` | Run the data pipeline from Node (needs server-side Supabase secrets; see DEPLOYMENT.md §7) |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm run deploy` | Build and deploy to Cloudflare (`wrangler login` first) |
| `node scripts/generate-demo-seed.mjs` | Regenerate demo JSON + `supabase/seed.sql` |
| `npm run icons` | Re-render PWA icons from the brand mark |

## Project layout

```
src/
  core/        Framework-free domain logic, reusable by a future native app:
               rating engine, schedules/time zones, discovery, types
  data/        Api contract + Supabase and demo implementations, React Query hooks
  core/ingest/ Pure pipeline logic: matching, parsing, extraction, robots, confidence, scheduling
  pipeline/    Pipeline runtime: polite fetcher, enrichment, discovery, job runner, providers, optional LLM
  app/         Providers (auth, location), router, shell, PWA, monitoring
  components/  Design system (ui.tsx) and domain components (cards, sliders, sheets)
  screens/     One file per screen; admin/ holds the dashboard (incl. Data pipeline)
worker/        Cloudflare Worker: /api/health, /api/geocode, /api/admin/run, cron
scripts/       pipeline.ts (Node runner), demo seed and icon generators
supabase/
  migrations/  Versioned SQL: schema, reference data, RLS, functions, storage
  seed.sql     DEMO data for local stacks only (generated)
tests/         unit/ (Vitest), db/ (Vitest + real Postgres/PostGIS), staging/ (smoke + staging), fixtures/ (FICTIONAL)
e2e/           Playwright specs
```

## Brand assets

No logo files were in the repository, so `src/components/brand.tsx` and `public/icons/` use a **placeholder mark** in the brand palette (chocolate `#3B251B`, butter `#FFDE75`, gold `#F4B942`, cream `#FFF9EC`). To use the official Aour logo:
1. Add `public/brand/logo.svg` and `mark.svg`.
2. Update `Logo` and `Mark` in `brand.tsx`.
3. Update the SVG in `scripts/generate-icons.mjs` and run `npm run icons`.

## Status against the MVP definition of done

| # | Requirement | Status |
|---|---|---|
| 1–2 | Open on iPhone, install to Home Screen | ✅ PWA manifest, icons, service worker, iOS install guidance |
| 3 | Browse real listings | ✅ Admin-managed listings with verification, plus automated discovery and refresh (configure per DEPLOYMENT.md §7). ⚠️ **No real listings exist yet**: nothing has been deployed or imported |
| 4 | Create an account | ✅ Passwordless email code (Supabase Auth); Sign in with Apple behind a flag |
| 5 | Save to wishlist | ✅ |
| 6 | Detailed rating | ✅ Quick + Detailed, N/A, tags, notes, review, photos |
| 7 | Rankings update immediately | ✅ Live rank preview while rating, and the list recalculates on save |
| 8 | Change preferences, rankings recalculate | ✅ Settings → "What matters most to you" |
| 9 | Community reviews and scores | ✅ Count-aware (Bayesian) ordering; raw average shown separately |
| 10 | Follow users, see public ratings | ✅ |
| 11 | Data persists | ✅ Postgres (or localStorage in demo mode) |
| Admin | Manage listings and verification without code | ✅ `/admin` |

Not done yet: production deployment needs your Supabase and Cloudflare accounts (steps in DEPLOYMENT.md), and nothing has been verified on live infrastructure (PRODUCTION_AUDIT.md). An App Store release has **not** happened; see IOS_RELEASE_PLAN.md.
