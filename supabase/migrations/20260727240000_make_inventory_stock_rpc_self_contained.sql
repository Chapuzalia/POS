-- The public seven-argument stock RPC must not delegate to the legacy
-- five-argument overload. PostgreSQL validates NOT NULL columns on the
-- proposed INSERT tuple before resolving ON CONFLICT, so the legacy insert
-- can fail even when a complete product setting already exists.

create or replace function public.set_inventory_product_stock(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_product_id uuid,
  p_unit_id uuid,
  p_content_quantity numeric,
  p_content_unit_id uuid,
  p_levels jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_levels jsonb := coalesce(p_levels, '[]'::jsonb);
  v_content_decimal_places integer;
  v_current_content_quantity numeric(18, 6);
  v_current_content_unit_id uuid;
  v_current_unit_id uuid;
  v_level jsonb;
  v_level_count integer;
  v_valid_warehouse_count integer;
  v_quantity numeric(18, 6);
  v_warehouse_id uuid;
begin
  if not public.user_is_tenant_admin(p_tenant_id) then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
      and v.tenant_id = p_tenant_id
  ) then
    raise exception 'INVENTORY_VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from public.products p
    where p.id = p_product_id
      and p.tenant_id = p_tenant_id
      and p.venue_id = p_venue_id
  ) then
    raise exception 'INVENTORY_PRODUCT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from public.inventory_units u
    where u.id = p_unit_id
      and u.tenant_id = p_tenant_id
      and u.venue_id = p_venue_id
      and u.is_active = true
  ) then
    raise exception 'INVENTORY_UNIT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select u.decimal_places
  into v_content_decimal_places
  from public.inventory_units u
  where u.id = p_content_unit_id
    and u.tenant_id = p_tenant_id
    and u.venue_id = p_venue_id
    and u.is_active = true;

  if v_content_decimal_places is null then
    raise exception 'INVENTORY_CONTENT_UNIT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_content_quantity is null
    or p_content_quantity <= 0
    or p_content_quantity > 999999999999.999999
    or round(p_content_quantity, v_content_decimal_places) <> p_content_quantity
  then
    raise exception 'INVENTORY_INVALID_CONTENT_QUANTITY' using errcode = '22023';
  end if;

  if jsonb_typeof(v_levels) <> 'array' then
    raise exception 'INVENTORY_INVALID_LEVELS' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_levels) item
    where jsonb_typeof(item) <> 'object'
      or nullif(btrim(item ->> 'warehouseId'), '') is null
      or (item ->> 'warehouseId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(item -> 'quantity') <> 'number'
  ) then
    raise exception 'INVENTORY_INVALID_LEVELS' using errcode = '22023';
  end if;

  select count(*)
  into v_level_count
  from jsonb_array_elements(v_levels);

  if (
    select count(distinct item ->> 'warehouseId')
    from jsonb_array_elements(v_levels) item
  ) <> v_level_count then
    raise exception 'INVENTORY_DUPLICATE_WAREHOUSE' using errcode = '22023';
  end if;

  select count(*)
  into v_valid_warehouse_count
  from public.inventory_warehouses w
  where w.tenant_id = p_tenant_id
    and w.venue_id = p_venue_id
    and w.is_active = true
    and w.id in (
      select (item ->> 'warehouseId')::uuid
      from jsonb_array_elements(v_levels) item
    );

  if v_valid_warehouse_count <> v_level_count then
    raise exception 'INVENTORY_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_levels) item
    where (item ->> 'quantity')::numeric < 0
      or round((item ->> 'quantity')::numeric, 6)
        <> (item ->> 'quantity')::numeric
      or (item ->> 'quantity')::numeric > 999999999999.999999
  ) then
    raise exception 'INVENTORY_INVALID_QUANTITY' using errcode = '22023';
  end if;

  select s.unit_id, s.content_quantity, s.content_unit_id
  into v_current_unit_id, v_current_content_quantity, v_current_content_unit_id
  from public.inventory_product_settings s
  where s.product_id = p_product_id
    and s.tenant_id = p_tenant_id
    and s.venue_id = p_venue_id;

  if v_current_unit_id is not null
    and (
      v_current_unit_id is distinct from p_unit_id
      or v_current_content_quantity is distinct from p_content_quantity
      or v_current_content_unit_id is distinct from p_content_unit_id
    )
    and exists (
      select 1
      from public.inventory_stock_levels l
      where l.product_id = p_product_id
        and l.tenant_id = p_tenant_id
        and l.venue_id = p_venue_id
        and l.quantity <> 0
    )
  then
    raise exception 'INVENTORY_PACKAGE_CHANGE_WITH_STOCK' using errcode = '22023';
  end if;

  insert into public.inventory_product_settings (
    product_id,
    tenant_id,
    venue_id,
    unit_id,
    content_quantity,
    content_unit_id
  )
  values (
    p_product_id,
    p_tenant_id,
    p_venue_id,
    p_unit_id,
    p_content_quantity::numeric(18, 6),
    p_content_unit_id
  )
  on conflict (product_id) do update
  set unit_id = excluded.unit_id,
      content_quantity = excluded.content_quantity,
      content_unit_id = excluded.content_unit_id,
      updated_at = now();

  for v_level in
    select item
    from jsonb_array_elements(v_levels) item
  loop
    v_warehouse_id := (v_level ->> 'warehouseId')::uuid;
    v_quantity := (v_level ->> 'quantity')::numeric(18, 6);

    insert into public.inventory_stock_levels (
      warehouse_id,
      product_id,
      tenant_id,
      venue_id,
      quantity
    )
    values (
      v_warehouse_id,
      p_product_id,
      p_tenant_id,
      p_venue_id,
      v_quantity
    )
    on conflict (warehouse_id, product_id) do update
    set quantity = excluded.quantity,
        updated_at = now();
  end loop;

  delete from public.inventory_product_format_consumptions
  where product_id = p_product_id
    and tenant_id = p_tenant_id
    and venue_id = p_venue_id;
end;
$$;

revoke all on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  uuid,
  jsonb
) from public, anon;
grant execute on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  uuid,
  jsonb
) to authenticated;
