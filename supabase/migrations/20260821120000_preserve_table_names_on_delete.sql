-- Preserve the table label in operational history while allowing the live
-- restaurant_tables row to be removed.

alter table public.order_tables
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists table_name text;

alter table public.reservation_tables
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists table_name text;

update public.order_tables history
set table_name = tables.name
from public.restaurant_tables tables
where tables.id = history.table_id
  and history.table_name is null;

update public.reservation_tables history
set table_name = tables.name
from public.restaurant_tables tables
where tables.id = history.table_id
  and history.table_name is null;

alter table public.order_tables
  alter column id set default gen_random_uuid(),
  alter column id set not null,
  alter column table_name set not null;

alter table public.reservation_tables
  alter column id set default gen_random_uuid(),
  alter column id set not null,
  alter column table_name set not null;

alter table public.order_tables drop constraint if exists order_tables_pkey;
alter table public.order_tables drop constraint if exists order_tables_order_table_key;
alter table public.order_tables alter column table_id drop not null;
alter table public.order_tables
  add constraint order_tables_pkey primary key (id),
  add constraint order_tables_order_table_key unique (order_id, table_id);

alter table public.reservation_tables drop constraint if exists reservation_tables_pkey;
alter table public.reservation_tables drop constraint if exists reservation_tables_reservation_table_key;
alter table public.reservation_tables alter column table_id drop not null;
alter table public.reservation_tables
  add constraint reservation_tables_pkey primary key (id),
  add constraint reservation_tables_reservation_table_key unique (reservation_id, table_id);

alter table public.order_tables drop constraint if exists order_tables_table_fk;
alter table public.order_tables
  add constraint order_tables_table_fk
  foreign key (table_id) references public.restaurant_tables(id) on delete set null;

alter table public.reservation_tables drop constraint if exists reservation_tables_table_scope_fk;
alter table public.reservation_tables
  add constraint reservation_tables_table_scope_fk
  foreign key (table_id) references public.restaurant_tables(id) on delete set null;

comment on column public.order_tables.table_id is
  'Optional live table reference. It becomes null when the table is deleted.';
comment on column public.order_tables.table_name is
  'Immutable table-name snapshot used by order history.';
comment on column public.reservation_tables.table_id is
  'Optional live table reference. It becomes null when the table is deleted.';
comment on column public.reservation_tables.table_name is
  'Immutable table-name snapshot used by reservation history.';

create index if not exists order_tables_table_idx
  on public.order_tables (table_id) where table_id is not null;

create or replace function public.snapshot_restaurant_table_reference()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  snapshot_name text;
begin
  -- ON DELETE SET NULL must retain the existing snapshot.
  if new.table_id is null then return new; end if;

  select tables.name into snapshot_name
  from public.restaurant_tables tables
  where tables.id = new.table_id
    and tables.tenant_id = new.tenant_id
    and tables.venue_id = new.venue_id;

  if snapshot_name is null then
    raise exception 'RESTAURANT_TABLE_SCOPE_MISMATCH' using errcode = '23503';
  end if;

  new.table_name := snapshot_name;
  return new;
end;
$$;

drop trigger if exists snapshot_order_table_reference on public.order_tables;
create trigger snapshot_order_table_reference
before insert or update of table_id, tenant_id, venue_id on public.order_tables
for each row execute function public.snapshot_restaurant_table_reference();

drop trigger if exists snapshot_reservation_table_reference on public.reservation_tables;
create trigger snapshot_reservation_table_reference
before insert or update of table_id, tenant_id, venue_id on public.reservation_tables
for each row execute function public.snapshot_restaurant_table_reference();

create or replace function public.delete_restaurant_table(p_table_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_table public.restaurant_tables%rowtype;
begin
  -- save_reservation uses the same advisory key, while opening an order locks
  -- the restaurant_tables row. Together they make the check-and-delete atomic.
  perform pg_advisory_xact_lock(hashtextextended(p_table_id::text, 0));

  select tables.* into selected_table
  from public.restaurant_tables tables
  where tables.id = p_table_id
  for update;

  if selected_table.id is null then return false; end if;
  if not public.user_is_tenant_admin(selected_table.tenant_id) then
    raise exception 'RESTAURANT_TABLE_DELETE_FORBIDDEN' using errcode = '42501';
  end if;
  if selected_table.cash_session_id is not null then
    raise exception 'VIRTUAL_TABLE_DELETE_FORBIDDEN' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.order_tables history
    where history.table_id = p_table_id and history.released_at is null
  ) then
    raise exception 'TABLE_HAS_OPEN_ORDER' using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.reservation_tables assignment
    join public.reservations reservation on reservation.id = assignment.reservation_id
    where assignment.table_id = p_table_id
      and (
        reservation.status in ('arrived', 'seated')
        or (reservation.status = 'confirmed' and reservation.ends_at > now())
      )
  ) then
    raise exception 'TABLE_HAS_ACTIVE_RESERVATION' using errcode = '55000';
  end if;

  delete from public.restaurant_tables tables where tables.id = p_table_id;
  return found;
end;
$$;

-- Deleted tables must still appear by name in reservation JSON and search.
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
        'id', assignment.id,
        'table_id', assignment.table_id,
        'table_name', assignment.table_name,
        'restaurant_tables', case when tables.id is null then null else jsonb_build_object(
          'id', tables.id,
          'name', tables.name,
          'capacity', tables.capacity,
          'area_id', tables.area_id,
          'sort_order', tables.sort_order,
          'is_active', tables.is_active,
          'dining_areas', jsonb_build_object('name', areas.name)
        ) end
      ) order by coalesce(tables.sort_order, 2147483647), assignment.id)
      from public.reservation_tables assignment
      left join public.restaurant_tables tables on tables.id = assignment.table_id
      left join public.dining_areas areas on areas.id = tables.area_id
      where assignment.reservation_id = p_reservation.id
    ), '[]'::jsonb)
  );
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
  select venue.tenant_id, venue.timezone into v_tenant_id, v_time_zone
  from public.venues venue where venue.id = p_venue_id;
  if v_tenant_id is null or not public.user_has_venue_access(v_tenant_id, p_venue_id) then
    raise exception 'RESERVATION_FORBIDDEN' using errcode = '42501';
  end if;
  if v_query = '' then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(public.reservation_to_json(candidate.row_value)
    order by candidate.date_rank, candidate.starts_at), '[]'::jsonb)
  into v_result
  from (
    select reservation row_value, reservation.starts_at,
      case
        when (reservation.starts_at at time zone v_time_zone)::date = (now() at time zone v_time_zone)::date then 0
        when (reservation.starts_at at time zone v_time_zone)::date > (now() at time zone v_time_zone)::date then 1
        else 2
      end date_rank
    from public.reservations reservation
    where reservation.tenant_id = v_tenant_id
      and reservation.venue_id = p_venue_id
      and (
        lower(regexp_replace(btrim(reservation.customer_name), '\s+', ' ', 'g')) like '%' || v_query || '%'
        or (length(v_phone) >= 3 and regexp_replace(reservation.customer_phone, '[^0-9+]', '', 'g') like '%' || v_phone || '%')
        or exists (
          select 1 from public.reservation_tables assignment
          where assignment.reservation_id = reservation.id
            and lower(regexp_replace(btrim(assignment.table_name), '\s+', ' ', 'g')) like '%' || v_query || '%'
        )
      )
    order by date_rank, reservation.starts_at
    limit least(greatest(coalesce(p_limit, 100), 1), 300)
  ) candidate;
  return v_result;
end;
$$;

revoke delete on public.restaurant_tables from authenticated;
revoke all on function public.delete_restaurant_table(uuid) from public;
grant execute on function public.delete_restaurant_table(uuid) to authenticated;
