-- Puntos de caja logicos compartidos por varios dispositivos.
-- Baseline: complete-database.sql + restaurant tables blocks 1 and 2.

begin;

create table if not exists public.cash_registers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  name text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id, venue_id),
  unique (tenant_id, venue_id, name)
);

alter table public.devices add column if not exists device_mode text not null default 'checkout';
alter table public.devices drop constraint if exists devices_device_mode_check;
alter table public.devices add constraint devices_device_mode_check
check (device_mode in ('satellite', 'checkout', 'hybrid'));
alter table public.devices add column if not exists default_cash_register_id uuid;
alter table public.devices add column if not exists can_take_orders boolean not null default true;
alter table public.devices add column if not exists can_take_payments boolean not null default true;
alter table public.devices add column if not exists can_open_cash_session boolean not null default true;
alter table public.devices add column if not exists can_close_cash_session boolean not null default true;
alter table public.devices add column if not exists can_manage_cash boolean not null default true;
alter table public.devices drop constraint if exists devices_satellite_capabilities_check;
alter table public.devices add constraint devices_satellite_capabilities_check check (
  device_mode <> 'satellite'
  or (not can_take_payments and not can_open_cash_session and not can_close_cash_session and not can_manage_cash)
);

insert into public.cash_registers (id, tenant_id, venue_id, name, sort_order)
select d.id, d.tenant_id, d.venue_id, d.name, row_number() over (partition by d.venue_id order by d.created_at)::integer
from public.devices d
on conflict (id) do nothing;

update public.devices d set default_cash_register_id = d.id
where d.default_cash_register_id is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'devices_default_cash_register_fk') then
    alter table public.devices add constraint devices_default_cash_register_fk
    foreign key (default_cash_register_id) references public.cash_registers (id) on delete set null;
  end if;
end $$;

alter table public.cash_sessions add column if not exists cash_register_id uuid;
alter table public.cash_sessions add column if not exists opened_by_device_id uuid;
alter table public.cash_sessions add column if not exists closed_by_device_id uuid;
update public.cash_sessions cs set cash_register_id = cs.device_id where cs.cash_register_id is null;
update public.cash_sessions cs set opened_by_device_id = cs.device_id where cs.opened_by_device_id is null;
alter table public.cash_sessions alter column cash_register_id set not null;
alter table public.cash_sessions alter column opened_by_device_id set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cash_sessions_register_fk') then
    alter table public.cash_sessions add constraint cash_sessions_register_fk
    foreign key (cash_register_id, tenant_id, venue_id)
    references public.cash_registers (id, tenant_id, venue_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cash_sessions_opened_device_fk') then
    alter table public.cash_sessions add constraint cash_sessions_opened_device_fk
    foreign key (opened_by_device_id) references public.devices(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cash_sessions_closed_device_fk') then
    alter table public.cash_sessions add constraint cash_sessions_closed_device_fk
    foreign key (closed_by_device_id) references public.devices(id) on delete restrict;
  end if;
end $$;

drop index if exists public.one_open_cash_session_per_device;
create unique index if not exists one_open_cash_session_per_register
on public.cash_sessions (cash_register_id) where status = 'open';

alter table public.tickets add column if not exists cash_register_id uuid;
alter table public.sales add column if not exists cash_register_id uuid;
alter table public.orders add column if not exists cash_register_id uuid;
update public.tickets t set cash_register_id = cs.cash_register_id from public.cash_sessions cs where cs.id = t.cash_session_id and t.cash_register_id is null;
update public.sales s set cash_register_id = cs.cash_register_id from public.cash_sessions cs where cs.id = s.cash_session_id and s.cash_register_id is null;
update public.orders o set cash_register_id = cs.cash_register_id from public.cash_sessions cs where cs.id = o.cash_session_id and o.cash_register_id is null;
alter table public.tickets alter column cash_register_id set not null;
alter table public.sales alter column cash_register_id set not null;
alter table public.orders alter column cash_register_id set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tickets_cash_register_fk') then
    alter table public.tickets add constraint tickets_cash_register_fk foreign key (cash_register_id) references public.cash_registers(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_cash_register_fk') then
    alter table public.sales add constraint sales_cash_register_fk foreign key (cash_register_id) references public.cash_registers(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_cash_register_fk') then
    alter table public.orders add constraint orders_cash_register_fk foreign key (cash_register_id) references public.cash_registers(id) on delete restrict;
  end if;
end $$;

create or replace function public.validate_device_cash_register()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.default_cash_register_id is not null and not exists (
    select 1 from public.cash_registers cr where cr.id = new.default_cash_register_id
      and cr.tenant_id = new.tenant_id and cr.venue_id = new.venue_id
  ) then raise exception 'La caja predeterminada debe pertenecer al mismo local'; end if;
  return new;
end;
$$;
drop trigger if exists validate_device_cash_register on public.devices;
create trigger validate_device_cash_register before insert or update on public.devices
for each row execute function public.validate_device_cash_register();

create index if not exists cash_sessions_venue_open_register_idx on public.cash_sessions (tenant_id, venue_id, cash_register_id) where status = 'open';
create index if not exists sales_register_created_idx on public.sales (tenant_id, cash_register_id, created_at desc);
create index if not exists tickets_register_created_idx on public.tickets (tenant_id, cash_register_id, created_at desc);
create index if not exists orders_register_open_idx on public.orders (tenant_id, cash_register_id, opened_at) where status = 'open';

alter table public.cash_registers enable row level security;
drop policy if exists "cash_registers_select" on public.cash_registers;
drop policy if exists "cash_registers_admin" on public.cash_registers;
create policy "cash_registers_select" on public.cash_registers for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy "cash_registers_admin" on public.cash_registers for all to authenticated
using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));

create or replace function public.protect_open_cash_register()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.is_active and not new.is_active and exists (
    select 1 from public.cash_sessions cs where cs.cash_register_id = old.id and cs.status = 'open'
  ) then raise exception 'No se puede desactivar un punto de caja abierto'; end if;
  return new;
end;
$$;
drop trigger if exists protect_open_cash_register on public.cash_registers;
create trigger protect_open_cash_register before update on public.cash_registers
for each row execute function public.protect_open_cash_register();

drop policy if exists "cash_sessions_select" on public.cash_sessions;
drop policy if exists "cash_sessions_insert" on public.cash_sessions;
drop policy if exists "cash_sessions_update" on public.cash_sessions;
create policy "cash_sessions_select" on public.cash_sessions for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

drop policy if exists "tickets_select" on public.tickets;
create policy "tickets_select" on public.tickets for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
drop policy if exists "sales_select" on public.sales;
create policy "sales_select" on public.sales for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
drop policy if exists "ticket_lines_select" on public.ticket_lines;
create policy "ticket_lines_select" on public.ticket_lines for select to authenticated using (exists (
  select 1 from public.tickets t where t.id = ticket_lines.ticket_id
    and (public.user_is_tenant_admin(t.tenant_id) or public.user_has_venue_access(t.tenant_id, t.venue_id))
));
drop policy if exists "sale_payments_select" on public.sale_payments;
create policy "sale_payments_select" on public.sale_payments for select to authenticated using (exists (
  select 1 from public.sales s where s.id = sale_payments.sale_id
    and (public.user_is_tenant_admin(s.tenant_id) or public.user_has_venue_access(s.tenant_id, s.venue_id))
));

create or replace function public.open_cash_register_session(
  p_cash_register_id uuid,
  p_opening_float_cents integer,
  p_device_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  register_row public.cash_registers%rowtype;
  device_row public.devices%rowtype;
  new_session_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Autenticacion requerida' using errcode = '42501'; end if;
  if p_opening_float_cents < 0 then raise exception 'Fondo inicial no valido'; end if;
  select cr.* into register_row from public.cash_registers cr where cr.id = p_cash_register_id for update;
  select d.* into device_row from public.devices d where d.id = p_device_id for update;
  if register_row.id is null or not register_row.is_active then raise exception 'Punto de caja no disponible'; end if;
  if device_row.id is null or not device_row.is_active
    or device_row.tenant_id <> register_row.tenant_id or device_row.venue_id <> register_row.venue_id
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id)
    or not device_row.can_open_cash_session then
    raise exception 'El dispositivo no puede abrir esta caja' using errcode = '42501';
  end if;
  if exists (select 1 from public.cash_sessions cs where cs.cash_register_id = register_row.id and cs.status = 'open') then
    raise exception 'Este punto de caja ya esta abierto' using errcode = '23505';
  end if;
  insert into public.cash_sessions (
    id, tenant_id, venue_id, cash_register_id, device_id, opened_by_device_id,
    opened_by, status, opening_float_cents, sync_source
  ) values (
    new_session_id, register_row.tenant_id, register_row.venue_id, register_row.id,
    device_row.id, device_row.id, auth.uid(), 'open', p_opening_float_cents, 'online'
  );
  return new_session_id;
end;
$$;

create or replace function public.close_cash_register_session(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
begin
  select cs.* into session_row from public.cash_sessions cs where cs.id = p_cash_session_id for update;
  select d.* into device_row from public.devices d where d.id = p_device_id;
  if session_row.id is null or session_row.status <> 'open' then raise exception 'Caja no disponible'; end if;
  if device_row.id is null or device_row.tenant_id <> session_row.tenant_id or device_row.venue_id <> session_row.venue_id
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id)
    or not device_row.can_close_cash_session then
    raise exception 'El dispositivo no puede cerrar esta caja' using errcode = '42501';
  end if;
  if exists (select 1 from public.orders o where o.cash_session_id = session_row.id and o.status = 'open') then
    raise exception 'No se puede cerrar la caja mientras existan comandas abiertas';
  end if;
  update public.cash_sessions as cs set
    status = 'closed', closed_at = now(), closed_by = auth.uid(), closed_by_device_id = device_row.id,
    expected_cash_cents = (p_payload ->> 'expectedCashCents')::integer,
    expected_card_cents = (p_payload ->> 'expectedCardCents')::integer,
    expected_invitation_cents = (p_payload ->> 'expectedInvitationCents')::integer,
    expected_other_cents = (p_payload ->> 'expectedOtherCents')::integer,
    counted_cash_cents = (p_payload ->> 'countedCashCents')::integer,
    counted_card_cents = (p_payload ->> 'countedCardCents')::integer,
    counted_invitation_cents = (p_payload ->> 'countedInvitationCents')::integer,
    counted_other_cents = (p_payload ->> 'countedOtherCents')::integer,
    discrepancy_cents = (p_payload ->> 'discrepancyCents')::integer,
    notes = nullif(p_payload ->> 'notes', '')
  where cs.id = session_row.id;
end;
$$;

create or replace function public.validate_transaction_actor_and_cash()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.tenant_id is distinct from old.tenant_id
      or new.cash_session_id is distinct from old.cash_session_id or new.cash_register_id is distinct from old.cash_register_id
      or new.venue_id is distinct from old.venue_id or new.device_id is distinct from old.device_id then
      raise exception 'No se puede cambiar la identidad economica de una transaccion';
    end if;
    return new;
  end if;
  if auth.uid() is not null and new.user_id <> auth.uid() then raise exception 'Usuario de transaccion no valido' using errcode = '42501'; end if;
  select cs.* into session_row from public.cash_sessions cs where cs.id = new.cash_session_id for share;
  select d.* into device_row from public.devices d where d.id = new.device_id;
  if session_row.id is null or session_row.status <> 'open' then raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000'; end if;
  if new.cash_register_id is null then new.cash_register_id := session_row.cash_register_id; end if;
  if session_row.tenant_id <> new.tenant_id or session_row.venue_id <> new.venue_id
    or session_row.cash_register_id <> new.cash_register_id then raise exception 'La venta no coincide con la caja economica'; end if;
  if device_row.id is null or device_row.tenant_id <> new.tenant_id or device_row.venue_id <> new.venue_id
    or not public.user_has_device_access(new.tenant_id, new.venue_id, new.device_id)
    or not device_row.can_take_payments then raise exception 'Dispositivo sin permiso de cobro' using errcode = '42501'; end if;
  return new;
end;
$$;

create or replace function public.set_order_cash_register()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.cash_register_id is null then
    select cs.cash_register_id into new.cash_register_id from public.cash_sessions cs
    where cs.id = new.cash_session_id and cs.status = 'open';
  end if;
  if new.cash_register_id is null then raise exception 'La comanda requiere una caja abierta'; end if;
  return new;
end;
$$;
drop trigger if exists set_order_cash_register on public.orders;
create trigger set_order_cash_register before insert on public.orders
for each row execute function public.set_order_cash_register();

create or replace function public.validate_cash_session_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and new.opened_by <> auth.uid() then raise exception 'Usuario de apertura no valido' using errcode = '42501'; end if;
    if new.status <> 'open' or new.closed_at is not null then raise exception 'Una caja nueva debe estar abierta'; end if;
    return new;
  end if;
  if new.tenant_id is distinct from old.tenant_id or new.venue_id is distinct from old.venue_id
    or new.cash_register_id is distinct from old.cash_register_id or new.opened_by is distinct from old.opened_by
    or new.opened_by_device_id is distinct from old.opened_by_device_id or new.opened_at is distinct from old.opened_at then
    raise exception 'No se puede cambiar la identidad de una sesion de caja';
  end if;
  if old.status = 'closed' and new.status is distinct from old.status then raise exception 'Una caja cerrada no se puede reabrir'; end if;
  if old.status = 'open' and new.status = 'closed' and (new.closed_by is null or new.closed_by_device_id is null or new.closed_at is null) then
    raise exception 'El cierre requiere usuario, dispositivo y fecha';
  end if;
  return new;
end;
$$;

create or replace function public.close_order_and_create_sale(
  p_order_id uuid,
  p_payment_method text,
  p_received_cents integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  total_cents integer;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
begin
  if p_payment_method not in ('cash', 'card', 'invitation', 'other') then raise exception 'Metodo de pago no valido'; end if;
  select o.* into order_row from public.orders o where o.id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id and dua.venue_id = order_row.venue_id and dua.is_active limit 1;
  if session_row.status <> 'open' or actor_device.id is null or not actor_device.can_take_payments then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;
  select coalesce(sum(ol.quantity * ol.unit_price_cents), 0)::integer into total_cents
  from public.order_lines ol where ol.order_id = order_row.id;
  if total_cents <= 0 then raise exception 'No se puede cobrar una comanda vacia'; end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < total_cents then raise exception 'Importe recibido insuficiente'; end if;

  insert into public.tickets (id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, status, subtotal_cents, total_cents, local_created_at)
  values (ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id, order_row.venue_id, actor_device.id, auth.uid(), 'paid', total_cents, total_cents, now());
  insert into public.ticket_lines (id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name, quantity, unit_price_cents, line_total_cents, modifiers)
  select gen_random_uuid(), ol.tenant_id, ticket_id, ol.product_id, ol.variant_id, ol.product_name, ol.variant_name, ol.quantity, ol.unit_price_cents, ol.quantity * ol.unit_price_cents, ol.modifiers
  from public.order_lines ol where ol.order_id = order_row.id;
  insert into public.sales (id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, total_cents, payment_method, local_created_at)
  values (sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id, order_row.venue_id, actor_device.id, auth.uid(), total_cents, p_payment_method, now());
  insert into public.sale_payments (id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents)
  values (payment_id, order_row.tenant_id, sale_id, p_payment_method, total_cents,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - total_cents else 0 end);
  update public.orders as o set status = 'paid', closed_at = now() where o.id = order_row.id;
  update public.order_tables as ot set released_at = now() where ot.order_id = order_row.id and ot.released_at is null;
  return jsonb_build_object('orderId', order_row.id, 'ticketId', ticket_id, 'saleId', sale_id, 'paymentId', payment_id, 'totalCents', total_cents);
end;
$$;

create or replace function public.open_restaurant_order(
  p_table_ids uuid[],
  p_guest_count integer,
  p_cash_session_id uuid,
  p_device_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_table public.restaurant_tables%rowtype;
  new_order_id uuid := gen_random_uuid();
  table_count integer;
  locked_count integer;
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
begin
  if coalesce(array_length(p_table_ids, 1), 0) = 0 or p_guest_count < 1 then raise exception 'Seleccion de mesas no valida'; end if;
  select count(distinct value) into table_count from unnest(p_table_ids) as selected(value);
  if table_count <> array_length(p_table_ids, 1) then raise exception 'Hay mesas duplicadas'; end if;
  select rt.* into first_table from public.restaurant_tables rt where rt.id = p_table_ids[1] for update;
  perform 1 from public.restaurant_tables rt where rt.id = any(p_table_ids) order by rt.id for update;
  select count(*) into locked_count from public.restaurant_tables rt where rt.id = any(p_table_ids)
    and rt.tenant_id = first_table.tenant_id and rt.venue_id = first_table.venue_id and rt.is_active
    and (rt.reserved_until is null or rt.reserved_until <= now());
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
  insert into public.orders (
    id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id, opened_by_device_id, guest_count
  ) values (
    new_order_id, first_table.tenant_id, first_table.venue_id, session_row.id, session_row.cash_register_id, auth.uid(), device_row.id, p_guest_count
  );
  insert into public.order_tables (tenant_id, venue_id, order_id, table_id)
  select first_table.tenant_id, first_table.venue_id, new_order_id, value from unnest(p_table_ids) as selected(value);
  return new_order_id;
end;
$$;

revoke all on function public.open_cash_register_session(uuid, integer, uuid) from public;
revoke all on function public.close_cash_register_session(uuid, uuid, jsonb) from public;
grant execute on function public.open_cash_register_session(uuid, integer, uuid) to authenticated;
grant execute on function public.close_cash_register_session(uuid, uuid, jsonb) to authenticated;
grant select on public.cash_registers to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.cash_registers; exception when duplicate_object then null; end;
end $$;

commit;
