-- Aour core schema.
-- Conventions: snake_case, uuid PKs, timestamptz, RLS on every table (see next migration).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.visibility as enum ('public', 'private');
create type public.user_role as enum ('user', 'admin');
create type public.listing_status as enum ('draft', 'published', 'archived');
create type public.hh_status as enum ('verified', 'unverified', 'outdated', 'none');
create type public.establishment_kind as enum (
  'bar', 'restaurant', 'cocktail_lounge', 'wine_bar', 'brewery', 'tiki_bar', 'raw_bar', 'sports_bar', 'other'
);
create type public.visit_mode as enum ('quick', 'detailed');
create type public.review_status as enum ('published', 'hidden', 'removed');
create type public.saved_list as enum ('want_to_try', 'favorite');
create type public.submission_kind as enum ('new_place', 'correction', 'outdated');
create type public.submission_status as enum ('pending', 'approved', 'rejected');
create type public.report_reason as enum ('spam', 'offensive', 'not_relevant', 'fake', 'other');
create type public.report_status as enum ('open', 'resolved', 'dismissed');
create type public.special_kind as enum ('drink', 'food', 'other');
create type public.source_kind as enum (
  'in_person', 'phone', 'website', 'menu_photo', 'owner', 'user_submission', 'social'
);

-- Shared updated_at trigger
create function public.aour_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Markets (launch: Treasure Coast — Stuart / Martin County)
-- ---------------------------------------------------------------------------
create table public.markets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  name text not null,
  region text not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  timezone text not null,
  areas text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(display_name) between 1 and 50),
  avatar_url text check (avatar_url is null or avatar_url ~ '^https://'),
  bio text check (char_length(bio) <= 280),
  home_city text check (char_length(home_city) <= 60),
  market_id uuid references public.markets (id) on delete set null,
  visibility public.visibility not null default 'public',
  default_visit_visibility public.visibility not null default 'public',
  contribute_to_community boolean not null default true,
  role public.user_role not null default 'user',
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function public.aour_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Establishments & happy-hour data
-- ---------------------------------------------------------------------------
create table public.establishments (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,80}$'),
  name text not null check (char_length(name) between 1 and 100),
  kind public.establishment_kind not null default 'restaurant',
  market_id uuid not null references public.markets (id),
  neighborhood text,
  city text not null,
  state text not null default 'FL',
  address text not null,
  postal_code text,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  timezone text not null default 'America/New_York',
  phone text,
  website text check (website is null or website ~ '^https?://'),
  description text check (char_length(description) <= 1000),
  price_level smallint check (price_level between 1 and 4),
  amenities text[] not null default '{}',
  hh_status public.hh_status not null default 'unverified',
  hh_verified_at timestamptz,
  hh_verified_by uuid references public.profiles (id) on delete set null,
  hh_source_note text check (char_length(hh_source_note) <= 280),
  status public.listing_status not null default 'draft',
  -- Development/demo data. Never inserted by migrations; the UI always badges it.
  is_demo boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint verified_has_date check (hh_status <> 'verified' or hh_verified_at is not null)
);
create index establishments_market_status_idx on public.establishments (market_id, status);
create index establishments_geo_idx on public.establishments (lat, lng);
create index establishments_verified_idx on public.establishments (hh_verified_at);
create trigger establishments_touch before update on public.establishments
  for each row execute function public.aour_touch_updated_at();

create table public.happy_hour_windows (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  days smallint[] not null check (cardinality(days) between 1 and 7 and days <@ array[0,1,2,3,4,5,6]::smallint[]),
  start_time time not null,
  end_time time not null,
  label text check (char_length(label) <= 60),
  notes text check (char_length(notes) <= 280),
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  check (start_time <> end_time)
);
create index happy_hour_windows_est_idx on public.happy_hour_windows (establishment_id);

create table public.schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  date date not null,
  closed boolean not null default true,
  start_time time,
  end_time time,
  note text check (char_length(note) <= 140),
  unique (establishment_id, date),
  check (closed or (start_time is not null and end_time is not null))
);

create table public.happy_hour_specials (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  kind public.special_kind not null default 'drink',
  title text not null check (char_length(title) between 1 and 80),
  price text check (char_length(price) <= 30),
  description text check (char_length(description) <= 200),
  sort_order smallint not null default 0,
  created_at timestamptz not null default now()
);
create index happy_hour_specials_est_idx on public.happy_hour_specials (establishment_id);

create table public.establishment_photos (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  url text not null check (url ~ '^https://'),
  alt text check (char_length(alt) <= 140),
  -- Licensing: only photos we have rights to (owner-provided, staff-taken, or openly licensed).
  attribution text check (char_length(attribution) <= 140),
  license text check (char_length(license) <= 60),
  sort_order smallint not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index establishment_photos_est_idx on public.establishment_photos (establishment_id);

-- Where each piece of happy-hour information came from (admin-only).
create table public.listing_sources (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  kind public.source_kind not null,
  url text check (url is null or url ~ '^https?://'),
  note text check (char_length(note) <= 500),
  observed_on date not null default current_date,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index listing_sources_est_idx on public.listing_sources (establishment_id, observed_on desc);

-- ---------------------------------------------------------------------------
-- Rating definitions
-- ---------------------------------------------------------------------------
create table public.rating_categories (
  key text primary key check (key ~ '^[a-z_]{2,40}$'),
  label text not null,
  description text not null default '',
  group_key text not null check (group_key in ('primary', 'drinks', 'food', 'atmosphere', 'experience', 'happy_hour')),
  -- Integer percent; only 'primary' categories carry weight.
  default_weight smallint not null default 0 check (default_weight between 0 and 100),
  sort_order smallint not null,
  is_active boolean not null default true,
  check (group_key = 'primary' or default_weight = 0)
);

create table public.tags (
  key text primary key check (key ~ '^[a-z-]{2,40}$'),
  label text not null,
  emoji text not null default ''
);

create table public.user_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  weights jsonb not null,
  updated_at timestamptz not null default now()
);
create trigger user_preferences_touch before update on public.user_preferences
  for each row execute function public.aour_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Visits (one rated happy-hour experience) and their scores
-- ---------------------------------------------------------------------------
create table public.visits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  visited_on date not null check (visited_on between date '2000-01-01' and current_date + 1),
  mode public.visit_mode not null default 'quick',
  visibility public.visibility not null default 'public',
  -- Moderation: admins can exclude abusive/fake visits from community aggregates.
  excluded_from_community boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index visits_user_idx on public.visits (user_id, visited_on desc);
create index visits_establishment_idx on public.visits (establishment_id, created_at desc);
create index visits_public_recent_idx on public.visits (created_at desc) where visibility = 'public';
create trigger visits_touch before update on public.visits
  for each row execute function public.aour_touch_updated_at();

-- "Rating category scores". NULL score = explicit N/A. Absent row = not rated.
create table public.rating_scores (
  visit_id uuid not null references public.visits (id) on delete cascade,
  category_key text not null references public.rating_categories (key),
  score numeric(3, 1) check (score is null or (score between 1 and 10 and score * 2 = trunc(score * 2))),
  primary key (visit_id, category_key)
);

create table public.visit_tags (
  visit_id uuid not null references public.visits (id) on delete cascade,
  tag text not null references public.tags (key),
  primary key (visit_id, tag)
);
create index visit_tags_tag_idx on public.visit_tags (tag);

-- Private notes live in their own table so public visit rows never carry them.
create table public.visit_notes (
  visit_id uuid primary key references public.visits (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000)
);

-- Public written reviews (moderated independently of scores).
create table public.reviews (
  visit_id uuid primary key references public.visits (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  status public.review_status not null default 'published',
  report_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reviews_establishment_idx on public.reviews (establishment_id, created_at desc);
create trigger reviews_touch before update on public.reviews
  for each row execute function public.aour_touch_updated_at();

create table public.visit_photos (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references public.visits (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Path inside the 'visit-photos' bucket: "<user_id>/<uuid>.jpg"
  storage_path text not null check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-zA-Z_.-]{1,80}$'),
  created_at timestamptz not null default now()
);
create index visit_photos_visit_idx on public.visit_photos (visit_id);

-- Server-maintained community aggregates (see aour_refresh_establishment_stats).
create table public.establishment_stats (
  establishment_id uuid primary key references public.establishments (id) on delete cascade,
  average numeric(4, 2),
  reviewers integer not null default 0,
  visit_count integer not null default 0,
  category_averages jsonb not null default '{}',
  distribution jsonb not null default '[0,0,0,0,0,0,0,0,0,0]',
  top_tags jsonb not null default '[]',
  last_rated_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Social & lists
-- ---------------------------------------------------------------------------
create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index follows_followee_idx on public.follows (followee_id);

-- Favorites and Want to Try ("wishlist") share one table, keyed by list.
create table public.saved_places (
  user_id uuid not null references public.profiles (id) on delete cascade,
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  list public.saved_list not null,
  created_at timestamptz not null default now(),
  primary key (user_id, establishment_id, list)
);
create index saved_places_user_idx on public.saved_places (user_id, list, created_at desc);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  description text check (char_length(description) <= 280),
  visibility public.visibility not null default 'private',
  share_id text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  featured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index collections_user_idx on public.collections (user_id, updated_at desc);
create index collections_featured_idx on public.collections (featured_at desc) where featured_at is not null;
create trigger collections_touch before update on public.collections
  for each row execute function public.aour_touch_updated_at();

create table public.collection_items (
  collection_id uuid not null references public.collections (id) on delete cascade,
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  note text check (char_length(note) <= 280),
  position integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (collection_id, establishment_id)
);

-- ---------------------------------------------------------------------------
-- Trust & moderation
-- ---------------------------------------------------------------------------
create table public.review_reports (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references public.visits (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reason public.report_reason not null,
  details text check (char_length(details) <= 500),
  status public.report_status not null default 'open',
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (visit_id, reporter_id)
);
create index review_reports_status_idx on public.review_reports (status, created_at desc);

-- New places, corrections and "this is outdated" reports. Never auto-published.
create table public.establishment_submissions (
  id uuid primary key default gen_random_uuid(),
  kind public.submission_kind not null,
  establishment_id uuid references public.establishments (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  payload jsonb not null default '{}' check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) < 8000),
  status public.submission_status not null default 'pending',
  admin_note text check (char_length(admin_note) <= 500),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (kind = 'new_place' or establishment_id is not null)
);
create index submissions_status_idx on public.establishment_submissions (status, created_at desc);
create index submissions_user_idx on public.establishment_submissions (user_id, created_at desc);

create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.profiles (id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text not null,
  note text,
  created_at timestamptz not null default now()
);
create index moderation_actions_recent_idx on public.moderation_actions (created_at desc);
