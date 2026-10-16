-- Automatic coverage: when people using their device location find no listings, their anonymous
-- (~11 km) coverage request can become a discovery area without an admin, within a monthly cap.
-- New areas only import venues (Overture) and then refresh happy hours from the venues' own
-- websites; nothing is marked verified. Disable or resize via provider_limits 'auto_market'.

alter table public.coverage_requests
  add column timezone text check (timezone is null or char_length(timezone) <= 64);

alter table public.markets
  add column auto_created boolean not null default false;

insert into public.provider_limits (provider, monthly_limit, enabled, note) values
  ('auto_market', 3, true, 'Discovery areas created automatically from "near me" coverage requests (10 mi radius)')
on conflict (provider) do nothing;

-- Same contract as before plus an optional IANA time zone hint from the requesting device.
drop function public.request_coverage(double precision, double precision, text);
create function public.request_coverage(p_lat double precision, p_lng double precision, p_label text default null, p_timezone text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  covered boolean;
  c_lat numeric := round(p_lat::numeric, 1);
  c_lng numeric := round(p_lng::numeric, 1);
  tz text := case when p_timezone is not null and exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone)
                  then p_timezone end;
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
    insert into public.coverage_requests (cell, lat, lng, label, timezone)
    values (c_lat || ',' || c_lng, c_lat, c_lng, left(p_label, 80), tz)
    on conflict (cell) do update
      set requests = public.coverage_requests.requests + 1,
          last_requested_at = now(),
          label = coalesce(public.coverage_requests.label, excluded.label),
          timezone = coalesce(public.coverage_requests.timezone, excluded.timezone);
  end if;
  return covered;
end $$;

-- Turn open coverage requests (with a known time zone, outside every active market) into
-- discovery areas, most-requested first, spending one 'auto_market' budget unit each.
create function public.pipeline_promote_coverage(p_limit integer default 1)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r public.coverage_requests;
  n int := 0;
begin
  for r in
    select * from public.coverage_requests c
    where c.status = 'open' and c.timezone is not null
      and not exists (
        select 1 from public.markets m
        where m.is_active and extensions.st_dwithin(
          extensions.st_setsrid(extensions.st_makepoint(m.lng, m.lat), 4326)::extensions.geography,
          extensions.st_setsrid(extensions.st_makepoint(c.lng::double precision, c.lat::double precision), 4326)::extensions.geography,
          m.radius_miles * 1609.34))
    order by c.requests desc, c.first_requested_at
    limit greatest(p_limit, 0)
  loop
    exit when not public.pipeline_consume_budget('auto_market', 1);
    insert into public.markets (slug, name, region, lat, lng, timezone, areas, radius_miles, auto_publish, discovery_enabled, is_active, auto_created)
    values (
      -- "27.2,-80.3" → "area-27p2-m80p3" (slugs allow only a-z, 0-9 and dashes)
      left('area-' || replace(replace(replace(r.cell, '-', 'm'), '.', 'p'), ',', '-'), 40),
      coalesce(r.label, 'Area near ' || r.lat || ', ' || r.lng),
      '', r.lat::double precision, r.lng::double precision, r.timezone, '{}', 10, true, true, true, true)
    on conflict (slug) do nothing;
    update public.coverage_requests set status = 'activated' where cell = r.cell;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.request_coverage(double precision, double precision, text, text) from public;
revoke execute on function public.pipeline_promote_coverage(integer) from public, anon, authenticated;
grant execute on function public.request_coverage(double precision, double precision, text, text) to anon, authenticated;
grant execute on function public.pipeline_promote_coverage(integer) to service_role;
