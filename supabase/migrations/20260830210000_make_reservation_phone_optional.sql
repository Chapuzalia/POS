-- A reservation can be created without a phone number. Keep an empty string
-- for backwards compatibility with existing clients and JSON response types.
alter table public.reservations
  drop constraint if exists reservations_customer_phone_check;

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
  select venue.tenant_id into v_tenant_id
  from public.venues venue
  where venue.id = p_venue_id;

  if v_tenant_id is null or not public.user_can_manage_reservations(v_tenant_id, p_venue_id) then
    raise exception 'RESERVATION_FORBIDDEN' using errcode = '42501';
  end if;
  if btrim(coalesce(p_customer_name, '')) = ''
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
  from public.restaurant_tables tables
  where tables.id = any(v_table_ids)
    and tables.tenant_id = v_tenant_id
    and tables.venue_id = p_venue_id
    and tables.is_active;
  if v_table_count <> cardinality(v_table_ids) then
    raise exception 'RESERVATION_TABLE_SCOPE_OR_INACTIVE' using errcode = '22023';
  end if;

  if p_reservation_id is not null then
    select * into v_current
    from public.reservations reservation
    where reservation.id = p_reservation_id
      and reservation.tenant_id = v_tenant_id
      and reservation.venue_id = p_venue_id
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
      or (select coalesce(array_agg(assignment.table_id order by assignment.table_id), '{}'::uuid[])
          from public.reservation_tables assignment
          where assignment.reservation_id = v_current.id)
        <> (select coalesce(array_agg(value order by value), '{}'::uuid[])
            from unnest(v_table_ids) selected(value))
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
    select distinct reservation.id, reservation.customer_name,
      reservation.starts_at, reservation.ends_at,
      assignment.table_id, tables.name table_name
    from public.reservations reservation
    join public.reservation_tables assignment
      on assignment.reservation_id = reservation.id
    join public.restaurant_tables tables on tables.id = assignment.table_id
    where assignment.table_id = any(v_table_ids)
      and reservation.tenant_id = v_tenant_id
      and reservation.venue_id = p_venue_id
      and reservation.id <> coalesce(p_reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and reservation.status in ('confirmed', 'arrived', 'seated')
      and reservation.starts_at < p_ends_at
      and reservation.ends_at > p_starts_at
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
      v_tenant_id, p_venue_id, btrim(p_customer_name), btrim(coalesce(p_customer_phone, '')),
      nullif(btrim(coalesce(p_customer_email, '')), ''), p_party_size,
      p_starts_at, p_ends_at, 'confirmed', nullif(btrim(coalesce(p_notes, '')), '')
    ) returning * into v_reservation;
  else
    update public.reservations
    set customer_name = btrim(p_customer_name),
        customer_phone = btrim(coalesce(p_customer_phone, '')),
        customer_email = nullif(btrim(coalesce(p_customer_email, '')), ''),
        party_size = p_party_size,
        starts_at = p_starts_at,
        ends_at = p_ends_at,
        notes = nullif(btrim(coalesce(p_notes, '')), '')
    where id = p_reservation_id
    returning * into v_reservation;
    delete from public.reservation_tables
    where reservation_id = v_reservation.id;
  end if;

  insert into public.reservation_tables (
    reservation_id, table_id, tenant_id, venue_id
  )
  select v_reservation.id, selected.value, v_tenant_id, p_venue_id
  from unnest(v_table_ids) selected(value);

  select * into v_reservation
  from public.reservations reservation
  where reservation.id = v_reservation.id;
  return jsonb_build_object(
    'reservation', public.reservation_to_json(v_reservation),
    'conflicts', v_conflicts
  );
end;
$$;
