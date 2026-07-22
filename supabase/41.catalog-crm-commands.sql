begin;

-- Runs several existing catalog commands under one PostgreSQL transaction.
-- Client-generated UUIDs let later commands reference entities created earlier
-- in the same batch without exposing database details in the UI.
create or replace function public.catalog_command_batch(
  p_venue_id uuid,
  p_commands jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_commands) <> 'array' or jsonb_array_length(p_commands) = 0 then
    raise exception 'CATALOG_EMPTY_COMMAND_BATCH';
  end if;
  if jsonb_array_length(p_commands) > 5000 then
    raise exception 'CATALOG_COMMAND_BATCH_TOO_LARGE';
  end if;
  perform 1 from public.venues where id = p_venue_id for update;
  if not found then raise exception 'CATALOG_SCOPE_MISMATCH'; end if;
  for v_command in select value from jsonb_array_elements(p_commands) loop
    if coalesce(v_command ->> 'command', '') = '' then
      raise exception 'CATALOG_INVALID_BATCH_COMMAND';
    end if;
    if v_command ->> 'command' = 'save_tab_category' then
      v_results := v_results || jsonb_build_array(public.catalog_tab_category_command(
        p_venue_id, 'save', coalesce(v_command -> 'payload', '{}'::jsonb)
      ));
    else
      v_results := v_results || jsonb_build_array(public.catalog_command(
        p_venue_id,
        v_command ->> 'command',
        coalesce(v_command -> 'payload', '{}'::jsonb)
      ));
    end if;
  end loop;
  return jsonb_build_object('result', 'SUCCESS', 'results', v_results);
end;
$$;

create or replace function public.catalog_tab_category_command(
  p_venue_id uuid,
  p_action text,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_id uuid;
begin
  select tenant_id into v_tenant_id from public.venues where id = p_venue_id for update;
  if v_tenant_id is null then raise exception 'CATALOG_SCOPE_MISMATCH'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant_id) then
    raise exception 'CATALOG_COMMAND_FORBIDDEN';
  end if;
  if p_action = 'save' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.catalog_tab_categories(
      id, tenant_id, venue_id, tab_id, category_id, is_active, sort_order
    ) values (
      v_id, v_tenant_id, p_venue_id,
      (p_payload ->> 'tabId')::uuid,
      (p_payload ->> 'categoryId')::uuid,
      coalesce((p_payload ->> 'active')::boolean, true),
      (p_payload ->> 'sortOrder')::integer
    )
    on conflict (tab_id, category_id) do update set
      is_active = excluded.is_active,
      sort_order = excluded.sort_order
    where catalog_tab_categories.venue_id = p_venue_id
    returning id into v_id;
  elsif p_action = 'delete' then
    v_id := (p_payload ->> 'id')::uuid;
    if exists (
      select 1 from public.catalog_placements
      where venue_id = p_venue_id
        and tab_id = (select tab_id from public.catalog_tab_categories where id = v_id)
        and category_id = (select category_id from public.catalog_tab_categories where id = v_id)
    ) then
      raise exception 'CATALOG_TAB_CATEGORY_IN_USE';
    end if;
    delete from public.catalog_tab_categories where id = v_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;
  else
    raise exception 'CATALOG_UNKNOWN_TAB_CATEGORY_COMMAND';
  end if;
  return jsonb_build_object('result', 'SUCCESS', 'id', v_id);
end;
$$;

create or replace function public.catalog_image_command(
  p_venue_id uuid,
  p_action text,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_product_id uuid := (p_payload ->> 'productId')::uuid;
  v_id uuid;
  v_previous_path text;
  v_orphaned_paths text[] := '{}';
begin
  select tenant_id into v_tenant_id from public.venues where id = p_venue_id for update;
  if v_tenant_id is null then raise exception 'CATALOG_SCOPE_MISMATCH'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant_id) then
    raise exception 'CATALOG_COMMAND_FORBIDDEN';
  end if;
  if not exists (
    select 1 from public.products where id = v_product_id and venue_id = p_venue_id
  ) then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;

  select storage_path into v_previous_path
  from public.product_images
  where product_id = v_product_id and venue_id = p_venue_id
  for update;

  if p_action = 'save' then
    if p_payload ->> 'mimeType' not in ('image/webp', 'image/jpeg', 'image/png', 'image/avif') then
      raise exception 'CATALOG_IMAGE_TYPE_INVALID';
    end if;
    if (p_payload ->> 'sizeBytes')::bigint <= 0 or (p_payload ->> 'sizeBytes')::bigint > 1048576 then
      raise exception 'CATALOG_IMAGE_SIZE_INVALID';
    end if;
    if p_payload ->> 'sha256' !~ '^[a-f0-9]{64}$' then
      raise exception 'CATALOG_IMAGE_HASH_INVALID';
    end if;
    if (p_payload ->> 'storagePath') not like (v_tenant_id::text || '/' || p_venue_id::text || '/products/%') then
      raise exception 'CATALOG_IMAGE_PATH_INVALID';
    end if;
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.product_images(
      id, tenant_id, venue_id, product_id, storage_path, mime_type, size_bytes, sha256
    ) values (
      v_id, v_tenant_id, p_venue_id, v_product_id,
      p_payload ->> 'storagePath', p_payload ->> 'mimeType',
      (p_payload ->> 'sizeBytes')::bigint, p_payload ->> 'sha256'
    )
    on conflict (product_id) do update set
      storage_path = excluded.storage_path,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      sha256 = excluded.sha256
    where product_images.venue_id = p_venue_id
    returning id into v_id;
  elsif p_action = 'delete' then
    delete from public.product_images
    where product_id = v_product_id and venue_id = p_venue_id
    returning id into v_id;
    if not found then raise exception 'CATALOG_IMAGE_NOT_FOUND'; end if;
  else
    raise exception 'CATALOG_UNKNOWN_IMAGE_COMMAND';
  end if;

  if v_previous_path is not null
    and v_previous_path is distinct from p_payload ->> 'storagePath'
    and not exists (select 1 from public.product_images where storage_path = v_previous_path)
  then
    v_orphaned_paths := array_append(v_orphaned_paths, v_previous_path);
  end if;
  return jsonb_build_object(
    'result', 'SUCCESS', 'id', v_id,
    'orphanedImagePaths', to_jsonb(v_orphaned_paths)
  );
end;
$$;

revoke all on function public.catalog_command_batch(uuid, jsonb) from public, anon;
revoke all on function public.catalog_tab_category_command(uuid, text, jsonb) from public, anon;
revoke all on function public.catalog_image_command(uuid, text, jsonb) from public, anon;
grant execute on function public.catalog_command_batch(uuid, jsonb) to authenticated, service_role;
grant execute on function public.catalog_tab_category_command(uuid, text, jsonb) to authenticated, service_role;
grant execute on function public.catalog_image_command(uuid, text, jsonb) to authenticated, service_role;

comment on function public.catalog_command_batch(uuid, jsonb) is
  'Executes CRM catalog mutations atomically using the definitive command service.';
comment on function public.catalog_image_command(uuid, text, jsonb) is
  'Registers or removes product image metadata and returns only unreferenced storage paths.';

commit;
