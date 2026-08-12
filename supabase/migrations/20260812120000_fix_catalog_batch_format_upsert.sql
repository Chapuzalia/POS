create or replace function public.catalog_command_batch_with_formats(
  p_venue_id uuid,
  p_commands jsonb,
  p_variant_formats jsonb,
  p_new_formats jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_result jsonb;
  v_item jsonb;
  v_format_id uuid;
  v_format_name text;
begin
  select v.tenant_id into v_tenant_id
  from public.venues v
  where v.id = p_venue_id
  for update;

  if v_tenant_id is null then raise exception 'CATALOG_VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role'
    and not public.user_is_tenant_admin(v_tenant_id)
  then
    raise exception 'CATALOG_COMMAND_FORBIDDEN';
  end if;
  if jsonb_typeof(p_commands) <> 'array'
    or jsonb_array_length(p_commands) = 0
  then
    raise exception 'CATALOG_EMPTY_COMMAND_BATCH';
  end if;
  if jsonb_typeof(p_variant_formats) <> 'array'
    or jsonb_array_length(p_variant_formats) = 0
  then
    raise exception 'CATALOG_VARIANT_FORMAT_REQUIRED';
  end if;
  if jsonb_typeof(coalesce(p_new_formats, '[]'::jsonb)) <> 'array' then
    raise exception 'CATALOG_SALE_FORMAT_PLAN_INVALID';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(coalesce(p_new_formats, '[]'::jsonb))
  loop
    v_format_id := nullif(v_item ->> 'id', '')::uuid;
    v_format_name := trim(v_item ->> 'name');
    if v_format_id is null or coalesce(v_format_name, '') = '' then
      raise exception 'CATALOG_SALE_FORMAT_PLAN_INVALID';
    end if;
    if exists (
      select 1
      from public.catalog_sale_formats f
      where f.id = v_format_id
        and (f.tenant_id <> v_tenant_id or f.venue_id <> p_venue_id)
    ) then
      raise exception 'CATALOG_SCOPE_MISMATCH';
    end if;

    insert into public.catalog_sale_formats (
      id,
      tenant_id,
      venue_id,
      name,
      is_active,
      sort_order
    )
    values (
      v_format_id,
      v_tenant_id,
      p_venue_id,
      v_format_name,
      coalesce((v_item ->> 'active')::boolean, true),
      coalesce((v_item ->> 'sortOrder')::integer, 0)
    )
    on conflict (id) do update
    set name = excluded.name,
        is_active = excluded.is_active,
        sort_order = excluded.sort_order
    where catalog_sale_formats.tenant_id = v_tenant_id
      and catalog_sale_formats.venue_id = p_venue_id;
  end loop;

  v_result := public.catalog_command_batch(p_venue_id, p_commands);

  for v_item in
    select value
    from jsonb_array_elements(p_variant_formats)
  loop
    select f.name into v_format_name
    from public.catalog_sale_formats f
    where f.id = (v_item ->> 'formatId')::uuid
      and f.venue_id = p_venue_id
      and f.is_active;

    if v_format_name is null then
      raise exception 'CATALOG_SALE_FORMAT_NOT_FOUND';
    end if;

    update public.product_variants
    set catalog_sale_format_id = (v_item ->> 'formatId')::uuid,
        name = v_format_name
    where id = (v_item ->> 'variantId')::uuid
      and venue_id = p_venue_id;

    if not found then raise exception 'CATALOG_VARIANT_NOT_FOUND'; end if;
  end loop;

  return v_result;
end;
$$;

comment on function public.catalog_command_batch_with_formats(uuid, jsonb, jsonb, jsonb) is
  'Executes a catalog batch atomically, upserting client-identified reusable sale formats before linking variants.';

revoke all on function public.catalog_command_batch_with_formats(uuid, jsonb, jsonb, jsonb)
  from public, anon;
grant execute on function public.catalog_command_batch_with_formats(uuid, jsonb, jsonb, jsonb)
  to authenticated, service_role;
