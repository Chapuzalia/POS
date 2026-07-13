-- Los puntos de caja se generan exclusivamente desde dispositivos activos en
-- modo Caja o Hibrido que tengan un usuario cashier activo asignado.
-- No se permite crear puntos de caja manuales.
-- Baseline: logical-cash-registers-migration.sql.

begin;

-- Sustituye la politica ALL anterior: los clientes solo pueden consultar los
-- puntos. Las funciones SECURITY DEFINER son las unicas que los modifican.
drop policy if exists "cash_registers_admin" on public.cash_registers;
drop policy if exists "cash_registers_admin_insert" on public.cash_registers;
drop policy if exists "cash_registers_admin_update" on public.cash_registers;
drop policy if exists "cash_registers_admin_delete" on public.cash_registers;

drop trigger if exists sync_legacy_cash_register_device_mode on public.devices;
drop function if exists public.sync_legacy_cash_register_device_mode();
drop trigger if exists create_device_cash_register on public.devices;
drop trigger if exists update_device_cash_register on public.devices;
drop trigger if exists sync_assignment_cash_register on public.device_user_assignments;
drop trigger if exists sync_membership_cash_register on public.tenant_memberships;
drop trigger if exists disable_satellite_register_after_close on public.cash_sessions;
drop function if exists public.disable_satellite_register_after_close();
drop trigger if exists reconcile_cash_register_after_close on public.cash_sessions;

create or replace function public.reconcile_device_cash_register(target_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  device_row public.devices%rowtype;
  has_active_cashier boolean := false;
  is_cash_point boolean := false;
  next_sort_order integer;
begin
  select d.*
  into device_row
  from public.devices d
  where d.id = target_device_id;

  if not found then
    update public.cash_registers cr
    set is_active = false,
        updated_at = now()
    where cr.id = target_device_id
      and cr.is_active = true
      and not exists (
        select 1 from public.cash_sessions cs
        where cs.cash_register_id = cr.id and cs.status = 'open'
      );
    return;
  end if;

  select exists (
    select 1
    from public.device_user_assignments dua
    join public.tenant_memberships tm
      on tm.tenant_id = dua.tenant_id
     and tm.user_id = dua.user_id
    where dua.device_id = device_row.id
      and dua.tenant_id = device_row.tenant_id
      and dua.venue_id = device_row.venue_id
      and dua.is_active = true
      and tm.is_active = true
      and tm.role = 'cashier'
  )
  into has_active_cashier;

  is_cash_point := (
    device_row.is_active = true
    and device_row.device_mode in ('checkout', 'hybrid')
    and device_row.can_open_cash_session = true
    and has_active_cashier
  );

  if is_cash_point then
    -- Un punto manual antiguo podria conservar el mismo nombre. Se archiva
    -- antes de crear el punto vinculado al dispositivo real.
    update public.cash_registers cr
    set name = cr.name || ' (archivado ' || left(cr.id::text, 8) || ')',
        updated_at = now()
    where cr.id <> device_row.id
      and cr.tenant_id = device_row.tenant_id
      and cr.venue_id = device_row.venue_id
      and cr.name = device_row.name;

    select coalesce(max(cr.sort_order), 0) + 1
    into next_sort_order
    from public.cash_registers cr
    where cr.tenant_id = device_row.tenant_id
      and cr.venue_id = device_row.venue_id;

    insert into public.cash_registers (
      id,
      tenant_id,
      venue_id,
      name,
      is_active,
      sort_order
    ) values (
      device_row.id,
      device_row.tenant_id,
      device_row.venue_id,
      device_row.name,
      true,
      next_sort_order
    )
    on conflict (id) do update
    set name = excluded.name,
        is_active = true,
        updated_at = now();

    update public.devices
    set default_cash_register_id = device_row.id
    where id = device_row.id
      and default_cash_register_id is distinct from device_row.id;
  else
    update public.devices
    set default_cash_register_id = null
    where id = device_row.id
      and default_cash_register_id is not null;

    -- Si esta abierta se conserva hasta su cierre; el trigger de cash_sessions
    -- volvera a ejecutar esta funcion en ese momento.
    update public.cash_registers cr
    set is_active = false,
        updated_at = now()
    where cr.id = device_row.id
      and cr.is_active = true
      and not exists (
        select 1 from public.cash_sessions cs
        where cs.cash_register_id = cr.id and cs.status = 'open'
      );
  end if;
end;
$$;

revoke all on function public.reconcile_device_cash_register(uuid) from public;

create or replace function public.sync_device_cash_register()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.reconcile_device_cash_register(new.id);
  return new;
end;
$$;

create trigger create_device_cash_register
after insert on public.devices
for each row execute function public.sync_device_cash_register();

create trigger update_device_cash_register
after update of name, device_mode, is_active, can_open_cash_session on public.devices
for each row execute function public.sync_device_cash_register();

revoke all on function public.sync_device_cash_register() from public;

create or replace function public.sync_assignment_cash_register()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.reconcile_device_cash_register(new.device_id);
    return new;
  elsif tg_op = 'DELETE' then
    perform public.reconcile_device_cash_register(old.device_id);
    return old;
  end if;

  perform public.reconcile_device_cash_register(old.device_id);
  if new.device_id is distinct from old.device_id then
    perform public.reconcile_device_cash_register(new.device_id);
  end if;

  return new;
end;
$$;

create trigger sync_assignment_cash_register
after insert or update of device_id, user_id, is_active or delete
on public.device_user_assignments
for each row execute function public.sync_assignment_cash_register();

revoke all on function public.sync_assignment_cash_register() from public;

create or replace function public.sync_membership_cash_register()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  assigned_device_id uuid;
begin
  if tg_op <> 'INSERT' then
    for assigned_device_id in
      select dua.device_id
      from public.device_user_assignments dua
      where dua.tenant_id = old.tenant_id
        and dua.user_id = old.user_id
    loop
      perform public.reconcile_device_cash_register(assigned_device_id);
    end loop;
  end if;

  if tg_op <> 'DELETE' then
    for assigned_device_id in
      select dua.device_id
      from public.device_user_assignments dua
      where dua.tenant_id = new.tenant_id
        and dua.user_id = new.user_id
    loop
      perform public.reconcile_device_cash_register(assigned_device_id);
    end loop;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger sync_membership_cash_register
after insert or update of role, is_active or delete
on public.tenant_memberships
for each row execute function public.sync_membership_cash_register();

revoke all on function public.sync_membership_cash_register() from public;

create or replace function public.reconcile_cash_register_after_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'open' and new.status = 'closed' then
    perform public.reconcile_device_cash_register(new.cash_register_id);
  end if;
  return new;
end;
$$;

create trigger reconcile_cash_register_after_close
after update of status on public.cash_sessions
for each row execute function public.reconcile_cash_register_after_close();

revoke all on function public.reconcile_cash_register_after_close() from public;

-- Ajusta todos los datos existentes a la nueva regla.
do $$
declare
  current_device_id uuid;
begin
  for current_device_id in select d.id from public.devices d
  loop
    perform public.reconcile_device_cash_register(current_device_id);
  end loop;
end;
$$;

-- Desactiva los puntos manuales que no corresponden a ningun dispositivo. Los
-- que esten abiertos se desactivaran al cerrar su sesion actual.
update public.cash_registers cr
set is_active = false,
    updated_at = now()
where cr.is_active = true
  and not exists (select 1 from public.devices d where d.id = cr.id)
  and not exists (
    select 1 from public.cash_sessions cs
    where cs.cash_register_id = cr.id and cs.status = 'open'
  );

commit;
