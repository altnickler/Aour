-- People the caller follows, as public user cards (profiles rows are not directly readable).
create function public.my_following() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.aour_user_card(p) order by p.display_name), '[]'::jsonb)
  from public.follows f join public.profiles p on p.id = f.followee_id
  where f.follower_id = auth.uid() and p.suspended_at is null
$$;

revoke execute on function public.my_following() from public, anon, authenticated;
grant execute on function public.my_following() to authenticated;

-- Adding/removing items bumps the collection's updated_at (for "recently updated" order).
create function public.aour_touch_collection() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.collections set updated_at = now()
   where id = coalesce(new.collection_id, old.collection_id);
  return null;
end $$;
create trigger collection_items_touch after insert or delete on public.collection_items
  for each row execute function public.aour_touch_collection();
revoke execute on function public.aour_touch_collection() from public, anon, authenticated;
