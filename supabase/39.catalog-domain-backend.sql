begin;

-- Phase 3.1 adds the definitive data boundary. Migration-29 objects remain in
-- place but are not read or written by these functions.
create index if not exists categories_venue_order_final_idx
  on public.categories (tenant_id, venue_id, is_active, sort_order, id);
create index if not exists products_venue_order_final_idx
  on public.products (tenant_id, venue_id, is_active, sort_order, id);
create index if not exists product_variants_product_order_final_idx
  on public.product_variants (tenant_id, venue_id, product_id, is_active, sort_order, id);
create index if not exists catalog_tab_categories_order_final_idx
  on public.catalog_tab_categories (tenant_id, venue_id, tab_id, is_active, sort_order, id);
create index if not exists selection_group_options_order_final_idx
  on public.selection_group_options (tenant_id, venue_id, group_id, is_active, sort_order, id);
create index if not exists product_selection_assignments_order_final_idx
  on public.product_selection_group_assignments (tenant_id, venue_id, product_id, is_active, sort_order, id);
create index if not exists product_selection_assignment_variants_variant_final_idx
  on public.product_selection_group_assignment_variants (tenant_id, venue_id, variant_id, assignment_id);
create index if not exists modifiers_order_final_idx
  on public.modifiers (tenant_id, venue_id, group_id, is_active, sort_order, id);
create index if not exists product_modifier_assignments_order_final_idx
  on public.product_modifier_group_assignments (tenant_id, venue_id, product_id, is_active, sort_order, id);
create index if not exists product_modifier_assignment_variants_variant_final_idx
  on public.product_modifier_group_assignment_variants (tenant_id, venue_id, variant_id, assignment_id);
create index if not exists product_images_storage_path_final_idx
  on public.product_images (tenant_id, venue_id, storage_path);

create or replace function public.get_catalog(p_venue_id uuid, p_mode text default 'admin')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_active_only boolean;
begin
  if p_mode not in ('admin', 'pos') then
    raise exception 'CATALOG_INVALID_READ_MODE';
  end if;
  select v.tenant_id into v_tenant_id from public.venues v where v.id = p_venue_id;
  if v_tenant_id is null then raise exception 'CATALOG_VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role'
    and not public.user_is_tenant_admin(v_tenant_id)
    and not public.user_has_venue_access(v_tenant_id, p_venue_id)
  then raise exception 'CATALOG_READ_FORBIDDEN'; end if;
  v_active_only := p_mode = 'pos';

  return jsonb_build_object(
    'tenant_id', v_tenant_id,
    'venue_id', p_venue_id,
    'mode', p_mode,
    'products', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id) from (
        select p.id, p.tenant_id, p.venue_id, p.product_type, p.name, p.description,
          p.tax_rate, p.is_active, p.sort_order, p.created_at, p.updated_at
        from public.products p
        where p.venue_id = p_venue_id and (not v_active_only or p.is_active)
      ) x
    ), '[]'::jsonb),
    'variants', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.product_id, x.sort_order, x.name, x.id) from (
        select v.id, v.tenant_id, v.venue_id, v.product_id, v.name, v.price_cents, v.sku,
          v.is_default, v.is_active, v.sort_order, v.created_at, v.updated_at
        from public.product_variants v
        join public.products p on p.id = v.product_id and p.venue_id = p_venue_id
        where v.venue_id = p_venue_id and (not v_active_only or (v.is_active and p.is_active))
      ) x
    ), '[]'::jsonb),
    'tabs', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.label, x.id) from (
        select t.id, t.tenant_id, t.venue_id, t.key, t.label, t.icon, t.is_active,
          t.sort_order, t.created_at, t.updated_at
        from public.catalog_tabs t
        where t.venue_id = p_venue_id and (not v_active_only or t.is_active)
      ) x
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id) from (
        select c.id, c.tenant_id, c.venue_id, c.name, c.icon, c.unused, c.is_active,
          c.sort_order, c.created_at, c.updated_at
        from public.categories c
        where c.venue_id = p_venue_id and (not v_active_only or c.is_active)
      ) x
    ), '[]'::jsonb),
    'tab_categories', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.tab_id, x.sort_order, x.id) from (
        select tc.id, tc.tenant_id, tc.venue_id, tc.tab_id, tc.category_id, tc.is_active,
          tc.sort_order, tc.created_at, tc.updated_at
        from public.catalog_tab_categories tc
        join public.catalog_tabs t on t.id = tc.tab_id and t.venue_id = p_venue_id
        join public.categories c on c.id = tc.category_id and c.venue_id = p_venue_id
        where tc.venue_id = p_venue_id
          and (not v_active_only or (tc.is_active and t.is_active and c.is_active))
      ) x
    ), '[]'::jsonb),
    'placements', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.tab_id, x.category_id nulls first, x.sort_order, x.id) from (
        select cp.id, cp.tenant_id, cp.venue_id, cp.product_id, cp.tab_id, cp.category_id,
          cp.variant_id, cp.is_featured, cp.is_active, cp.sort_order, cp.created_at, cp.updated_at
        from public.catalog_placements cp
        join public.products p on p.id = cp.product_id and p.venue_id = p_venue_id
        join public.catalog_tabs t on t.id = cp.tab_id and t.venue_id = p_venue_id
        left join public.categories c on c.id = cp.category_id and c.venue_id = p_venue_id
        left join public.product_variants v on v.id = cp.variant_id and v.product_id = cp.product_id and v.venue_id = p_venue_id
        where cp.venue_id = p_venue_id and (not v_active_only or (
          cp.is_active and p.is_active and t.is_active and (cp.category_id is null or c.is_active)
          and (cp.variant_id is null or v.is_active)
        ))
      ) x
    ), '[]'::jsonb),
    'selection_groups', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id) from (
        select g.id, g.tenant_id, g.venue_id, g.name, g.kind, g.is_active,
          g.sort_order, g.created_at, g.updated_at
        from public.selection_groups g
        where g.venue_id = p_venue_id and (not v_active_only or g.is_active)
      ) x
    ), '[]'::jsonb),
    'selection_options', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.group_id, x.sort_order, x.id) from (
        select o.id, o.tenant_id, o.venue_id, o.group_id, o.product_id, o.variant_id,
          o.supplement_cents, o.default_quantity, o.max_quantity, o.is_active,
          o.sort_order, o.created_at, o.updated_at
        from public.selection_group_options o
        join public.selection_groups g on g.id = o.group_id and g.venue_id = p_venue_id
        join public.products p on p.id = o.product_id and p.venue_id = p_venue_id
        left join public.product_variants v on v.id = o.variant_id and v.product_id = o.product_id
        where o.venue_id = p_venue_id and (not v_active_only or (
          o.is_active and g.is_active and p.is_active and (o.variant_id is null or v.is_active)
        ))
      ) x
    ), '[]'::jsonb),
    'selection_assignments', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.product_id, x.sort_order, x.id) from (
        select a.id, a.tenant_id, a.venue_id, a.product_id, a.group_id, a.display_name,
          a.min_selection, a.max_selection, a.applies_to_all_variants,
          coalesce((select array_agg(av.variant_id order by av.variant_id)
            from public.product_selection_group_assignment_variants av where av.assignment_id = a.id), '{}'::uuid[]) variant_ids,
          a.is_active, a.sort_order, a.created_at, a.updated_at
        from public.product_selection_group_assignments a
        join public.products p on p.id = a.product_id and p.venue_id = p_venue_id
        join public.selection_groups g on g.id = a.group_id and g.venue_id = p_venue_id
        where a.venue_id = p_venue_id and (not v_active_only or (a.is_active and p.is_active and g.is_active))
      ) x
    ), '[]'::jsonb),
    'modifier_groups', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id) from (
        select g.id, g.tenant_id, g.venue_id, g.name, g.is_active,
          g.sort_order, g.created_at, g.updated_at
        from public.modifier_groups g
        where g.venue_id = p_venue_id and (not v_active_only or g.is_active)
      ) x
    ), '[]'::jsonb),
    'modifiers', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.group_id, x.sort_order, x.id) from (
        select m.id, m.tenant_id, m.venue_id, m.group_id, m.name, m.supplement_cents,
          m.is_default, m.is_active, m.sort_order, m.created_at, m.updated_at
        from public.modifiers m
        join public.modifier_groups g on g.id = m.group_id and g.venue_id = p_venue_id
        where m.venue_id = p_venue_id and (not v_active_only or (m.is_active and g.is_active))
      ) x
    ), '[]'::jsonb),
    'modifier_assignments', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.product_id, x.sort_order, x.id) from (
        select a.id, a.tenant_id, a.venue_id, a.product_id, a.group_id, a.display_name,
          a.min_selection, a.max_selection, a.applies_to_all_variants,
          coalesce((select array_agg(av.variant_id order by av.variant_id)
            from public.product_modifier_group_assignment_variants av where av.assignment_id = a.id), '{}'::uuid[]) variant_ids,
          a.is_active, a.sort_order, a.created_at, a.updated_at
        from public.product_modifier_group_assignments a
        join public.products p on p.id = a.product_id and p.venue_id = p_venue_id
        join public.modifier_groups g on g.id = a.group_id and g.venue_id = p_venue_id
        where a.venue_id = p_venue_id and (not v_active_only or (a.is_active and p.is_active and g.is_active))
      ) x
    ), '[]'::jsonb),
    'images', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.product_id, x.id) from (
        select i.id, i.tenant_id, i.venue_id, i.product_id, i.storage_path, i.mime_type,
          i.size_bytes, i.sha256, i.created_at, i.updated_at
        from public.product_images i
        join public.products p on p.id = i.product_id and p.venue_id = p_venue_id
        where i.venue_id = p_venue_id and (not v_active_only or p.is_active)
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.catalog_command(p_venue_id uuid, p_command text, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_id uuid;
  v_product_id uuid;
  v_group_id uuid;
  v_variant_id uuid;
  v_item jsonb;
  v_table text;
  v_path text;
  v_orphaned_paths text[] := '{}';
  v_default_count integer;
  v_default_assigned boolean := false;
begin
  select v.tenant_id into v_tenant_id from public.venues v where v.id = p_venue_id for update;
  if v_tenant_id is null then raise exception 'CATALOG_VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant_id) then
    raise exception 'CATALOG_COMMAND_FORBIDDEN';
  end if;

  if p_command = 'create_product' then
    if jsonb_typeof(p_payload -> 'variants') <> 'array' or jsonb_array_length(p_payload -> 'variants') = 0 then
      raise exception 'CATALOG_PRODUCT_REQUIRES_VARIANT';
    end if;
    select count(*) into v_default_count from jsonb_array_elements(p_payload -> 'variants') x
      where coalesce((x ->> 'active')::boolean, true) and coalesce((x ->> 'isDefault')::boolean, false);
    if v_default_count > 1 then raise exception 'INVALID_ACTIVE_DEFAULT_VARIANT_COUNT'; end if;
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.products(id, tenant_id, venue_id, category_id, name, description, image_path, kind,
      product_type, tax_rate, is_active, sort_order)
    values (v_id, v_tenant_id, p_venue_id, null, trim(p_payload ->> 'name'), nullif(p_payload ->> 'description', ''),
      null, null, p_payload ->> 'type', nullif(p_payload ->> 'vatRate', '')::numeric,
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer);
    for v_item in select value from jsonb_array_elements(p_payload -> 'variants') loop
      if v_default_count = 0 and not v_default_assigned and coalesce((v_item ->> 'active')::boolean, true) then
        v_item := jsonb_set(v_item, '{isDefault}', 'true'::jsonb);
        v_default_assigned := true;
      end if;
      v_variant_id := coalesce(nullif(v_item ->> 'id', '')::uuid, gen_random_uuid());
      insert into public.product_variants(id, tenant_id, venue_id, product_id, name, price_cents, sku,
        is_default, is_active, sort_order)
      values (v_variant_id, v_tenant_id, p_venue_id, v_id, trim(v_item ->> 'name'),
        (v_item ->> 'priceCents')::integer, nullif(v_item ->> 'sku', ''),
        coalesce((v_item ->> 'isDefault')::boolean, false),
        coalesce((v_item ->> 'active')::boolean, true), (v_item ->> 'sortOrder')::integer);
    end loop;

  elsif p_command = 'update_product' then
    v_id := (p_payload ->> 'id')::uuid;
    if p_payload ? 'active' and not (p_payload ->> 'active')::boolean then
      update public.product_selection_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
      update public.product_modifier_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
    end if;
    update public.products p set
      name = case when p_payload ? 'name' then trim(p_payload ->> 'name') else p.name end,
      description = case when p_payload ? 'description' then nullif(p_payload ->> 'description', '') else p.description end,
      product_type = case when p_payload ? 'type' then p_payload ->> 'type' else p.product_type end,
      tax_rate = case when p_payload ? 'vatRate' then nullif(p_payload ->> 'vatRate', '')::numeric else p.tax_rate end,
      is_active = case when p_payload ? 'active' then (p_payload ->> 'active')::boolean else p.is_active end,
      sort_order = case when p_payload ? 'sortOrder' then (p_payload ->> 'sortOrder')::integer else p.sort_order end
    where p.id = v_id and p.venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;

  elsif p_command = 'set_product_active' then
    v_id := (p_payload ->> 'id')::uuid;
    if not (p_payload ->> 'active')::boolean then
      update public.product_selection_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
      update public.product_modifier_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
    end if;
    update public.products set is_active = (p_payload ->> 'active')::boolean where id = v_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;

  elsif p_command = 'delete_product' then
    v_id := (p_payload ->> 'id')::uuid;
    select i.storage_path into v_path from public.product_images i where i.product_id = v_id and i.venue_id = p_venue_id;
    delete from public.products where id = v_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;
    if v_path is not null and not exists (select 1 from public.product_images where storage_path = v_path) then
      v_orphaned_paths := array_append(v_orphaned_paths, v_path);
    end if;

  elsif p_command in ('create_variant', 'update_variant') then
    v_product_id := (p_payload ->> 'productId')::uuid;
    if not exists (select 1 from public.products where id = v_product_id and venue_id = p_venue_id) then
      raise exception 'CATALOG_PRODUCT_NOT_FOUND';
    end if;
    v_id := case when p_command = 'update_variant' then (p_payload ->> 'id')::uuid
      else coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid()) end;
    if coalesce((p_payload ->> 'isDefault')::boolean, false) then
      update public.product_variants set is_default = false where product_id = v_product_id and venue_id = p_venue_id;
    end if;
    if p_command = 'create_variant' then
      insert into public.product_variants(id, tenant_id, venue_id, product_id, name, price_cents, sku,
        is_default, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, v_product_id, trim(p_payload ->> 'name'),
        (p_payload ->> 'priceCents')::integer, nullif(p_payload ->> 'sku', ''),
        coalesce((p_payload ->> 'isDefault')::boolean, false), coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer);
    else
      update public.product_variants v set
        name = case when p_payload ? 'name' then trim(p_payload ->> 'name') else v.name end,
        price_cents = case when p_payload ? 'priceCents' then (p_payload ->> 'priceCents')::integer else v.price_cents end,
        sku = case when p_payload ? 'sku' then nullif(p_payload ->> 'sku', '') else v.sku end,
        is_default = case when p_payload ? 'isDefault' then (p_payload ->> 'isDefault')::boolean else v.is_default end,
        is_active = case when p_payload ? 'active' then (p_payload ->> 'active')::boolean else v.is_active end,
        sort_order = case when p_payload ? 'sortOrder' then (p_payload ->> 'sortOrder')::integer else v.sort_order end
      where v.id = v_id and v.product_id = v_product_id and v.venue_id = p_venue_id;
      if not found then raise exception 'CATALOG_VARIANT_NOT_FOUND'; end if;
    end if;

  elsif p_command = 'set_default_variant' then
    v_product_id := (p_payload ->> 'productId')::uuid;
    v_variant_id := (p_payload ->> 'variantId')::uuid;
    if not exists (select 1 from public.product_variants where id = v_variant_id and product_id = v_product_id and venue_id = p_venue_id and is_active) then
      raise exception 'CATALOG_VARIANT_PRODUCT_MISMATCH';
    end if;
    update public.product_variants set is_default = (id = v_variant_id)
      where product_id = v_product_id and venue_id = p_venue_id;

  elsif p_command = 'delete_variant' then
    v_product_id := (p_payload ->> 'productId')::uuid;
    v_id := (p_payload ->> 'id')::uuid;
    if exists (select 1 from public.product_variants where id = v_id and product_id = v_product_id and venue_id = p_venue_id and is_active and is_default) then
      raise exception 'CATALOG_DEFAULT_VARIANT_REQUIRES_REPLACEMENT';
    end if;
    delete from public.product_variants where id = v_id and product_id = v_product_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_VARIANT_NOT_FOUND'; end if;

  elsif p_command in ('create_placement', 'update_placement') then
    v_id := case when p_command = 'update_placement' then (p_payload ->> 'id')::uuid
      else coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid()) end;
    if p_command = 'create_placement' then
      insert into public.catalog_placements(id, tenant_id, venue_id, product_id, tab_id, category_id, variant_id,
        is_featured, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, (p_payload ->> 'productId')::uuid, (p_payload ->> 'tabId')::uuid,
        nullif(p_payload ->> 'categoryId', '')::uuid, nullif(p_payload ->> 'pinnedVariantId', '')::uuid,
        coalesce((p_payload ->> 'featured')::boolean, false), coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer);
    else
      update public.catalog_placements cp set
        product_id = case when p_payload ? 'productId' then (p_payload ->> 'productId')::uuid else cp.product_id end,
        tab_id = case when p_payload ? 'tabId' then (p_payload ->> 'tabId')::uuid else cp.tab_id end,
        category_id = case when p_payload ? 'categoryId' then nullif(p_payload ->> 'categoryId', '')::uuid else cp.category_id end,
        variant_id = case when p_payload ? 'pinnedVariantId' then nullif(p_payload ->> 'pinnedVariantId', '')::uuid else cp.variant_id end,
        is_featured = case when p_payload ? 'featured' then (p_payload ->> 'featured')::boolean else cp.is_featured end,
        is_active = case when p_payload ? 'active' then (p_payload ->> 'active')::boolean else cp.is_active end,
        sort_order = case when p_payload ? 'sortOrder' then (p_payload ->> 'sortOrder')::integer else cp.sort_order end
      where cp.id = v_id and cp.venue_id = p_venue_id;
      if not found then raise exception 'CATALOG_PLACEMENT_INVALID'; end if;
    end if;

  elsif p_command = 'delete_placement' then
    delete from public.catalog_placements where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PLACEMENT_INVALID'; end if;

  elsif p_command = 'save_tab' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.catalog_tabs(id, tenant_id, venue_id, key, label, icon, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, p_payload ->> 'key', trim(p_payload ->> 'label'), nullif(p_payload ->> 'icon', ''),
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set key = excluded.key, label = excluded.label, icon = excluded.icon,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where catalog_tabs.venue_id = p_venue_id;

  elsif p_command = 'delete_tab' then
    delete from public.catalog_tabs where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PLACEMENT_INVALID'; end if;

  elsif p_command = 'save_category' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.categories(id, tenant_id, venue_id, name, kind, icon, unused, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, trim(p_payload ->> 'name'), null, nullif(p_payload ->> 'icon', ''),
      coalesce((p_payload ->> 'unused')::boolean, false), coalesce((p_payload ->> 'active')::boolean, true),
      (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set name = excluded.name, icon = excluded.icon, unused = excluded.unused,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where categories.venue_id = p_venue_id;

  elsif p_command = 'delete_category' then
    delete from public.categories where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_selection_group' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.selection_groups(id, tenant_id, venue_id, kind, name, min_select, max_select, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, p_payload ->> 'type', trim(p_payload ->> 'name'), 0, 1,
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set kind = excluded.kind, name = excluded.name,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where selection_groups.venue_id = p_venue_id;

  elsif p_command = 'delete_selection_group' then
    delete from public.selection_groups where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_selection_option' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.selection_group_options(id, tenant_id, venue_id, group_id, product_id, variant_id,
      supplement_cents, default_quantity, max_quantity, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, (p_payload ->> 'groupId')::uuid, (p_payload ->> 'productId')::uuid,
      nullif(p_payload ->> 'variantId', '')::uuid, (p_payload ->> 'supplementCents')::integer,
      (p_payload ->> 'defaultQuantity')::integer, nullif(p_payload ->> 'maxQuantity', '')::integer,
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set group_id = excluded.group_id, product_id = excluded.product_id,
      variant_id = excluded.variant_id, supplement_cents = excluded.supplement_cents,
      default_quantity = excluded.default_quantity, max_quantity = excluded.max_quantity,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where selection_group_options.venue_id = p_venue_id;

  elsif p_command = 'delete_selection_option' then
    delete from public.selection_group_options where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_modifier_group' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.modifier_groups(id, tenant_id, venue_id, product_id, name, min_select, max_select, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, null, trim(p_payload ->> 'name'), 0, 1,
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set product_id = null, name = excluded.name,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where modifier_groups.venue_id = p_venue_id;

  elsif p_command = 'delete_modifier_group' then
    delete from public.modifier_groups where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_modifier' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.modifiers(id, tenant_id, venue_id, group_id, name, price_cents, supplement_cents,
      is_default, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, (p_payload ->> 'groupId')::uuid, trim(p_payload ->> 'name'), 0,
      (p_payload ->> 'supplementCents')::integer, coalesce((p_payload ->> 'isDefault')::boolean, false),
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set group_id = excluded.group_id, name = excluded.name,
      supplement_cents = excluded.supplement_cents, is_default = excluded.is_default,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where modifiers.venue_id = p_venue_id;

  elsif p_command = 'delete_modifier' then
    delete from public.modifiers where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_assignment' then
    v_product_id := (p_payload ->> 'productId')::uuid;
    v_group_id := (p_payload ->> 'groupId')::uuid;
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    if p_payload ->> 'domain' = 'selection' then
      insert into public.product_selection_group_assignments(id, tenant_id, venue_id, product_id, group_id,
        display_name, min_selection, max_selection, applies_to_all_variants, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, v_product_id, v_group_id, nullif(p_payload ->> 'displayName', ''),
        (p_payload ->> 'minSelection')::integer, (p_payload ->> 'maxSelection')::integer,
        (p_payload ->> 'appliesToAllVariants')::boolean, coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer)
      on conflict (product_id, group_id) do update set display_name = excluded.display_name,
        min_selection = excluded.min_selection, max_selection = excluded.max_selection,
        applies_to_all_variants = excluded.applies_to_all_variants, is_active = excluded.is_active,
        sort_order = excluded.sort_order returning id into v_id;
      delete from public.product_selection_group_assignment_variants where assignment_id = v_id;
      if not (p_payload ->> 'appliesToAllVariants')::boolean then
        for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'variantIds', '[]'::jsonb)) loop
          insert into public.product_selection_group_assignment_variants(tenant_id, venue_id, assignment_id, product_id, variant_id)
          values(v_tenant_id, p_venue_id, v_id, v_product_id, (v_item #>> '{}')::uuid);
        end loop;
      end if;
    elsif p_payload ->> 'domain' = 'modifier' then
      insert into public.product_modifier_group_assignments(id, tenant_id, venue_id, product_id, group_id,
        display_name, min_selection, max_selection, applies_to_all_variants, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, v_product_id, v_group_id, nullif(p_payload ->> 'displayName', ''),
        (p_payload ->> 'minSelection')::integer, (p_payload ->> 'maxSelection')::integer,
        (p_payload ->> 'appliesToAllVariants')::boolean, coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer)
      on conflict (product_id, group_id) do update set display_name = excluded.display_name,
        min_selection = excluded.min_selection, max_selection = excluded.max_selection,
        applies_to_all_variants = excluded.applies_to_all_variants, is_active = excluded.is_active,
        sort_order = excluded.sort_order returning id into v_id;
      delete from public.product_modifier_group_assignment_variants where assignment_id = v_id;
      if not (p_payload ->> 'appliesToAllVariants')::boolean then
        for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'variantIds', '[]'::jsonb)) loop
          insert into public.product_modifier_group_assignment_variants(tenant_id, venue_id, assignment_id, product_id, variant_id)
          values(v_tenant_id, p_venue_id, v_id, v_product_id, (v_item #>> '{}')::uuid);
        end loop;
      end if;
    else raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'delete_assignment' then
    if p_payload ->> 'domain' = 'selection' then
      delete from public.product_selection_group_assignments where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    elsif p_payload ->> 'domain' = 'modifier' then
      delete from public.product_modifier_group_assignments where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    else raise exception 'CATALOG_GROUP_INVALID'; end if;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'reorder' then
    v_table := case p_payload ->> 'entity'
      when 'products' then 'products' when 'variants' then 'product_variants'
      when 'placements' then 'catalog_placements' when 'tabs' then 'catalog_tabs'
      when 'categories' then 'categories' when 'tab_categories' then 'catalog_tab_categories'
      when 'selection_groups' then 'selection_groups' when 'selection_options' then 'selection_group_options'
      when 'selection_assignments' then 'product_selection_group_assignments'
      when 'modifier_groups' then 'modifier_groups' when 'modifiers' then 'modifiers'
      when 'modifier_assignments' then 'product_modifier_group_assignments' else null end;
    if v_table is null then raise exception 'CATALOG_INVALID_REORDER_ENTITY'; end if;
    for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) order by value ->> 'id' loop
      execute format('update public.%I set sort_order = $1 where id = $2 and venue_id = $3', v_table)
        using (v_item ->> 'sortOrder')::integer, (v_item ->> 'id')::uuid, p_venue_id;
      if not found then raise exception 'CATALOG_REORDER_ENTITY_NOT_FOUND'; end if;
    end loop;
  else
    raise exception 'CATALOG_UNKNOWN_COMMAND %', p_command;
  end if;

  set constraints all immediate;
  return jsonb_build_object('result', 'SUCCESS', 'id', v_id, 'orphanedImagePaths', to_jsonb(v_orphaned_paths));
end;
$$;

create or replace function public.canonical_catalog_modifiers(
  p_venue_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_submitted jsonb
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'groupId', g.id, 'name', m.name, 'priceCents', m.supplement_cents
  ) order by a.sort_order, g.sort_order, m.sort_order, m.id), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_submitted, '[]'::jsonb)) submitted
  join public.modifiers m on m.id = nullif(submitted ->> 'id', '')::uuid
    and m.venue_id = p_venue_id and m.is_active
  join public.modifier_groups g on g.id = m.group_id and g.venue_id = p_venue_id and g.is_active
  join public.product_modifier_group_assignments a on a.group_id = g.id
    and a.product_id = p_product_id and a.venue_id = p_venue_id and a.is_active
    and (a.applies_to_all_variants or exists (
      select 1 from public.product_modifier_group_assignment_variants av
      where av.assignment_id = a.id and av.variant_id = p_variant_id
    ));
$$;

revoke all on function public.get_catalog(uuid, text) from public, anon;
revoke all on function public.catalog_command(uuid, text, jsonb) from public, anon;
revoke all on function public.canonical_catalog_modifiers(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.get_catalog(uuid, text) to authenticated, service_role;
grant execute on function public.catalog_command(uuid, text, jsonb) to authenticated, service_role;

comment on function public.get_catalog(uuid, text) is 'Definitive venue-scoped catalogue read boundary for admin and POS.';
comment on function public.catalog_command(uuid, text, jsonb) is 'Definitive transactional catalogue command boundary. Locks one venue and never writes migration-29 transitional objects.';

commit;
