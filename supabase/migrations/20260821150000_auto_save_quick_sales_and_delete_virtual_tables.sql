-- A quick sale may be parked in the session-only Virtual area, so the atomic
-- conversion no longer requires a physical dining area.
create or replace function public.save_quick_sale_as_virtual_table(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_area_id uuid,
  p_name text,
  p_capacity integer,
  p_shape text,
  p_lines jsonb,
  p_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_table_id uuid;
  new_order_id uuid;
  saved_order jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'La Venta rápida no contiene productos' using errcode = '22023';
  end if;
  if p_discount is not null and jsonb_typeof(p_discount) <> 'object' then
    raise exception 'El descuento de la cuenta no es válido' using errcode = '22023';
  end if;

  new_table_id := public.create_virtual_restaurant_table(
    p_cash_session_id,
    p_device_id,
    p_area_id,
    p_name,
    p_capacity,
    p_shape
  );
  new_order_id := public.open_restaurant_order(
    array[new_table_id],
    greatest(1, p_capacity),
    p_cash_session_id,
    p_device_id
  );
  saved_order := public.save_catalog_order_lines(new_order_id, 0, p_lines);

  update public.orders
  set draft_discount = p_discount
  where id = new_order_id;

  return jsonb_build_object(
    'tableId', new_table_id,
    'orderId', new_order_id,
    'revision', (saved_order ->> 'revision')::integer
  );
end;
$$;

-- Delete a table that belongs to the current cash session. If it contains a
-- wholly unpaid, unshared order, cancel that order in the same transaction.
create or replace function public.delete_session_virtual_restaurant_table(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_table_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  selected_table public.restaurant_tables%rowtype;
  active_group_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_table_id::text, 0));

  select session.* into session_row
  from public.cash_sessions session
  where session.id = p_cash_session_id
  for update;

  select device.* into device_row
  from public.devices device
  where device.id = p_device_id;

  if session_row.id is null
    or session_row.status <> 'open'
    or device_row.id is null
    or not device_row.can_take_orders
    or not public.user_has_device_access(session_row.tenant_id, session_row.venue_id, device_row.id)
  then
    raise exception 'VIRTUAL_TABLE_DELETE_FORBIDDEN' using errcode = '42501';
  end if;

  select tables.* into selected_table
  from public.restaurant_tables tables
  where tables.id = p_table_id
  for update;

  if selected_table.id is null then return false; end if;
  if selected_table.cash_session_id is distinct from session_row.id
    or selected_table.tenant_id is distinct from session_row.tenant_id
    or selected_table.venue_id is distinct from session_row.venue_id
  then
    raise exception 'VIRTUAL_TABLE_SESSION_MISMATCH' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.reservation_tables assignment
    join public.reservations reservation on reservation.id = assignment.reservation_id
    where assignment.table_id = selected_table.id
      and (
        reservation.status in ('arrived', 'seated')
        or (reservation.status = 'confirmed' and reservation.ends_at > now())
      )
  ) then
    raise exception 'VIRTUAL_TABLE_HAS_ACTIVE_RESERVATION' using errcode = '55000';
  end if;

  select assignment.order_group_id into active_group_id
  from public.order_tables assignment
  where assignment.table_id = selected_table.id
    and assignment.released_at is null
  order by assignment.joined_at desc
  limit 1;

  if active_group_id is not null then
    perform 1 from public.order_groups groups
    where groups.id = active_group_id
    for update;
    perform 1 from public.orders orders
    where orders.order_group_id = active_group_id
    order by orders.id
    for update;
    perform 1 from public.order_tables assignment
    where assignment.order_group_id = active_group_id
      and assignment.released_at is null
    order by assignment.id
    for update;

    if (
      select count(*)
      from public.order_tables assignment
      where assignment.order_group_id = active_group_id
        and assignment.released_at is null
    ) > 1 then
      raise exception 'VIRTUAL_TABLE_JOINED' using errcode = '55000';
    end if;

    if exists (
      select 1 from public.orders orders
      where orders.order_group_id = active_group_id
        and orders.status = 'paid'
    ) or exists (
      select 1 from public.restaurant_order_equal_splits split
      where split.order_group_id = active_group_id
        and split.paid_parts > 0
    ) then
      raise exception 'VIRTUAL_TABLE_HAS_PAYMENTS' using errcode = '55000';
    end if;

    update public.orders orders
    set status = 'cancelled',
        closed_at = now(),
        updated_at = now(),
        revision = orders.revision + 1
    where orders.order_group_id = active_group_id
      and orders.status = 'open';

    update public.order_groups groups
    set status = 'closed',
        closed_at = now(),
        updated_at = now()
    where groups.id = active_group_id
      and groups.status = 'open';

    update public.order_tables assignment
    set released_at = now()
    where assignment.order_group_id = active_group_id
      and assignment.released_at is null;
  end if;

  -- Remove the table from the session layout and dissolve a layout group that
  -- would otherwise be left with a single member.
  update public.cash_session_table_layouts layout
  set tables = (
        select coalesce(jsonb_object_agg(item.key,
          case
            when item.group_id is not null and item.group_members < 2
              then jsonb_set(item.value, '{groupId}', 'null'::jsonb, true)
            else item.value
          end
        ), '{}'::jsonb)
        from (
          select entry.key,
                 entry.value,
                 nullif(entry.value ->> 'groupId', '') group_id,
                 count(*) over (partition by nullif(entry.value ->> 'groupId', '')) group_members
          from jsonb_each(layout.tables - selected_table.id::text) entry
        ) item
      ),
      revision = layout.revision + 1,
      updated_by = auth.uid(),
      updated_at = now()
  where layout.cash_session_id = session_row.id;

  delete from public.restaurant_tables tables
  where tables.id = selected_table.id;
  return found;
end;
$$;

revoke all on function public.save_quick_sale_as_virtual_table(uuid, uuid, uuid, text, integer, text, jsonb, jsonb) from public;
grant execute on function public.save_quick_sale_as_virtual_table(uuid, uuid, uuid, text, integer, text, jsonb, jsonb) to authenticated;
revoke all on function public.delete_session_virtual_restaurant_table(uuid, uuid, uuid) from public;
grant execute on function public.delete_session_virtual_restaurant_table(uuid, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
