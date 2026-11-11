-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserve the stock RPC signature and legacy set semantics; add atomic, audited and retry-safe manual additions. Revoke only PUBLIC/anon routine execution and grant authenticated explicitly.
set lock_timeout = '5s';
set statement_timeout = '5min';

create index inventory_manual_stock_request_idx
  on public.inventory_stock_movements (tenant_id, venue_id, inventory_item_id, warehouse_id, (metadata ->> 'requestId'))
  where source_type = 'manual_adjustment';

create or replace function public.set_inventory_item_stock(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_inventory_item_id uuid,
  p_levels jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_level jsonb;
  v_unit_id uuid;
  v_warehouse_id uuid;
  v_before numeric;
  v_after numeric;
  v_quantity numeric;
  v_mode text;
  v_request_id text;
begin
  if auth.uid() is null or not public.user_is_tenant_admin(p_tenant_id) then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;
  select base_unit_id into v_unit_id from public.inventory_items
  where id = p_inventory_item_id and tenant_id = p_tenant_id and venue_id = p_venue_id;
  if not found then raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_levels is not null and jsonb_typeof(p_levels) <> 'array' then
    raise exception 'INVENTORY_INVALID_LEVELS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_levels) > 1000 or exists (
    select 1 from jsonb_array_elements(p_levels) entry
    group by entry ->> 'warehouseId' having count(*) > 1
  ) then raise exception 'INVENTORY_INVALID_LEVELS' using errcode = '22023'; end if;

  -- The level lock serializes additions and request deduplication with other
  -- terminals. Nothing is added to the sale trigger or payment path.
  for v_level in select value from jsonb_array_elements(p_levels) order by value ->> 'warehouseId'
  loop
    v_warehouse_id := (v_level ->> 'warehouseId')::uuid;
    if not exists (select 1 from public.inventory_warehouses
      where id = v_warehouse_id and tenant_id = p_tenant_id and venue_id = p_venue_id) then
      raise exception 'INVENTORY_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
    end if;
    v_quantity := round((v_level ->> 'quantity')::numeric, 6);
    v_mode := coalesce(v_level ->> 'mode', 'set');
    v_request_id := nullif(v_level ->> 'requestId', '');
    if v_quantity is null or v_quantity::text in ('NaN', 'Infinity', '-Infinity')
      or v_mode not in ('add', 'set') or (v_mode = 'add' and v_quantity < 0)
      or length(coalesce(v_request_id, '')) > 80 then
      raise exception 'INVENTORY_INVALID_QUANTITY' using errcode = '22023';
    end if;

    insert into public.inventory_stock_levels (warehouse_id, inventory_item_id, tenant_id, venue_id, quantity, is_enabled)
    values (v_warehouse_id, p_inventory_item_id, p_tenant_id, p_venue_id, 0, coalesce((v_level ->> 'enabled')::boolean, true))
    on conflict (warehouse_id, inventory_item_id) do nothing;

    select quantity into v_before from public.inventory_stock_levels
    where warehouse_id = v_warehouse_id and inventory_item_id = p_inventory_item_id
      and tenant_id = p_tenant_id and venue_id = p_venue_id
    for update;
    if not found then raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501'; end if;
    if v_request_id is not null and exists (
      select 1 from public.inventory_stock_movements
      where tenant_id = p_tenant_id and venue_id = p_venue_id
        and inventory_item_id = p_inventory_item_id and warehouse_id = v_warehouse_id
        and source_type = 'manual_adjustment' and metadata ->> 'requestId' = v_request_id
    ) then continue; end if;
    if v_mode = 'set' and v_level ->> 'expectedQuantity' is not null
      and v_before <> (v_level ->> 'expectedQuantity')::numeric then
      raise exception 'INVENTORY_STOCK_CHANGED' using errcode = '40001';
    end if;
    v_after := case when v_mode = 'add' then v_before + v_quantity else v_quantity end;
    update public.inventory_stock_levels set quantity = v_after,
      is_enabled = coalesce((v_level ->> 'enabled')::boolean, true), updated_at = now()
    where warehouse_id = v_warehouse_id and inventory_item_id = p_inventory_item_id
      and tenant_id = p_tenant_id and venue_id = p_venue_id;

    if v_after <> v_before then
      insert into public.inventory_stock_movements (
        tenant_id, venue_id, inventory_item_id, warehouse_id, unit_id, source_type,
        stock_quantity_before, stock_quantity_delta, stock_quantity_after, metadata
      ) values (
        p_tenant_id, p_venue_id, p_inventory_item_id, v_warehouse_id, v_unit_id, 'manual_adjustment',
        v_before, v_after - v_before, v_after,
        jsonb_strip_nulls(jsonb_build_object('mode', v_mode, 'requestId', v_request_id, 'actorId', auth.uid()))
      );
    end if;
  end loop;
end;
$$;
revoke all on function public.set_inventory_item_stock(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_inventory_item_stock(uuid, uuid, uuid, jsonb) to authenticated;

-- A new entry point prevents an older server from ignoring the new mode field
-- and interpreting a received quantity as an absolute stock total.
create function public.update_inventory_item_stock(
  p_tenant_id uuid, p_venue_id uuid, p_inventory_item_id uuid, p_levels jsonb
)
returns void language sql security invoker set search_path to ''
as $$
  select public.set_inventory_item_stock(p_tenant_id, p_venue_id, p_inventory_item_id, p_levels);
$$;
revoke all on function public.update_inventory_item_stock(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.update_inventory_item_stock(uuid, uuid, uuid, jsonb) to authenticated;

-- Aggregate only the selected item and bounded time window. SECURITY INVOKER
-- preserves the existing movement/failure RLS, with explicit scope checks too.
create function public.inventory_item_consumption_report(
  p_tenant_id uuid, p_venue_id uuid, p_inventory_item_id uuid,
  p_start timestamptz, p_end timestamptz, p_warehouse_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path to ''
as $$
declare
  v_timezone text;
  v_offset interval;
  v_unit_id uuid;
  v_daily jsonb;
  v_failures bigint;
  v_incompatible bigint;
begin
  if auth.uid() is null or not (public.user_is_tenant_admin(p_tenant_id) or public.user_has_venue_access(p_tenant_id, p_venue_id)) then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;
  if p_start is null or p_end is null or p_end <= p_start or p_end - p_start > interval '186 days' then
    raise exception 'INVENTORY_INVALID_PERIOD' using errcode = '22023';
  end if;
  select venue.timezone, coalesce(venue.day_change_time, time '00:00') - time '00:00', item.base_unit_id
    into v_timezone, v_offset, v_unit_id
  from public.venues venue join public.inventory_items item
    on item.venue_id = venue.id and item.tenant_id = venue.tenant_id
  where venue.id = p_venue_id and venue.tenant_id = p_tenant_id and item.id = p_inventory_item_id;
  if not found then raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(to_jsonb(daily) order by daily.day), '[]'::jsonb) into v_daily
  from (
    select ((movement.created_at at time zone v_timezone) - v_offset)::date as day,
      sum(-movement.stock_quantity_delta) as quantity
    from public.inventory_stock_movements movement
    where movement.tenant_id = p_tenant_id and movement.venue_id = p_venue_id
      and movement.inventory_item_id = p_inventory_item_id
      and (p_warehouse_id is null or movement.warehouse_id = p_warehouse_id)
      and movement.created_at >= p_start and movement.created_at < p_end
      and movement.unit_id = v_unit_id and movement.stock_quantity_delta < 0
      and movement.ticket_line_id is not null
      and movement.source_type in ('product', 'mixer', 'menu_component', 'modifier', 'sale', 'sale_aggregate')
    group by 1
  ) daily;
  select count(*) into v_incompatible from public.inventory_stock_movements movement
  where movement.tenant_id = p_tenant_id and movement.venue_id = p_venue_id
    and movement.inventory_item_id = p_inventory_item_id
    and (p_warehouse_id is null or movement.warehouse_id = p_warehouse_id)
    and movement.created_at >= p_start and movement.created_at < p_end
    and movement.unit_id is distinct from v_unit_id;
  -- Failures often cannot identify an item: disclose venue-wide failures rather
  -- than attributing them to a guessed ingredient or showing complete coverage.
  select count(*) into v_failures from public.inventory_consumption_failures failure
  where failure.tenant_id = p_tenant_id and failure.venue_id = p_venue_id
    and failure.created_at >= p_start and failure.created_at < p_end;
  return jsonb_build_object('daily', v_daily, 'failureCount', v_failures, 'incompatibleCount', v_incompatible);
end;
$$;
revoke all on function public.inventory_item_consumption_report(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.inventory_item_consumption_report(uuid, uuid, uuid, timestamptz, timestamptz, uuid) to authenticated;
