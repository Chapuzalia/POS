-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- The product-images policies only existed in the baseline dump, so environments
-- built from migrations deny every catalog image upload. New names keep this
-- additive on installations that already have the historical policies: the
-- predicates match them and grant no additional access. No UPDATE policy: the
-- app never overwrites images (uploads use upsert: false).
create policy product_images_access_read
  on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid));

create policy product_images_access_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid));

create policy product_images_access_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid));
