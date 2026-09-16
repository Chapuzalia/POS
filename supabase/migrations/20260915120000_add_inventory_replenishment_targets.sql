-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Adds a nullable replenishment target and keeps the existing inventory RPC signature and behavior compatible.
set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.inventory_stock_levels
  add column if not exists target_quantity numeric(18, 6);

alter table public.inventory_stock_levels
  add constraint inventory_stock_levels_target_quantity_check
    check (target_quantity is null or target_quantity >= 0) not valid;

create or replace function public.save_inventory_item(
  p_venue_id uuid,
  p_inventory_item_id uuid,
  p_name text,
  p_description text,
  p_base_unit_id uuid,
  p_active boolean,
  p_routes jsonb
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_item_id uuid := coalesce(p_inventory_item_id, gen_random_uuid());
  v_route jsonb;
begin
  select tenant_id into v_tenant_id from public.venues where id = p_venue_id;
  if v_tenant_id is null then raise exception 'INVENTORY_VENUE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_is_tenant_admin(v_tenant_id) then raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501'; end if;
  if btrim(coalesce(p_name, '')) = '' or char_length(btrim(p_name)) > 120 then
    raise exception 'INVENTORY_INVALID_NAME' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_routes, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_routes, '[]'::jsonb)) = 0
  then raise exception 'INVENTORY_ITEM_ROUTE_REQUIRED' using errcode = '22023'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_routes) route
    where jsonb_typeof(route) <> 'object'
      or nullif(btrim(route ->> 'warehouseId'), '') is null
      or (route ->> 'warehouseId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce((route ->> 'targetQuantity')::numeric, 0) < 0
      or round(coalesce((route ->> 'targetQuantity')::numeric, 0), 6) <> coalesce((route ->> 'targetQuantity')::numeric, 0)
  ) then raise exception 'INVENTORY_INVALID_TARGET_QUANTITY' using errcode = '22023'; end if;
  if p_inventory_item_id is not null and exists (
    select 1
    from public.inventory_items item
    join public.inventory_stock_levels level
      on level.inventory_item_id = item.id
     and level.tenant_id = item.tenant_id
     and level.venue_id = item.venue_id
    where item.id = p_inventory_item_id
      and item.tenant_id = v_tenant_id
      and item.venue_id = p_venue_id
      and item.base_unit_id <> p_base_unit_id
      and level.quantity <> 0
  ) then
    raise exception 'INVENTORY_UNIT_CHANGE_WITH_STOCK' using errcode = '22023';
  end if;

  insert into public.inventory_items (
    id, tenant_id, venue_id, name, description, base_unit_id, is_active
  ) values (
    v_item_id, v_tenant_id, p_venue_id, btrim(p_name), btrim(coalesce(p_description, '')),
    p_base_unit_id, coalesce(p_active, true)
  )
  on conflict (id) do update
  set name = excluded.name, description = excluded.description,
      base_unit_id = excluded.base_unit_id, is_active = excluded.is_active,
      updated_at = now()
  where public.inventory_items.tenant_id = v_tenant_id
    and public.inventory_items.venue_id = p_venue_id;

  delete from public.inventory_item_warehouse_routes
  where inventory_item_id = v_item_id;
  for v_route in select value from jsonb_array_elements(p_routes)
  loop
    insert into public.inventory_item_warehouse_routes (
      inventory_item_id, warehouse_id, tenant_id, venue_id, priority, is_enabled
    ) values (
      v_item_id, (v_route ->> 'warehouseId')::uuid, v_tenant_id, p_venue_id,
      (v_route ->> 'priority')::integer,
      coalesce((v_route ->> 'enabled')::boolean, true)
    );
    insert into public.inventory_stock_levels (
      warehouse_id, inventory_item_id, tenant_id, venue_id, quantity, is_enabled, target_quantity
    ) values (
      (v_route ->> 'warehouseId')::uuid, v_item_id, v_tenant_id, p_venue_id, 0,
      coalesce((v_route ->> 'enabled')::boolean, true),
      nullif(v_route ->> 'targetQuantity', '')::numeric
    ) on conflict (warehouse_id, inventory_item_id) do update
      set is_enabled = excluded.is_enabled, target_quantity = excluded.target_quantity;
  end loop;
  return v_item_id;
end;
$$;

create index if not exists inventory_stock_levels_replenishment_idx
  on public.inventory_stock_levels (tenant_id, venue_id, inventory_item_id)
  where is_enabled and target_quantity is not null;
