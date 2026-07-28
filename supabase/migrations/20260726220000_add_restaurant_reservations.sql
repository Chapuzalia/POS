-- Persistent restaurant reservations. Assignments always reference permanent
-- restaurant_tables ids; cash-session layouts are only a visual projection.

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  venue_id uuid not null references public.venues(id),
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  party_size integer not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed',
  notes text,
  cancellation_reason text,
  order_id uuid references public.orders(id) on delete set null,
  arrived_at timestamptz,
  seated_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservations_customer_name_check check (btrim(customer_name) <> ''),
  constraint reservations_customer_phone_check check (btrim(customer_phone) <> ''),
  constraint reservations_party_size_check check (party_size > 0 and party_size <= 999),
  constraint reservations_time_check check (ends_at > starts_at),
  constraint reservations_status_check check (status in ('confirmed', 'arrived', 'seated', 'completed', 'cancelled', 'no_show')),
  constraint reservations_scope_unique unique (id, tenant_id, venue_id)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.restaurant_tables'::regclass
      and conname = 'restaurant_tables_scope_unique'
  ) then
    alter table public.restaurant_tables
      add constraint restaurant_tables_scope_unique unique (id, tenant_id, venue_id);
  end if;
end $$;

create table if not exists public.reservation_tables (
  reservation_id uuid not null,
  table_id uuid not null,
  tenant_id uuid not null,
  venue_id uuid not null,
  assigned_at timestamptz not null default now(),
  primary key (reservation_id, table_id),
  constraint reservation_tables_reservation_scope_fk
    foreign key (reservation_id, tenant_id, venue_id)
    references public.reservations(id, tenant_id, venue_id) on delete cascade,
  constraint reservation_tables_table_scope_fk
    foreign key (table_id, tenant_id, venue_id)
    references public.restaurant_tables(id, tenant_id, venue_id)
);

comment on column public.restaurant_tables.reserved_until is
  'Legacy reservation field. New reservation availability is sourced from reservations and reservation_tables.';
comment on column public.restaurant_tables.reservation_note is
  'Legacy reservation field. New reservation details are sourced from reservations and reservation_tables.';

create index if not exists reservations_venue_starts_at_idx
  on public.reservations (tenant_id, venue_id, starts_at);
create index if not exists reservations_active_date_idx
  on public.reservations (tenant_id, venue_id, starts_at, ends_at)
  where status in ('confirmed', 'arrived', 'seated');
create index if not exists reservations_phone_idx
  on public.reservations (tenant_id, venue_id, customer_phone);
create index if not exists reservation_tables_table_idx
  on public.reservation_tables (table_id, venue_id, reservation_id);
create index if not exists reservation_tables_overlap_idx
  on public.reservation_tables (tenant_id, venue_id, table_id, reservation_id);

drop trigger if exists set_reservations_updated_at on public.reservations;
create trigger set_reservations_updated_at
  before update on public.reservations
  for each row execute function public.set_updated_at();

create or replace function public.user_can_manage_reservations(target_tenant uuid, target_venue uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.role() = 'service_role'
    or exists (
      select 1
      from public.tenant_memberships tm
      where tm.tenant_id = target_tenant
        and tm.user_id = auth.uid()
        and tm.is_active
        and tm.role in ('owner', 'manager')
    )
    or exists (
      select 1
      from public.device_user_assignments dua
      join public.devices d on d.id = dua.device_id
      where dua.tenant_id = target_tenant
        and dua.venue_id = target_venue
        and dua.user_id = auth.uid()
        and dua.is_active
        and d.tenant_id = target_tenant
        and d.venue_id = target_venue
        and d.is_active
        and d.can_take_orders
    );
$$;

create or replace function public.reservation_to_json(p_reservation public.reservations)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select to_jsonb(p_reservation) || jsonb_build_object(
    'reservation_tables',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'table_id', rt.table_id,
        'restaurant_tables', jsonb_build_object(
          'id', t.id,
          'name', t.name,
          'capacity', t.capacity,
          'area_id', t.area_id,
          'sort_order', t.sort_order,
          'is_active', t.is_active,
          'dining_areas', jsonb_build_object('name', a.name)
        )
      ) order by t.sort_order, t.id)
      from public.reservation_tables rt
      join public.restaurant_tables t on t.id = rt.table_id
      join public.dining_areas a on a.id = t.area_id
      where rt.reservation_id = p_reservation.id
    ), '[]'::jsonb)
  );
$$;

create or replace function public.save_reservation(
  p_reservation_id uuid,
  p_venue_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_party_size integer,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_notes text,
  p_table_ids uuid[],
  p_allow_conflict boolean,
  p_expected_updated_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_reservation public.reservations%rowtype;
  v_current public.reservations%rowtype;
  v_table_count integer;
  v_conflicts jsonb := '[]'::jsonb;
  v_table_ids uuid[] := coalesce(p_table_ids, '{}'::uuid[]);
begin
  select v.tenant_id into v_tenant_id from public.venues v where v.id = p_venue_id;
  if v_tenant_id is null or not public.user_can_manage_reservations(v_tenant_id, p_venue_id) then
    raise exception 'RESERVATION_FORBIDDEN' using errcode = '42501';
  end if;
  if btrim(coalesce(p_customer_name, '')) = ''
    or btrim(coalesce(p_customer_phone, '')) = ''
    or p_party_size <= 0
    or p_ends_at <= p_starts_at then
    raise exception 'RESERVATION_INVALID_DATA' using errcode = '22023';
  end if;
  if cardinality(v_table_ids) <> (select count(distinct value) from unnest(v_table_ids) selected(value)) then
    raise exception 'RESERVATION_DUPLICATE_TABLE';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(selected.value::text, 0))
  from unnest(v_table_ids) selected(value)
  order by selected.value;

  select count(*) into v_table_count
  from public.restaurant_tables t
  where t.id = any(v_table_ids)
    and t.tenant_id = v_tenant_id
    and t.venue_id = p_venue_id
    and t.is_active;
  if v_table_count <> cardinality(v_table_ids) then
    raise exception 'RESERVATION_TABLE_SCOPE_OR_INACTIVE' using errcode = '22023';
  end if;

  if p_reservation_id is not null then
    select * into v_current
    from public.reservations r
    where r.id = p_reservation_id
      and r.tenant_id = v_tenant_id
      and r.venue_id = p_venue_id
    for update;
    if v_current.id is null then raise exception 'RESERVATION_NOT_FOUND'; end if;
    if p_expected_updated_at is not null and v_current.updated_at <> p_expected_updated_at then
      raise exception 'RESERVATION_REVISION_CONFLICT' using errcode = '40001';
    end if;
    if v_current.status in ('cancelled', 'completed', 'no_show') then
      raise exception 'RESERVATION_FINAL_STATE';
    end if;
    if v_current.status = 'seated' and (
      v_current.starts_at <> p_starts_at
      or v_current.ends_at <> p_ends_at
      or (select coalesce(array_agg(rt.table_id order by rt.table_id), '{}'::uuid[])
          from public.reservation_tables rt where rt.reservation_id = v_current.id)
        <> (select coalesce(array_agg(value order by value), '{}'::uuid[]) from unnest(v_table_ids) selected(value))
    ) then
      raise exception 'RESERVATION_SEATED_SCHEDULE_LOCKED';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'reservationId', conflict.id,
    'customerName', conflict.customer_name,
    'startsAt', conflict.starts_at,
    'endsAt', conflict.ends_at,
    'tableId', conflict.table_id,
    'tableName', conflict.table_name
  ) order by conflict.starts_at), '[]'::jsonb)
  into v_conflicts
  from (
    select distinct r.id, r.customer_name, r.starts_at, r.ends_at, rt.table_id, t.name table_name
    from public.reservations r
    join public.reservation_tables rt on rt.reservation_id = r.id
    join public.restaurant_tables t on t.id = rt.table_id
    where rt.table_id = any(v_table_ids)
      and r.tenant_id = v_tenant_id
      and r.venue_id = p_venue_id
      and r.id <> coalesce(p_reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and r.status in ('confirmed', 'arrived', 'seated')
      and r.starts_at < p_ends_at
      and r.ends_at > p_starts_at
  ) conflict;
  if jsonb_array_length(v_conflicts) > 0 and not p_allow_conflict then
    raise exception 'RESERVATION_CONFLICT'
      using errcode = 'P0001', detail = jsonb_build_object('conflicts', v_conflicts)::text;
  end if;

  if p_reservation_id is null then
    insert into public.reservations (
      tenant_id, venue_id, customer_name, customer_phone, customer_email,
      party_size, starts_at, ends_at, status, notes
    ) values (
      v_tenant_id, p_venue_id, btrim(p_customer_name), btrim(p_customer_phone),
      nullif(btrim(coalesce(p_customer_email, '')), ''), p_party_size,
      p_starts_at, p_ends_at, 'confirmed', nullif(btrim(coalesce(p_notes, '')), '')
    ) returning * into v_reservation;
  else
    update public.reservations
    set customer_name = btrim(p_customer_name),
        customer_phone = btrim(p_customer_phone),
        customer_email = nullif(btrim(coalesce(p_customer_email, '')), ''),
        party_size = p_party_size,
        starts_at = p_starts_at,
        ends_at = p_ends_at,
        notes = nullif(btrim(coalesce(p_notes, '')), '')
    where id = p_reservation_id
    returning * into v_reservation;
    delete from public.reservation_tables where reservation_id = v_reservation.id;
  end if;

  insert into public.reservation_tables (reservation_id, table_id, tenant_id, venue_id)
  select v_reservation.id, selected.value, v_tenant_id, p_venue_id
  from unnest(v_table_ids) selected(value);

  select * into v_reservation from public.reservations where id = v_reservation.id;
  return jsonb_build_object(
    'reservation', public.reservation_to_json(v_reservation),
    'conflicts', v_conflicts
  );
end;
$$;

create or replace function public.change_reservation_status(
  p_reservation_id uuid,
  p_status text,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if v_reservation.id is null or not public.user_can_manage_reservations(v_reservation.tenant_id, v_reservation.venue_id) then
    raise exception 'RESERVATION_FORBIDDEN' using errcode = '42501';
  end if;
  if not (
    (v_reservation.status = 'confirmed' and p_status in ('arrived', 'cancelled', 'no_show'))
    or (v_reservation.status = 'arrived' and p_status = 'cancelled')
    or (v_reservation.status = 'seated' and p_status = 'completed')
  ) then raise exception 'RESERVATION_INVALID_TRANSITION'; end if;

  update public.reservations
  set status = p_status,
      arrived_at = case when p_status = 'arrived' then now() else arrived_at end,
      cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end,
      cancellation_reason = case when p_status = 'cancelled' then nullif(btrim(coalesce(p_reason, '')), '') else cancellation_reason end,
      completed_at = case when p_status = 'completed' then now() else completed_at end
  where id = p_reservation_id returning * into v_reservation;
  return jsonb_build_object('reservation', public.reservation_to_json(v_reservation));
end;
$$;

create or replace function public.search_reservations(
  p_venue_id uuid,
  p_query text,
  p_limit integer default 100
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_time_zone text;
  v_query text := lower(regexp_replace(btrim(coalesce(p_query, '')), '\s+', ' ', 'g'));
  v_phone text := regexp_replace(coalesce(p_query, ''), '[^0-9+]', '', 'g');
  v_result jsonb;
begin
  select v.tenant_id, v.timezone into v_tenant_id, v_time_zone
  from public.venues v where v.id = p_venue_id;
  if v_tenant_id is null or not public.user_has_venue_access(v_tenant_id, p_venue_id) then
    raise exception 'RESERVATION_FORBIDDEN' using errcode = '42501';
  end if;
  if v_query = '' then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(public.reservation_to_json(candidate.row_value)
    order by candidate.date_rank, candidate.starts_at), '[]'::jsonb)
  into v_result
  from (
    select r row_value, r.starts_at,
      case
        when (r.starts_at at time zone v_time_zone)::date = (now() at time zone v_time_zone)::date then 0
        when (r.starts_at at time zone v_time_zone)::date > (now() at time zone v_time_zone)::date then 1
        else 2
      end date_rank
    from public.reservations r
    where r.tenant_id = v_tenant_id
      and r.venue_id = p_venue_id
      and (
        lower(regexp_replace(btrim(r.customer_name), '\s+', ' ', 'g')) like '%' || v_query || '%'
        or (length(v_phone) >= 3 and regexp_replace(r.customer_phone, '[^0-9+]', '', 'g') like '%' || v_phone || '%')
        or exists (
          select 1
          from public.reservation_tables rt
          join public.restaurant_tables t on t.id = rt.table_id
          where rt.reservation_id = r.id
            and lower(regexp_replace(btrim(t.name), '\s+', ' ', 'g')) like '%' || v_query || '%'
        )
      )
    order by date_rank, r.starts_at
    limit least(greatest(coalesce(p_limit, 100), 1), 300)
  ) candidate;
  return v_result;
end;
$$;
-- Remove legacy reservation fields from operational availability. They remain
-- on restaurant_tables only for backwards-compatible storage.
create or replace function public.open_restaurant_order(
  p_table_ids uuid[],
  p_guest_count integer,
  p_cash_session_id uuid,
  p_device_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_table public.restaurant_tables%rowtype;
  new_group_id uuid := gen_random_uuid();
  new_order_id uuid := gen_random_uuid();
  table_count integer;
  locked_count integer;
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
begin
  if coalesce(array_length(p_table_ids, 1), 0) = 0 or p_guest_count < 1 then raise exception 'Seleccion de mesas no valida'; end if;
  select count(distinct value) into table_count from unnest(p_table_ids) selected(value);
  if table_count <> array_length(p_table_ids, 1) then raise exception 'Hay mesas duplicadas'; end if;
  select rt.* into first_table from public.restaurant_tables rt where rt.id = p_table_ids[1] for update;
  perform 1 from public.restaurant_tables rt where rt.id = any(p_table_ids) order by rt.id for update;
  select count(*) into locked_count from public.restaurant_tables rt
  where rt.id = any(p_table_ids)
    and rt.tenant_id = first_table.tenant_id
    and rt.venue_id = first_table.venue_id
    and rt.is_active;
  if first_table.id is null or locked_count <> table_count or exists (
    select 1 from public.order_tables ot where ot.table_id = any(p_table_ids) and ot.released_at is null
  ) then raise exception 'Una de las mesas ya no esta disponible'; end if;
  select cs.* into session_row from public.cash_sessions cs where cs.id = p_cash_session_id for update;
  select d.* into device_row from public.devices d where d.id = p_device_id;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> first_table.tenant_id or session_row.venue_id <> first_table.venue_id
    or device_row.id is null or not device_row.can_take_orders
    or not public.user_has_device_access(session_row.tenant_id, session_row.venue_id, device_row.id) then
    raise exception 'La caja o el dispositivo no son validos' using errcode = '42501';
  end if;
  insert into public.order_groups (id, tenant_id, venue_id, cash_session_id)
  values (new_group_id, first_table.tenant_id, first_table.venue_id, session_row.id);
  insert into public.orders (
    id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id,
    opened_by_device_id, guest_count, order_group_id, split_sequence
  ) values (
    new_order_id, first_table.tenant_id, first_table.venue_id, session_row.id,
    session_row.cash_register_id, auth.uid(), device_row.id, p_guest_count, new_group_id, 1
  );
  insert into public.order_tables (tenant_id, venue_id, order_id, order_group_id, table_id)
  select first_table.tenant_id, first_table.venue_id, new_order_id, new_group_id, value
  from unnest(p_table_ids) selected(value);
  return new_order_id;
end;
$$;

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
  if v_reservation.status = 'seated' and v_reservation.order_id is not null then
    return v_reservation.order_id;
  end if;
  if v_reservation.status not in ('confirmed', 'arrived') then raise exception 'RESERVATION_CANNOT_BE_SEATED'; end if;
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

create or replace function public.complete_reservation_from_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'paid' and old.status = 'open' and not exists (
    select 1 from public.orders sibling
    where sibling.order_group_id = new.order_group_id and sibling.status = 'open'
  ) then
    update public.reservations
    set status = 'completed', completed_at = coalesce(completed_at, now())
    where order_id in (select id from public.orders where order_group_id = new.order_group_id)
      and status = 'seated';
  end if;
  return new;
end;
$$;

drop trigger if exists complete_reservation_after_order on public.orders;
create trigger complete_reservation_after_order
  after update of status on public.orders
  for each row execute function public.complete_reservation_from_order();

alter table public.reservations enable row level security;
alter table public.reservation_tables enable row level security;

drop policy if exists reservations_select on public.reservations;
drop policy if exists reservations_insert on public.reservations;
drop policy if exists reservations_update on public.reservations;
drop policy if exists reservation_tables_select on public.reservation_tables;
drop policy if exists reservation_tables_insert on public.reservation_tables;
drop policy if exists reservation_tables_update on public.reservation_tables;
create policy reservations_select on public.reservations
  for select to authenticated
  using (public.user_has_venue_access(tenant_id, venue_id));
create policy reservations_insert on public.reservations
  for insert to authenticated
  with check (public.user_can_manage_reservations(tenant_id, venue_id));
create policy reservations_update on public.reservations
  for update to authenticated
  using (public.user_can_manage_reservations(tenant_id, venue_id))
  with check (public.user_can_manage_reservations(tenant_id, venue_id));
create policy reservation_tables_select on public.reservation_tables
  for select to authenticated
  using (public.user_has_venue_access(tenant_id, venue_id));
create policy reservation_tables_insert on public.reservation_tables
  for insert to authenticated
  with check (public.user_can_manage_reservations(tenant_id, venue_id));
create policy reservation_tables_update on public.reservation_tables
  for update to authenticated
  using (public.user_can_manage_reservations(tenant_id, venue_id))
  with check (public.user_can_manage_reservations(tenant_id, venue_id));

revoke all on table public.reservations from public, anon;
revoke all on table public.reservation_tables from public, anon;
grant select on table public.reservations to authenticated;
grant select on table public.reservation_tables to authenticated;
revoke all on function public.user_can_manage_reservations(uuid, uuid) from public;
grant execute on function public.user_can_manage_reservations(uuid, uuid) to authenticated;
revoke all on function public.save_reservation(uuid, uuid, text, text, text, integer, timestamptz, timestamptz, text, uuid[], boolean, timestamptz) from public;
grant execute on function public.save_reservation(uuid, uuid, text, text, text, integer, timestamptz, timestamptz, text, uuid[], boolean, timestamptz) to authenticated;
revoke all on function public.search_reservations(uuid, text, integer) from public;
grant execute on function public.search_reservations(uuid, text, integer) to authenticated;
revoke all on function public.change_reservation_status(uuid, text, text) from public;
grant execute on function public.change_reservation_status(uuid, text, text) to authenticated;
revoke all on function public.seat_reservation(uuid, uuid, uuid, uuid[]) from public;
grant execute on function public.seat_reservation(uuid, uuid, uuid, uuid[]) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.reservations;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.reservation_tables;
exception when duplicate_object then null;
end $$;
