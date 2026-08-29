-- Session tables placed in the synthetic Virtual room are disposable. Tables
-- from the same session that were placed in a physical dining area remain
-- reusable after their order is released.
create or replace function public.cleanup_virtual_room_restaurant_table(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_table_id uuid,
  p_close_as_paid boolean default false
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
  cleanup_table_ids uuid[];
  cleanup_table_keys text[];
  deleted_count integer := 0;
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
    raise exception 'VIRTUAL_TABLE_CLEANUP_FORBIDDEN' using errcode = '42501';
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
    raise exception 'VIRTUAL_TABLE_CLEANUP_SESSION_MISMATCH' using errcode = '55000';
  end if;

  -- This is the important distinction: a session table with a physical area
  -- is temporary but reusable, whereas an unplaced table belongs to Virtual.
  if selected_table.area_id is not null then return false; end if;

  select assignment.order_group_id into active_group_id
  from public.order_tables assignment
  where assignment.table_id = selected_table.id
    and assignment.released_at is null
  order by assignment.joined_at desc
  limit 1;

  cleanup_table_ids := array[selected_table.id];

  if active_group_id is not null then
    perform 1 from public.order_groups groups
    where groups.id = active_group_id
    for update;
    perform 1 from public.orders orders
    where orders.order_group_id = active_group_id
    order by orders.id
    for update;
    perform 1 from public.order_lines lines
    join public.orders orders on orders.id = lines.order_id
    where orders.order_group_id = active_group_id
    order by lines.id
    for update of lines;
    perform 1 from public.order_tables assignment
    where assignment.order_group_id = active_group_id
      and assignment.released_at is null
    order by assignment.id
    for update;

    -- The table is still occupied while any order in the joined group has
    -- items. This also prevents deleting a table when only one split is empty.
    if exists (
      select 1
      from public.order_lines lines
      join public.orders orders on orders.id = lines.order_id
      where orders.order_group_id = active_group_id
    ) then
      return false;
    end if;

    select coalesce(array_agg(distinct tables.id), array[selected_table.id])
    into cleanup_table_ids
    from public.order_tables assignment
    join public.restaurant_tables tables on tables.id = assignment.table_id
    where assignment.order_group_id = active_group_id
      and assignment.released_at is null
      and tables.cash_session_id = session_row.id
      and tables.area_id is null;
  end if;

  if exists (
    select 1
    from public.reservation_tables assignment
    join public.reservations reservation on reservation.id = assignment.reservation_id
    where assignment.table_id = any(cleanup_table_ids)
      and (
        reservation.status in ('arrived', 'seated')
        or (reservation.status = 'confirmed' and reservation.ends_at > now())
      )
  ) then
    return false;
  end if;

  if active_group_id is not null then
    update public.restaurant_order_equal_splits split
    set status = 'cancelled',
        updated_at = now(),
        revision = split.revision + 1
    where split.order_group_id = active_group_id
      and split.status = 'open';

    update public.orders orders
    set status = case when p_close_as_paid then 'paid' else 'cancelled' end,
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

  select coalesce(array_agg(table_id::text), '{}'::text[])
  into cleanup_table_keys
  from unnest(cleanup_table_ids) table_id;

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
          from jsonb_each(layout.tables - cleanup_table_keys) entry
        ) item
      ),
      revision = layout.revision + 1,
      updated_by = auth.uid(),
      updated_at = now()
  where layout.cash_session_id = session_row.id;

  delete from public.restaurant_tables tables
  where tables.id = any(cleanup_table_ids)
    and tables.cash_session_id = session_row.id
    and tables.area_id is null
    and not exists (
      select 1 from public.order_tables assignment
      where assignment.table_id = tables.id
        and assignment.released_at is null
    );
  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

revoke all on function public.cleanup_virtual_room_restaurant_table(uuid, uuid, uuid, boolean) from public;
grant execute on function public.cleanup_virtual_room_restaurant_table(uuid, uuid, uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
