-- Atomic create/update of a listing with its schedule, exceptions and specials, so an
-- admin save can never leave a half-written listing visible to users.
--
-- p = { id?, slug, name, kind, market_id, neighborhood, city, state, address, postal_code,
--       lat, lng, timezone, phone, website, description, price_level, amenities: [..],
--       hh_status, hh_source_note, status,
--       windows: [{days:[1,2], start:"16:00", end:"19:00", label, notes}],
--       exceptions: [{date, closed, start, end, note}],
--       specials: [{kind, title, price, description}] }
create function public.admin_save_establishment(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  w jsonb;
  i int := 0;
begin
  perform public.aour_require_admin();

  if v_id is null then
    insert into public.establishments (
      slug, name, kind, market_id, neighborhood, city, state, address, postal_code, lat, lng, timezone,
      phone, website, description, price_level, amenities, hh_status, hh_source_note, status, created_by
    ) values (
      p ->> 'slug', p ->> 'name', (p ->> 'kind')::public.establishment_kind, (p ->> 'market_id')::uuid,
      nullif(p ->> 'neighborhood', ''), p ->> 'city', coalesce(nullif(p ->> 'state', ''), 'FL'), p ->> 'address',
      nullif(p ->> 'postal_code', ''), (p ->> 'lat')::double precision, (p ->> 'lng')::double precision,
      coalesce(nullif(p ->> 'timezone', ''), 'America/New_York'), nullif(p ->> 'phone', ''), nullif(p ->> 'website', ''),
      nullif(p ->> 'description', ''), nullif(p ->> 'price_level', '')::smallint,
      coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'amenities') x), '{}'),
      -- New listings are never "verified" until an admin records a source via admin_verify_listing.
      case when p ->> 'hh_status' = 'none' then 'none'::public.hh_status else 'unverified'::public.hh_status end,
      nullif(p ->> 'hh_source_note', ''), coalesce(p ->> 'status', 'draft')::public.listing_status, auth.uid()
    ) returning id into v_id;
    perform public.aour_log('create_listing', 'establishment', v_id::text, p ->> 'name');
  else
    update public.establishments set
      slug = p ->> 'slug', name = p ->> 'name', kind = (p ->> 'kind')::public.establishment_kind,
      market_id = (p ->> 'market_id')::uuid, neighborhood = nullif(p ->> 'neighborhood', ''), city = p ->> 'city',
      state = coalesce(nullif(p ->> 'state', ''), 'FL'), address = p ->> 'address', postal_code = nullif(p ->> 'postal_code', ''),
      lat = (p ->> 'lat')::double precision, lng = (p ->> 'lng')::double precision,
      timezone = coalesce(nullif(p ->> 'timezone', ''), 'America/New_York'), phone = nullif(p ->> 'phone', ''),
      website = nullif(p ->> 'website', ''), description = nullif(p ->> 'description', ''),
      price_level = nullif(p ->> 'price_level', '')::smallint,
      amenities = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'amenities') x), '{}'),
      -- Admins may downgrade/flag freely; "verified" can only be set via admin_verify_listing.
      hh_status = case
        when p ->> 'hh_status' in ('unverified', 'outdated', 'none') then (p ->> 'hh_status')::public.hh_status
        else hh_status end,
      hh_source_note = nullif(p ->> 'hh_source_note', ''),
      status = coalesce(p ->> 'status', status::text)::public.listing_status
    where id = v_id;
    if not found then
      raise exception 'Listing not found.' using errcode = 'P0002';
    end if;
    perform public.aour_log('update_listing', 'establishment', v_id::text, p ->> 'name');
  end if;

  if p ? 'windows' then
    delete from public.happy_hour_windows where establishment_id = v_id;
    for w in select * from jsonb_array_elements(p -> 'windows') loop
      i := i + 1;
      insert into public.happy_hour_windows (establishment_id, days, start_time, end_time, label, notes, sort_order)
      values (
        v_id,
        (select array_agg(d::smallint order by d::smallint) from jsonb_array_elements_text(w -> 'days') d),
        (w ->> 'start')::time, (w ->> 'end')::time, nullif(w ->> 'label', ''), nullif(w ->> 'notes', ''), i
      );
    end loop;
  end if;

  if p ? 'exceptions' then
    delete from public.schedule_exceptions where establishment_id = v_id;
    insert into public.schedule_exceptions (establishment_id, date, closed, start_time, end_time, note)
    select v_id, (e ->> 'date')::date, coalesce((e ->> 'closed')::boolean, true),
           nullif(e ->> 'start', '')::time, nullif(e ->> 'end', '')::time, nullif(e ->> 'note', '')
    from jsonb_array_elements(p -> 'exceptions') e;
  end if;

  if p ? 'specials' then
    delete from public.happy_hour_specials where establishment_id = v_id;
    insert into public.happy_hour_specials (establishment_id, kind, title, price, description, sort_order)
    select v_id, coalesce(s ->> 'kind', 'drink')::public.special_kind, s ->> 'title', nullif(s ->> 'price', ''),
           nullif(s ->> 'description', ''), ord::smallint
    from jsonb_array_elements(p -> 'specials') with ordinality as t(s, ord);
  end if;

  return v_id;
end $$;

revoke execute on function public.admin_save_establishment(jsonb) from public, anon, authenticated;
grant execute on function public.admin_save_establishment(jsonb) to authenticated;
