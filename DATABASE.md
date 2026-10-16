# Database

Postgres on Supabase. Everything is defined in versioned migrations in `supabase/migrations/` and applied in filename order:

| Migration | Contents |
|---|---|
| `…0100_schema.sql` | Enums and tables |
| `…0200_reference_data.sql` | Rating categories, tags, launch market (generated from `src/core/categories.ts`) |
| `…0300_functions_and_security.sql` | Helpers, rating SQL, stats triggers, rate limits, moderation triggers, **grants + RLS**, RPCs |
| `…0400_storage.sql` | Buckets and storage policies |
| `…0500_admin_listing_rpc.sql` | Atomic `admin_save_establishment` |
| `…0600_social_helpers.sql` | `my_following`, collection touch trigger |
| `20261016000100_discovery_enums.sql` | New statuses `establishment_reported`, `community_reported`; source kinds `official_website`, `open_data` |
| `20261016000200_discovery.sql` | PostGIS location + GiST index, provenance, findings, job queue, budgets, coverage, pipeline/admin RPCs, column-level privacy |

`supabase/seed.sql` holds **demo data for local stacks only**. It's never pushed to production.

## Tables

| Table | Purpose | Notes |
|---|---|---|
| `markets` | Launch areas (city + neighbourhoods, centre, time zone) | One row: Stuart & Martin County |
| `profiles` | 1:1 with `auth.users` | Created by trigger on sign-up. `role`, `suspended_at` are admin-only columns |
| `establishments` | Places | `status` draft/published/archived; `hh_status` verified/unverified/outdated/none; `hh_verified_at`; `amenities[]` (verified objective facts); `is_demo` |
| `happy_hour_windows` | Schedule: `days smallint[]`, `start_time`, `end_time`, label | `end <= start` = crosses midnight |
| `schedule_exceptions` | Holidays/events: closed or special hours for a date | unique per (place, date) |
| `happy_hour_specials` | Drink/food specials with price text | |
| `establishment_photos` | Licensed photos with `attribution`/`license` | admin-managed |
| `listing_sources` | **Verification history**: how and when info was confirmed | admin-only |
| `rating_categories` | Category definitions (6 primary + detailed) | New metrics = new rows, never new columns |
| `tags` | Descriptive user tags | Distinct from `establishments.amenities` |
| `user_preferences` | Personal weights (`jsonb`), validated by `aour_valid_weights` | |
| `visits` | **A rating of one visit** (the "ratings" entity) | `visited_on`, `mode`, `visibility`, `excluded_from_community` (admin) |
| `rating_scores` | Category scores per visit | `NULL` = N/A; check: 1–10 in 0.5 steps |
| `visit_tags` | Tags per visit | FK to `tags` |
| `visit_notes` | **Private** notes | Owner-only table, so public visit rows never carry them |
| `reviews` | Public written review per visit | `status` published/hidden/removed (moderation), `report_count` |
| `visit_photos` | Storage paths for visit photos | Path must start with the owner's id |
| `establishment_stats` | Server-maintained community aggregates | average, reviewers, visit_count, category averages, distribution, top tags |
| `follows` | follower → followee | Can't follow yourself or private profiles |
| `saved_places` | **Favorites** and **Want to Try** (`list` column) | Private to owner |
| `collections` / `collection_items` | Custom lists; public/private; `share_id` for links; `featured_at` (admin) | |
| `review_reports` | Reports on reviews | 3 open reports auto-hide |
| `establishment_submissions` | New places, corrections, "outdated" reports (`payload jsonb`) | Never auto-published |
| `moderation_actions` | Audit log of admin actions | |

Indexes cover every foreign-key lookup path: visits by user/date and by place, public recent visits, listings by market/status, lat/lng, verification date, report and submission queues.

## Row-level security summary

| Data | Read | Write |
|---|---|---|
| Published listings, schedules, specials, photos, stats | Everyone (including anonymous) | Admins (stats: triggers only) |
| Drafts, archived listings, verification sources | Admins | Admins |
| Visit + scores + tags + photos | Owner; everyone if visit **and** profile are public and not excluded; admins | Owner (and active, not suspended) |
| Private notes | Owner | Owner |
| Reviews | As visit, and only when `status = 'published'` (owner and admins always) | Owner edits text; status via admin RPC only |
| Profiles (full row) | Self, admins | Self (safe columns only) |
| Saved places, preferences | Owner | Owner |
| Collections | Owner, admins, everyone if public and owner active | Owner (`featured_at` via admin RPC) |
| Follows | Either party, admins | Follower |
| Reports, submissions | Reporter/submitter, admins | Insert own; status via admins |

## Functions (RPCs)

Public reads (`SECURITY DEFINER`, privacy rules inside):

| Function | Returns |
|---|---|
| `establishment_reviews(id, following_only, limit, before)` | Public reviews; set `following_only` for "Friends' ratings" |
| `get_profile(username)` | Hides bio and activity for private profiles |
| `profile_reviews(user_id)` | A user's public reviews |
| `profile_favorites(user_id)` | A user's favorites |
| `search_profiles(q)` | Public profiles matching the query |
| `collection_by_share(share_id)` | One collection by its share link |
| `featured_collections()` | Admin-featured public collections |
| `following_feed(limit, before)` | Activity from people you follow |
| `friend_activity(days)` | Recent visits by people you follow |
| `my_following()` | Profile cards for people you follow |

Writes:

| Function | Purpose |
|---|---|
| `save_visit(jsonb)` | `SECURITY INVOKER`, so all RLS applies. Creates or edits a visit with scores, tags, note, review and photos in one transaction; requires at least one primary score |
| `delete_my_account()` | Deletes the caller's account and all their data |

Admin (each checks `aour_require_admin()` and logs to `moderation_actions`):

| Function | Purpose |
|---|---|
| `admin_stats()` | Dashboard counts |
| `admin_list_users(q)` | User search |
| `admin_set_suspended` | Suspend or restore a user |
| `admin_set_role` | Grant or remove admin |
| `admin_moderate_review` | Publish, hide or remove review text |
| `admin_set_visit_excluded` | Exclude a visit from community scores |
| `admin_dismiss_report` | Close a report without action |
| `admin_list_reports` | Open reports with review content |
| `admin_review_submission` | Approve or reject a submission |
| `admin_set_featured` | Feature a public collection |
| `admin_verify_listing` | Records a source, stamps `hh_verified_at` |
| `admin_save_establishment(jsonb)` | Atomic listing + schedule + specials + exceptions |

Rating SQL: `aour_composite(scores jsonb, weights jsonb)` and `aour_refresh_establishment_stats(id)`, which statement-level triggers on `visits`, `rating_scores`, `visit_tags` and `profiles` call automatically.

Deny-by-default: `revoke execute on all functions … from public, anon, authenticated`, then explicit grants. Internal helpers (stats refresh, audit log, review JSON) are not callable by clients.

## Discovery pipeline schema (`…20261016000200_discovery.sql`)

New columns on `establishments`:

- **Location:** `location` (generated PostGIS geography, GiST index).
- **Provenance and hours:** `origin` (`manual`/`import`/`user_submission`), `attribution`, `business_hours` (opening hours, not happy hour).
- **Happy-hour source:** `hh_source_url`, `hh_source_published_at`, `hh_last_confirmed_at`, `hh_last_changed_at`, `hh_restrictions`.
- **Internal:** `hh_confidence`, `hh_conflict`, `hh_fingerprint`, `hh_managed_by` (`auto`/`admin`), `locked_fields`, plus scheduling fields `next_enrich_at`, `enrich_failures`, `last_enrich_*`, and `merged_into`.

New columns on `markets`: `radius_miles`, `discovery_enabled`, `auto_publish`, `last_discovered_at`, `next_discovery_at`.

| Table | Purpose |
|---|---|
| `establishment_external_ids` | Stable provider IDs (Overture GERS, OSM `node/123`, Foursquare id) → listing |
| `possible_duplicates` | Imports that resemble an existing listing, for admin merge or dismiss |
| `source_documents` | Pages fetched per listing: ETag / Last-Modified / content hash, attempt and success times, failures |
| `source_domains` | Per-host robots.txt cache, Crawl-delay, politeness window, sticky blocks |
| `hh_findings` | Every extraction with evidence quotes, confidence and status (`pending`/`applied`/`approved`/`rejected`/`superseded`) |
| `listing_changes` | Refresh history: who changed what (pipeline or admin) and from which source |
| `refresh_jobs` | Job queue. A unique partial index allows one active job per target |
| `provider_limits`, `provider_usage` | Monthly budgets per external provider |
| `coverage_requests` | Anonymous demand by ~11 km cell |

**Access:**

- All pipeline tables are **admin-read-only** for clients.
- Writes happen only through RPCs:
  - `pipeline_*` RPCs are granted to `service_role` only;
  - `admin_*` RPCs check `aour_require_admin()`.
- `establishments` uses **column-level `select` grants**. Confidence, fingerprints, crawl state, locks, `hh_verified_by` and `created_by` are not readable through the public API. `nearby_establishments` blanks those columns, and admins read them via `admin_listing_history`.

**Public RPCs:**

| Function | Returns |
|---|---|
| `nearby_establishments(lat, lng, radius_m, limit)` | Published places within ≤ 50 mi, nearest first, using the GiST index. Returns table rows so PostgREST can embed schedules, specials and stats |
| `request_coverage(lat, lng, label)` | Records an anonymous ~11 km demand signal; returns whether an active market already covers it |

**Pipeline RPCs (service role):**

| Function | Purpose |
|---|---|
| `pipeline_enqueue_due(limit)` | Queue due enrichment and discovery, downgrade stale automated data, reclaim stuck jobs |
| `pipeline_claim_jobs(worker, limit, kinds)` | `FOR UPDATE SKIP LOCKED` claim |
| `pipeline_finish_job(...)` | Succeed, skip, or fail with a retry time (until `max_attempts`) |
| `pipeline_consume_budget(provider, units)` | Atomic monthly budget spend |
| `pipeline_get_market`, `pipeline_mark_market_discovered` | Market discovery state |
| `pipeline_nearby_for_match`, `pipeline_upsert_place` | Matching inputs, then create/update/link with locks and storage rules. Foursquare is ID-only |
| `pipeline_enrichment_target`, `pipeline_record_document`, `pipeline_record_finding`, `pipeline_mark_outdated`, `pipeline_schedule_establishment` | Enrichment state and results. Can never set `verified`; never overwrites admin-managed listings |
| `pipeline_get_domain`, `pipeline_put_domain` | robots and politeness state. Blocks are sticky |

**Admin RPCs:**

- `admin_pipeline_overview`
- `admin_list_findings`, `admin_review_finding` (approve → verified + admin-managed)
- `admin_set_hh_managed` (lock, or hand back to automation)
- `admin_merge_establishments`, `admin_list_duplicates`, `admin_resolve_duplicate`
- `admin_enqueue_refresh`, `admin_set_provider_limit`
- `admin_save_market`, `admin_dismiss_coverage`
- `admin_listing_history`

**Triggers:** admin edits lock the edited imported fields (`aour_lock_on_admin_edit`), and admin edits to windows or specials make the listing admin-managed (`aour_admin_manages_hh`).

## Working with migrations

```bash
supabase migration new add_something      # creates supabase/migrations/<timestamp>_add_something.sql
npm run test:db                           # applies ALL migrations to a fresh database and runs RLS/parity tests
supabase db push                          # apply to the linked project (CI does this on main)
```

Rules:
- Never edit a migration that has run in production; add a new one.
- If you add a rating category, update `src/core/categories.ts` **and** add an insert migration. The parity test fails until they match.
- Keep `security definer` functions on `set search_path = ''` with schema-qualified names.

## Creating the first admin

After you sign in once in production, run this in the Supabase SQL editor:

```sql
update public.profiles set role = 'admin' where username = 'your_username';
```

From then on, admins can promote others from `/admin/users`.
