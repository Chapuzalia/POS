-- Delete a warehouse safely. Non-zero product balances must be transferred to
-- another active warehouse in the same venue before the source is removed.

create or replace function public.delete_inventory_warehouse(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_warehouse_id uuid,
  p_target_warehouse_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_source public.inventory_warehouses%rowtype;
  v_target public.inventory_warehouses%rowtype;
  v_level record;
  v_transfer_count integer := 0;
begin
  if not public.user_is_tenant_admin(p_tenant_id) then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_source
  from public.inventory_warehouses w
  where w.id = p_warehouse_id
    and w.tenant_id = p_tenant_id
    and w.venue_id = p_venue_id
  for update;

  if v_source.id is null then
    raise exception 'INVENTORY_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_target_warehouse_id = p_warehouse_id then
    raise exception 'INVENTORY_WAREHOUSE_TRANSFER_SAME' using errcode = '22023';
  end if;

  -- Lock every source balance so consumption cannot change it between the
  -- transfer and the cascading warehouse deletion.
  for v_level in
    select l.product_id, l.quantity
    from public.inventory_stock_levels l
    where l.warehouse_id = p_warehouse_id
      and l.tenant_id = p_tenant_id
      and l.venue_id = p_venue_id
    order by l.product_id
    for update
  loop
    if v_level.quantity = 0 then
      continue;
    end if;

    if p_target_warehouse_id is null then
      raise exception 'INVENTORY_WAREHOUSE_TRANSFER_REQUIRED' using errcode = '22023';
    end if;

    if v_target.id is null then
      select * into v_target
      from public.inventory_warehouses w
      where w.id = p_target_warehouse_id
        and w.tenant_id = p_tenant_id
        and w.venue_id = p_venue_id
        and w.is_active = true
      for update;

      if v_target.id is null then
        raise exception 'INVENTORY_TARGET_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
      end if;
    end if;

    insert into public.inventory_stock_levels as destination (
      warehouse_id,
      product_id,
      tenant_id,
      venue_id,
      quantity,
      is_enabled
    )
    values (
      p_target_warehouse_id,
      v_level.product_id,
      p_tenant_id,
      p_venue_id,
      v_level.quantity,
      true
    )
    on conflict (warehouse_id, product_id) do update
    set quantity = destination.quantity + excluded.quantity,
        is_enabled = true,
        updated_at = now();

    v_transfer_count := v_transfer_count + 1;
  end loop;

  delete from public.inventory_warehouses w
  where w.id = p_warehouse_id
    and w.tenant_id = p_tenant_id
    and w.venue_id = p_venue_id;

  return v_transfer_count;
end;
$$;

revoke all on function public.delete_inventory_warehouse(
  uuid,
  uuid,
  uuid,
  uuid
) from public, anon;
grant execute on function public.delete_inventory_warehouse(
  uuid,
  uuid,
  uuid,
  uuid
) to authenticated;

comment on function public.delete_inventory_warehouse(uuid, uuid, uuid, uuid) is
  'Transfers every non-zero product balance to another active warehouse and atomically deletes the source.';
