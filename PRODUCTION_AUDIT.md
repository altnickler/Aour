# Production audit

## Live discovery results — 2026-10-16 (GitHub Actions, service role, read-only reports)

- **Database:** all five migrations are applied, including `20261017000200_discovery_catchup.sql`. Internal columns are hidden from the public API. Status runs 38944876401 and later.
- **Import (Overture):** 1,209 candidates in the 15-mile market; 1,002 listings created and 112 held as drafts for duplicate review (run 38940823710).
  - The first classifier also let in non-venues: insurance agencies, bakeries and fast-food chains.
  - After the strict classifier, the reversible clean-up archived 262 untouched listings and corrected the venue type of 28 (run 38942856202).
  - Now: **752 published, 99 drafts, 263 archived. Nothing was deleted.**
- **Happy hours** (all 919 venue websites checked once; final run 38957555280):
  - **54** places publish a happy hour on their own website and show it in the app.
  - **4** more need verification.
  - **0** are admin-verified. Only an admin can mark one verified.
  - Within 5 miles: Stuart 29, Palm City 26, Jensen Beach 26, Hobe Sound 1.
  - No place is wrongly marked "outdated" any more.
- **Awaiting admin review:** 15 happy-hour findings (the website mentions a happy hour but no times could be read), and 112 possible duplicates, held as drafts.
- **Website checks — problems found live and fixed:**
  1. A robots.txt that failed to load was treated as "disallowed" for 30 days, which hit 65 domains. It is now a retried error, and nothing is crawled until robots.txt answers.
  2. Cloudflare's page script was mistaken for a bot wall on normal pages. Genuine walls (about 20 domains) stay blocked.
  3. The Worker cron called `fetch` with the wrong `this` ("Illegal invocation").
  4. The Worker ran its tick in `waitUntil` (cut off after about 30 s) with 6 jobs, so the jobs it claimed were left "running". It now awaits a 2-job tick. The daily GitHub run also checks websites.
  5. A page-wide CMS date (`article:modified_time`) marked current happy hours "outdated", and so did a redesigned homepage hiding an unchanged happy-hour page.

  The remaining failures are mostly the venues' own problems: dead domains (DNS not found), expired or broken TLS certificates, and sites that redirect to ordering platforms or parked-domain pages.
- **Tools:** `maintenance.yml` tasks `robots` / `robots --probe` (read-only), `robots --recheck [--apply]` and `refresh-outdated [--apply]`.

## Live database check — project viqhsibrtdgcwoiitzgz (2026-10-16, via the read-only Production status workflow)

Verified live through GitHub Actions run 38938999968:

- **Deployment:** commit `f389983`, backend `supabase`; Worker `pipeline: true`, no missing settings.
- **Migrations present:** core, storage/admin/social, discovery (PostGIS, markets) and automatic areas.
- **Column privacy NOT in effect:** the public API could read internal columns. This indicates production applied an early draft of `20261016000200_discovery.sql`. Reproduced locally on that draft: **every Overture venue without opening hours failed to import** (check-constraint violation).
  - Fix: `20261017000200_discovery_catchup.sql`. It is idempotent and data-safe (only `CREATE OR REPLACE FUNCTION`, `GRANT`, `REVOKE`).
  - Verified locally on the draft schema: import works, privacy applies, it is re-runnable, and 93 DB tests pass.
- **Market:** "Stuart & Martin County" (15 mi radius) covers Stuart (0 mi), Palm City (2.2), Jensen Beach (4.2) and Hobe Sound (11.9). Discovery is on but has never run.
- **Public nearby query:** 0 places near each of the four towns. Nothing has been imported yet.
- **Not yet checked:** pipeline internals, because the `SUPABASE_SERVICE_ROLE_KEY` GitHub secret is not set.


## Live deployment audit — https://aour.mute-frost-03a9.workers.dev (2026-10-16, second pass)

### Verified live (evidence from GitHub)

| Finding | Evidence |
|---|---|
| The repository has one branch, `claude/aour-happy-hour-app-pptgkb`; the head before this pass was `168d2af` | GitHub branch list |
| The Worker was **not** deployed by `deploy.yml` | GitHub lists exactly one workflow run in the repository, and it is not a deploy. So the deployment came from `wrangler deploy` or Cloudflare Workers Builds, outside GitHub Actions. The deployed commit cannot be identified from GitHub |
| **Discovery has never imported anything** | That one run was the scheduled `Discovery` run #1 (2026-10-16 12:22 UTC, commit `168d2af`). Its `Run pipeline` step was **skipped** and `Not configured` ran instead: the GitHub `production` environment has no `SUPABASE_SERVICE_ROLE_KEY`. No Overture import has happened |

### Blocked — not verified

- **The deployment itself.** This environment's egress proxy refuses `aour.mute-frost-03a9.workers.dev` (connect rejected). So none of these could be observed: the HTML, `/api/health`, rendering, navigation, location, the map, Supabase connectivity, migrations, auth, Worker logs, cron executions, or the database contents (imported establishments and verified schedules).
- **Supabase and Cloudflare APIs.** Unreachable, and no credentials are available in this session.

### Risks that apply to this deployment until checked

- **Demo mode in production.**
  - The cause: a dashboard or `wrangler` deploy bypasses `deploy.yml`'s "refuse demo build" guard. A build without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` then serves fictional listings, demo sign-in (code 123456) and first-account-is-admin.
  - Fixed in code: demo mode now refuses to run on public hostnames and shows "Aour is almost ready" instead.
  - To check what is actually live: open `/version.json` and look for `"backend": "supabase"`.
- **Worker secrets missing.** If they are missing, the cron pipeline and geocoding do nothing. `/api/health` now lists the names of any missing secrets.
- **Dashboard variables wiped on deploy.** `wrangler deploy` used to remove plain variables set in the dashboard. Fixed: `keep_vars: true`.

### Fixed in this pass (tested locally, not yet observed live)

- `/version.json` (commit, branch, builder, backend mode) and `/api/health` reporting `build` and `missing`. These make it possible to identify the deployed commit and spot configuration gaps.
- Demo-mode guard for public hostnames.
- `keep_vars` in `wrangler.jsonc`.
- Discovery picks the newest Overture release automatically, so `OVERTURE_RELEASE` is now optional.
- **Automatic areas.** "Near me" with no nearby listings sends an anonymous coverage request (~11 km cell plus time zone). The pipeline turns it into a discovery area, capped by the `auto_market` budget (3/month), so venues near a user's real location get imported without an admin.
- Smoke test checks the deployed build is not demo mode and logs the deployed commit.

Local results:

| Suite | Result |
|---|---|
| Unit | 100 passed |
| Database | 93 passed |
| e2e | 28 passed |
| Smoke vs local Worker runtime | 7 passed |

### To finish the live audit

1. **Allow this cloud environment to reach the hosts.** Cloud environment menu → **Edit** → **Network access**: choose a broader level, or add these under **Allowed domains**:
   - `aour.mute-frost-03a9.workers.dev`
   - your Supabase host `<ref>.supabase.co`
   - optionally `api.cloudflare.com`

   Then run `SITE_URL=https://aour.mute-frost-03a9.workers.dev npm run test:smoke`. Steps: https://code.claude.com/docs/en/cloud-environments#network-access
2. **Configure the GitHub `production` environment:**
   - secret `SUPABASE_SERVICE_ROLE_KEY`;
   - variable `VITE_SUPABASE_URL`.

   Then run **Actions → Discovery** manually.
3. **Configure the Cloudflare Worker:**
   - build variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SITE_URL`;
   - secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`;
   - the Workers Paid plan.

   See DEPLOYMENT.md §4b and §7.
4. **Apply migrations** to the production Supabase project, including `20261017000100_auto_markets.sql` (`supabase db push`).
5. **Optional, for deeper verification:**
   - a Cloudflare API token with Workers read access, to read deployments, cron history and logs;
   - read-only access to the production database, to count imported venues.

   Provide these as environment secrets, never in chat.

---

## First pass (before deployment)


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
