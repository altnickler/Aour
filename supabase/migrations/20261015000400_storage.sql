-- Storage buckets. Images are compressed client-side (≤1600px JPEG ~80%) before upload.
--
-- Buckets are public-read so images are served from Supabase's CDN cheaply. Object names
-- are random UUIDs under the owner's folder, so they are not enumerable; a photo attached
-- to a private visit is only reachable by someone who already has its exact URL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('visit-photos', 'visit-photos', true, 3145728, array['image/jpeg', 'image/webp', 'image/png']),
  ('avatars', 'avatars', true, 1048576, array['image/jpeg', 'image/webp', 'image/png']),
  ('establishment-photos', 'establishment-photos', true, 5242880, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do nothing;

-- Users write only inside "<their user id>/…" in visit-photos and avatars.
create policy "own folder insert" on storage.objects for insert to authenticated with check (
  bucket_id in ('visit-photos', 'avatars')
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.aour_is_active()
);
create policy "own folder update" on storage.objects for update to authenticated using (
  bucket_id in ('visit-photos', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "own folder delete" on storage.objects for delete to authenticated using (
  bucket_id in ('visit-photos', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "own folder list" on storage.objects for select to authenticated using (
  bucket_id in ('visit-photos', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text
);

-- Establishment photos are managed by admins only.
create policy "admin establishment photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'establishment-photos' and public.aour_is_admin());
create policy "admin establishment photos update" on storage.objects for update to authenticated
  using (bucket_id = 'establishment-photos' and public.aour_is_admin());
create policy "admin establishment photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'establishment-photos' and public.aour_is_admin());
create policy "admin establishment photos list" on storage.objects for select to authenticated
  using (bucket_id = 'establishment-photos' and public.aour_is_admin());
