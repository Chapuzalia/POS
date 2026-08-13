alter table public.devices
  add column if not exists active_cash_session_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'devices_active_cash_session_id_fkey'
      and conrelid = 'public.devices'::regclass
  ) then
    alter table public.devices
      add constraint devices_active_cash_session_id_fkey
      foreign key (active_cash_session_id)
      references public.cash_sessions(id)
      on delete set null;
  end if;
end $$;

create index if not exists devices_active_cash_session_idx
  on public.devices(active_cash_session_id)
  where active_cash_session_id is not null;

update public.devices device
set active_cash_session_id = (
  select session.id
  from public.cash_sessions session
  where session.opened_by_device_id = device.id
    and session.tenant_id = device.tenant_id
    and session.venue_id = device.venue_id
    and session.status = 'open'
  order by session.opened_at desc
  limit 1
)
where device.active_cash_session_id is null
  and exists (
    select 1
    from public.cash_sessions session
    where session.opened_by_device_id = device.id
      and session.tenant_id = device.tenant_id
      and session.venue_id = device.venue_id
      and session.status = 'open'
  );

create or replace function public.validate_device_cash_register()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.default_cash_register_id is not null and not exists (
    select 1
    from public.cash_registers register
    where register.id = new.default_cash_register_id
      and register.tenant_id = new.tenant_id
      and register.venue_id = new.venue_id
  ) then
    raise exception 'La caja predeterminada debe pertenecer al mismo local';
  end if;

  if new.active_cash_session_id is not null and not exists (
    select 1
    from public.cash_sessions session
    where session.id = new.active_cash_session_id
      and session.tenant_id = new.tenant_id
      and session.venue_id = new.venue_id
      and session.status = 'open'
  ) then
    raise exception 'La sesion de caja seleccionada debe estar abierta y pertenecer al mismo local';
  end if;

  return new;
end;
$$;

create or replace function public.select_device_cash_session(
  p_cash_session_id uuid,
  p_device_id uuid
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Autenticacion requerida' using errcode = '42501';
  end if;

  select session.*
  into session_row
  from public.cash_sessions session
  where session.id = p_cash_session_id
  for update;

  select device.*
  into device_row
  from public.devices device
  where device.id = p_device_id
  for update;

  if session_row.id is null or session_row.status <> 'open' then
    raise exception 'Caja no disponible';
  end if;

  if device_row.id is null
    or not device_row.is_active
    or device_row.tenant_id <> session_row.tenant_id
    or device_row.venue_id <> session_row.venue_id
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id) then
    raise exception 'El dispositivo no puede usar esta caja' using errcode = '42501';
  end if;

  update public.devices
  set active_cash_session_id = session_row.id
  where id = device_row.id;

  return true;
end;
$$;

revoke all on function public.select_device_cash_session(uuid, uuid) from public, anon;
grant execute on function public.select_device_cash_session(uuid, uuid) to authenticated;

create or replace function public.clear_closed_cash_session_device_selections()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if old.status = 'open' and new.status <> 'open' then
    update public.devices
    set active_cash_session_id = null
    where active_cash_session_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_closed_cash_session_device_selections on public.cash_sessions;
create trigger clear_closed_cash_session_device_selections
after update of status on public.cash_sessions
for each row execute function public.clear_closed_cash_session_device_selections();

create or replace function public.open_cash_register_session(
  p_cash_register_id uuid,
  p_opening_float_cents integer,
  p_device_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  register_row public.cash_registers%rowtype;
  device_row public.devices%rowtype;
  new_session_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Autenticacion requerida' using errcode = '42501'; end if;
  if p_opening_float_cents < 0 then raise exception 'Fondo inicial no valido'; end if;
  select register.* into register_row from public.cash_registers register where register.id = p_cash_register_id for update;
  select device.* into device_row from public.devices device where device.id = p_device_id for update;
  if register_row.id is null or not register_row.is_active then raise exception 'Punto de caja no disponible'; end if;
  if device_row.id is null or not device_row.is_active
    or device_row.tenant_id <> register_row.tenant_id or device_row.venue_id <> register_row.venue_id
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id)
    or not device_row.can_open_cash_session then
    raise exception 'El dispositivo no puede abrir esta caja' using errcode = '42501';
  end if;
  if exists (select 1 from public.cash_sessions session where session.cash_register_id = register_row.id and session.status = 'open') then
    raise exception 'Este punto de caja ya esta abierto' using errcode = '23505';
  end if;
  insert into public.cash_sessions (
    id, tenant_id, venue_id, cash_register_id, device_id, opened_by_device_id,
    opened_by, status, opening_float_cents, sync_source
  ) values (
    new_session_id, register_row.tenant_id, register_row.venue_id, register_row.id,
    device_row.id, device_row.id, auth.uid(), 'open', p_opening_float_cents, 'online'
  );
  update public.devices
  set active_cash_session_id = new_session_id
  where id = device_row.id;
  return new_session_id;
end;
$$;
