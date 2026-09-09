-- Opening a cash session claims every pending restaurant carryover in the same
-- transaction. The short undo window only reverses an untouched recovery; the
-- append-only JSON history preserves every automatic recovery and unload.
alter table public.restaurant_order_carryovers
  add column if not exists recovery_undo_expires_at timestamptz,
  add column if not exists recovery_order_revisions jsonb,
  add column if not exists recovery_table_ids uuid[],
  add column if not exists destination_table_layout_before jsonb,
  add column if not exists recovery_history jsonb not null default '[]'::jsonb;

-- Rows recovered before this migration stay recovered, but their undo window is
-- deliberately expired. Backfill the snapshot so the new invariant also holds
-- on venues that already used the original carryover flow.
update public.restaurant_order_carryovers transfer set
  recovery_undo_expires_at = transfer.recovered_at,
  recovery_order_revisions = coalesce((
    select jsonb_object_agg(o.id::text, to_jsonb(o.revision))
    from public.orders o where o.id = any(transfer.order_ids)
  ), '{}'::jsonb),
  recovery_table_ids = coalesce((
    select array_agg(distinct ot.table_id order by ot.table_id)
    from public.order_tables ot
    where ot.order_group_id = transfer.order_group_id and ot.released_at is null
  ), '{}'::uuid[]),
  destination_table_layout_before = '{}'::jsonb,
  recovery_history = case
    when jsonb_array_length(transfer.recovery_history) > 0 then transfer.recovery_history
    else jsonb_build_array(jsonb_build_object(
      'event', 'recovered',
      'cashSessionId', transfer.to_cash_session_id,
      'at', transfer.recovered_at,
      'by', transfer.recovered_by,
      'deviceId', transfer.recovered_by_device_id,
      'historical', true
    ))
  end
where transfer.recovered_at is not null
  and (
    transfer.recovery_undo_expires_at is null
    or transfer.recovery_order_revisions is null
    or transfer.recovery_table_ids is null
    or transfer.destination_table_layout_before is null
  );

alter table public.restaurant_order_carryovers
  drop constraint if exists restaurant_order_carryovers_recovery_history_check,
  drop constraint if exists restaurant_order_carryovers_recovery_snapshot_check;
alter table public.restaurant_order_carryovers
  add constraint restaurant_order_carryovers_recovery_history_check
    check (jsonb_typeof(recovery_history) = 'array'),
  add constraint restaurant_order_carryovers_recovery_snapshot_check check (
    (recovered_at is null
      and recovery_undo_expires_at is null
      and recovery_order_revisions is null
      and recovery_table_ids is null
      and destination_table_layout_before is null)
    or
    (recovered_at is not null
      and recovery_undo_expires_at is not null
      and recovery_order_revisions is not null
      and recovery_table_ids is not null
      and destination_table_layout_before is not null)
  );

create or replace function public.recover_restaurant_carryovers(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_carryover_ids uuid[]
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  transfer_row public.restaurant_order_carryovers%rowtype;
  recovered_count integer := 0;
  recovered_at_value timestamptz;
  previous_layout jsonb;
  recovered_revisions jsonb;
  recovered_tables uuid[];
begin
  if auth.uid() is null then raise exception 'Autenticacion requerida' using errcode = '42501'; end if;
  select * into session_row from public.cash_sessions where id = p_cash_session_id for update;
  select * into device_row from public.devices where id = p_device_id;
  if session_row.id is null or session_row.status <> 'open' or device_row.id is null or not device_row.is_active
    or device_row.tenant_id <> session_row.tenant_id or device_row.venue_id <> session_row.venue_id
    or not device_row.can_take_orders or device_row.active_cash_session_id is distinct from session_row.id
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id) then
    raise exception 'Selecciona una caja abierta del local para recuperar las mesas' using errcode = '42501';
  end if;
  if p_carryover_ids is null or cardinality(p_carryover_ids) = 0 then return 0; end if;
  if exists (select 1 from unnest(p_carryover_ids) as requested(transfer_id) where not exists (
    select 1 from public.restaurant_order_carryovers c where c.id = requested.transfer_id
      and c.tenant_id = session_row.tenant_id and c.venue_id = session_row.venue_id
  )) then raise exception 'Traspaso no disponible' using errcode = '42501'; end if;

  for transfer_row in select * from public.restaurant_order_carryovers
    where id = any(p_carryover_ids) order by id for update
  loop
    -- Recheck after locking: another device or cash session may have claimed it.
    if transfer_row.recovered_at is not null then continue; end if;
    if not exists (select 1 from public.cash_sessions cs where cs.id = transfer_row.from_cash_session_id
      and cs.status = 'closed' and cs.closed_at <= session_row.opened_at) then
      raise exception 'Recupera las mesas en un turno abierto despues del cierre de origen';
    end if;
    perform 1 from public.order_groups where id = transfer_row.order_group_id for update nowait;
    perform 1 from public.orders where order_group_id = transfer_row.order_group_id order by id for update nowait;
    if exists (select 1 from public.orders where id = any(transfer_row.order_ids)
      and (status <> 'carried_forward' or cash_session_id <> transfer_row.from_cash_session_id)) then
      raise exception 'El estado del traspaso ha cambiado';
    end if;

    perform public.get_cash_session_table_layout(session_row.id);
    select coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into previous_layout
      from public.cash_session_table_layouts layout
      cross join lateral jsonb_each(layout.tables) entry
      where layout.cash_session_id = session_row.id and transfer_row.table_layout ? entry.key;
    select coalesce(array_agg(distinct ot.table_id order by ot.table_id), '{}'::uuid[])
      into recovered_tables
      from public.order_tables ot
      where ot.order_group_id = transfer_row.order_group_id and ot.released_at is null;

    update public.order_groups set cash_session_id = session_row.id where id = transfer_row.order_group_id;
    update public.orders set status = 'open', cash_session_id = session_row.id,
      cash_register_id = session_row.cash_register_id, revision = revision + 1
      where id = any(transfer_row.order_ids);
    select coalesce(jsonb_object_agg(o.id::text, to_jsonb(o.revision)), '{}'::jsonb)
      into recovered_revisions from public.orders o where o.id = any(transfer_row.order_ids);
    update public.restaurant_tables rt set cash_session_id = session_row.id, is_active = true
      where rt.cash_session_id = transfer_row.from_cash_session_id and rt.id = any(recovered_tables);
    update public.cash_session_table_layouts set tables = tables || transfer_row.table_layout,
      revision = revision + 1, updated_by = auth.uid() where cash_session_id = session_row.id;

    recovered_at_value := clock_timestamp();
    update public.restaurant_order_carryovers set
      to_cash_session_id = session_row.id,
      recovered_at = recovered_at_value,
      recovered_by = auth.uid(),
      recovered_by_device_id = device_row.id,
      recovery_undo_expires_at = recovered_at_value + interval '5 seconds',
      recovery_order_revisions = recovered_revisions,
      recovery_table_ids = recovered_tables,
      destination_table_layout_before = previous_layout,
      recovery_history = recovery_history || jsonb_build_array(jsonb_build_object(
        'event', 'recovered',
        'cashSessionId', session_row.id,
        'at', recovered_at_value,
        'by', auth.uid(),
        'deviceId', device_row.id
      ))
      where id = transfer_row.id;
    recovered_count := recovered_count + cardinality(transfer_row.order_ids);
  end loop;
  return recovered_count;
exception when lock_not_available then
  raise exception 'Hay una operacion en curso en las mesas. Vuelve a recuperarlas.' using errcode = '55P03';
end;
$$;

create or replace function public.open_cash_register_session_with_carryovers(
  p_cash_register_id uuid,
  p_opening_float_cents integer,
  p_device_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  opened_session_id uuid;
  pending_ids uuid[];
begin
  if auth.uid() is null then raise exception 'Autenticacion requerida' using errcode = '42501'; end if;
  opened_session_id := public.open_cash_register_session(
    p_cash_register_id,
    p_opening_float_cents,
    p_device_id
  );

  if exists (select 1 from public.devices d where d.id = p_device_id and d.can_take_orders) then
    select array_agg(c.id order by c.id) into pending_ids
      from public.restaurant_order_carryovers c
      join public.cash_sessions cs on cs.id = opened_session_id
      where c.tenant_id = cs.tenant_id and c.venue_id = cs.venue_id and c.recovered_at is null;
    if cardinality(pending_ids) > 0 then
      perform public.recover_restaurant_carryovers(opened_session_id, p_device_id, pending_ids);
    end if;
  end if;
  return opened_session_id;
end;
$$;

create or replace function public.unload_restaurant_carryovers(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_carryover_ids uuid[]
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  transfer_row public.restaurant_order_carryovers%rowtype;
  current_table_ids uuid[];
  unloaded_count integer := 0;
  unloaded_at_value timestamptz;
begin
  if auth.uid() is null then raise exception 'Autenticacion requerida' using errcode = '42501'; end if;
  select * into session_row from public.cash_sessions where id = p_cash_session_id for update;
  select * into device_row from public.devices where id = p_device_id;
  if session_row.id is null or session_row.status <> 'open' or device_row.id is null or not device_row.is_active
    or device_row.tenant_id <> session_row.tenant_id or device_row.venue_id <> session_row.venue_id
    or not device_row.can_take_orders or device_row.active_cash_session_id is distinct from session_row.id
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id) then
    raise exception 'Selecciona la caja que recupero las mesas' using errcode = '42501';
  end if;
  if p_carryover_ids is null or cardinality(p_carryover_ids) = 0 then return 0; end if;

  for transfer_row in select * from public.restaurant_order_carryovers
    where id = any(p_carryover_ids) order by id for update
  loop
    if transfer_row.to_cash_session_id is distinct from session_row.id
      or transfer_row.recovered_by_device_id is distinct from device_row.id
      or transfer_row.recovery_undo_expires_at is null
      or clock_timestamp() >= transfer_row.recovery_undo_expires_at then
      continue;
    end if;

    perform 1 from public.order_groups where id = transfer_row.order_group_id for update nowait;
    perform 1 from public.orders where order_group_id = transfer_row.order_group_id order by id for update nowait;
    if (select count(*) from public.orders where order_group_id = transfer_row.order_group_id)
        <> cardinality(transfer_row.order_ids)
      or exists (
        select 1 from public.orders o where o.id = any(transfer_row.order_ids) and (
          o.status <> 'open'
          or o.cash_session_id <> session_row.id
          or transfer_row.recovery_order_revisions ->> o.id::text is distinct from o.revision::text
        )
      ) then
      raise exception 'Las mesas ya se han modificado y no se puede deshacer la carga';
    end if;
    select coalesce(array_agg(distinct ot.table_id order by ot.table_id), '{}'::uuid[])
      into current_table_ids from public.order_tables ot
      where ot.order_group_id = transfer_row.order_group_id and ot.released_at is null;
    if current_table_ids is distinct from transfer_row.recovery_table_ids then
      raise exception 'Las mesas ya se han modificado y no se puede deshacer la carga';
    end if;

    update public.cash_session_table_layouts set
      tables = (tables - array(select jsonb_object_keys(transfer_row.table_layout)))
        || transfer_row.destination_table_layout_before,
      revision = revision + 1,
      updated_by = auth.uid()
      where cash_session_id = session_row.id;
    update public.restaurant_tables rt set cash_session_id = transfer_row.from_cash_session_id
      where rt.cash_session_id = session_row.id and rt.id = any(transfer_row.recovery_table_ids);
    update public.order_groups set cash_session_id = transfer_row.from_cash_session_id
      where id = transfer_row.order_group_id;
    update public.orders o set
      status = 'carried_forward',
      cash_session_id = transfer_row.from_cash_session_id,
      cash_register_id = origin.cash_register_id,
      revision = revision + 1
      from public.cash_sessions origin
      where o.id = any(transfer_row.order_ids) and origin.id = transfer_row.from_cash_session_id;

    unloaded_at_value := clock_timestamp();
    update public.restaurant_order_carryovers set
      recovery_history = recovery_history || jsonb_build_array(jsonb_build_object(
        'event', 'unloaded',
        'cashSessionId', session_row.id,
        'at', unloaded_at_value,
        'by', auth.uid(),
        'deviceId', device_row.id
      )),
      to_cash_session_id = null,
      recovered_at = null,
      recovered_by = null,
      recovered_by_device_id = null,
      recovery_undo_expires_at = null,
      recovery_order_revisions = null,
      recovery_table_ids = null,
      destination_table_layout_before = null
      where id = transfer_row.id;
    unloaded_count := unloaded_count + cardinality(transfer_row.order_ids);
  end loop;
  return unloaded_count;
exception when lock_not_available then
  raise exception 'Hay una operacion en curso en las mesas y no se puede deshacer la carga.' using errcode = '55P03';
end;
$$;

revoke all on function public.open_cash_register_session_with_carryovers(uuid, integer, uuid) from public, anon;
revoke all on function public.unload_restaurant_carryovers(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.open_cash_register_session_with_carryovers(uuid, integer, uuid) to authenticated;
grant execute on function public.unload_restaurant_carryovers(uuid, uuid, uuid[]) to authenticated;
