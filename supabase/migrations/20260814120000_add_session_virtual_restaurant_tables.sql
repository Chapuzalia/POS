-- Mesas temporales que existen únicamente durante una sesión de caja.
-- Se conservan desactivadas al cerrar para mantener íntegro el historial de comandas.

alter table public.restaurant_tables
  add column if not exists cash_session_id uuid references public.cash_sessions(id) on delete restrict;

alter table public.restaurant_tables
  alter column area_id drop not null;

alter table public.restaurant_tables
  drop constraint if exists restaurant_tables_area_or_session_check;

alter table public.restaurant_tables
  add constraint restaurant_tables_area_or_session_check
  check (area_id is not null or cash_session_id is not null);

create index if not exists restaurant_tables_virtual_session_idx
  on public.restaurant_tables (cash_session_id, is_active, sort_order)
  where cash_session_id is not null;

create or replace function public.validate_restaurant_table_scope()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.area_id is not null and not exists (
    select 1
    from public.dining_areas da
    where da.id = new.area_id
      and da.tenant_id = new.tenant_id
      and da.venue_id = new.venue_id
  ) then
    raise exception 'La zona de la mesa no pertenece al local' using errcode = '23514';
  end if;

  if new.cash_session_id is not null and not exists (
    select 1
    from public.cash_sessions cs
    where cs.id = new.cash_session_id
      and cs.tenant_id = new.tenant_id
      and cs.venue_id = new.venue_id
  ) then
    raise exception 'La sesión de la mesa virtual no pertenece al local' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_restaurant_table_scope on public.restaurant_tables;
create trigger validate_restaurant_table_scope
before insert or update of tenant_id, venue_id, area_id, cash_session_id
on public.restaurant_tables
for each row execute function public.validate_restaurant_table_scope();

create or replace function public.validate_order_table_virtual_session()
returns trigger
language plpgsql
set search_path to ''
as $$
declare
  table_session_id uuid;
  order_session_id uuid;
begin
  select rt.cash_session_id into table_session_id
  from public.restaurant_tables rt
  where rt.id = new.table_id;

  if table_session_id is null then
    return new;
  end if;

  select o.cash_session_id into order_session_id
  from public.orders o
  where o.id = new.order_id;

  if order_session_id is distinct from table_session_id then
    raise exception 'La mesa virtual pertenece a otra sesión de caja' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_order_table_virtual_session on public.order_tables;
create trigger validate_order_table_virtual_session
before insert or update of order_id, table_id
on public.order_tables
for each row execute function public.validate_order_table_virtual_session();

create or replace function public.validate_compact_joined_table_layout(p_tables jsonb)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  group_key text;
  member_count integer;
  reached_count integer;
begin
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then
    raise exception 'Distribución de mesas no válida';
  end if;

  if exists (
    with entries as (
      select item.key as table_id,
        nullif(item.value ->> 'groupId', '') as group_id,
        coalesce(rt.area_id, rt.cash_session_id) as layout_area_id,
        (item.value ->> 'positionX')::numeric as x,
        (item.value ->> 'positionY')::numeric as y,
        rt.width::numeric as width,
        rt.height::numeric as height
      from jsonb_each(p_tables) item
      join public.restaurant_tables rt on rt.id = item.key::uuid
    )
    select 1
    from entries a
    join entries b on a.table_id < b.table_id
    where a.layout_area_id = b.layout_area_id
      and (a.group_id is not null or b.group_id is not null)
      and least(a.x + a.width, b.x + b.width) - greatest(a.x, b.x) > 0.08
      and least(a.y + a.height, b.y + b.height) - greatest(a.y, b.y) > 0.08
  ) then
    raise exception 'Las mesas juntadas no pueden solaparse con otras mesas';
  end if;

  if exists (
    select 1
    from jsonb_each(p_tables) item
    join public.restaurant_tables rt on rt.id = item.key::uuid
    where nullif(item.value ->> 'groupId', '') is not null
    group by item.value ->> 'groupId'
    having count(distinct coalesce(rt.area_id, rt.cash_session_id)) > 1
  ) then
    raise exception 'No se pueden juntar mesas de zonas distintas';
  end if;

  for group_key in
    select distinct nullif(item.value ->> 'groupId', '')
    from jsonb_each(p_tables) item
    where nullif(item.value ->> 'groupId', '') is not null
  loop
    with recursive members as (
      select item.key as table_id,
        (item.value ->> 'positionX')::numeric as x,
        (item.value ->> 'positionY')::numeric as y,
        rt.width::numeric as width,
        rt.height::numeric as height
      from jsonb_each(p_tables) item
      join public.restaurant_tables rt on rt.id = item.key::uuid
      where item.value ->> 'groupId' = group_key
    ), connected(table_id) as (
      select min(m.table_id) from members m
      union
      select candidate.table_id
      from connected reached
      join members current_member on current_member.table_id = reached.table_id
      join members candidate on candidate.table_id <> current_member.table_id
      where (
        (
          (abs((current_member.x + current_member.width) - candidate.x) <= 0.30
            or abs((candidate.x + candidate.width) - current_member.x) <= 0.30)
          and least(current_member.y + current_member.height, candidate.y + candidate.height)
            - greatest(current_member.y, candidate.y) > 0.20
        ) or (
          (abs((current_member.y + current_member.height) - candidate.y) <= 0.30
            or abs((candidate.y + candidate.height) - current_member.y) <= 0.30)
          and least(current_member.x + current_member.width, candidate.x + candidate.width)
            - greatest(current_member.x, candidate.x) > 0.20
        )
      )
    )
    select (select count(*) from members), (select count(distinct connected.table_id) from connected)
    into member_count, reached_count;

    if member_count < 2 or reached_count <> member_count then
      raise exception 'Las mesas juntadas deben permanecer físicamente pegadas';
    end if;
  end loop;
end;
$$;

create or replace function public.get_cash_session_table_layout(p_cash_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  layout_row public.cash_session_table_layouts%rowtype;
begin
  select cs.* into session_row
  from public.cash_sessions cs
  where cs.id = p_cash_session_id;

  if session_row.id is null or session_row.status <> 'open'
    or not public.user_has_venue_access(session_row.tenant_id, session_row.venue_id) then
    raise exception 'Sesión de caja no disponible' using errcode = '42501';
  end if;

  insert into public.cash_session_table_layouts (
    cash_session_id, tenant_id, venue_id, cash_register_id, tables, updated_by
  )
  select session_row.id, session_row.tenant_id, session_row.venue_id, session_row.cash_register_id,
    coalesce(jsonb_object_agg(
      rt.id::text,
      jsonb_build_object('positionX', rt.position_x, 'positionY', rt.position_y, 'groupId', null)
    ), '{}'::jsonb),
    auth.uid()
  from public.restaurant_tables rt
  where rt.tenant_id = session_row.tenant_id
    and rt.venue_id = session_row.venue_id
    and rt.is_active
    and (rt.cash_session_id is null or rt.cash_session_id = session_row.id)
  on conflict (cash_session_id) do nothing;

  select l.* into layout_row
  from public.cash_session_table_layouts l
  where l.cash_session_id = session_row.id;

  return jsonb_build_object(
    'cashSessionId', layout_row.cash_session_id,
    'revision', layout_row.revision,
    'updatedAt', layout_row.updated_at,
    'tables', layout_row.tables
  );
end;
$$;

create or replace function public.save_cash_session_table_layout(
  p_cash_session_id uuid,
  p_expected_revision bigint,
  p_tables jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  layout_row public.cash_session_table_layouts%rowtype;
  active_count integer;
  supplied_count integer;
begin
  select cs.* into session_row
  from public.cash_sessions cs
  where cs.id = p_cash_session_id
  for update;

  if session_row.id is null or session_row.status <> 'open'
    or not public.user_has_venue_access(session_row.tenant_id, session_row.venue_id) then
    raise exception 'Sesión de caja no disponible' using errcode = '42501';
  end if;

  perform public.get_cash_session_table_layout(p_cash_session_id);
  select l.* into layout_row
  from public.cash_session_table_layouts l
  where l.cash_session_id = p_cash_session_id
  for update;

  if layout_row.revision <> p_expected_revision then
    raise exception 'La distribución ha cambiado en otro dispositivo'
      using errcode = '40001', detail = jsonb_build_object('currentRevision', layout_row.revision)::text;
  end if;
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then
    raise exception 'Distribución no válida';
  end if;

  select count(*) into active_count
  from public.restaurant_tables rt
  where rt.tenant_id = session_row.tenant_id
    and rt.venue_id = session_row.venue_id
    and rt.is_active
    and (rt.cash_session_id is null or rt.cash_session_id = session_row.id);

  select count(*) into supplied_count from jsonb_object_keys(p_tables);
  if supplied_count <> active_count or exists (
    select 1
    from jsonb_object_keys(p_tables) supplied(table_id)
    where not exists (
      select 1
      from public.restaurant_tables rt
      where rt.id = supplied.table_id::uuid
        and rt.tenant_id = session_row.tenant_id
        and rt.venue_id = session_row.venue_id
        and rt.is_active
        and (rt.cash_session_id is null or rt.cash_session_id = session_row.id)
    )
  ) then
    raise exception 'La distribución no contiene exactamente las mesas activas de esta sesión';
  end if;

  if exists (
    select 1
    from jsonb_each(p_tables) item(table_id, value)
    join public.restaurant_tables rt on rt.id = item.table_id::uuid
    where jsonb_typeof(item.value) <> 'object'
      or jsonb_typeof(item.value -> 'positionX') <> 'number'
      or jsonb_typeof(item.value -> 'positionY') <> 'number'
      or (item.value ->> 'positionX')::numeric < 0
      or (item.value ->> 'positionY')::numeric < 0
      or (item.value ->> 'positionX')::numeric > 100 - rt.width
      or (item.value ->> 'positionY')::numeric > 100 - rt.height
  ) then
    raise exception 'Una mesa tiene una posición no válida';
  end if;

  if exists (
    select 1
    from (
      select item.value ->> 'groupId' group_id, count(*) member_count
      from jsonb_each(p_tables) item(table_id, value)
      where nullif(item.value ->> 'groupId', '') is not null
      group by item.value ->> 'groupId'
    ) groups
    where groups.member_count < 2
  ) then
    raise exception 'Los grupos deben contener al menos dos mesas';
  end if;

  if exists (
    select 1
    from jsonb_each(p_tables) item(table_id, value)
    join public.order_tables ot on ot.table_id = item.table_id::uuid and ot.released_at is null
    join public.orders o on o.id = ot.order_id and o.status = 'open'
    where nullif(item.value ->> 'groupId', '') is not null
    group by item.value ->> 'groupId'
    having count(distinct o.id) > 1
  ) then
    raise exception 'No se pueden agrupar mesas con comandas distintas';
  end if;

  update public.cash_session_table_layouts l
  set tables = p_tables,
      revision = l.revision + 1,
      updated_by = auth.uid(),
      updated_at = now()
  where l.cash_session_id = p_cash_session_id
  returning l.* into layout_row;

  return jsonb_build_object(
    'cashSessionId', layout_row.cash_session_id,
    'revision', layout_row.revision,
    'updatedAt', layout_row.updated_at,
    'tables', layout_row.tables
  );
end;
$$;

create or replace function public.create_virtual_restaurant_table(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_area_id uuid,
  p_name text,
  p_capacity integer,
  p_shape text default 'square'
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  virtual_count integer;
  new_table_id uuid := gen_random_uuid();
  next_x numeric(8,3);
  next_y numeric(8,3);
begin
  select cs.* into session_row
  from public.cash_sessions cs
  where cs.id = p_cash_session_id
  for update;

  select d.* into device_row
  from public.devices d
  where d.id = p_device_id;

  if session_row.id is null or session_row.status <> 'open'
    or device_row.id is null or not device_row.can_take_orders
    or not public.user_has_device_access(session_row.tenant_id, session_row.venue_id, device_row.id) then
    raise exception 'La caja o el dispositivo no son válidos' using errcode = '42501';
  end if;

  if p_area_id is not null and not exists (
    select 1
    from public.dining_areas da
    where da.id = p_area_id
      and da.tenant_id = session_row.tenant_id
      and da.venue_id = session_row.venue_id
      and da.is_active
  ) then
    raise exception 'La zona seleccionada no está disponible' using errcode = '23514';
  end if;

  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 80 then
    raise exception 'Indica un nombre de mesa válido' using errcode = '22023';
  end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 99 then
    raise exception 'La capacidad debe estar entre 1 y 99' using errcode = '22023';
  end if;
  if p_shape not in ('square', 'rectangle', 'round') then
    raise exception 'La forma de mesa no es válida' using errcode = '22023';
  end if;

  perform public.get_cash_session_table_layout(session_row.id);

  select count(*) into virtual_count
  from public.restaurant_tables rt
  where rt.cash_session_id = session_row.id
    and rt.area_id is not distinct from p_area_id;

  next_x := 4 + (virtual_count % 6) * 15;
  next_y := 4 + ((virtual_count / 6) % 5) * 17;

  insert into public.restaurant_tables (
    id, tenant_id, venue_id, area_id, cash_session_id, name, capacity, shape,
    position_x, position_y, width, height, sort_order
  ) values (
    new_table_id, session_row.tenant_id, session_row.venue_id, p_area_id, session_row.id,
    btrim(p_name), p_capacity, p_shape, next_x, next_y, 12, 12, virtual_count
  );

  update public.cash_session_table_layouts l
  set tables = l.tables || jsonb_build_object(
        new_table_id::text,
        jsonb_build_object('positionX', next_x, 'positionY', next_y, 'groupId', null)
      ),
      revision = l.revision + 1,
      updated_by = auth.uid(),
      updated_at = now()
  where l.cash_session_id = session_row.id;

  return new_table_id;
end;
$$;

create or replace function public.deactivate_closed_session_virtual_tables()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if old.status = 'open' and new.status <> 'open' then
    update public.restaurant_tables
    set is_active = false
    where cash_session_id = new.id
      and is_active;
  end if;
  return new;
end;
$$;

drop trigger if exists deactivate_closed_session_virtual_tables on public.cash_sessions;
create trigger deactivate_closed_session_virtual_tables
after update of status on public.cash_sessions
for each row execute function public.deactivate_closed_session_virtual_tables();

revoke all on function public.create_virtual_restaurant_table(uuid, uuid, uuid, text, integer, text) from public;
grant execute on function public.create_virtual_restaurant_table(uuid, uuid, uuid, text, integer, text) to authenticated;
