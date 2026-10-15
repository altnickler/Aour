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

- `wrangler.jsonc` deploys **static assets only**, with SPA fallback for client routes. No Worker code runs, so requests are free.
- `public/_headers` sets the CSP and security headers. If you use a custom Supabase domain or another map provider, add it to `connect-src` / `img-src`.
- Optional analytics: **Analytics & Logs → Web Analytics → Add site**. Copy the token into `VITE_CF_ANALYTICS_TOKEN`.

## 5. Automated deploys from GitHub

`.github/workflows/ci.yml` runs on every PR and push. It covers typecheck, lint, unit tests, database/RLS tests against Postgres 17, and Playwright e2e plus accessibility on an iPhone viewport.

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

The deploy job refuses to ship if `VITE_SUPABASE_URL` is empty, so a demo-mode build can never reach production.

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
- [ ] Uptime check (e.g. Better Stack or a cron hitting `/`), and Supabase email alerts enabled.

## Local development options

| Mode | How |
|---|---|
| Demo (no backend) | `npm run dev`. Fictional data in localStorage, sign-in code `123456` |
| Local Supabase | `supabase start` (Docker), then `.env.local` with the printed URL and anon key. Seed data loads automatically; Inbucket at :54324 shows emails |
| Remote dev project | A second free Supabase project; `.env.local` with its keys |

## Backups and recovery

- Pro includes daily backups (7-day retention). Point-in-time recovery is a paid add-on, worth it once data is valuable.
- Listings are the hardest data to recreate. Export them regularly from **Table Editor → establishments → Export CSV** (and the schedule and special tables).
