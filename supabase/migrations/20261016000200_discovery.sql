-- Automated discovery + enrichment, location-aware search, provenance and admin overrides.
--
-- Principles (see ARCHITECTURE.md → "Data pipeline"):
--   * Discovered venues are facts about a place, NOT confirmed happy hours.
--   * Every happy-hour fact keeps its source; automated data never becomes "verified".
--   * Admin edits are preserved: automation never overwrites admin-managed happy-hour data or
--     locked fields — it files findings for review instead.
--   * Pipeline functions are callable only with the service role (Worker / CI), never clients.

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- Establishments: geography, provenance, verification detail, locks, refresh state
-- ---------------------------------------------------------------------------
alter table public.establishments
  add column location extensions.geography(Point, 4326)
    generated always as (extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography) stored,
  add column origin text not null default 'manual' check (origin in ('manual', 'import', 'user_submission')),
  add column attribution text check (char_length(attribution) <= 200),
  add column business_hours jsonb check (business_hours is null or jsonb_typeof(business_hours) = 'array'),
  add column business_hours_source text check (char_length(business_hours_source) <= 200),
  add column hh_confidence numeric(3, 2) not null default 0 check (hh_confidence between 0 and 1),
  add column hh_managed_by text not null default 'admin' check (hh_managed_by in ('auto', 'admin')),
  add column hh_source_url text check (hh_source_url is null or hh_source_url ~ '^https?://'),
  add column hh_source_published_at timestamptz,
  add column hh_checked_at timestamptz,
  add column hh_last_confirmed_at timestamptz,
  add column hh_last_changed_at timestamptz,
  add column hh_conflict boolean not null default false,
  add column hh_fingerprint text,
  add column hh_restrictions text[] not null default '{}',
  add column locked_fields text[] not null default '{}',
  add column enrich_priority smallint not null default 0,
  add column next_enrich_at timestamptz,
  add column enrich_failures integer not null default 0,
  add column last_enrich_attempt_at timestamptz,
  add column last_enrich_success_at timestamptz,
  add column merged_into uuid references public.establishments (id) on delete set null;

create index establishments_location_idx on public.establishments using gist (location);
create index establishments_enrich_due_idx on public.establishments (next_enrich_at) where status = 'published' and website is not null;

-- Existing manually entered listings are admin-managed; anything with a verification date is
-- also "last confirmed" then.
update public.establishments set hh_last_confirmed_at = hh_verified_at where hh_verified_at is not null;

alter table public.markets
  add column radius_miles numeric not null default 15 check (radius_miles between 1 and 100),
  add column discovery_enabled boolean not null default true,
  add column auto_publish boolean not null default true,
  add column last_discovered_at timestamptz,
  add column next_discovery_at timestamptz;

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------
create table public.establishment_external_ids (
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  provider text not null check (provider in ('osm', 'overture', 'foursquare', 'fsq_os')),
  external_id text not null check (char_length(external_id) between 1 and 200),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (provider, external_id)
);
create index external_ids_establishment_idx on public.establishment_external_ids (establishment_id);

create table public.possible_duplicates (
  id uuid primary key default gen_random_uuid(),
  establishment_a uuid not null references public.establishments (id) on delete cascade,
  establishment_b uuid not null references public.establishments (id) on delete cascade,
  score numeric(3, 2) not null,
  reasons text[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'merged', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  check (establishment_a <> establishment_b),
  unique (establishment_a, establishment_b)
);

-- Websites we fetch, with conditional-GET validators so unchanged pages cost nothing.
create table public.source_documents (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  url text not null check (url ~ '^https?://'),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_status integer,
  etag text,
  last_modified text,
  content_hash text,
  outcome text check (outcome in ('changed', 'unchanged', 'not_found', 'blocked', 'error')),
  failures integer not null default 0,
  unique (establishment_id, url)
);

-- Per-domain crawl state: cached robots.txt (≤ 24 h), politeness, blocks.
create table public.source_domains (
  domain text primary key,
  robots_txt text,
  robots_status integer,
  robots_fetched_at timestamptz,
  crawl_delay_sec numeric,
  next_allowed_at timestamptz,
  blocked boolean not null default false,
  blocked_reason text,
  updated_at timestamptz not null default now()
);

-- Every extraction result, with evidence quotes (admin-only).
create table public.hh_findings (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  source_kind text not null check (source_kind in ('official_website', 'osm', 'user', 'admin', 'partner_feed')),
  method text not null check (method in ('json_ld', 'pattern', 'llm', 'osm_tag', 'user', 'admin')),
  source_url text,
  windows jsonb not null default '[]',
  specials jsonb not null default '[]',
  restrictions text[] not null default '{}',
  evidence jsonb not null default '[]',
  source_published_at timestamptz,
  checked_at timestamptz not null default now(),
  fingerprint text,
  confidence numeric(3, 2),
  mentioned_but_unparsed boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'approved', 'superseded')),
  decision_reason text,
  created_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz
);
create index hh_findings_establishment_idx on public.hh_findings (establishment_id, created_at desc);
create index hh_findings_pending_idx on public.hh_findings (created_at desc) where status = 'pending';

-- What changed on a listing, by whom (pipeline or admin) — the "refresh history".
create table public.listing_changes (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments (id) on delete cascade,
  actor text not null check (actor in ('pipeline', 'admin')),
  admin_id uuid references public.profiles (id) on delete set null,
  summary text not null,
  before_fingerprint text,
  after_fingerprint text,
  source_url text,
  created_at timestamptz not null default now()
);
create index listing_changes_establishment_idx on public.listing_changes (establishment_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Job queue, budgets, coverage requests
-- ---------------------------------------------------------------------------
create table public.refresh_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('discover_market', 'enrich_establishment')),
  target_id uuid not null,
  priority smallint not null default 0,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  attempts integer not null default 0,
  max_attempts integer not null default 4,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  requested_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- At most one active job per target: prevents duplicate concurrent enrichment.
create unique index refresh_jobs_one_active on public.refresh_jobs (kind, target_id) where status in ('queued', 'running');
create index refresh_jobs_ready_idx on public.refresh_jobs (priority desc, run_after) where status = 'queued';
create index refresh_jobs_recent_idx on public.refresh_jobs (created_at desc);

create table public.provider_limits (
  provider text primary key,
  monthly_limit integer not null check (monthly_limit >= 0),
  enabled boolean not null default true,
  note text
);
create table public.provider_usage (
  provider text not null references public.provider_limits (provider) on delete cascade,
  period text not null check (period ~ '^\d{4}-\d{2}$'),
  used integer not null default 0,
  primary key (provider, period)
);

-- Explicit monthly ceilings. Raise deliberately; external calls stop when exhausted.
insert into public.provider_limits (provider, monthly_limit, enabled, note) values
  ('website_fetch', 20000, true, 'Pages fetched from venue websites (robots.txt + politeness enforced)'),
  ('overture', 60, true, 'Market-level Overture bulk queries (DuckDB, free)'),
  ('osm_overpass', 0, false, 'Off by default: ODbL share-alike review required (DATA_SOURCES.md)'),
  ('foursquare', 0, false, 'Off by default: Places API data may not be stored (id-only)'),
  ('geocode', 30000, true, 'Place/address search via the geocoding provider (cached)'),
  ('llm_extract', 300, false, 'Optional AI-assisted extraction; results always need admin review');

-- Anonymous demand signal: people searching where Aour has no coverage. Rounded to ~11 km.
create table public.coverage_requests (
  cell text primary key,
  lat numeric(5, 1) not null,
  lng numeric(5, 1) not null,
  label text,
  requests integer not null default 1,
  first_requested_at timestamptz not null default now(),
  last_requested_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'activated', 'dismissed'))
);

-- ---------------------------------------------------------------------------
-- Grants & RLS
-- ---------------------------------------------------------------------------
revoke all on public.establishment_external_ids, public.possible_duplicates, public.source_documents,
  public.source_domains, public.hh_findings, public.listing_changes, public.refresh_jobs,
  public.provider_limits, public.provider_usage, public.coverage_requests from anon, authenticated;

alter table public.establishment_external_ids enable row level security;
alter table public.possible_duplicates enable row level security;
alter table public.source_documents enable row level security;
alter table public.source_domains enable row level security;
alter table public.hh_findings enable row level security;
alter table public.listing_changes enable row level security;
alter table public.refresh_jobs enable row level security;
alter table public.provider_limits enable row level security;
alter table public.provider_usage enable row level security;
alter table public.coverage_requests enable row level security;

-- Admins can read the pipeline's state; all writes go through RPCs below.
grant select on public.establishment_external_ids, public.possible_duplicates, public.source_documents,
  public.source_domains, public.hh_findings, public.listing_changes, public.refresh_jobs,
  public.provider_limits, public.provider_usage, public.coverage_requests to authenticated;
do $$
declare t text;
begin
  foreach t in array array['establishment_external_ids', 'possible_duplicates', 'source_documents', 'source_domains',
    'hh_findings', 'listing_changes', 'refresh_jobs', 'provider_limits', 'provider_usage', 'coverage_requests'] loop
    execute format('create policy "%1$s admin read" on public.%1$I for select to authenticated using (public.aour_is_admin())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Location-aware search (public)
-- ---------------------------------------------------------------------------
-- Published places within a radius, nearest first, using the GiST geography index.
-- SECURITY INVOKER: RLS still applies. Returns table rows so PostgREST can embed relations.
create function public.nearby_establishments(
  p_lat double precision, p_lng double precision, p_radius_m integer default 8047, p_limit integer default 300
) returns setof public.establishments
language sql stable security invoker set search_path = '' as $$
  select e.*
  from public.establishments e
  where e.status = 'published'
    and extensions.st_dwithin(
      e.location,
      extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
      least(greatest(p_radius_m, 100), 80467)  -- 50 miles max
    )
  order by e.location operator(extensions.<->) extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography
  limit least(greatest(p_limit, 1), 500)
$$;

-- Record (anonymously, ~11 km precision) that someone looked for happy hours here.
-- Returns true when an active market already covers the point.
create function public.request_coverage(p_lat double precision, p_lng double precision, p_label text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  covered boolean;
  c_lat numeric := round(p_lat::numeric, 1);
  c_lng numeric := round(p_lng::numeric, 1);
begin
  if p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Invalid coordinates' using errcode = '22023';
  end if;
  select exists (
    select 1 from public.markets m
    where m.is_active and extensions.st_dwithin(
      extensions.st_setsrid(extensions.st_makepoint(m.lng, m.lat), 4326)::extensions.geography,
      extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
      m.radius_miles * 1609.34)
  ) into covered;
  if not covered then
    insert into public.coverage_requests (cell, lat, lng, label)
    values (c_lat || ',' || c_lng, c_lat, c_lng, left(p_label, 80))
    on conflict (cell) do update
      set requests = public.coverage_requests.requests + 1,
          last_requested_at = now(),
          label = coalesce(public.coverage_requests.label, excluded.label);
  end if;
  return covered;
end $$;

-- ---------------------------------------------------------------------------
-- Pipeline RPCs (service role only)
-- ---------------------------------------------------------------------------
create function public.aour_slug_available(p_base text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  candidate text := left(coalesce(nullif(p_base, ''), 'place'), 70);
  n int := 1;
begin
  while exists (select 1 from public.establishments where slug = candidate) loop
    n := n + 1;
    candidate := left(p_base, 70) || '-' || n;
  end loop;
  return candidate;
end $$;

-- Places near a point, with provider ids, for duplicate matching in the pipeline.
create function public.pipeline_nearby_for_match(p_lat double precision, p_lng double precision, p_radius_m integer default 500)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'name', e.name, 'lat', e.lat, 'lng', e.lng, 'website', e.website, 'phone', e.phone,
    'externalIds', coalesce((select jsonb_agg(jsonb_build_object('provider', x.provider, 'externalId', x.external_id))
                             from public.establishment_external_ids x where x.establishment_id = e.id), '[]'::jsonb)
  )), '[]'::jsonb)
  from public.establishments e
  where e.status <> 'archived'
    and extensions.st_dwithin(e.location, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography, p_radius_m)
$$;

-- Create or update a venue from a provider candidate, honouring locks and storage rights.
-- p_candidate: CandidatePlace + {businessHours: windows[] | null}
-- p_match: {decision: 'same'|'review'|'new', establishmentId, score, reasons}
create function public.pipeline_upsert_place(p_market uuid, p_candidate jsonb, p_match jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := p_candidate;
  v_provider text := c ->> 'provider';
  v_decision text := p_match ->> 'decision';
  est_id uuid := nullif(p_match ->> 'establishmentId', '')::uuid;
  e public.establishments;
  m public.markets;
  new_id uuid;
begin
  if v_provider not in ('osm', 'overture', 'foursquare', 'fsq_os') then
    raise exception 'Unknown provider %', v_provider using errcode = '22023';
  end if;

  -- Providers whose terms forbid storing attributes may only be linked by id.
  if v_provider = 'foursquare' then
    if v_decision <> 'same' or est_id is null then
      return jsonb_build_object('action', 'skipped', 'reason', 'id-only provider cannot create places');
    end if;
    insert into public.establishment_external_ids (establishment_id, provider, external_id)
    values (est_id, v_provider, c ->> 'externalId')
    on conflict (provider, external_id) do update set last_seen_at = now();
    return jsonb_build_object('action', 'linked', 'establishmentId', est_id);
  end if;

  if v_decision = 'same' and est_id is not null then
    select * into e from public.establishments where id = est_id;
    if not found then
      raise exception 'Match target not found' using errcode = 'P0002';
    end if;
    insert into public.establishment_external_ids (establishment_id, provider, external_id)
    values (est_id, v_provider, c ->> 'externalId')
    on conflict (provider, external_id) do update set last_seen_at = now(), establishment_id = excluded.establishment_id;

    -- Imported rows track the provider (unless an admin locked the field); manual rows only gain missing facts.
    update public.establishments set
      website = case when 'website' = any(locked_fields) then website
                     when origin = 'import' then coalesce(c ->> 'website', website) else coalesce(website, c ->> 'website') end,
      phone = case when 'phone' = any(locked_fields) then phone
                   when origin = 'import' then coalesce(c ->> 'phone', phone) else coalesce(phone, c ->> 'phone') end,
      postal_code = coalesce(postal_code, c ->> 'postalCode'),
      business_hours = case when 'business_hours' = any(locked_fields) then business_hours
                            else coalesce(nullif(c -> 'businessHours', 'null'::jsonb), business_hours) end,
      business_hours_source = case when nullif(c -> 'businessHours', 'null'::jsonb) is not null and not ('business_hours' = any(locked_fields))
                                   then c ->> 'attribution' else business_hours_source end,
      attribution = case when attribution is null then c ->> 'attribution'
                         when position(c ->> 'attribution' in attribution) > 0 then attribution
                         else left(attribution || ' · ' || (c ->> 'attribution'), 200) end,
      -- A provider reporting permanent closure archives imported, unlocked listings.
      status = case when (c ->> 'closed')::boolean and origin = 'import' and not ('status' = any(locked_fields))
                    then 'archived'::public.listing_status else status end
    where id = est_id;
    return jsonb_build_object('action', 'updated', 'establishmentId', est_id);
  end if;

  if (c ->> 'closed')::boolean then
    return jsonb_build_object('action', 'skipped', 'reason', 'closed');
  end if;

  select * into m from public.markets where id = p_market;
  if not found then
    raise exception 'Market not found' using errcode = 'P0002';
  end if;

  insert into public.establishments (
    slug, name, kind, market_id, neighborhood, city, state, address, postal_code, lat, lng, timezone,
    phone, website, amenities, hh_status, hh_managed_by, status, origin, attribution,
    business_hours, business_hours_source, next_enrich_at
  ) values (
    public.aour_slug_available(trim(both '-' from regexp_replace(lower(c ->> 'name'), '[^a-z0-9]+', '-', 'g'))),
    left(c ->> 'name', 100),
    (c ->> 'kind')::public.establishment_kind,
    p_market,
    null,
    coalesce(nullif(c ->> 'city', ''), m.name),
    coalesce(nullif(c ->> 'state', ''), 'FL'),
    coalesce(nullif(c ->> 'address', ''), 'Address not listed'),
    c ->> 'postalCode',
    (c ->> 'lat')::double precision,
    (c ->> 'lng')::double precision,
    m.timezone,
    c ->> 'phone',
    c ->> 'website',
    coalesce((select array_agg(x) from jsonb_array_elements_text(c -> 'amenities') x), '{}'),
    'none',
    'auto',
    -- Possible duplicates wait as drafts until an admin merges or dismisses them.
    case when v_decision = 'review' or not m.auto_publish then 'draft'::public.listing_status else 'published'::public.listing_status end,
    'import',
    c ->> 'attribution',
    nullif(c -> 'businessHours', 'null'::jsonb),
    case when nullif(c -> 'businessHours', 'null'::jsonb) is not null then c ->> 'attribution' end,
    now()
  ) returning id into new_id;

  insert into public.establishment_external_ids (establishment_id, provider, external_id)
  values (new_id, v_provider, c ->> 'externalId');

  if v_decision = 'review' and est_id is not null then
    insert into public.possible_duplicates (establishment_a, establishment_b, score, reasons)
    values (est_id, new_id, coalesce((p_match ->> 'score')::numeric, 0), coalesce((select array_agg(x) from jsonb_array_elements_text(p_match -> 'reasons') x), '{}'))
    on conflict do nothing;
  end if;
  return jsonb_build_object('action', case when v_decision = 'review' then 'created_for_review' else 'created' end, 'establishmentId', new_id);
end $$;

-- Everything the enrichment step needs to decide what to do with a new finding.
create function public.pipeline_enrichment_target(p_establishment uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id, 'name', e.name, 'website', e.website, 'timezone', e.timezone,
    'managedBy', e.hh_managed_by, 'fingerprint', e.hh_fingerprint,
    'hasData', exists (select 1 from public.happy_hour_windows w where w.establishment_id = e.id),
    'adminVerifiedAt', case when e.hh_status = 'verified' then e.hh_verified_at end,
    'priority', e.enrich_priority > 0,
    'failures', e.enrich_failures,
    'lastSuccessAt', e.last_enrich_success_at,
    'findings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sourceKind', f.source_kind, 'method', f.method, 'sourceUrl', f.source_url, 'windows', f.windows,
        'specials', f.specials, 'restrictions', f.restrictions, 'evidence', '[]'::jsonb,
        'sourcePublishedAt', f.source_published_at, 'checkedAt', f.checked_at,
        'mentionedButUnparsed', f.mentioned_but_unparsed))
      from (
        select distinct on (coalesce(source_url, method)) *
        from public.hh_findings
        where establishment_id = e.id and status in ('applied', 'approved', 'pending')
          and checked_at > now() - interval '400 days'
        order by coalesce(source_url, method), checked_at desc
      ) f), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('url', d.url, 'etag', d.etag, 'lastModified', d.last_modified, 'contentHash', d.content_hash))
      from public.source_documents d where d.establishment_id = e.id), '[]'::jsonb)
  )
  from public.establishments e where e.id = p_establishment
$$;

-- Store a finding and (when decided) apply it to the public listing.
-- p_action: 'apply' | 'review' | 'touch' | 'discard'
-- p_assessment: {status, confidence, conflict}
create function public.pipeline_record_finding(p_establishment uuid, p_finding jsonb, p_action text, p_assessment jsonb, p_fingerprint text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e public.establishments;
  f_id uuid;
  w jsonb;
  i int := 0;
  a_status public.hh_status := (p_assessment ->> 'status')::public.hh_status;
begin
  select * into e from public.establishments where id = p_establishment for update;
  if not found then
    raise exception 'Establishment not found' using errcode = 'P0002';
  end if;
  if a_status = 'verified' then
    raise exception 'The pipeline cannot mark listings verified' using errcode = '42501';
  end if;

  update public.establishments set hh_checked_at = now() where id = e.id;

  if p_action = 'discard' then
    return jsonb_build_object('action', 'discard');
  end if;

  if p_action = 'touch' then
    -- Same facts re-confirmed by the source.
    update public.establishments set
      hh_last_confirmed_at = now(),
      hh_status = case when hh_managed_by = 'auto' then a_status else hh_status end,
      hh_confidence = case when hh_managed_by = 'auto' then (p_assessment ->> 'confidence')::numeric else hh_confidence end
    where id = e.id;
    update public.hh_findings set checked_at = now()
     where id = (select id from public.hh_findings where establishment_id = e.id and fingerprint = p_fingerprint
                 and status in ('applied', 'approved') order by checked_at desc limit 1);
    return jsonb_build_object('action', 'touch');
  end if;

  insert into public.hh_findings (
    establishment_id, source_kind, method, source_url, windows, specials, restrictions, evidence,
    source_published_at, checked_at, fingerprint, confidence, mentioned_but_unparsed, status, decision_reason
  ) values (
    e.id, p_finding ->> 'sourceKind', p_finding ->> 'method', p_finding ->> 'sourceUrl',
    coalesce(p_finding -> 'windows', '[]'), coalesce(p_finding -> 'specials', '[]'),
    coalesce((select array_agg(x) from jsonb_array_elements_text(p_finding -> 'restrictions') x), '{}'),
    coalesce(p_finding -> 'evidence', '[]'),
    nullif(p_finding ->> 'sourcePublishedAt', '')::timestamptz,
    coalesce(nullif(p_finding ->> 'checkedAt', '')::timestamptz, now()),
    p_fingerprint,
    (p_assessment ->> 'confidence')::numeric,
    coalesce((p_finding ->> 'mentionedButUnparsed')::boolean, false),
    case when p_action = 'apply' and e.hh_managed_by = 'auto' then 'applied' else 'pending' end,
    p_assessment ->> 'reason'
  ) returning id into f_id;

  -- Defence in depth: even if a caller asks to apply, admin-managed listings are never overwritten.
  if p_action <> 'apply' or e.hh_managed_by <> 'auto' then
    update public.establishments set hh_conflict = coalesce((p_assessment ->> 'conflict')::boolean, false) or hh_conflict where id = e.id;
    return jsonb_build_object('action', 'review', 'findingId', f_id);
  end if;

  delete from public.happy_hour_windows where establishment_id = e.id;
  for w in select * from jsonb_array_elements(coalesce(p_finding -> 'windows', '[]')) loop
    i := i + 1;
    insert into public.happy_hour_windows (establishment_id, days, start_time, end_time, label, sort_order)
    values (e.id, (select array_agg(d::smallint order by d::smallint) from jsonb_array_elements_text(w -> 'days') d),
            (w ->> 'start')::time, (w ->> 'end')::time, nullif(w ->> 'label', ''), i);
  end loop;
  delete from public.happy_hour_specials where establishment_id = e.id;
  insert into public.happy_hour_specials (establishment_id, kind, title, price, description, sort_order)
  select e.id, coalesce(s ->> 'kind', 'other')::public.special_kind, left(s ->> 'title', 80), left(nullif(s ->> 'price', ''), 30),
         left(nullif(s ->> 'description', ''), 200), ord::smallint
  from jsonb_array_elements(coalesce(p_finding -> 'specials', '[]')) with ordinality t(s, ord);

  update public.hh_findings set status = 'superseded'
   where establishment_id = e.id and status = 'applied' and id <> f_id;

  update public.establishments set
    hh_status = a_status,
    hh_confidence = (p_assessment ->> 'confidence')::numeric,
    hh_conflict = coalesce((p_assessment ->> 'conflict')::boolean, false),
    hh_source_url = p_finding ->> 'sourceUrl',
    hh_source_published_at = nullif(p_finding ->> 'sourcePublishedAt', '')::timestamptz,
    hh_source_note = case p_finding ->> 'sourceKind'
                       when 'official_website' then 'From the venue’s website'
                       when 'osm' then 'From OpenStreetMap contributors'
                       else 'Automated source' end,
    hh_restrictions = coalesce((select array_agg(x) from jsonb_array_elements_text(p_finding -> 'restrictions') x), '{}'),
    hh_fingerprint = p_fingerprint,
    hh_last_confirmed_at = now(),
    hh_last_changed_at = now()
  where id = e.id;

  insert into public.listing_changes (establishment_id, actor, summary, before_fingerprint, after_fingerprint, source_url)
  values (e.id, 'pipeline', 'Happy-hour details updated from ' || coalesce(p_finding ->> 'sourceKind', 'source'),
          e.hh_fingerprint, p_fingerprint, p_finding ->> 'sourceUrl');
  return jsonb_build_object('action', 'apply', 'findingId', f_id);
end $$;

-- Record a fetch result for conditional requests next time.
create function public.pipeline_record_document(p_establishment uuid, p_url text, p_doc jsonb)
returns void
language sql security definer set search_path = '' as $$
  insert into public.source_documents (establishment_id, url, last_attempt_at, last_success_at, last_status, etag, last_modified, content_hash, outcome, failures)
  values (p_establishment, p_url, now(),
          case when (p_doc ->> 'outcome') in ('changed', 'unchanged', 'not_found') then now() end,
          (p_doc ->> 'status')::int, p_doc ->> 'etag', p_doc ->> 'lastModified', p_doc ->> 'contentHash', p_doc ->> 'outcome',
          case when p_doc ->> 'outcome' = 'error' then 1 else 0 end)
  on conflict (establishment_id, url) do update set
    last_attempt_at = now(),
    last_success_at = case when excluded.outcome in ('changed', 'unchanged', 'not_found') then now() else public.source_documents.last_success_at end,
    last_status = excluded.last_status,
    etag = coalesce(excluded.etag, public.source_documents.etag),
    last_modified = coalesce(excluded.last_modified, public.source_documents.last_modified),
    content_hash = coalesce(excluded.content_hash, public.source_documents.content_hash),
    outcome = excluded.outcome,
    failures = case when excluded.outcome = 'error' then public.source_documents.failures + 1 else 0 end
$$;

create function public.pipeline_get_domain(p_domain text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(d) from public.source_domains d where d.domain = lower(p_domain)
$$;

create function public.pipeline_put_domain(p_domain text, p_state jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.source_domains (domain, robots_txt, robots_status, robots_fetched_at, crawl_delay_sec, next_allowed_at, blocked, blocked_reason, updated_at)
  values (lower(p_domain), p_state ->> 'robots_txt', (p_state ->> 'robots_status')::int, (p_state ->> 'robots_fetched_at')::timestamptz,
          (p_state ->> 'crawl_delay_sec')::numeric, (p_state ->> 'next_allowed_at')::timestamptz,
          coalesce((p_state ->> 'blocked')::boolean, false), p_state ->> 'blocked_reason', now())
  on conflict (domain) do update set
    robots_txt = coalesce(excluded.robots_txt, public.source_domains.robots_txt),
    robots_status = coalesce(excluded.robots_status, public.source_domains.robots_status),
    robots_fetched_at = coalesce(excluded.robots_fetched_at, public.source_domains.robots_fetched_at),
    crawl_delay_sec = coalesce(excluded.crawl_delay_sec, public.source_domains.crawl_delay_sec),
    next_allowed_at = greatest(excluded.next_allowed_at, public.source_domains.next_allowed_at),
    -- An admin block is sticky; the pipeline can only add blocks, not lift them.
    blocked = public.source_domains.blocked or excluded.blocked,
    blocked_reason = coalesce(public.source_domains.blocked_reason, excluded.blocked_reason),
    updated_at = now()
$$;

-- After an enrichment attempt: schedule the next one (backoff computed in core/ingest/refresh.ts).
-- p_ok: true = success, false = failure (counts toward backoff), null = deferred (rate limit / politeness).
create function public.pipeline_schedule_establishment(p_establishment uuid, p_ok boolean, p_next_at timestamptz)
returns void
language sql security definer set search_path = '' as $$
  update public.establishments set
    last_enrich_attempt_at = now(),
    last_enrich_success_at = case when p_ok then now() else last_enrich_success_at end,
    enrich_failures = case when p_ok then 0 when not p_ok then enrich_failures + 1 else enrich_failures end,
    next_enrich_at = p_next_at
  where id = p_establishment
$$;

create function public.pipeline_get_market(p_market uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', id, 'name', name, 'lat', lat, 'lng', lng, 'radiusMiles', radius_miles,
                            'timezone', timezone, 'discoveryEnabled', discovery_enabled and is_active)
  from public.markets where id = p_market
$$;

-- The venue's site no longer mentions happy hour: auto-managed info becomes "outdated" (never deleted).
create function public.pipeline_mark_outdated(p_establishment uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.establishments set hh_status = 'outdated', hh_checked_at = now()
   where id = p_establishment and hh_managed_by = 'auto' and hh_status not in ('none', 'outdated');
  if found then
    insert into public.listing_changes (establishment_id, actor, summary)
    values (p_establishment, 'pipeline', left('Marked outdated: ' || p_reason, 300));
  end if;
  return found;
end $$;

-- Atomically spend from a provider's monthly budget. false = disabled or exhausted.
create function public.pipeline_consume_budget(p_provider text, p_units integer default 1)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  lim public.provider_limits;
  v_period text := to_char(now() at time zone 'UTC', 'YYYY-MM');
begin
  select * into lim from public.provider_limits where provider = p_provider;
  if not found or not lim.enabled then
    return false;
  end if;
  insert into public.provider_usage (provider, period, used) values (p_provider, v_period, 0) on conflict do nothing;
  -- Single conditional UPDATE: concurrent callers can never overspend.
  update public.provider_usage set used = used + p_units
   where provider = p_provider and period = v_period and used + p_units <= lim.monthly_limit;
  return found;
end $$;

-- Queue due work. Called by the scheduler each tick; cheap and idempotent.
create function public.pipeline_enqueue_due(p_limit integer default 50)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_enrich int;
  n_discover int;
  n_stale int;
begin
  insert into public.refresh_jobs (kind, target_id, priority)
  select 'enrich_establishment', e.id, e.enrich_priority
  from public.establishments e
  -- Drafts are enriched too, so admins see what a venue publishes before approving it.
  where e.status in ('published', 'draft') and e.website is not null
    and coalesce(e.next_enrich_at, '-infinity') <= now()
    and not exists (select 1 from public.refresh_jobs j where j.kind = 'enrich_establishment' and j.target_id = e.id and j.status in ('queued', 'running'))
  order by e.enrich_priority desc, e.next_enrich_at nulls first
  limit greatest(p_limit, 0)
  on conflict do nothing;
  get diagnostics n_enrich = row_count;

  insert into public.refresh_jobs (kind, target_id, priority)
  select 'discover_market', m.id, 1
  from public.markets m
  where m.is_active and m.discovery_enabled and coalesce(m.next_discovery_at, '-infinity') <= now()
    and not exists (select 1 from public.refresh_jobs j where j.kind = 'discover_market' and j.target_id = m.id and j.status in ('queued', 'running'))
  on conflict do nothing;
  get diagnostics n_discover = row_count;

  -- Downgrade automated happy-hour info nobody has re-confirmed in 180 days.
  update public.establishments set hh_status = 'outdated'
   where hh_managed_by = 'auto'
     and hh_status in ('establishment_reported', 'community_reported', 'unverified')
     and coalesce(hh_last_confirmed_at, '-infinity') < now() - interval '180 days'
     and exists (select 1 from public.happy_hour_windows w where w.establishment_id = establishments.id);
  get diagnostics n_stale = row_count;

  -- Release jobs whose worker died mid-run.
  update public.refresh_jobs set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
         locked_at = null, locked_by = null, last_error = coalesce(last_error, 'worker timed out')
   where status = 'running' and locked_at < now() - interval '15 minutes';

  return jsonb_build_object('enrich', n_enrich, 'discover', n_discover, 'stale', n_stale);
end $$;

-- Claim ready jobs without double-processing (SKIP LOCKED).
create function public.pipeline_claim_jobs(p_worker text, p_limit integer, p_kinds text[])
returns setof public.refresh_jobs
language sql security definer set search_path = '' as $$
  update public.refresh_jobs j set status = 'running', locked_at = now(), locked_by = p_worker,
         attempts = j.attempts + 1, started_at = now()
  where j.id in (
    select id from public.refresh_jobs
    where status = 'queued' and run_after <= now() and kind = any(p_kinds)
    order by priority desc, run_after
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  )
  returning j.*
$$;

-- Finish a job. Failed jobs retry at p_retry_at until max_attempts.
create function public.pipeline_finish_job(p_job uuid, p_status text, p_error text default null, p_result jsonb default null, p_retry_at timestamptz default null)
returns void
language sql security definer set search_path = '' as $$
  update public.refresh_jobs set
    status = case
      when p_status = 'failed' and p_retry_at is not null and attempts < max_attempts then 'queued'
      else p_status end,
    run_after = coalesce(p_retry_at, run_after),
    last_error = left(p_error, 500),
    result = p_result,
    locked_at = null,
    locked_by = null,
    finished_at = case when p_status = 'failed' and p_retry_at is not null and attempts < max_attempts then null else now() end
  where id = p_job and status = 'running'
$$;

create function public.pipeline_mark_market_discovered(p_market uuid, p_ok boolean)
returns void
language sql security definer set search_path = '' as $$
  update public.markets set
    last_discovered_at = case when p_ok then now() else last_discovered_at end,
    next_discovery_at = now() + case when p_ok then interval '7 days' else interval '1 day' end
  where id = p_market
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------
create function public.admin_pipeline_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  return jsonb_build_object(
    'jobs', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from public.refresh_jobs group by status) s),
    'recentJobs', (select coalesce(jsonb_agg(to_jsonb(j) - 'locked_by' order by j.created_at desc), '[]') from (
        select j.*, coalesce(e.name, m.name) as target_name
        from public.refresh_jobs j
        left join public.establishments e on e.id = j.target_id
        left join public.markets m on m.id = j.target_id
        order by j.created_at desc limit 40) j),
    'budgets', (select coalesce(jsonb_agg(jsonb_build_object('provider', l.provider, 'limit', l.monthly_limit, 'enabled', l.enabled, 'note', l.note,
                  'used', coalesce(u.used, 0)) order by l.provider), '[]')
                from public.provider_limits l
                left join public.provider_usage u on u.provider = l.provider and u.period = to_char(now() at time zone 'UTC', 'YYYY-MM')),
    'pendingFindings', (select count(*) from public.hh_findings where status = 'pending'),
    'openDuplicates', (select count(*) from public.possible_duplicates where status = 'open'),
    'coverageRequests', (select coalesce(jsonb_agg(to_jsonb(c) order by c.requests desc), '[]') from (
        select * from public.coverage_requests where status = 'open' order by requests desc limit 20) c),
    'markets', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'lastDiscoveredAt', last_discovered_at,
                  'nextDiscoveryAt', next_discovery_at, 'discoveryEnabled', discovery_enabled, 'radiusMiles', radius_miles,
                  'places', (select count(*) from public.establishments e where e.market_id = markets.id and e.status = 'published'))), '[]')
                from public.markets)
  );
end $$;

create function public.admin_list_findings(p_status text default 'pending', p_establishment uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  return (
    select coalesce(jsonb_agg(to_jsonb(f) || jsonb_build_object('establishmentName', e.name, 'establishmentSlug', e.slug,
             'managedBy', e.hh_managed_by) order by f.created_at desc), '[]')
    from (select * from public.hh_findings
          where (p_establishment is null or establishment_id = p_establishment)
            and (p_status = 'all' or status = p_status)
          order by created_at desc limit 200) f
    join public.establishments e on e.id = f.establishment_id
  );
end $$;

-- Approve: an admin confirms the finding → listing updated, status "verified", admin-managed.
-- Reject: finding kept for history, listing untouched.
create function public.admin_review_finding(p_finding uuid, p_action text, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  f public.hh_findings;
  w jsonb;
  i int := 0;
begin
  perform public.aour_require_admin();
  select * into f from public.hh_findings where id = p_finding for update;
  if not found then
    raise exception 'Finding not found' using errcode = 'P0002';
  end if;
  if p_action = 'reject' then
    update public.hh_findings set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(),
           decision_reason = coalesce(p_note, decision_reason) where id = f.id;
    perform public.aour_log('reject_finding', 'hh_finding', f.id::text, p_note);
    return;
  end if;
  if p_action <> 'approve' then
    raise exception 'Unknown action' using errcode = '22023';
  end if;

  delete from public.happy_hour_windows where establishment_id = f.establishment_id;
  for w in select * from jsonb_array_elements(f.windows) loop
    i := i + 1;
    insert into public.happy_hour_windows (establishment_id, days, start_time, end_time, label, sort_order)
    values (f.establishment_id, (select array_agg(d::smallint order by d::smallint) from jsonb_array_elements_text(w -> 'days') d),
            (w ->> 'start')::time, (w ->> 'end')::time, nullif(w ->> 'label', ''), i);
  end loop;
  delete from public.happy_hour_specials where establishment_id = f.establishment_id;
  insert into public.happy_hour_specials (establishment_id, kind, title, price, description, sort_order)
  select f.establishment_id, coalesce(s ->> 'kind', 'other')::public.special_kind, left(s ->> 'title', 80), left(nullif(s ->> 'price', ''), 30),
         left(nullif(s ->> 'description', ''), 200), ord::smallint
  from jsonb_array_elements(f.specials) with ordinality t(s, ord);

  insert into public.listing_sources (establishment_id, kind, url, note, created_by)
  values (f.establishment_id,
          case f.source_kind when 'official_website' then 'official_website'::public.source_kind
                             when 'osm' then 'open_data'::public.source_kind
                             when 'user' then 'user_submission'::public.source_kind else 'website'::public.source_kind end,
          f.source_url, coalesce(p_note, 'Approved automated finding'), auth.uid());

  update public.hh_findings set status = 'superseded' where establishment_id = f.establishment_id and status in ('applied', 'approved') and id <> f.id;
  update public.hh_findings set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now() where id = f.id;
  update public.establishments set
    hh_status = case when jsonb_array_length(f.windows) = 0 and jsonb_array_length(f.specials) = 0 then hh_status else 'verified' end,
    hh_verified_at = now(), hh_verified_by = auth.uid(), hh_managed_by = 'admin', hh_confidence = 1, hh_conflict = false,
    hh_source_url = f.source_url, hh_restrictions = f.restrictions, hh_fingerprint = f.fingerprint,
    hh_last_confirmed_at = now(), hh_last_changed_at = now(),
    hh_source_note = coalesce(hh_source_note, 'Verified by Aour')
  where id = f.establishment_id;
  insert into public.listing_changes (establishment_id, actor, admin_id, summary, after_fingerprint, source_url)
  values (f.establishment_id, 'admin', auth.uid(), 'Approved automated finding', f.fingerprint, f.source_url);
  perform public.aour_log('approve_finding', 'hh_finding', f.id::text, p_note);
end $$;

-- Hand a listing back to automation (or take it over) explicitly.
create function public.admin_set_hh_managed(p_establishment uuid, p_managed_by text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  if p_managed_by not in ('auto', 'admin') then
    raise exception 'Invalid value' using errcode = '22023';
  end if;
  update public.establishments set hh_managed_by = p_managed_by,
         locked_fields = case when p_managed_by = 'auto' then '{}' else locked_fields end,
         next_enrich_at = case when p_managed_by = 'auto' then now() else next_enrich_at end
   where id = p_establishment;
  perform public.aour_log('set_hh_managed_' || p_managed_by, 'establishment', p_establishment::text);
end $$;

-- Merge a duplicate into the record we keep. Ratings, saves, lists and provenance move over.
create function public.admin_merge_establishments(p_keep uuid, p_merge uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  if p_keep = p_merge then
    raise exception 'Choose two different places' using errcode = '22023';
  end if;
  if not exists (select 1 from public.establishments where id = p_keep) or not exists (select 1 from public.establishments where id = p_merge) then
    raise exception 'Place not found' using errcode = 'P0002';
  end if;

  update public.visits set establishment_id = p_keep where establishment_id = p_merge;
  update public.reviews set establishment_id = p_keep where establishment_id = p_merge;
  insert into public.saved_places (user_id, establishment_id, list, created_at)
    select user_id, p_keep, list, created_at from public.saved_places where establishment_id = p_merge
    on conflict do nothing;
  delete from public.saved_places where establishment_id = p_merge;
  insert into public.collection_items (collection_id, establishment_id, note, position, added_at)
    select collection_id, p_keep, note, position, added_at from public.collection_items where establishment_id = p_merge
    on conflict do nothing;
  delete from public.collection_items where establishment_id = p_merge;
  update public.establishment_external_ids set establishment_id = p_keep where establishment_id = p_merge;
  update public.listing_sources set establishment_id = p_keep where establishment_id = p_merge;
  update public.hh_findings set establishment_id = p_keep where establishment_id = p_merge;
  update public.establishment_photos set establishment_id = p_keep where establishment_id = p_merge;
  update public.establishment_submissions set establishment_id = p_keep where establishment_id = p_merge;
  -- Fill gaps on the kept record from the merged one.
  update public.establishments k set
    website = coalesce(k.website, m.website), phone = coalesce(k.phone, m.phone),
    postal_code = coalesce(k.postal_code, m.postal_code), business_hours = coalesce(k.business_hours, m.business_hours),
    attribution = coalesce(k.attribution, m.attribution)
  from public.establishments m where k.id = p_keep and m.id = p_merge;
  update public.establishments set status = 'archived', merged_into = p_keep where id = p_merge;
  update public.possible_duplicates set status = 'merged', resolved_by = auth.uid(), resolved_at = now()
   where status = 'open' and (establishment_a in (p_keep, p_merge) and establishment_b in (p_keep, p_merge));
  perform public.aour_refresh_establishment_stats(p_keep);
  perform public.aour_refresh_establishment_stats(p_merge);
  insert into public.listing_changes (establishment_id, actor, admin_id, summary)
  values (p_keep, 'admin', auth.uid(), 'Merged duplicate listing ' || p_merge::text);
  perform public.aour_log('merge_establishments', 'establishment', p_keep::text, 'merged ' || p_merge::text);
end $$;

create function public.admin_resolve_duplicate(p_duplicate uuid, p_action text)
returns void
language plpgsql security definer set search_path = '' as $$
declare d public.possible_duplicates;
begin
  perform public.aour_require_admin();
  select * into d from public.possible_duplicates where id = p_duplicate;
  if not found then
    raise exception 'Not found' using errcode = 'P0002';
  end if;
  if p_action = 'merge' then
    perform public.admin_merge_establishments(d.establishment_a, d.establishment_b);
  elsif p_action = 'dismiss' then
    -- Not the same place: publish the new record if it was held back as a draft.
    update public.establishments set status = 'published'
     where id = d.establishment_b and status = 'draft' and origin = 'import';
    update public.possible_duplicates set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now() where id = d.id;
    perform public.aour_log('dismiss_duplicate', 'possible_duplicate', d.id::text);
  else
    raise exception 'Unknown action' using errcode = '22023';
  end if;
end $$;

create function public.admin_list_duplicates() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'score', d.score, 'reasons', d.reasons, 'createdAt', d.created_at,
      'a', jsonb_build_object('id', a.id, 'name', a.name, 'slug', a.slug, 'address', a.address, 'website', a.website, 'status', a.status, 'origin', a.origin,
                              'visits', (select count(*) from public.visits v where v.establishment_id = a.id)),
      'b', jsonb_build_object('id', b.id, 'name', b.name, 'slug', b.slug, 'address', b.address, 'website', b.website, 'status', b.status, 'origin', b.origin,
                              'visits', (select count(*) from public.visits v where v.establishment_id = b.id))
    ) order by d.score desc), '[]')
    from public.possible_duplicates d
    join public.establishments a on a.id = d.establishment_a
    join public.establishments b on b.id = d.establishment_b
    where d.status = 'open'
  );
end $$;

create function public.admin_enqueue_refresh(p_kind text, p_target uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare j uuid;
begin
  perform public.aour_require_admin();
  if p_kind not in ('discover_market', 'enrich_establishment') then
    raise exception 'Unknown job kind' using errcode = '22023';
  end if;
  insert into public.refresh_jobs (kind, target_id, priority, requested_by)
  values (p_kind, p_target, 10, auth.uid())
  on conflict do nothing
  returning id into j;
  if j is null then
    select id into j from public.refresh_jobs where kind = p_kind and target_id = p_target and status in ('queued', 'running');
    update public.refresh_jobs set priority = 10, run_after = least(run_after, now()) where id = j and status = 'queued';
  end if;
  perform public.aour_log('enqueue_refresh', p_kind, p_target::text);
  return j;
end $$;

create function public.admin_set_provider_limit(p_provider text, p_monthly_limit integer, p_enabled boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  update public.provider_limits set monthly_limit = greatest(p_monthly_limit, 0), enabled = p_enabled where provider = p_provider;
  perform public.aour_log('set_provider_limit', 'provider', p_provider, p_monthly_limit || ' / ' || p_enabled);
end $$;

-- Create or update a market (e.g. from a coverage request); discovery starts on the next tick.
create function public.admin_save_market(p jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public.aour_require_admin();
  if v_id is null then
    insert into public.markets (slug, name, region, lat, lng, timezone, areas, radius_miles, auto_publish)
    values (p ->> 'slug', p ->> 'name', coalesce(p ->> 'region', ''), (p ->> 'lat')::double precision, (p ->> 'lng')::double precision,
            p ->> 'timezone', coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'areas') x), '{}'),
            coalesce((p ->> 'radiusMiles')::numeric, 15), coalesce((p ->> 'autoPublish')::boolean, true))
    returning id into v_id;
  else
    update public.markets set name = p ->> 'name', region = coalesce(p ->> 'region', region),
      lat = (p ->> 'lat')::double precision, lng = (p ->> 'lng')::double precision, timezone = p ->> 'timezone',
      radius_miles = coalesce((p ->> 'radiusMiles')::numeric, radius_miles),
      auto_publish = coalesce((p ->> 'autoPublish')::boolean, auto_publish),
      discovery_enabled = coalesce((p ->> 'discoveryEnabled')::boolean, discovery_enabled),
      is_active = coalesce((p ->> 'isActive')::boolean, is_active)
    where id = v_id;
  end if;
  if p ? 'coverageCell' then
    update public.coverage_requests set status = 'activated' where cell = p ->> 'coverageCell';
  end if;
  perform public.aour_log('save_market', 'market', v_id::text, p ->> 'name');
  return v_id;
end $$;

create function public.admin_dismiss_coverage(p_cell text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  update public.coverage_requests set status = 'dismissed' where cell = p_cell;
end $$;

create function public.admin_listing_history(p_establishment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  return jsonb_build_object(
    'changes', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc), '[]') from (
      select * from public.listing_changes where establishment_id = p_establishment order by created_at desc limit 50) c),
    'jobs', (select coalesce(jsonb_agg(to_jsonb(j) order by j.created_at desc), '[]') from (
      select * from public.refresh_jobs where target_id = p_establishment order by created_at desc limit 20) j),
    'documents', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from public.source_documents d where d.establishment_id = p_establishment),
    'externalIds', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.establishment_external_ids x where x.establishment_id = p_establishment)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Admin edits now lock what they touch (automation will not overwrite them).
-- ---------------------------------------------------------------------------
create or replace function public.aour_lock_on_admin_edit() returns trigger
language plpgsql set search_path = '' as $$
declare locks text[] := new.locked_fields;
begin
  -- Only interactive admin sessions lock fields; the pipeline runs without an end-user JWT.
  if auth.uid() is null or not public.aour_is_admin() then return new; end if;
  if new.name is distinct from old.name then locks := array_append(locks, 'name'); end if;
  if new.website is distinct from old.website then locks := array_append(locks, 'website'); end if;
  if new.phone is distinct from old.phone then locks := array_append(locks, 'phone'); end if;
  if new.address is distinct from old.address or new.lat is distinct from old.lat or new.lng is distinct from old.lng then
    locks := array_append(locks, 'location');
  end if;
  if new.status is distinct from old.status then locks := array_append(locks, 'status'); end if;
  new.locked_fields := (select coalesce(array_agg(distinct x), '{}') from unnest(locks) x);
  return new;
end $$;
create trigger establishments_admin_locks before update on public.establishments
  for each row execute function public.aour_lock_on_admin_edit();

-- Schedule/specials edited by an admin ⇒ admin-managed from now on.
create or replace function public.aour_admin_manages_hh() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and public.aour_is_admin() then
    update public.establishments set hh_managed_by = 'admin'
     where id = coalesce(new.establishment_id, old.establishment_id) and hh_managed_by <> 'admin';
  end if;
  return null;
end $$;
create trigger windows_admin_manages after insert or update or delete on public.happy_hour_windows
  for each row execute function public.aour_admin_manages_hh();
create trigger specials_admin_manages after insert or update or delete on public.happy_hour_specials
  for each row execute function public.aour_admin_manages_hh();

-- Admin verification now also records confirmation time and takes ownership.
create or replace function public.admin_verify_listing(
  p_establishment uuid, p_source_kind public.source_kind, p_source_note text default null, p_source_url text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.aour_require_admin();
  insert into public.listing_sources (establishment_id, kind, url, note, created_by)
  values (p_establishment, p_source_kind, p_source_url, p_source_note, auth.uid());
  update public.establishments
     set hh_status = case when hh_status = 'none' then 'none'::public.hh_status else 'verified'::public.hh_status end,
         hh_verified_at = now(), hh_verified_by = auth.uid(), hh_managed_by = 'admin',
         hh_confidence = 1, hh_conflict = false, hh_last_confirmed_at = now()
   where id = p_establishment;
  insert into public.listing_changes (establishment_id, actor, admin_id, summary, source_url)
  values (p_establishment, 'admin', auth.uid(), 'Verified: ' || coalesce(p_source_note, p_source_kind::text), p_source_url);
  perform public.aour_log('verify_listing', 'establishment', p_establishment::text, p_source_note);
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- Re-grant the existing public API (the blanket revoke above covers every function).
grant execute on function
  public.aour_is_admin(), public.aour_is_active(), public.aour_user_active(uuid), public.aour_profile_is_public(uuid),
  public.aour_can_view_visit(uuid), public.aour_owns_visit(uuid), public.aour_owns_collection(uuid),
  public.aour_valid_weights(jsonb), public.aour_composite(jsonb, jsonb), public.aour_user_card(public.profiles),
  public.establishment_reviews(uuid, boolean, int, timestamptz), public.get_profile(text),
  public.profile_reviews(uuid, int, timestamptz), public.profile_favorites(uuid), public.search_profiles(text),
  public.collection_by_share(text), public.featured_collections(),
  public.nearby_establishments(double precision, double precision, integer, integer),
  public.request_coverage(double precision, double precision, text)
to anon, authenticated;

grant execute on function
  public.save_visit(jsonb), public.delete_my_account(), public.following_feed(int, timestamptz), public.friend_activity(int),
  public.my_following(),
  public.admin_stats(), public.admin_list_users(text, int), public.admin_set_suspended(uuid, boolean, text),
  public.admin_set_role(uuid, public.user_role), public.admin_moderate_review(uuid, public.review_status, text),
  public.admin_set_visit_excluded(uuid, boolean, text), public.admin_dismiss_report(uuid),
  public.admin_list_reports(public.report_status), public.admin_review_submission(uuid, public.submission_status, text),
  public.admin_set_featured(uuid, boolean), public.admin_verify_listing(uuid, public.source_kind, text, text),
  public.admin_save_establishment(jsonb),
  public.admin_pipeline_overview(), public.admin_list_findings(text, uuid), public.admin_review_finding(uuid, text, text),
  public.admin_set_hh_managed(uuid, text), public.admin_merge_establishments(uuid, uuid), public.admin_resolve_duplicate(uuid, text),
  public.admin_list_duplicates(), public.admin_enqueue_refresh(text, uuid), public.admin_set_provider_limit(text, integer, boolean),
  public.admin_save_market(jsonb), public.admin_dismiss_coverage(text), public.admin_listing_history(uuid)
to authenticated;

-- The background pipeline authenticates with the service role (Worker secret / CI secret).
grant execute on function
  public.pipeline_nearby_for_match(double precision, double precision, integer),
  public.pipeline_upsert_place(uuid, jsonb, jsonb),
  public.pipeline_enrichment_target(uuid),
  public.pipeline_record_finding(uuid, jsonb, text, jsonb, text),
  public.pipeline_record_document(uuid, text, jsonb),
  public.pipeline_get_domain(text), public.pipeline_put_domain(text, jsonb),
  public.pipeline_schedule_establishment(uuid, boolean, timestamptz),
  public.pipeline_consume_budget(text, integer),
  public.pipeline_enqueue_due(integer),
  public.pipeline_claim_jobs(text, integer, text[]),
  public.pipeline_finish_job(uuid, text, text, jsonb, timestamptz),
  public.pipeline_mark_market_discovered(uuid, boolean),
  public.pipeline_get_market(uuid), public.pipeline_mark_outdated(uuid, text),
  public.aour_slug_available(text)
to service_role;
grant select on public.markets, public.establishments to service_role;
