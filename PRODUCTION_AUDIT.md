# Production audit

Audit date: 2026-10-16. Scope: Part 1 of the "Production audit & automated happy-hour discovery" brief.

## Bottom line

**No live deployment could be audited, because none exists yet.** Every check that could run was run, against the real code, the real migrations and the real Worker bundle.

What GitHub shows for `altnickler/aour`:

- The only branch is `claude/aour-happy-hour-app-pptgkb`. There is no `main` branch.
- No GitHub Actions run has ever executed (`total_count: 0`).
- So `deploy.yml`, which deploys after CI passes on `main`, has never deployed anything.

What this environment could reach:

- No Supabase or Cloudflare credentials are present.
- The egress proxy refuses every deployment and provider host: `aour.app`, `www.aour.app`, `*.pages.dev`, `*.workers.dev`, `*.supabase.co`, `api.supabase.com`, `api.cloudflare.com`, `photon.komoot.io`, `overpass-api.de`, `stac.overturemaps.org`, `places-api.foursquare.com`.

None of the results below are mocked or assumed. Each item says how it was verified, or that it was not.

## Results

Legend:

- ✅ verified in this session
- 🟡 verified locally against the same code and SQL that production would run, but not against a deployed project
- ⛔ not tested: needs credentials or network access (see "How to finish the audit")

### Authentication and sessions

- 🟡 Email-code sign-in, session persistence, sign-out and account deletion.
  - Covered by Playwright e2e in demo mode.
  - `tests/staging/supabase.test.ts` (password sessions, sign-out) is written but was not run.
- ⛔ Real Supabase Auth: custom SMTP delivery, the magic-link redirect to `VITE_SITE_URL`, and Sign in with Apple.

### Ratings, rankings, weights and community calculations

- 🟡 About 70 database tests run against the real migrations:
  - `save_visit` validation;
  - community stats recomputed by triggers;
  - Bayesian ranking parity between SQL and TypeScript (`tests/db/rating-integrity.test.ts`);
  - weight validation.
- 🟡 e2e covers rating flows, rankings and weights changing the order.
- ⛔ The same checks against a hosted project. The staging suite covers rating, weights and a community score update.

### Row-level security and admin authorisation

- 🟡 About 30 security tests:
  - private visits and notes are hidden;
  - users cannot rate as someone else;
  - admin RPCs are refused for non-admins;
  - pipeline RPCs are callable by `service_role` only;
  - pipeline tables are admin-read-only.
- ✅ Finding fixed: pipeline internals were publicly readable through the table-level `select` grant. These include:
  - `hh_confidence`, fingerprints and crawl state;
  - `hh_verified_by` and `created_by`.

  `establishments` now uses column grants. The public `nearby_establishments` RPC blanks those columns. Tests: `tests/db/pipeline.test.ts → internal pipeline signals stay private`.
- ⛔ The same checks on hosted Supabase. The staging suite repeats the key ones over PostgREST.

### Uploads

- 🟡 Storage policies were reviewed. `storage.objects` RLS is exercised with the shim.
- ⛔ Real Storage upload, the per-user folder rule and public URL serving. These are covered by the staging suite, which was not run.

### Location permission, map and distances

- ✅ e2e (Chromium, iPhone viewport) uses the real Geolocation API with mocked coordinates. It covers:
  - permission granted ("Near me" appears only after sharing);
  - permission denied (clear message, honest label);
  - manual search;
  - the 2–50 mi radius chips;
  - a far-away location, which shows an empty state rather than Stuart.
- ✅ Unit tests cover:
  - radius filtering and nearest-first ordering;
  - each venue's own time zone, windows that cross midnight, and dated exceptions;
  - tomorrow and weekend filters.
- 🟡 The map renders with MapLibre in e2e. Tiles come from OpenFreeMap, which is unreachable here; the "Map unavailable" list fallback was exercised.

### PWA

- ✅ The manifest and service worker are checked in e2e.
- ✅ `tests/staging/smoke.test.ts` passed 6/6 against the production Worker bundle running locally in `wrangler dev`. It checks:
  - security headers and the CSP;
  - the SPA fallback, the manifest and `sw.js`;
  - `/api/health` and API input validation;
  - that no server secrets appear in client JavaScript.
- ⛔ The same smoke test against the deployed URL. The deploy workflow now runs it automatically after each deploy.

### Error handling

- ✅ Covered by unit tests, e2e and the Worker API tests:
  - offline or failed queries show an error state with retry;
  - map failure shows the list fallback;
  - geocoding errors are surfaced in place;
  - the Worker returns JSON errors without stack traces.

### Discovery pipeline

- 🟡 Tests run the pipeline end to end against the real migrations, serving fictional fixture websites:
  - robots.txt and politeness;
  - 429 / Retry-After, 5xx, CAPTCHA challenges and timeouts;
  - budgets and admin overrides;
  - overlapping scheduler ticks and retries.
- 🟡 The Overture query was run with DuckDB on a local Parquet file in Overture's layout.
- ⛔ Real providers: Overture on S3, Overpass, Photon, Foursquare and the Claude API. All are blocked here, and **no venue data was fetched or loaded anywhere.**

### Accessibility

- ✅ axe (WCAG 2.1 AA) passes on the public screens and on the signed-in screens.

Test totals at the time of writing:

| Suite | Result |
|---|---|
| Unit | 99 passed |
| Database | 91 passed |
| e2e | 28 passed |
| Smoke (local Worker) | 6 passed |
| Staging | 7 written, not run (no credentials) |

## How to finish the audit

1. **Allow this cloud environment to reach the services.** In claude.ai, open the cloud environment menu → **Edit**, then set **Network access** to "Full" or add these allowed domains (docs: https://code.claude.com/docs/en/cloud-environments#network-access):
   - `*.supabase.co` and `api.supabase.com`
   - `api.cloudflare.com`, plus your site domain and its `*.workers.dev` URL
   - `photon.komoot.io`
   - `overturemaps-us-west-2.s3.us-west-2.amazonaws.com` and `stac.overturemaps.org`
   - `overpass-api.de`, only if OSM will be enabled
2. **Create a staging Supabase project.** It must be separate from production; the staging suite refuses to run against the production URL.
3. **Provide credentials as environment secrets.** Never paste them into chat or commit them. In the cloud environment's **Environment variables**, or in a GitHub environment named `staging`, set:
   - `STAGING_SUPABASE_URL`
   - `STAGING_SUPABASE_ANON_KEY`
   - `STAGING_SUPABASE_SERVICE_ROLE_KEY`
   - `PRODUCTION_SUPABASE_URL` (used only to refuse running against production)
   - `STAGING_SITE_URL` (a staging Worker deploy)
4. **Run the checks:**
   - `npm run test:staging` with `STAGING_CONFIRM=i-understand-this-writes-test-data`. This creates throwaway users and one labelled test listing, then deletes them.
   - `SITE_URL=<staging or production URL> npm run test:smoke`. This one is read-only and safe for production.
   - Or run **Actions → Staging integration**.
5. **Deploy production** following DEPLOYMENT.md:
   - merge to `main`;
   - set the `production` environment secrets and variables;
   - `wrangler secret put` for the Worker secrets.

   The deploy workflow runs migrations, deploys, then runs the read-only smoke test against `VITE_SITE_URL`.
6. **Check production by hand.** Install on a real iPhone, sign in with an emailed code, rate a place, change weights, upload a photo, deny and then grant location, and search another city. Do not run the staging suite against production.
