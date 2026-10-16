# Deployment

Production is a **Supabase** project (database, auth, storage) plus **Cloudflare Workers static assets** (the web app). Expect about an hour the first time.

## 0. Prerequisites

- Accounts: Supabase, Cloudflare, Resend (or any SMTP provider), GitHub.
- A domain, e.g. `aour.app`, managed in Cloudflare DNS (recommended).
- Node 22 and the Supabase CLI (`npm i -g supabase`, or use `npx supabase`).

## 1. Supabase project

1. Create a project in the US East region (closest to Florida). Save the **database password**.
2. Link it and apply migrations from this repo:
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push            # applies supabase/migrations/* — never seed.sql
   ```
3. **Settings → API**: copy the Project URL and the **anon / publishable** key. These are safe in the browser.
   - **Never** put the `service_role` / secret key in any `VITE_` variable, the repo, or the client.

## 2. Auth configuration (dashboard → Authentication)

| Setting | Value |
|---|---|
| **Sign In / Providers → Email** | Enabled. "Confirm email" **off** (the one-time code *is* the confirmation). OTP length 6, expiry 900 s |
| **URL Configuration** | Site URL `https://aour.app`. Redirect URLs `https://aour.app/**` (and your `*.workers.dev` URL while testing) |
| **Email Templates** | Paste `supabase/templates/magic_link.html` into **Magic Link** *and* **Confirm signup**. It must contain `{{ .Token }}`, because the installed iPhone app signs in with the 6-digit code |
| **SMTP Settings** | **Required.** The built-in sender allows only ~2 emails/hour, and only to team addresses. Use Resend: verify your domain, then host `smtp.resend.com`, port 465, user `resend`, password = Resend API key, sender `Aour <hello@aour.app>` |
| **Rate Limits** | After SMTP: emails ~30/hour to start; raise as you grow |
| **Sign in with Apple** (optional) | Needs an Apple Developer account, a Services ID and a .p8 key. Regenerate the client secret **at least every 6 months**. Then set `VITE_ENABLE_APPLE_SIGNIN=true` |

Account recovery is built in: a user who loses access just requests a new code to their email. There are no passwords.

## 3. First admin

Sign in once on the deployed site, then in **SQL Editor**:

```sql
update public.profiles set role = 'admin' where username = '<your username>';
```

Open `/admin` and add your first real listings. Record a verification source for each, then publish.

## 4. Cloudflare (web app)

Manual deploy:

```bash
cp .env.example .env.production.local      # fill VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_SITE_URL=https://aour.app
npx wrangler login
npm run deploy                             # vite build + wrangler deploy (wrangler.jsonc)
```

Then in the Cloudflare dashboard, open **Workers & Pages → aour → Settings → Domains & Routes** and add the custom domain `aour.app`.

- `wrangler.jsonc` deploys the PWA as static assets (SPA fallback for client routes) plus a small Worker (`worker/index.ts`).
  - Only `/api/*` runs Worker code, so page views stay free.
  - The Worker also runs the scheduled data pipeline (Cron Trigger every 15 min). See §7.
- `public/_headers` sets the CSP and security headers. If you use a custom Supabase domain or another map provider, add it to `connect-src` / `img-src`.
- Optional analytics: **Analytics & Logs → Web Analytics → Add site**. Copy the token into `VITE_CF_ANALYTICS_TOKEN`.

## 5. Automated deploys from GitHub

`.github/workflows/ci.yml` runs on every PR and push. It covers typecheck, lint, unit tests, database/RLS tests against PostGIS 17, and Playwright e2e plus accessibility on an iPhone viewport.

`.github/workflows/deploy.yml` runs after CI passes on `main`. It applies migrations, then builds and deploys. Configure the repository under **Settings → Secrets and variables → Actions**, using a `production` environment:

| Name | Kind | Value |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | secret | Supabase personal access token |
| `SUPABASE_DB_PASSWORD` | secret | Database password |
| `CLOUDFLARE_API_TOKEN` | secret | Token with "Workers Scripts: Edit" permission |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Your Cloudflare account ID |
| `SUPABASE_PROJECT_ID` | variable | Project ref |
| `VITE_SUPABASE_URL` | variable | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | variable | anon / publishable key (public by design) |
| `VITE_SITE_URL` | variable | `https://aour.app` |
| `VITE_ENABLE_APPLE_SIGNIN` | variable | `true` / `false` |
| `VITE_CF_ANALYTICS_TOKEN` | variable | optional |

The deploy job refuses to ship if `VITE_SUPABASE_URL` is empty, so a demo-mode build can never reach production. After deploying, it runs the read-only smoke test (`npm run test:smoke`) against `VITE_SITE_URL`.

Additional `production` environment entries for the pipeline (§7):

| Name | Kind | Value |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | secret | Service-role / `sb_secret_…` key, used **only** by the scheduled discovery workflow. Never a `VITE_` variable |
| `OVERTURE_RELEASE` | variable | Overture release to read, e.g. `2026-09-17.0` (https://docs.overturemaps.org/release/latest/) |
| `DISCOVERY_SOURCES` | variable | `overture` (default). Add `,osm` only after the ODbL review in DATA_SOURCES.md |

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | prod | Supabase project URL. If empty, the app runs in on-device demo mode |
| `VITE_SUPABASE_ANON_KEY` | prod | Public anon key |
| `VITE_SITE_URL` | prod | Canonical origin for share links and auth redirects |
| `VITE_ENABLE_APPLE_SIGNIN` | no | Show "Continue with Apple" |
| `VITE_MAP_STYLE_URL` | no | MapLibre style URL (default: OpenFreeMap Positron) |
| `VITE_CF_ANALYTICS_TOKEN` | no | Cloudflare Web Analytics |

## 6. Before public launch

- [ ] Supabase on **Pro** ($25/mo): no pausing, daily backups. Free projects pause after 7 idle days.
- [ ] Custom SMTP working: send yourself a code from a non-team address.
- [ ] Real, verified listings entered for the Stuart / Martin County launch areas.
- [ ] Privacy policy and terms reviewed by a lawyer (current pages are placeholders).
- [ ] Smoke test on a real iPhone:
  - Add to Home Screen, sign in with a code inside the installed app.
  - Rate a place, then check rankings.
  - Change weights, then check the ranking recalculates.
  - Follow an account; delete a test account.
- [ ] Spend cap left **on** in Supabase billing.
- [ ] Uptime check (e.g. Better Stack or a cron hitting `/api/health`), and Supabase email alerts enabled.
- [ ] Staging integration suite green; production smoke test green (see §8).
- [ ] Legal review of DATA_SOURCES.md items before enabling crawling, OSM or AI extraction in production.

## 7. Data pipeline (discovery and refresh)

Venue discovery and happy-hour refresh are automated, but they are not live until configured. Every step is safe to skip: without secrets, the Worker cron returns immediately and the discovery workflow logs "skipped".

1. **Upgrade the Worker to Workers Paid ($5/mo).** The free plan's 10 ms CPU limit per cron run is too small for page parsing.
2. **Set the Worker secrets** (never commit them; never prefix them with `VITE_`):

   ```bash
   npx wrangler secret put SUPABASE_URL               # https://<ref>.supabase.co
   npx wrangler secret put SUPABASE_ANON_KEY          # public key; used to check admin rights on /api/admin/run
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY  # service-role / sb_secret_ key (server only)
   # optional
   npx wrangler secret put ANTHROPIC_API_KEY          # enables AI-assisted extraction (also enable the llm_extract budget)
   npx wrangler secret put ANTHROPIC_MODEL            # defaults to claude-opus-5-5
   npx wrangler secret put FOURSQUARE_API_KEY         # id-only linking; also enable the foursquare budget
   ```

   Variables in `wrangler.jsonc`:
   - `PIPELINE_ENABLED` — set to `"false"` to pause the scheduler.
   - `WORKER_DISCOVERY` — comma list `osm,foursquare`; empty by default, because Overture discovery runs in GitHub Actions.
3. **Cron:** `*/15 * * * *` is declared in `wrangler.jsonc` and deployed with the Worker. Each tick:
   - queues due work and downgrades stale data;
   - claims at most 6 jobs, with no duplicate concurrent jobs;
   - fetches politely within the monthly budgets.
4. **Discovery from Overture:** `.github/workflows/discovery.yml` runs daily at 07:17 UTC. It also runs manually from **Actions → Discovery**. Only markets whose weekly discovery is due do work. It needs `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL` and `OVERTURE_RELEASE` in the `production` environment.
5. **Markets:**
   - The launch market exists from the migrations (radius 15 mi, discovery on, auto-publish on).
   - New markets come from **Admin → Data pipeline → Coverage requests → Create market**. Auto-publish is off by default, so discovered venues wait as drafts.
6. **Budgets:** review **Admin → Data pipeline → Jobs & budgets**. Defaults: 20k pages, 60 Overture queries and 30k geocodes per month; OSM, Foursquare and AI are off.
7. **Rate limit:** `/api/geocode` uses the Workers Rate Limiting binding `GEOCODE_LIMITER` (30 requests/min per IP), declared in `wrangler.jsonc`.
8. **Crawler page:** `https://aour.app/bot` explains AourBot and how to opt out. Keep `bot@aour.app` monitored.

## 8. Staging and integration tests

- Create a **separate** Supabase project for staging, and optionally a second Worker (e.g. `wrangler deploy --name aour-staging` with its own secrets).
- Create a GitHub environment `staging` with:
  - `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`, `STAGING_SITE_URL` and `PRODUCTION_SUPABASE_URL` (variables);
  - `STAGING_SUPABASE_SERVICE_ROLE_KEY` (secret).
- Run **Actions → Staging integration**. It creates throwaway users and one labelled test listing, verifies auth, ratings, weights, community scores, RLS, admin checks and uploads, then deletes everything it created. It refuses to run against the production URL.
- `npm run test:smoke` with `SITE_URL=…` is read-only and safe against production.

See PRODUCTION_AUDIT.md for what has and hasn't been verified on real infrastructure.

## Local development options

| Mode | How |
|---|---|
| Demo (no backend) | `npm run dev`. Fictional data in localStorage, sign-in code `123456` |
| Local Supabase | `supabase start` (Docker), then `.env.local` with the printed URL and anon key. Seed data loads automatically; Inbucket at :54324 shows emails |
| Remote dev project | A second free Supabase project; `.env.local` with its keys |

## Backups and recovery

- Pro includes daily backups (7-day retention). Point-in-time recovery is a paid add-on, worth it once data is valuable.
- Listings are the hardest data to recreate. Export them regularly from **Table Editor → establishments → Export CSV** (and the schedule and special tables).
