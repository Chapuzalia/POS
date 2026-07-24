-- A deleted device must disappear from administration while its economic and
-- restaurant history remains available without a dangling terminal reference.

alter table public.cash_sessions
  alter column device_id drop not null,
  alter column opened_by_device_id drop not null;

alter table public.orders
  alter column opened_by_device_id drop not null;

alter table public.sales
  alter column device_id drop not null;

alter table public.tickets
  alter column device_id drop not null;

alter table public.cash_sessions
  drop constraint cash_sessions_closed_device_fk,
  drop constraint cash_sessions_device_id_fkey,
  drop constraint cash_sessions_opened_device_fk,
  add constraint cash_sessions_closed_device_fk
    foreign key (closed_by_device_id) references public.devices(id) on delete set null,
  add constraint cash_sessions_device_id_fkey
    foreign key (device_id) references public.devices(id) on delete set null,
  add constraint cash_sessions_opened_device_fk
    foreign key (opened_by_device_id) references public.devices(id) on delete set null;

alter table public.orders
  drop constraint orders_opened_by_device_id_fkey,
  add constraint orders_opened_by_device_id_fkey
    foreign key (opened_by_device_id) references public.devices(id) on delete set null;

alter table public.sales
  drop constraint sales_device_id_fkey,
  add constraint sales_device_id_fkey
    foreign key (device_id) references public.devices(id) on delete set null;

alter table public.tickets
  drop constraint tickets_device_id_fkey,
  add constraint tickets_device_id_fkey
    foreign key (device_id) references public.devices(id) on delete set null;

create or replace function public.validate_cash_session_write()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and new.opened_by <> auth.uid() then
      raise exception 'Usuario de apertura no valido' using errcode = '42501';
    end if;
    if new.status <> 'open' or new.closed_at is not null then
      raise exception 'Una caja nueva debe estar abierta';
    end if;
    return new;
  end if;

  if new.tenant_id is distinct from old.tenant_id
    or new.venue_id is distinct from old.venue_id
    or new.cash_register_id is distinct from old.cash_register_id
    or new.opened_by is distinct from old.opened_by
    or new.opened_at is distinct from old.opened_at then
    raise exception 'No se puede cambiar la identidad de una sesion de caja';
  end if;

  -- ON DELETE SET NULL is the only valid identity change.
  if new.opened_by_device_id is distinct from old.opened_by_device_id
    and not (
      new.opened_by_device_id is null
      and not exists (
        select 1 from public.devices d where d.id = old.opened_by_device_id
      )
    ) then
    raise exception 'No se puede cambiar la identidad de una sesion de caja';
  end if;

  if old.status = 'closed' and new.status is distinct from old.status then
    raise exception 'Una caja cerrada no se puede reabrir';
  end if;
  if old.status = 'open'
    and new.status = 'closed'
    and (new.closed_by is null or new.closed_by_device_id is null or new.closed_at is null) then
    raise exception 'El cierre requiere usuario, dispositivo y fecha';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_device_delete_with_open_work()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if not exists (select 1 from public.tenants t where t.id = old.tenant_id) then
    return old;
  end if;

  if exists (
    select 1
    from public.cash_sessions cs
    where cs.tenant_id = old.tenant_id
      and cs.status = 'open'
      and (
        cs.device_id = old.id
        or cs.opened_by_device_id = old.id
        or cs.cash_register_id = old.id
      )
  ) or exists (
    select 1
    from public.orders o
    where o.tenant_id = old.tenant_id
      and o.status = 'open'
      and (
        o.opened_by_device_id = old.id
        or o.cash_register_id = old.id
      )
  ) then
    raise exception 'Cierra la caja y las comandas abiertas de este dispositivo antes de eliminarlo'
      using errcode = 'P0001';
  end if;

  return old;
end;
$$;

drop trigger if exists prevent_device_delete_with_open_work on public.devices;
create trigger prevent_device_delete_with_open_work
before delete on public.devices
for each row execute function public.prevent_device_delete_with_open_work();

create or replace function public.validate_transaction_actor_and_cash()
returns trigger
language plpgsql
set search_path to ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id
      or new.tenant_id is distinct from old.tenant_id
      or new.cash_session_id is distinct from old.cash_session_id
      or new.cash_register_id is distinct from old.cash_register_id
      or new.venue_id is distinct from old.venue_id
      or (
        new.device_id is distinct from old.device_id
        and not (
          new.device_id is null
          and not exists (
            select 1 from public.devices d where d.id = old.device_id
          )
        )
      ) then
      raise exception 'No se puede cambiar la identidad economica de una transaccion';
    end if;
    return new;
  end if;

  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'Usuario de transaccion no valido' using errcode = '42501';
  end if;

  select cs.* into session_row
  from public.cash_sessions cs
  where cs.id = new.cash_session_id
  for share;

  select d.* into device_row
  from public.devices d
  where d.id = new.device_id;

  if session_row.id is null or session_row.status <> 'open' then
    raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000';
  end if;
  if new.cash_register_id is null then
    new.cash_register_id := session_row.cash_register_id;
  end if;
  if session_row.tenant_id <> new.tenant_id
    or session_row.venue_id <> new.venue_id
    or session_row.cash_register_id <> new.cash_register_id then
    raise exception 'La venta no coincide con la caja economica';
  end if;
  if device_row.id is null
    or device_row.tenant_id <> new.tenant_id
    or device_row.venue_id <> new.venue_id
    or not public.user_has_device_access(new.tenant_id, new.venue_id, new.device_id)
    or not device_row.can_take_payments then
    raise exception 'Dispositivo sin permiso de cobro' using errcode = '42501';
  end if;
  return new;
end;
$$;
