-- Aour: helper functions, triggers, grants, row-level security and RPCs.
--
-- Security model (see ARCHITECTURE.md → "Security"):
--   * The browser only ever holds the anon key + the user's JWT. Every table has RLS.
--   * Column-level grants stop users from writing privileged columns
--     (profiles.role, profiles.suspended_at, reviews.status, visits.excluded_from_community …).
--   * Privileged/admin operations are SECURITY DEFINER functions that check aour_is_admin()
--     and write an audit row to moderation_actions.
--   * SECURITY DEFINER functions always `set search_path = ''` and schema-qualify names.

-- ---------------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------------
create function public.aour_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and suspended_at is null
  )
$$;

-- Signed in and not suspended.
create function public.aour_is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and suspended_at is null)
$$;

create function public.aour_user_active(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = p_user and suspended_at is null)
$$;

create function public.aour_profile_is_public(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles where id = p_user and visibility = 'public' and suspended_at is null
  )
$$;

create function public.aour_can_view_visit(p_visit uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.visits v
    where v.id = p_visit
      and (
        v.user_id = auth.uid()
        or (v.visibility = 'public' and not v.excluded_from_community and public.aour_profile_is_public(v.user_id))
        or public.aour_is_admin()
      )
  )
$$;

create function public.aour_owns_visit(p_visit uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.visits where id = p_visit and user_id = auth.uid())
    and public.aour_is_active()
$$;

create function public.aour_owns_collection(p_collection uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.collections where id = p_collection and user_id = auth.uid())
    and public.aour_is_active()
$$;

-- ---------------------------------------------------------------------------
-- Rating engine (SQL mirror of src/core/rating.ts — parity enforced by tests)
-- ---------------------------------------------------------------------------
create function public.aour_valid_weights(w jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(w) = 'object'
    and coalesce((
      select bool_and(
        case when jsonb_typeof(w -> k) = 'number'
          then (w ->> k)::numeric between 0 and 100 and (w ->> k)::numeric = trunc((w ->> k)::numeric)
          else false end)
      from unnest(array['ambience', 'drinks', 'food', 'value', 'service', 'overall']) k
    ), false)
    and coalesce((
      select sum(case when jsonb_typeof(w -> k) = 'number' then (w ->> k)::numeric else 0 end)
      from unnest(array['ambience', 'drinks', 'food', 'value', 'service', 'overall']) k
    ), 0) > 0
$$;

alter table public.user_preferences add constraint weights_valid check (public.aour_valid_weights(weights));

-- Composite for a {category: score|null} object. p_weights NULL = default weights.
create function public.aour_composite(p_scores jsonb, p_weights jsonb default null) returns numeric
language sql stable set search_path = '' as $$
  select case when sum(w) > 0 then round(sum(w * s * 2) / (2 * sum(w)), 2) end
  from (
    select
      case when jsonb_typeof(p_scores -> rc.key) = 'number' then (p_scores ->> rc.key)::numeric end as s,
      case when p_weights is null then rc.default_weight::numeric
           else coalesce((p_weights ->> rc.key)::numeric, 0) end as w
    from public.rating_categories rc
    where rc.group_key = 'primary'
  ) x
  where s is not null and w > 0
$$;

-- Recompute community aggregates for one establishment.
create function public.aour_refresh_establishment_stats(p_establishment uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.establishments where id = p_establishment) then
    return;
  end if;

  insert into public.establishment_stats as es (
    establishment_id, average, reviewers, visit_count, category_averages, distribution, top_tags, last_rated_at, updated_at
  )
  with contributing as (
    select v.id, v.user_id, v.created_at
    from public.visits v
    join public.profiles p on p.id = v.user_id
    where v.establishment_id = p_establishment
      and v.visibility = 'public'           -- private ratings never feed public stats
      and not v.excluded_from_community
      and p.contribute_to_community
      and p.suspended_at is null
  ),
  scores as (
    select c.id as visit_id, c.user_id, rs.category_key, rs.score, rc.default_weight::numeric as w
    from contributing c
    join public.rating_scores rs on rs.visit_id = c.id
    join public.rating_categories rc on rc.key = rs.category_key
    where rc.group_key = 'primary' and rs.score is not null
  ),
  visit_comp as (
    select visit_id, user_id, round(sum(w * score * 2) / (2 * sum(w)), 2) as composite
    from scores where w > 0
    group by visit_id, user_id
  ),
  user_mean as (
    select user_id, round(avg(composite), 2) as m from visit_comp group by user_id
  ),
  user_cat as (
    select s.user_id, s.category_key, round(avg(s.score), 2) as m
    from scores s
    where s.user_id in (select user_id from user_mean)
    group by s.user_id, s.category_key
  ),
  cat as (
    select category_key, round(avg(m), 2) as a from user_cat group by category_key
  ),
  buckets as (
    select least(10, greatest(1, floor(m)::int)) as b, count(*) as n from user_mean group by 1
  ),
  tagc as (
    select t.tag, count(*) as n
    from contributing c join public.visit_tags t on t.visit_id = c.id
    group by t.tag
    order by n desc, t.tag collate "C" asc
    limit 8
  )
  select
    p_establishment,
    (select round(avg(m), 2) from user_mean),
    (select count(*) from user_mean),
    (select count(*) from contributing),
    coalesce((select jsonb_object_agg(category_key, a) from cat), '{}'::jsonb),
    (select jsonb_agg(coalesce(b.n, 0) order by g) from generate_series(1, 10) g left join buckets b on b.b = g),
    coalesce((select jsonb_agg(jsonb_build_object('key', tag, 'count', n) order by n desc, tag collate "C") from tagc), '[]'::jsonb),
    (select max(created_at) from contributing),
    now()
  on conflict (establishment_id) do update set
    average = excluded.average,
    reviewers = excluded.reviewers,
    visit_count = excluded.visit_count,
    category_averages = excluded.category_averages,
    distribution = excluded.distribution,
    top_tags = excluded.top_tags,
    last_rated_at = excluded.last_rated_at,
    updated_at = excluded.updated_at;
end $$;

-- Statement-level triggers keep stats fresh no matter how rows change.
create function public.aour_stats_from_visits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    for r in select distinct establishment_id from new_rows loop
      perform public.aour_refresh_establishment_stats(r.establishment_id);
    end loop;
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    for r in select distinct establishment_id from old_rows loop
      perform public.aour_refresh_establishment_stats(r.establishment_id);
    end loop;
  end if;
  return null;
end $$;

create trigger visits_stats_ins after insert on public.visits
  referencing new table as new_rows for each statement execute function public.aour_stats_from_visits();
create trigger visits_stats_upd after update on public.visits
  referencing new table as new_rows old table as old_rows for each statement execute function public.aour_stats_from_visits();
create trigger visits_stats_del after delete on public.visits
  referencing old table as old_rows for each statement execute function public.aour_stats_from_visits();

-- Child tables (scores, tags) resolve the establishment through visits.
create function public.aour_stats_from_children() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    for r in select distinct v.establishment_id from new_rows n join public.visits v on v.id = n.visit_id loop
      perform public.aour_refresh_establishment_stats(r.establishment_id);
    end loop;
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    for r in select distinct v.establishment_id from old_rows o join public.visits v on v.id = o.visit_id loop
      perform public.aour_refresh_establishment_stats(r.establishment_id);
    end loop;
  end if;
  return null;
end $$;

create trigger rating_scores_stats_ins after insert on public.rating_scores
  referencing new table as new_rows for each statement execute function public.aour_stats_from_children();
create trigger rating_scores_stats_upd after update on public.rating_scores
  referencing new table as new_rows old table as old_rows for each statement execute function public.aour_stats_from_children();
create trigger rating_scores_stats_del after delete on public.rating_scores
  referencing old table as old_rows for each statement execute function public.aour_stats_from_children();
create trigger visit_tags_stats_ins after insert on public.visit_tags
  referencing new table as new_rows for each statement execute function public.aour_stats_from_children();
create trigger visit_tags_stats_del after delete on public.visit_tags
  referencing old table as old_rows for each statement execute function public.aour_stats_from_children();

-- Community contribution / suspension changes affect every place the user rated.
create function public.aour_stats_from_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if new.contribute_to_community is distinct from old.contribute_to_community
     or (new.suspended_at is null) <> (old.suspended_at is null) then
    for r in select distinct establishment_id from public.visits where user_id = new.id loop
      perform public.aour_refresh_establishment_stats(r.establishment_id);
    end loop;
  end if;
  return null;
end $$;
create trigger profiles_stats after update on public.profiles
  for each row execute function public.aour_stats_from_profile();

-- New establishments get an empty stats row so embeds always return an object.
create function public.aour_init_stats() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.establishment_stats (establishment_id) values (new.id) on conflict do nothing;
  return null;
end $$;
create trigger establishments_init_stats after insert on public.establishments
  for each row execute function public.aour_init_stats();

-- ---------------------------------------------------------------------------
-- New user → profile
-- ---------------------------------------------------------------------------
alter table public.profiles add constraint username_not_reserved check (
  username not in ('admin', 'aour', 'support', 'help', 'settings', 'about', 'api', 'root', 'staff', 'moderator')
);

create function public.aour_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  candidate text;
  attempts int := 0;
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  base := lower(regexp_replace(coalesce(nullif(meta ->> 'username', ''), split_part(coalesce(new.email, ''), '@', 1), ''), '[^a-zA-Z0-9_]', '', 'g'));
  if char_length(base) < 3 then base := base || 'friend'; end if;
  base := left(base, 18);
  candidate := base;
  while exists (select 1 from public.profiles where username = candidate)
        or candidate in ('admin', 'aour', 'support', 'help', 'settings', 'about', 'api', 'root', 'staff', 'moderator') loop
    attempts := attempts + 1;
    candidate := base || (1000 + floor(random() * 9000))::int;
    if attempts > 25 then
      candidate := 'user' || substr(replace(new.id::text, '-', ''), 1, 12);
      exit;
    end if;
  end loop;

  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    candidate,
    left(coalesce(nullif(trim(meta ->> 'display_name'), ''), nullif(trim(meta ->> 'full_name'), ''), initcap(replace(base, '_', ' '))), 50)
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.aour_handle_new_user();

-- ---------------------------------------------------------------------------
-- Abuse prevention
-- ---------------------------------------------------------------------------
-- Append-only log of rate-limited actions. Counting rows that still exist would let
-- users reset limits by deleting and re-inserting, so we count events instead.
-- No policies: clients can't read or write it; only the trigger below (definer) can.
create table public.rate_limit_events (
  user_id uuid not null,
  action text not null,
  created_at timestamptz not null default now()
);
create index rate_limit_events_idx on public.rate_limit_events (user_id, action, created_at desc);
alter table public.rate_limit_events enable row level security;

-- Generic per-user rate limit: tg_argv = (user column, max events, window interval).
create function public.aour_rate_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  col text := tg_argv[0];
  max_rows int := tg_argv[1]::int;
  win interval := tg_argv[2]::interval;
  uid uuid;
  n int;
begin
  -- Server-side jobs (no end-user JWT) and admins are exempt.
  if auth.uid() is null or public.aour_is_admin() then return new; end if;
  execute format('select ($1).%I', col) into uid using new;
  select count(*) into n from public.rate_limit_events
   where user_id = uid and action = tg_table_name and created_at > now() - win;
  if n >= max_rows then
    raise exception 'You''re doing that a lot — please try again later.' using errcode = 'P0429';
  end if;
  insert into public.rate_limit_events (user_id, action) values (uid, tg_table_name);
  -- Opportunistic cleanup keeps the log small.
  delete from public.rate_limit_events where user_id = uid and action = tg_table_name and created_at < now() - interval '2 days';
  return new;
end $$;

create trigger visits_rate_limit before insert on public.visits
  for each row execute function public.aour_rate_limit('user_id', '40', '1 day');
create trigger reports_rate_limit before insert on public.review_reports
  for each row execute function public.aour_rate_limit('reporter_id', '20', '1 day');
create trigger submissions_rate_limit before insert on public.establishment_submissions
  for each row execute function public.aour_rate_limit('user_id', '10', '1 day');
create trigger follows_rate_limit before insert on public.follows
  for each row execute function public.aour_rate_limit('follower_id', '200', '1 day');
create trigger collections_rate_limit before insert on public.collections
  for each row execute function public.aour_rate_limit('user_id', '30', '1 day');

-- Reviews: reject link spam.
create function public.aour_review_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from regexp_matches(new.body, '(https?://|www\.)', 'gi')) > 1 then
    raise exception 'Reviews can include at most one link.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger reviews_guard before insert or update of body on public.reviews
  for each row execute function public.aour_review_guard();

-- Three open reports hide a review until an admin looks at it.
create function public.aour_on_review_report() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.reviews
     set report_count = report_count + 1,
         status = case
           when status = 'published' and (
             select count(*) from public.review_reports r where r.visit_id = new.visit_id and r.status = 'open'
           ) >= 3 then 'hidden'::public.review_status
           else status end
   where visit_id = new.visit_id;
  return null;
end $$;
create trigger review_reports_count after insert on public.review_reports
  for each row execute function public.aour_on_review_report();

-- Three distinct users reporting "outdated" within 30 days downgrades a verified listing.
-- (Only ever makes a listing *less* authoritative; never publishes new facts.)
create function public.aour_on_outdated_report() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'outdated' and (
    select count(distinct user_id) from public.establishment_submissions
    where establishment_id = new.establishment_id and kind = 'outdated' and status = 'pending'
      and created_at > now() - interval '30 days'
  ) >= 3 then
    update public.establishments set hh_status = 'outdated'
     where id = new.establishment_id and hh_status = 'verified';
  end if;
  return null;
end $$;
create trigger submissions_outdated after insert on public.establishment_submissions
  for each row execute function public.aour_on_outdated_report();

-- ---------------------------------------------------------------------------
-- Grants (explicit; never rely on platform defaults)
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

grant select on public.markets, public.rating_categories, public.tags to anon, authenticated;
grant insert, update on public.markets to authenticated;

grant select on public.establishments, public.happy_hour_windows, public.schedule_exceptions,
  public.happy_hour_specials, public.establishment_photos, public.establishment_stats to anon, authenticated;
grant insert, update, delete on public.establishments, public.happy_hour_windows, public.schedule_exceptions,
  public.happy_hour_specials, public.establishment_photos to authenticated;
grant select, insert, update, delete on public.listing_sources to authenticated;

grant select on public.profiles to authenticated;
grant update (username, display_name, avatar_url, bio, home_city, market_id, visibility,
  default_visit_visibility, contribute_to_community) on public.profiles to authenticated;

grant select, insert, update, delete on public.user_preferences to authenticated;

grant select on public.visits, public.rating_scores, public.visit_tags, public.visit_photos, public.reviews to anon, authenticated;
grant insert (id, user_id, establishment_id, visited_on, mode, visibility) on public.visits to authenticated;
grant update (visited_on, mode, visibility) on public.visits to authenticated;
grant delete on public.visits to authenticated;
grant insert, update, delete on public.rating_scores to authenticated;
grant insert, delete on public.visit_tags to authenticated;
grant insert, delete on public.visit_photos to authenticated;
grant select, insert, update, delete on public.visit_notes to authenticated;
grant insert (visit_id, user_id, establishment_id, body) on public.reviews to authenticated;
grant update (body) on public.reviews to authenticated;
grant delete on public.reviews to authenticated;

grant select, insert, delete on public.follows, public.saved_places to authenticated;
grant select on public.collections, public.collection_items to anon, authenticated;
grant insert (id, user_id, name, description, visibility) on public.collections to authenticated;
grant update (name, description, visibility) on public.collections to authenticated;
grant delete on public.collections to authenticated;
grant insert, update, delete on public.collection_items to authenticated;

grant select on public.review_reports to authenticated;
grant insert (visit_id, reporter_id, reason, details) on public.review_reports to authenticated;
grant select on public.establishment_submissions to authenticated;
grant insert (kind, establishment_id, user_id, payload) on public.establishment_submissions to authenticated;
grant select on public.moderation_actions to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.markets enable row level security;
alter table public.profiles enable row level security;
alter table public.establishments enable row level security;
alter table public.happy_hour_windows enable row level security;
alter table public.schedule_exceptions enable row level security;
alter table public.happy_hour_specials enable row level security;
alter table public.establishment_photos enable row level security;
alter table public.listing_sources enable row level security;
alter table public.rating_categories enable row level security;
alter table public.tags enable row level security;
alter table public.user_preferences enable row level security;
alter table public.visits enable row level security;
alter table public.rating_scores enable row level security;
alter table public.visit_tags enable row level security;
alter table public.visit_notes enable row level security;
alter table public.reviews enable row level security;
alter table public.visit_photos enable row level security;
alter table public.establishment_stats enable row level security;
alter table public.follows enable row level security;
alter table public.saved_places enable row level security;
alter table public.collections enable row level security;
alter table public.collection_items enable row level security;
alter table public.review_reports enable row level security;
alter table public.establishment_submissions enable row level security;
alter table public.moderation_actions enable row level security;

-- Reference data
create policy "markets readable" on public.markets for select using (is_active or public.aour_is_admin());
create policy "markets admin insert" on public.markets for insert to authenticated with check (public.aour_is_admin());
create policy "markets admin update" on public.markets for update to authenticated using (public.aour_is_admin()) with check (public.aour_is_admin());
create policy "categories readable" on public.rating_categories for select using (true);
create policy "tags readable" on public.tags for select using (true);

-- Profiles: full rows only for self/admin. Public profile info is served by RPCs below.
create policy "profiles self read" on public.profiles for select to authenticated
  using (id = auth.uid() or public.aour_is_admin());
create policy "profiles self update" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and public.aour_is_active());

-- Establishments: public sees published; admins manage everything.
create policy "establishments readable" on public.establishments for select
  using (status = 'published' or public.aour_is_admin());
create policy "establishments admin insert" on public.establishments for insert to authenticated with check (public.aour_is_admin());
create policy "establishments admin update" on public.establishments for update to authenticated using (public.aour_is_admin()) with check (public.aour_is_admin());
create policy "establishments admin delete" on public.establishments for delete to authenticated using (public.aour_is_admin());

-- Listing children inherit the parent's visibility (subquery is itself RLS-filtered).
do $$
declare t text;
begin
  foreach t in array array['happy_hour_windows', 'schedule_exceptions', 'happy_hour_specials', 'establishment_photos', 'establishment_stats'] loop
    execute format('create policy "%1$s readable" on public.%1$I for select using (exists (select 1 from public.establishments e where e.id = establishment_id))', t);
  end loop;
  foreach t in array array['happy_hour_windows', 'schedule_exceptions', 'happy_hour_specials', 'establishment_photos', 'listing_sources'] loop
    execute format('create policy "%1$s admin insert" on public.%1$I for insert to authenticated with check (public.aour_is_admin())', t);
    execute format('create policy "%1$s admin update" on public.%1$I for update to authenticated using (public.aour_is_admin()) with check (public.aour_is_admin())', t);
    execute format('create policy "%1$s admin delete" on public.%1$I for delete to authenticated using (public.aour_is_admin())', t);
  end loop;
end $$;
create policy "listing_sources admin read" on public.listing_sources for select to authenticated using (public.aour_is_admin());

-- Preferences: owner only.
create policy "preferences owner" on public.user_preferences for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.aour_is_active());

-- Visits
create policy "visits readable" on public.visits for select using (
  user_id = auth.uid()
  or (visibility = 'public' and not excluded_from_community and public.aour_profile_is_public(user_id))
  or public.aour_is_admin()
);
create policy "visits owner insert" on public.visits for insert to authenticated with check (
  user_id = auth.uid()
  and public.aour_is_active()
  and exists (select 1 from public.establishments e where e.id = establishment_id and e.status = 'published')
);
create policy "visits owner update" on public.visits for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.aour_is_active());
-- A visit whose review is under moderation can't be deleted by its author (that would
-- let them re-post the same text as a fresh, published review). Account deletion and
-- admins are unaffected.
create policy "visits owner delete" on public.visits for delete to authenticated
  using (
    public.aour_is_admin()
    or (user_id = auth.uid()
        and not exists (select 1 from public.reviews r where r.visit_id = visits.id and r.status <> 'published'))
  );

do $$
declare t text;
begin
  foreach t in array array['rating_scores', 'visit_tags'] loop
    execute format('create policy "%1$s readable" on public.%1$I for select using (public.aour_can_view_visit(visit_id))', t);
    execute format('create policy "%1$s owner insert" on public.%1$I for insert to authenticated with check (public.aour_owns_visit(visit_id))', t);
    execute format('create policy "%1$s owner update" on public.%1$I for update to authenticated using (public.aour_owns_visit(visit_id)) with check (public.aour_owns_visit(visit_id))', t);
    execute format('create policy "%1$s owner delete" on public.%1$I for delete to authenticated using (public.aour_owns_visit(visit_id))', t);
  end loop;
end $$;

create policy "visit_photos readable" on public.visit_photos for select using (public.aour_can_view_visit(visit_id));
create policy "visit_photos owner insert" on public.visit_photos for insert to authenticated with check (
  user_id = auth.uid() and public.aour_owns_visit(visit_id) and split_part(storage_path, '/', 1) = auth.uid()::text
);
create policy "visit_photos owner delete" on public.visit_photos for delete to authenticated using (user_id = auth.uid());

create policy "visit_notes owner" on public.visit_notes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.aour_owns_visit(visit_id));

create policy "reviews readable" on public.reviews for select using (
  public.aour_can_view_visit(visit_id) and (status = 'published' or user_id = auth.uid() or public.aour_is_admin())
);
create policy "reviews owner insert" on public.reviews for insert to authenticated with check (
  user_id = auth.uid() and public.aour_is_active()
  and exists (select 1 from public.visits v where v.id = visit_id and v.user_id = auth.uid() and v.establishment_id = reviews.establishment_id)
);
create policy "reviews owner update" on public.reviews for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.aour_is_active());
create policy "reviews owner delete" on public.reviews for delete to authenticated
  using ((user_id = auth.uid() and status = 'published') or public.aour_is_admin());

-- Social
create policy "follows involved" on public.follows for select to authenticated
  using (follower_id = auth.uid() or followee_id = auth.uid() or public.aour_is_admin());
create policy "follows insert" on public.follows for insert to authenticated with check (
  follower_id = auth.uid() and public.aour_is_active() and public.aour_profile_is_public(followee_id)
);
create policy "follows delete" on public.follows for delete to authenticated using (follower_id = auth.uid());

create policy "saved owner" on public.saved_places for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.aour_is_active());

create policy "collections readable" on public.collections for select using (
  user_id = auth.uid() or public.aour_is_admin() or (visibility = 'public' and public.aour_user_active(user_id))
);
create policy "collections owner insert" on public.collections for insert to authenticated
  with check (user_id = auth.uid() and public.aour_is_active());
create policy "collections owner update" on public.collections for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.aour_is_active());
create policy "collections owner delete" on public.collections for delete to authenticated using (user_id = auth.uid());

create policy "collection_items readable" on public.collection_items for select
  using (exists (select 1 from public.collections c where c.id = collection_id));
create policy "collection_items owner insert" on public.collection_items for insert to authenticated with check (
  public.aour_owns_collection(collection_id)
  and exists (select 1 from public.establishments e where e.id = establishment_id) -- RLS: published only
);
create policy "collection_items owner update" on public.collection_items for update to authenticated using (public.aour_owns_collection(collection_id)) with check (public.aour_owns_collection(collection_id));
create policy "collection_items owner delete" on public.collection_items for delete to authenticated using (public.aour_owns_collection(collection_id));

-- Moderation
create policy "reports own or admin" on public.review_reports for select to authenticated
  using (reporter_id = auth.uid() or public.aour_is_admin());
create policy "reports insert" on public.review_reports for insert to authenticated with check (
  reporter_id = auth.uid() and public.aour_is_active() and public.aour_can_view_visit(visit_id)
  and not exists (select 1 from public.visits v where v.id = visit_id and v.user_id = auth.uid())
);

create policy "submissions own or admin" on public.establishment_submissions for select to authenticated
  using (user_id = auth.uid() or public.aour_is_admin());
create policy "submissions insert" on public.establishment_submissions for insert to authenticated
  with check (
    user_id = auth.uid() and public.aour_is_active()
    and (establishment_id is null or exists (select 1 from public.establishments e where e.id = establishment_id))
  );

create policy "moderation admin read" on public.moderation_actions for select to authenticated using (public.aour_is_admin());

-- ---------------------------------------------------------------------------
-- RPCs: writes
-- ---------------------------------------------------------------------------

-- Create or edit a rated visit in one transaction. SECURITY INVOKER: every statement
-- is checked by the RLS policies above.
-- p = { id?, establishment_id, visited_on, mode, visibility, scores: {key: n|null},
--       tags: [..], note, review, photo_paths: [..] }
create function public.save_visit(p jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_est uuid;
  k text;
  val jsonb;
begin
  if v_uid is null then
    raise exception 'Sign in to rate a happy hour.' using errcode = '28000';
  end if;
  if jsonb_typeof(coalesce(p -> 'scores', '{}'::jsonb)) <> 'object' then
    raise exception 'scores must be an object' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.visits (user_id, establishment_id, visited_on, mode, visibility)
    values (
      v_uid,
      (p ->> 'establishment_id')::uuid,
      coalesce((p ->> 'visited_on')::date, current_date),
      coalesce(p ->> 'mode', 'quick')::public.visit_mode,
      coalesce(p ->> 'visibility', 'public')::public.visibility
    )
    returning id, establishment_id into v_id, v_est;
  else
    update public.visits
       set visited_on = coalesce((p ->> 'visited_on')::date, visited_on),
           mode = coalesce(p ->> 'mode', mode::text)::public.visit_mode,
           visibility = coalesce(p ->> 'visibility', visibility::text)::public.visibility
     where id = v_id and user_id = v_uid
    returning establishment_id into v_est;
    if v_est is null then
      raise exception 'Visit not found.' using errcode = 'P0002';
    end if;
    delete from public.rating_scores where visit_id = v_id;
    delete from public.visit_tags where visit_id = v_id;
  end if;

  for k, val in select key, value from jsonb_each(coalesce(p -> 'scores', '{}'::jsonb)) loop
    insert into public.rating_scores (visit_id, category_key, score)
    values (v_id, k, case when jsonb_typeof(val) = 'number' then (val #>> '{}')::numeric end);
  end loop;

  if not exists (
    select 1 from public.rating_scores rs
    join public.rating_categories rc on rc.key = rs.category_key
    where rs.visit_id = v_id and rc.group_key = 'primary' and rs.score is not null
  ) then
    raise exception 'Score at least one of the main categories.' using errcode = '22023';
  end if;

  insert into public.visit_tags (visit_id, tag)
  select distinct v_id, t from jsonb_array_elements_text(coalesce(p -> 'tags', '[]'::jsonb)) t;

  if nullif(trim(p ->> 'note'), '') is null then
    delete from public.visit_notes where visit_id = v_id;
  else
    insert into public.visit_notes (visit_id, user_id, body) values (v_id, v_uid, trim(p ->> 'note'))
    on conflict (visit_id) do update set body = excluded.body;
  end if;

  if nullif(trim(p ->> 'review'), '') is null then
    -- Moderated (hidden/removed) reviews stay put so they can't be re-posted as new.
    delete from public.reviews where visit_id = v_id and status = 'published';
  else
    insert into public.reviews (visit_id, user_id, establishment_id, body)
    values (v_id, v_uid, v_est, trim(p ->> 'review'))
    on conflict (visit_id) do update set body = excluded.body;
  end if;

  if p ? 'photo_paths' then
    if jsonb_array_length(p -> 'photo_paths') > 4 then
      raise exception 'Up to 4 photos per visit.' using errcode = '22023';
    end if;
    delete from public.visit_photos
     where visit_id = v_id
       and storage_path not in (select jsonb_array_elements_text(p -> 'photo_paths'));
    insert into public.visit_photos (visit_id, user_id, storage_path)
    select v_id, v_uid, x from jsonb_array_elements_text(p -> 'photo_paths') x
    where not exists (select 1 from public.visit_photos ph where ph.visit_id = v_id and ph.storage_path = x);
  end if;

  return v_id;
end $$;

-- Permanently delete the caller's account and all their data (App Store 5.1.1(v)).
-- Storage objects are removed by the client via the Storage API before calling this.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Sign in required.' using errcode = '28000';
  end if;
  delete from auth.users where id = uid; -- cascades to profiles and all user-owned rows
end $$;

-- ---------------------------------------------------------------------------
-- RPCs: public reads (privacy rules live here, in one place)
-- ---------------------------------------------------------------------------
create function public.aour_user_card(p public.profiles) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'username', p.username, 'displayName', p.display_name, 'avatarUrl', p.avatar_url)
$$;

-- Shape matches src/core/types.ts PublicReview (photoPaths are mapped to URLs client-side).
create function public.aour_review_json(v public.visits, p public.profiles) returns jsonb
language sql stable security definer set search_path = '' as $$
  with s as (
    select coalesce(jsonb_object_agg(rs.category_key, rs.score), '{}'::jsonb) as j
    from public.rating_scores rs where rs.visit_id = v.id
  )
  select jsonb_build_object(
    'visitId', v.id,
    'establishmentId', v.establishment_id,
    'user', public.aour_user_card(p),
    'visitedOn', v.visited_on,
    'composite', public.aour_composite(s.j),
    'scores', s.j,
    'tags', coalesce((select jsonb_agg(t.tag order by t.tag) from public.visit_tags t where t.visit_id = v.id), '[]'::jsonb),
    'review', (select r.body from public.reviews r where r.visit_id = v.id and r.status = 'published'),
    'photoPaths', coalesce((select jsonb_agg(ph.storage_path order by ph.created_at) from public.visit_photos ph where ph.visit_id = v.id), '[]'::jsonb),
    'createdAt', v.created_at
  )
  from s
$$;

-- Public visits for a place. p_following_only = "Friends' ratings".
create function public.establishment_reviews(
  p_establishment uuid, p_following_only boolean default false, p_limit int default 20, p_before timestamptz default null
) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb)
  from (
    select public.aour_review_json(v, p) as j, v.created_at
    from public.visits v
    join public.profiles p on p.id = v.user_id
    join public.establishments e on e.id = v.establishment_id
    where v.establishment_id = p_establishment
      and (e.status = 'published' or public.aour_is_admin())
      and v.visibility = 'public' and not v.excluded_from_community
      and p.visibility = 'public' and p.suspended_at is null
      and (p_before is null or v.created_at < p_before)
      and (not p_following_only or exists (
        select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = v.user_id))
    order by v.created_at desc
    limit least(greatest(p_limit, 1), 50)
  ) x
$$;

create function public.get_profile(p_username text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'username', p.username,
    'displayName', p.display_name,
    'avatarUrl', p.avatar_url,
    'bio', case when visible then p.bio end,
    'homeCity', case when visible then p.home_city end,
    'isPrivate', not visible,
    'placesRated', case when visible then (
      select count(distinct v.establishment_id) from public.visits v
      where v.user_id = p.id and (v.visibility = 'public' or p.id = auth.uid())) else 0 end,
    'visitsLogged', case when visible then (
      select count(*) from public.visits v
      where v.user_id = p.id and (v.visibility = 'public' or p.id = auth.uid())) else 0 end,
    'followers', (select count(*) from public.follows f where f.followee_id = p.id),
    'following', (select count(*) from public.follows f where f.follower_id = p.id),
    'isFollowing', exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = p.id),
    'createdAt', p.created_at
  )
  from public.profiles p,
  lateral (select (p.visibility = 'public' or p.id = auth.uid() or public.aour_is_admin()) as visible) vis
  where p.username = lower(p_username) and (p.suspended_at is null or public.aour_is_admin())
$$;

create function public.profile_reviews(p_user uuid, p_limit int default 30, p_before timestamptz default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb)
  from (
    select public.aour_review_json(v, p) as j, v.created_at
    from public.visits v join public.profiles p on p.id = v.user_id
    where v.user_id = p_user
      and p.suspended_at is null
      and (p.id = auth.uid() or (p.visibility = 'public' and v.visibility = 'public' and not v.excluded_from_community))
      and (p_before is null or v.created_at < p_before)
    order by v.created_at desc
    limit least(greatest(p_limit, 1), 100)
  ) x
$$;

create function public.profile_favorites(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(s.establishment_id order by s.created_at desc), '[]'::jsonb)
  from public.saved_places s join public.profiles p on p.id = s.user_id
  join public.establishments e on e.id = s.establishment_id and e.status = 'published'
  where s.user_id = p_user and s.list = 'favorite'
    and p.suspended_at is null and (p.visibility = 'public' or p.id = auth.uid())
$$;

create function public.search_profiles(p_query text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with q as (select replace(replace(replace(lower(trim(p_query)), '\', '\\'), '%', '\%'), '_', '\_') as t)
  select coalesce(jsonb_agg(public.aour_user_card(p) order by p.username), '[]'::jsonb)
  from (
    select p.* from public.profiles p, q
    where char_length(q.t) >= 2
      and p.visibility = 'public' and p.suspended_at is null
      and (p.username like q.t || '%' or lower(p.display_name) like '%' || q.t || '%')
    order by p.username
    limit 20
  ) p
$$;

create function public.collection_by_share(p_share_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'userId', c.user_id, 'ownerUsername', p.username, 'name', c.name, 'description', c.description,
    'visibility', c.visibility, 'shareId', c.share_id, 'featured', c.featured_at is not null,
    'createdAt', c.created_at, 'updatedAt', c.updated_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('establishmentId', i.establishment_id, 'note', i.note, 'position', i.position) order by i.position, i.added_at)
      from public.collection_items i join public.establishments e on e.id = i.establishment_id and e.status = 'published'
      where i.collection_id = c.id), '[]'::jsonb)
  )
  from public.collections c join public.profiles p on p.id = c.user_id
  where c.share_id = p_share_id
    and (c.user_id = auth.uid() or (c.visibility = 'public' and p.suspended_at is null) or public.aour_is_admin())
$$;

create function public.featured_collections() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.collection_by_share(c.share_id) order by c.featured_at desc), '[]'::jsonb)
  from public.collections c join public.profiles p on p.id = c.user_id
  where c.featured_at is not null and c.visibility = 'public' and p.suspended_at is null
$$;

-- Following feed: recent public activity from people the caller follows.
create function public.following_feed(p_limit int default 30, p_before timestamptz default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  with followees as (
    select p.* from public.follows f join public.profiles p on p.id = f.followee_id
    where f.follower_id = auth.uid() and p.visibility = 'public' and p.suspended_at is null
  ),
  items as (
    select 'visit:' || v.id as id, 'visit' as kind, v.created_at as at,
           jsonb_build_object('review', public.aour_review_json(v, fo)) as body
    from public.visits v join followees fo on fo.id = v.user_id
    where v.visibility = 'public' and not v.excluded_from_community
    union all
    select 'fav:' || s.user_id || ':' || s.establishment_id, 'favorite', s.created_at,
           jsonb_build_object('user', public.aour_user_card(fo), 'establishmentId', s.establishment_id)
    from public.saved_places s join followees fo on fo.id = s.user_id
    where s.list = 'favorite'
    union all
    select 'col:' || c.id, 'collection', c.created_at,
           jsonb_build_object('user', public.aour_user_card(fo), 'collection', jsonb_build_object(
             'id', c.id, 'name', c.name, 'shareId', c.share_id,
             'itemCount', (select count(*) from public.collection_items i where i.collection_id = c.id)))
    from public.collections c join followees fo on fo.id = c.user_id
    where c.visibility = 'public'
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'at', at) || body order by at desc), '[]'::jsonb)
  from (
    select * from items where p_before is null or at < p_before order by at desc limit least(greatest(p_limit, 1), 50)
  ) x
$$;

-- Lightweight list of (establishment, time) for "Trending with friends".
create function public.friend_activity(p_days int default 30) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('establishmentId', v.establishment_id, 'createdAt', v.created_at)), '[]'::jsonb)
  from public.visits v
  join public.follows f on f.followee_id = v.user_id and f.follower_id = auth.uid()
  join public.profiles p on p.id = v.user_id and p.visibility = 'public' and p.suspended_at is null
  where v.visibility = 'public' and not v.excluded_from_community
    and v.created_at > now() - make_interval(days => least(p_days, 90))
$$;

-- ---------------------------------------------------------------------------
-- RPCs: administration (all check aour_is_admin and log to moderation_actions)
-- ---------------------------------------------------------------------------
create function public.aour_require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.aour_is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
end $$;

create function public.aour_log(p_action text, p_target_type text, p_target_id text, p_note text default null) returns void
language sql security definer set search_path = '' as $$
  insert into public.moderation_actions (admin_id, action, target_type, target_id, note)
  values (auth.uid(), p_action, p_target_type, p_target_id, p_note)
$$;

create function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'newUsers7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'visits', (select count(*) from public.visits),
    'visits7d', (select count(*) from public.visits where created_at > now() - interval '7 days'),
    'establishments', (select count(*) from public.establishments where status <> 'archived'),
    'published', (select count(*) from public.establishments where status = 'published'),
    'pendingSubmissions', (select count(*) from public.establishment_submissions where status = 'pending'),
    'openReports', (select count(*) from public.review_reports where status = 'open'),
    'staleListings', (select count(*) from public.establishments
      where status = 'published' and hh_status <> 'none'
        and (hh_status <> 'verified' or hh_verified_at < now() - interval '90 days'))
  );
end $$;

create function public.admin_list_users(p_query text default '', p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'username', p.username, 'displayName', p.display_name, 'role', p.role,
      'suspended', p.suspended_at is not null,
      'visits', (select count(*) from public.visits v where v.user_id = p.id),
      'createdAt', p.created_at) order by p.created_at desc), '[]'::jsonb)
    from (
      select * from public.profiles p
      where coalesce(p_query, '') = ''
         or p.username ilike '%' || p_query || '%'
         or p.display_name ilike '%' || p_query || '%'
      order by p.created_at desc
      limit least(greatest(p_limit, 1), 200)
    ) p
  );
end $$;

create function public.admin_set_suspended(p_user uuid, p_suspended boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  if p_user = auth.uid() then
    raise exception 'You cannot suspend yourself.' using errcode = '22023';
  end if;
  update public.profiles
     set suspended_at = case when p_suspended then now() end,
         suspended_reason = case when p_suspended then p_reason end
   where id = p_user;
  perform public.aour_log(case when p_suspended then 'suspend_user' else 'unsuspend_user' end, 'profile', p_user::text, p_reason);
end $$;

create function public.admin_set_role(p_user uuid, p_role public.user_role) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  if p_user = auth.uid() and p_role <> 'admin' then
    raise exception 'You cannot remove your own admin role.' using errcode = '22023';
  end if;
  update public.profiles set role = p_role where id = p_user;
  perform public.aour_log('set_role', 'profile', p_user::text, p_role::text);
end $$;

create function public.admin_moderate_review(p_visit uuid, p_status public.review_status, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  update public.reviews set status = p_status where visit_id = p_visit;
  update public.review_reports set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
   where visit_id = p_visit and status = 'open';
  perform public.aour_log('review_' || p_status::text, 'visit', p_visit::text, p_note);
end $$;

create function public.admin_set_visit_excluded(p_visit uuid, p_excluded boolean, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  update public.visits set excluded_from_community = p_excluded where id = p_visit;
  perform public.aour_log(case when p_excluded then 'exclude_visit' else 'include_visit' end, 'visit', p_visit::text, p_note);
end $$;

create function public.admin_dismiss_report(p_report uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  update public.review_reports set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now() where id = p_report;
  perform public.aour_log('dismiss_report', 'review_report', p_report::text);
end $$;

create function public.admin_list_reports(p_status public.report_status default 'open') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'visitId', r.visit_id, 'reason', r.reason, 'details', r.details, 'status', r.status,
      'createdAt', r.created_at, 'reporterUsername', rp.username,
      'review', public.aour_review_json(v, vp) || jsonb_build_object(
        'review', (select body from public.reviews where visit_id = v.id),
        'reviewStatus', (select status from public.reviews where visit_id = v.id))
    ) order by r.created_at desc), '[]'::jsonb)
    from public.review_reports r
    join public.visits v on v.id = r.visit_id
    join public.profiles vp on vp.id = v.user_id
    left join public.profiles rp on rp.id = r.reporter_id
    where r.status = p_status
  );
end $$;

create function public.admin_review_submission(p_submission uuid, p_status public.submission_status, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  update public.establishment_submissions
     set status = p_status, admin_note = p_note, reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_submission;
  perform public.aour_log('submission_' || p_status::text, 'submission', p_submission::text, p_note);
end $$;

create function public.admin_set_featured(p_collection uuid, p_featured boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  update public.collections set featured_at = case when p_featured then now() end
   where id = p_collection and (not p_featured or visibility = 'public');
  perform public.aour_log(case when p_featured then 'feature_collection' else 'unfeature_collection' end, 'collection', p_collection::text);
end $$;

-- Mark happy-hour details verified now, recording where the information came from.
create function public.admin_verify_listing(
  p_establishment uuid, p_source_kind public.source_kind, p_source_note text default null, p_source_url text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  insert into public.listing_sources (establishment_id, kind, url, note, created_by)
  values (p_establishment, p_source_kind, p_source_url, p_source_note, auth.uid());
  update public.establishments
     set hh_status = case when hh_status = 'none' then 'none'::public.hh_status else 'verified'::public.hh_status end,
         hh_verified_at = now(), hh_verified_by = auth.uid()
   where id = p_establishment;
  perform public.aour_log('verify_listing', 'establishment', p_establishment::text, p_source_note);
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges: deny by default, then allow the public API surface.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- Used inside RLS policies / RPC bodies (must be callable by the querying role).
grant execute on function
  public.aour_is_admin(), public.aour_is_active(), public.aour_user_active(uuid), public.aour_profile_is_public(uuid),
  public.aour_can_view_visit(uuid), public.aour_owns_visit(uuid), public.aour_owns_collection(uuid),
  public.aour_valid_weights(jsonb), public.aour_composite(jsonb, jsonb), public.aour_user_card(public.profiles)
to anon, authenticated;

grant execute on function
  public.establishment_reviews(uuid, boolean, int, timestamptz), public.get_profile(text),
  public.profile_reviews(uuid, int, timestamptz), public.profile_favorites(uuid), public.search_profiles(text),
  public.collection_by_share(text), public.featured_collections()
to anon, authenticated;

grant execute on function
  public.save_visit(jsonb), public.delete_my_account(), public.following_feed(int, timestamptz), public.friend_activity(int),
  public.admin_stats(), public.admin_list_users(text, int), public.admin_set_suspended(uuid, boolean, text),
  public.admin_set_role(uuid, public.user_role), public.admin_moderate_review(uuid, public.review_status, text),
  public.admin_set_visit_excluded(uuid, boolean, text), public.admin_dismiss_report(uuid),
  public.admin_list_reports(public.report_status), public.admin_review_submission(uuid, public.submission_status, text),
  public.admin_set_featured(uuid, boolean),
  public.admin_verify_listing(uuid, public.source_kind, text, text)
to authenticated;
