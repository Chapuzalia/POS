-- Distribucion temporal y versionada del mapa de mesas por sesion de caja.
begin;

create table if not exists public.cash_session_table_layouts (
  cash_session_id uuid primary key references public.cash_sessions(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  cash_register_id uuid not null references public.cash_registers(id) on delete cascade,
  tables jsonb not null default '{}'::jsonb check (jsonb_typeof(tables) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cash_session_table_layouts_scope_idx
on public.cash_session_table_layouts (tenant_id, venue_id, cash_register_id, cash_session_id);

alter table public.cash_session_table_layouts enable row level security;
drop policy if exists "cash_session_table_layouts_select" on public.cash_session_table_layouts;
create policy "cash_session_table_layouts_select"
on public.cash_session_table_layouts for select to authenticated
using (public.user_has_venue_access(tenant_id, venue_id));

create or replace function public.get_cash_session_table_layout(p_cash_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare session_row public.cash_sessions%rowtype; layout_row public.cash_session_table_layouts%rowtype;
begin
  select cs.* into session_row from public.cash_sessions cs where cs.id = p_cash_session_id;
  if session_row.id is null or session_row.status <> 'open'
    or not public.user_has_venue_access(session_row.tenant_id, session_row.venue_id) then
    raise exception 'Sesion de caja no disponible' using errcode = '42501';
  end if;

  insert into public.cash_session_table_layouts (cash_session_id, tenant_id, venue_id, cash_register_id, tables, updated_by)
  select session_row.id, session_row.tenant_id, session_row.venue_id, session_row.cash_register_id,
    coalesce(jsonb_object_agg(rt.id::text, jsonb_build_object('positionX', rt.position_x, 'positionY', rt.position_y, 'groupId', null)), '{}'::jsonb), auth.uid()
  from public.restaurant_tables rt
  where rt.tenant_id = session_row.tenant_id and rt.venue_id = session_row.venue_id and rt.is_active
  on conflict (cash_session_id) do nothing;

  select l.* into layout_row from public.cash_session_table_layouts l where l.cash_session_id = session_row.id;
  return jsonb_build_object('cashSessionId', layout_row.cash_session_id, 'revision', layout_row.revision, 'updatedAt', layout_row.updated_at, 'tables', layout_row.tables);
end;
$$;

create or replace function public.save_cash_session_table_layout(
  p_cash_session_id uuid,
  p_expected_revision bigint,
  p_tables jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  session_row public.cash_sessions%rowtype;
  layout_row public.cash_session_table_layouts%rowtype;
  active_count integer;
  supplied_count integer;
begin
  select cs.* into session_row from public.cash_sessions cs where cs.id = p_cash_session_id for update;
  if session_row.id is null or session_row.status <> 'open'
    or not public.user_has_venue_access(session_row.tenant_id, session_row.venue_id) then
    raise exception 'Sesion de caja no disponible' using errcode = '42501';
  end if;
  perform public.get_cash_session_table_layout(p_cash_session_id);
  select l.* into layout_row from public.cash_session_table_layouts l where l.cash_session_id = p_cash_session_id for update;
  if layout_row.revision <> p_expected_revision then
    raise exception 'La distribucion ha cambiado en otro dispositivo' using errcode = '40001', detail = jsonb_build_object('currentRevision', layout_row.revision)::text;
  end if;
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then raise exception 'Distribucion no valida'; end if;

  select count(*) into active_count from public.restaurant_tables rt
  where rt.tenant_id = session_row.tenant_id and rt.venue_id = session_row.venue_id and rt.is_active;
  select count(*) into supplied_count from jsonb_object_keys(p_tables);
  if supplied_count <> active_count or exists (
    select 1 from jsonb_object_keys(p_tables) supplied(table_id)
    where not exists (select 1 from public.restaurant_tables rt where rt.id = supplied.table_id::uuid and rt.tenant_id = session_row.tenant_id and rt.venue_id = session_row.venue_id and rt.is_active)
  ) then raise exception 'La distribucion no contiene exactamente las mesas activas del local'; end if;

  if exists (
    select 1 from jsonb_each(p_tables) item(table_id, value)
    join public.restaurant_tables rt on rt.id = item.table_id::uuid
    where jsonb_typeof(item.value) <> 'object'
      or jsonb_typeof(item.value -> 'positionX') <> 'number'
      or jsonb_typeof(item.value -> 'positionY') <> 'number'
      or (item.value ->> 'positionX')::numeric < 0 or (item.value ->> 'positionY')::numeric < 0
      or (item.value ->> 'positionX')::numeric > 100 - rt.width
      or (item.value ->> 'positionY')::numeric > 100 - rt.height
  ) then raise exception 'Una mesa tiene una posicion no valida'; end if;

  if exists (
    select 1 from (
      select item.value ->> 'groupId' group_id, count(*) member_count
      from jsonb_each(p_tables) item(table_id, value)
      where nullif(item.value ->> 'groupId', '') is not null
      group by item.value ->> 'groupId'
    ) groups where groups.member_count < 2
  ) then raise exception 'Los grupos deben contener al menos dos mesas'; end if;

  if exists (
    select 1
    from jsonb_each(p_tables) item(table_id, value)
    join public.order_tables ot on ot.table_id = item.table_id::uuid and ot.released_at is null
    join public.orders o on o.id = ot.order_id and o.status = 'open'
    where nullif(item.value ->> 'groupId', '') is not null
    group by item.value ->> 'groupId'
    having count(distinct o.id) > 1
  ) then raise exception 'No se pueden agrupar mesas con comandas distintas'; end if;

  update public.cash_session_table_layouts l
  set tables = p_tables, revision = l.revision + 1, updated_by = auth.uid(), updated_at = now()
  where l.cash_session_id = p_cash_session_id returning l.* into layout_row;
  return jsonb_build_object('cashSessionId', layout_row.cash_session_id, 'revision', layout_row.revision, 'updatedAt', layout_row.updated_at, 'tables', layout_row.tables);
end;
$$;

create or replace function public.clear_closed_cash_session_table_layout()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'open' and new.status <> 'open' then delete from public.cash_session_table_layouts where cash_session_id = new.id; end if;
  return new;
end;
$$;
drop trigger if exists clear_closed_cash_session_table_layout on public.cash_sessions;
create trigger clear_closed_cash_session_table_layout after update of status on public.cash_sessions
for each row execute function public.clear_closed_cash_session_table_layout();

revoke all on function public.get_cash_session_table_layout(uuid) from public;
revoke all on function public.save_cash_session_table_layout(uuid, bigint, jsonb) from public;
revoke all on function public.clear_closed_cash_session_table_layout() from public;
grant execute on function public.get_cash_session_table_layout(uuid) to authenticated;
grant execute on function public.save_cash_session_table_layout(uuid, bigint, jsonb) to authenticated;
grant select on public.cash_session_table_layouts to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.cash_session_table_layouts; exception when duplicate_object then null; end;
end $$;

commit;
