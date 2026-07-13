-- Imagenes de producto para TPV y mixers.
-- Ejecutar una vez en Supabase SQL Editor.

alter table public.products
add column if not exists image_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 1048576, array['image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "product_images_public_read" on storage.objects;
-- El bucket publico permite getPublicUrl; el SELECT siguiente solo permite
-- consultar metadatos dentro de la carpeta de un tenant autorizado.

drop policy if exists "product_images_tenant_select" on storage.objects;
create policy "product_images_tenant_select"
on storage.objects for select to authenticated
using (
  bucket_id = 'product-images'
  and public.user_has_tenant_access(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "product_images_tenant_insert" on storage.objects;
create policy "product_images_tenant_insert"
on storage.objects for insert
with check (
  bucket_id = 'product-images'
  and public.user_has_tenant_access(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "product_images_tenant_update" on storage.objects;
create policy "product_images_tenant_update"
on storage.objects for update
using (
  bucket_id = 'product-images'
  and public.user_has_tenant_access(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'product-images'
  and public.user_has_tenant_access(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "product_images_tenant_delete" on storage.objects;
create policy "product_images_tenant_delete"
on storage.objects for delete
using (
  bucket_id = 'product-images'
  and public.user_has_tenant_access(((storage.foldername(name))[1])::uuid)
);
