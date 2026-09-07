-- A suspended order keeps its identity, lines, splits and production allocations.
-- Paid tickets/sales remain attached to the session which collected them.
alter table public.orders drop constraint orders_status_check;
alter table public.orders drop constraint orders_closed_state_check;
alter table public.orders add constraint orders_status_check
  check (status in ('open', 'carried_forward', 'paid', 'cancelled'));
alter table public.orders add constraint orders_closed_state_check check (
  (status in ('open', 'carried_forward') and closed_at is null)
  or (status in ('paid', 'cancelled') and closed_at is not null));

create table public.restaurant_order_carryovers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  order_group_id uuid not null references public.order_groups(id) on delete restrict,
  order_ids uuid[] not null,
  from_cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  to_cash_session_id uuid references public.cash_sessions(id) on delete restrict,
  carried_at timestamptz not null default now(),
  carried_by uuid not null references auth.users(id) on delete restrict,
  carried_by_device_id uuid not null references public.devices(id) on delete restrict,
  recovered_at timestamptz,
  recovered_by uuid references auth.users(id) on delete restrict,
  recovered_by_device_id uuid references public.devices(id) on delete restrict,
  table_layout jsonb not null default '{}'::jsonb,
  unique(order_group_id, from_cash_session_id),
  check (to_cash_session_id is distinct from from_cash_session_id),
  check ((to_cash_session_id is null and recovered_at is null and recovered_by is null and recovered_by_device_id is null)
    or (to_cash_session_id is not null and recovered_at is not null and recovered_by is not null and recovered_by_device_id is not null))
);
create unique index restaurant_order_carryovers_pending_group_idx
  on public.restaurant_order_carryovers(order_group_id) where recovered_at is null;
create index restaurant_order_carryovers_pending_venue_idx
  on public.restaurant_order_carryovers(tenant_id, venue_id, carried_at) where recovered_at is null;
create index restaurant_order_carryovers_destination_idx on public.restaurant_order_carryovers(to_cash_session_id);
create index orders_carried_forward_idx on public.orders(tenant_id, venue_id, cash_session_id)
  where status = 'carried_forward';
alter table public.restaurant_order_carryovers enable row level security;
create policy restaurant_order_carryovers_select on public.restaurant_order_carryovers
  for select to authenticated using (public.user_has_venue_access(tenant_id, venue_id));
revoke all on public.restaurant_order_carryovers from public, anon, authenticated;
grant select on public.restaurant_order_carryovers to authenticated;

create function public.carry_forward_and_close_cash_session(p_cash_session_id uuid, p_device_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
begin
  if auth.uid() is null then raise exception 'Autenticacion requerida' using errcode = '42501'; end if;
  select * into session_row from public.cash_sessions where id = p_cash_session_id for update;
  select * into device_row from public.devices where id = p_device_id;
  if session_row.id is null or device_row.id is null or not device_row.is_active
    or device_row.tenant_id <> session_row.tenant_id or device_row.venue_id <> session_row.venue_id
    or not device_row.can_close_cash_session
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id) then
    raise exception 'El dispositivo no puede cerrar esta caja' using errcode = '42501';
  end if;
  -- A lost response can safely retry this same session, without suspending anything else.
  if session_row.status = 'closed' then return jsonb_build_object('id', session_row.id); end if;
  if session_row.status <> 'open' then raise exception 'Caja no disponible'; end if;

  -- Existing payments lock group -> orders -> session. NOWAIT avoids reversing
  -- that lock order into a deadlock; a busy payment makes the whole close retryable.
  perform 1 from public.order_groups g where g.id in (
    select o.order_group_id from public.orders o where o.cash_session_id = session_row.id and o.status = 'open'
  ) order by g.id for update nowait;
  perform 1 from public.orders o where o.cash_session_id = session_row.id and o.status = 'open'
    order by o.id for update nowait;
  insert into public.restaurant_order_carryovers (
    tenant_id, venue_id, order_group_id, order_ids, from_cash_session_id, carried_by, carried_by_device_id, table_layout
  ) select session_row.tenant_id, session_row.venue_id, o.order_group_id, array_agg(o.id order by o.id),
    session_row.id, auth.uid(), device_row.id,
    coalesce((select jsonb_object_agg(e.key, e.value)
      from public.cash_session_table_layouts l cross join lateral jsonb_each(l.tables) e
      where l.cash_session_id = session_row.id and exists (
        select 1 from public.order_tables ot where ot.order_group_id = o.order_group_id
          and ot.released_at is null and ot.table_id::text = e.key)), '{}'::jsonb)
  from public.orders o where o.cash_session_id = session_row.id and o.status = 'open' group by o.order_group_id;
  update public.orders set status = 'carried_forward', revision = revision + 1
    where cash_session_id = session_row.id and status = 'open';
  -- Existing close retains its permission checks, accounting, snapshot and triggers.
  return public.close_cash_register_session(p_cash_session_id, p_device_id, p_payload);
exception when lock_not_available then
  raise exception 'Hay una operacion en curso en las mesas. Espera y vuelve a cerrar.' using errcode = '55P03';
end;
$$;
revoke all on function public.carry_forward_and_close_cash_session(uuid, uuid, jsonb) from public, anon;
grant execute on function public.carry_forward_and_close_cash_session(uuid, uuid, jsonb) to authenticated;

create function public.recover_restaurant_carryovers(p_cash_session_id uuid, p_device_id uuid, p_carryover_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  transfer_row public.restaurant_order_carryovers%rowtype;
  recovered_count integer := 0;
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
    -- Recheck after locking: another device may have already recovered it.
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
    update public.order_groups set cash_session_id = session_row.id where id = transfer_row.order_group_id;
    update public.orders set status = 'open', cash_session_id = session_row.id,
      cash_register_id = session_row.cash_register_id, revision = revision + 1
      where id = any(transfer_row.order_ids);
    update public.restaurant_tables rt set cash_session_id = session_row.id, is_active = true
      where rt.cash_session_id = transfer_row.from_cash_session_id and exists (
        select 1 from public.order_tables ot where ot.order_group_id = transfer_row.order_group_id
          and ot.table_id = rt.id and ot.released_at is null);
    perform public.get_cash_session_table_layout(session_row.id);
    update public.cash_session_table_layouts set tables = tables || transfer_row.table_layout,
      revision = revision + 1, updated_by = auth.uid() where cash_session_id = session_row.id;
    update public.restaurant_order_carryovers set to_cash_session_id = session_row.id,
      recovered_at = now(), recovered_by = auth.uid(), recovered_by_device_id = device_row.id
      where id = transfer_row.id;
    recovered_count := recovered_count + cardinality(transfer_row.order_ids);
  end loop;
  return recovered_count;
exception when lock_not_available then
  raise exception 'Hay una operacion en curso en las mesas. Vuelve a recuperarlas.' using errcode = '55P03';
end;
$$;
revoke all on function public.recover_restaurant_carryovers(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.recover_restaurant_carryovers(uuid, uuid, uuid[]) to authenticated;
