-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserves the existing RPC signature, result and authenticated grant; only makes seated retries reuse an open order.
set lock_timeout = '5s';
set statement_timeout = '5min';

create or replace function public.seat_reservation(
  p_reservation_id uuid,
  p_cash_session_id uuid,
  p_device_id uuid,
  p_table_ids uuid[] default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.reservations%rowtype;
  v_session public.cash_sessions%rowtype;
  v_time_zone text;
  v_table_ids uuid[];
  v_order_id uuid;
begin
  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if v_reservation.id is null or not public.user_can_manage_reservations(v_reservation.tenant_id, v_reservation.venue_id) then
    raise exception 'RESERVATION_FORBIDDEN' using errcode = '42501';
  end if;
  if v_reservation.status = 'seated'
    and v_reservation.order_id is not null
    and exists (
      select 1
      from public.orders linked_order
      where linked_order.id = v_reservation.order_id
        and linked_order.status = 'open'
    ) then
    return v_reservation.order_id;
  end if;
  if v_reservation.status not in ('confirmed', 'arrived', 'seated') then
    raise exception 'RESERVATION_CANNOT_BE_SEATED';
  end if;
  select v.timezone into v_time_zone from public.venues v where v.id = v_reservation.venue_id;
  if (v_reservation.starts_at at time zone v_time_zone)::date <> (now() at time zone v_time_zone)::date then
    raise exception 'RESERVATION_NOT_TODAY';
  end if;
  select * into v_session from public.cash_sessions where id = p_cash_session_id for update;
  if v_session.id is null or v_session.status <> 'open'
    or v_session.tenant_id <> v_reservation.tenant_id or v_session.venue_id <> v_reservation.venue_id then
    raise exception 'RESERVATION_CASH_SESSION_REQUIRED';
  end if;

  if p_table_ids is not null then
    perform pg_advisory_xact_lock(hashtextextended(selected.value::text, 0))
    from unnest(p_table_ids) selected(value) order by selected.value;
    if cardinality(p_table_ids) = 0 or exists (
      select 1 from unnest(p_table_ids) selected(value)
      where not exists (
        select 1 from public.restaurant_tables t
        where t.id = selected.value and t.tenant_id = v_reservation.tenant_id
          and t.venue_id = v_reservation.venue_id and t.is_active
      )
    ) then raise exception 'RESERVATION_TABLE_SCOPE_OR_INACTIVE'; end if;
    delete from public.reservation_tables where reservation_id = v_reservation.id;
    insert into public.reservation_tables (reservation_id, table_id, tenant_id, venue_id)
    select v_reservation.id, selected.value, v_reservation.tenant_id, v_reservation.venue_id
    from unnest(p_table_ids) selected(value);
  end if;

  select array_agg(rt.table_id order by rt.table_id) into v_table_ids
  from public.reservation_tables rt where rt.reservation_id = v_reservation.id;
  if coalesce(cardinality(v_table_ids), 0) = 0 then raise exception 'RESERVATION_TABLE_REQUIRED'; end if;

  v_order_id := public.open_restaurant_order(v_table_ids, v_reservation.party_size, p_cash_session_id, p_device_id);
  update public.reservations
  set status = 'seated', order_id = v_order_id, seated_at = now()
  where id = v_reservation.id;
  return v_order_id;
end;
$$;

revoke all on function public.seat_reservation(uuid, uuid, uuid, uuid[]) from public, anon;
grant execute on function public.seat_reservation(uuid, uuid, uuid, uuid[]) to authenticated;
