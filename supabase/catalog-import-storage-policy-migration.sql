-- Permite que los administradores sobrescriban imagenes durante la importacion
-- ZIP. Supabase Storage requiere SELECT ademas de INSERT y UPDATE para upsert.

drop policy if exists "product_images_tenant_select" on storage.objects;
create policy "product_images_tenant_select"
on storage.objects for select to authenticated
using (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);
