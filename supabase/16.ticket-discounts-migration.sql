-- Separa los descuentos de los metodos de pago y conserva un snapshot en cada ticket.
-- Los valores fijos configurados se guardan en euros (numeric); la aplicacion usa centimos.
-- Los metodos invitation/other se conservan solo para poder leer el historico existente.

begin;

create table if not exists public.discounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  type text not null check (type in ('percentage', 'fixed')),
  value numeric(12, 2) not null check (value > 0 and (type <> 'percentage' or value <= 100)),
  color text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists discounts_tenant_venue_order_idx
on public.discounts (tenant_id, venue_id, sort_order, name);

alter table public.venues
add column if not exists manual_discount_enabled boolean not null default false;

alter table public.tickets
  add column if not exists discount_id uuid references public.discounts(id) on delete set null,
  add column if not exists discount_name text,
  add column if not exists discount_type text,
  add column if not exists discount_value_type text,
  add column if not exists discount_value numeric(12, 2),
  add column if not exists discount_amount_cents integer;

alter table public.tickets drop constraint if exists tickets_discount_type_check;
alter table public.tickets add constraint tickets_discount_type_check
check (discount_type is null or discount_type in ('percentage', 'fixed', 'manual'));
alter table public.tickets drop constraint if exists tickets_discount_value_type_check;
alter table public.tickets add constraint tickets_discount_value_type_check
check (discount_value_type is null or discount_value_type in ('percentage', 'fixed'));
alter table public.tickets drop constraint if exists tickets_discount_amount_cents_check;
alter table public.tickets add constraint tickets_discount_amount_cents_check
check (discount_amount_cents is null or discount_amount_cents >= 0);
alter table public.tickets drop constraint if exists tickets_discount_snapshot_check;
alter table public.tickets add constraint tickets_discount_snapshot_check check (
  (discount_type is null and discount_name is null and discount_value_type is null
    and discount_value is null and discount_amount_cents is null)
  or
  (discount_type is not null and nullif(btrim(discount_name), '') is not null
    and discount_value_type is not null and discount_value is not null
    and discount_value > 0 and discount_amount_cents is not null
    and discount_amount_cents <= subtotal_cents
    and total_cents = subtotal_cents - discount_amount_cents)
);

-- NOT VALID evita escanear o reescribir filas historicas invitation/other,
-- pero PostgreSQL aplica estas reglas a cualquier alta o modificacion nueva.
alter table public.sales alter column payment_method drop not null;
alter table public.sales drop constraint if exists sales_payment_method_check;
alter table public.sales add constraint sales_payment_method_check
check (payment_method is null or payment_method in ('cash', 'card')) not valid;

alter table public.sale_payments drop constraint if exists sale_payments_method_check;
alter table public.sale_payments add constraint sale_payments_method_check
check (method in ('cash', 'card')) not valid;

create or replace function public.validate_discount_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.venues v
    where v.id = new.venue_id and v.tenant_id = new.tenant_id
  ) then
    raise exception 'El descuento no coincide con el negocio y el local';
  end if;
  new.name := btrim(new.name);
  return new;
end;
$$;

drop trigger if exists validate_discount_scope on public.discounts;
create trigger validate_discount_scope
before insert or update on public.discounts
for each row execute function public.validate_discount_scope();

drop trigger if exists set_discounts_updated_at on public.discounts;
create trigger set_discounts_updated_at
before update on public.discounts
for each row execute function public.set_updated_at();

alter table public.discounts enable row level security;
drop policy if exists discounts_select on public.discounts;
drop policy if exists discounts_admin_manage on public.discounts;
create policy discounts_select on public.discounts for select to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or (is_active and public.user_has_venue_access(tenant_id, venue_id))
);
create policy discounts_admin_manage on public.discounts for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

create or replace function public.resolve_ticket_discount(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_subtotal_cents integer,
  p_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  configured public.discounts%rowtype;
  snapshot_type text;
  calculation_type text;
  snapshot_name text;
  configured_value numeric(12, 2);
  fixed_value_cents integer;
  amount_cents integer;
begin
  if p_subtotal_cents < 0 then
    raise exception 'Subtotal no valido';
  end if;
  if p_discount is null or jsonb_typeof(p_discount) = 'null' then
    return jsonb_build_object('amountCents', 0, 'totalCents', p_subtotal_cents);
  end if;

  if nullif(p_discount ->> 'discountId', '') is not null then
    select d.* into configured
    from public.discounts d
    where d.id = (p_discount ->> 'discountId')::uuid
      and d.tenant_id = p_tenant_id
      and d.venue_id = p_venue_id
      and d.is_active;
    if configured.id is null then
      raise exception 'El descuento no existe, esta inactivo o pertenece a otro local' using errcode = '42501';
    end if;
    snapshot_type := configured.type;
    calculation_type := configured.type;
    snapshot_name := configured.name;
    configured_value := configured.value;
    fixed_value_cents := case when configured.type = 'fixed' then round(configured.value * 100)::integer else null end;
  else
    if coalesce((select v.manual_discount_enabled from public.venues v
      where v.id = p_venue_id and v.tenant_id = p_tenant_id), false) is false then
      raise exception 'El descuento manual esta deshabilitado' using errcode = '42501';
    end if;
    snapshot_type := 'manual';
    calculation_type := p_discount ->> 'calculationType';
    snapshot_name := 'Descuento manual';
    if calculation_type = 'percentage' then
      configured_value := (p_discount ->> 'value')::numeric;
    elsif calculation_type = 'fixed' then
      fixed_value_cents := (p_discount ->> 'value')::integer;
      configured_value := fixed_value_cents::numeric / 100;
    else
      raise exception 'Tipo de descuento manual no valido';
    end if;
  end if;

  if calculation_type = 'percentage' then
    if configured_value <= 0 or configured_value > 100 then
      raise exception 'El porcentaje debe estar entre 0 y 100';
    end if;
    amount_cents := round(p_subtotal_cents * configured_value / 100)::integer;
  else
    if fixed_value_cents is null then
      fixed_value_cents := round(configured_value * 100)::integer;
    end if;
    if fixed_value_cents <= 0 then raise exception 'El importe fijo debe ser mayor que cero'; end if;
    amount_cents := fixed_value_cents;
  end if;

  amount_cents := least(p_subtotal_cents, amount_cents);
  return jsonb_build_object(
    'discountId', configured.id,
    'name', snapshot_name,
    'type', snapshot_type,
    'calculationType', calculation_type,
    'value', case when calculation_type = 'fixed' then fixed_value_cents else configured_value end,
    'storedValue', configured_value,
    'amountCents', amount_cents,
    'totalCents', p_subtotal_cents - amount_cents
  );
end;
$$;

create or replace function public.sync_sale_created_v2(p_event_id uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  ticket_payload jsonb := p_payload -> 'ticket';
  sale_payload jsonb := p_payload -> 'sale';
  payment_payload jsonb := p_payload -> 'payment';
  tenant_id_value uuid := (ticket_payload ->> 'tenantId')::uuid;
  ticket_id_value uuid := (ticket_payload ->> 'id')::uuid;
  sale_id_value uuid := (sale_payload ->> 'id')::uuid;
  cash_session_id_value uuid := (ticket_payload ->> 'cashSessionId')::uuid;
  cash_register_id_value uuid := nullif(ticket_payload ->> 'cashRegisterId', '')::uuid;
  venue_id_value uuid := (ticket_payload ->> 'venueId')::uuid;
  device_id_value uuid := (ticket_payload ->> 'deviceId')::uuid;
  payment_method_value text := nullif(sale_payload ->> 'paymentMethod', '');
  subtotal_cents_value integer;
  total_cents_value integer;
  discount_result jsonb;
  line_count integer;
  lines_total bigint;
  lines_are_valid boolean;
  received_cents_value integer;
  change_cents_value integer;
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  logged_event_id uuid;
begin
  if current_user_id is null then raise exception 'Se requiere un usuario autenticado' using errcode = '42501'; end if;
  if p_event_id is null or jsonb_typeof(p_payload -> 'lines') is distinct from 'array' then
    raise exception 'El evento de venta no tiene un formato valido';
  end if;
  if (ticket_payload ->> 'userId')::uuid <> current_user_id
    or (sale_payload ->> 'userId')::uuid <> current_user_id then
    raise exception 'El userId enviado no coincide con auth.uid()' using errcode = '42501';
  end if;
  if not public.user_has_tenant_access(tenant_id_value) then
    raise exception 'El usuario no tiene acceso al negocio' using errcode = '42501';
  end if;
  if (sale_payload ->> 'tenantId')::uuid <> tenant_id_value
    or (sale_payload ->> 'ticketId')::uuid <> ticket_id_value
    or (sale_payload ->> 'cashSessionId')::uuid <> cash_session_id_value
    or (sale_payload ->> 'venueId')::uuid <> venue_id_value
    or (sale_payload ->> 'deviceId')::uuid <> device_id_value then
    raise exception 'Los datos relacionados de la venta no coinciden';
  end if;
  if exists (select 1 from public.offline_event_log where tenant_id = tenant_id_value and client_event_id = p_event_id) then return; end if;

  select count(*), coalesce(sum((line ->> 'lineTotalCents')::bigint), 0), coalesce(bool_and(
    (line ->> 'tenantId')::uuid = tenant_id_value
    and (line ->> 'ticketId')::uuid = ticket_id_value
    and (line ->> 'quantity')::integer > 0
    and (line ->> 'unitPriceCents')::bigint >= 0
    and (line ->> 'lineTotalCents')::bigint = (line ->> 'unitPriceCents')::bigint * (line ->> 'quantity')::integer
  ), false)
  into line_count, lines_total, lines_are_valid
  from jsonb_array_elements(p_payload -> 'lines') as line;
  if line_count = 0 or not lines_are_valid then raise exception 'Las lineas de la venta no son validas'; end if;

  subtotal_cents_value := lines_total::integer;
  discount_result := public.resolve_ticket_discount(tenant_id_value, venue_id_value, subtotal_cents_value, ticket_payload -> 'discount');
  total_cents_value := (discount_result ->> 'totalCents')::integer;
  if (ticket_payload ->> 'subtotalCents')::integer <> subtotal_cents_value
    or (ticket_payload ->> 'discountAmountCents')::integer <> (discount_result ->> 'amountCents')::integer
    or (ticket_payload ->> 'totalCents')::integer <> total_cents_value
    or (sale_payload ->> 'totalCents')::integer <> total_cents_value then
    raise exception 'Los totales enviados no coinciden con el calculo del servidor';
  end if;

  if total_cents_value = 0 then
    if payment_method_value is not null or (payment_payload is not null and jsonb_typeof(payment_payload) <> 'null') then
      raise exception 'Un ticket a cero no requiere metodo de pago';
    end if;
  else
    if payment_method_value not in ('cash', 'card') or jsonb_typeof(payment_payload) <> 'object' then
      raise exception 'Metodo de pago no valido';
    end if;
    if (payment_payload ->> 'tenantId')::uuid <> tenant_id_value
      or (payment_payload ->> 'saleId')::uuid <> sale_id_value
      or payment_payload ->> 'method' <> payment_method_value
      or (payment_payload ->> 'amountCents')::integer <> total_cents_value then
      raise exception 'Los datos del pago no coinciden';
    end if;
    received_cents_value := nullif(payment_payload ->> 'receivedCents', '')::integer;
    change_cents_value := (payment_payload ->> 'changeCents')::integer;
    if payment_method_value = 'cash' then
      if received_cents_value is null or received_cents_value < total_cents_value
        or change_cents_value <> received_cents_value - total_cents_value then
        raise exception 'Los importes del pago en efectivo no son validos';
      end if;
    elsif change_cents_value <> 0 then raise exception 'Un pago no efectivo no puede tener cambio'; end if;
  end if;

  select * into session_row from public.cash_sessions where id = cash_session_id_value for update;
  if session_row.id is null or session_row.status <> 'open' then
    raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000';
  end if;
  if session_row.tenant_id <> tenant_id_value or session_row.venue_id <> venue_id_value
    or (cash_register_id_value is not null and session_row.cash_register_id <> cash_register_id_value) then
    raise exception 'La venta no coincide con el negocio, local o punto de caja';
  end if;
  cash_register_id_value := session_row.cash_register_id;
  select * into device_row from public.devices where id = device_id_value;
  if device_row.id is null or device_row.tenant_id <> tenant_id_value or device_row.venue_id <> venue_id_value
    or not device_row.is_active or not device_row.can_take_payments
    or not public.user_has_device_access(tenant_id_value, venue_id_value, device_id_value) then
    raise exception 'El dispositivo no puede cobrar en esta caja' using errcode = '42501';
  end if;

  insert into public.offline_event_log (tenant_id, event_kind, client_event_id, payload)
  values (tenant_id_value, 'sale_created', p_event_id, p_payload)
  on conflict (tenant_id, client_event_id) do nothing returning id into logged_event_id;
  if logged_event_id is null then return; end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, status,
    subtotal_cents, discount_id, discount_name, discount_type, discount_value_type,
    discount_value, discount_amount_cents, total_cents, local_created_at, created_at
  ) values (
    ticket_id_value, tenant_id_value, cash_session_id_value, cash_register_id_value, venue_id_value,
    device_id_value, current_user_id, 'paid', subtotal_cents_value,
    nullif(discount_result ->> 'discountId', '')::uuid, discount_result ->> 'name',
    discount_result ->> 'type', discount_result ->> 'calculationType',
    nullif(discount_result ->> 'storedValue', '')::numeric,
    case when discount_result ->> 'type' is null then null
      else nullif(discount_result ->> 'amountCents', '')::integer end, total_cents_value,
    (ticket_payload ->> 'createdAt')::timestamptz, (ticket_payload ->> 'createdAt')::timestamptz
  );
  insert into public.ticket_lines (id, ticket_id, tenant_id, product_id, variant_id, product_name, variant_name, quantity, unit_price_cents, line_total_cents, modifiers)
  select (line ->> 'id')::uuid, ticket_id_value, tenant_id_value, (line ->> 'productId')::uuid,
    (line ->> 'variantId')::uuid, line ->> 'productName', line ->> 'variantName',
    (line ->> 'quantity')::integer, (line ->> 'unitPriceCents')::integer,
    (line ->> 'lineTotalCents')::integer, coalesce(line -> 'modifiers', '[]'::jsonb)
  from jsonb_array_elements(p_payload -> 'lines') as line;
  insert into public.sales (id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, total_cents, payment_method, local_created_at, created_at)
  values (sale_id_value, tenant_id_value, ticket_id_value, cash_session_id_value, cash_register_id_value,
    venue_id_value, device_id_value, current_user_id, total_cents_value, payment_method_value,
    (sale_payload ->> 'createdAt')::timestamptz, (sale_payload ->> 'createdAt')::timestamptz);
  if total_cents_value > 0 then
    insert into public.sale_payments (id, sale_id, tenant_id, method, amount_cents, received_cents, change_cents)
    values ((payment_payload ->> 'id')::uuid, sale_id_value, tenant_id_value, payment_method_value,
      total_cents_value, received_cents_value, change_cents_value);
  end if;
end;
$$;

create or replace function public.close_order_and_create_sale_v2(
  p_order_id uuid,
  p_payment_method text default null,
  p_received_cents integer default null,
  p_discount jsonb default null
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
  subtotal_cents integer;
  total_cents integer;
  discount_result jsonb;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
begin
  select o.* into order_row from public.orders o where o.id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id and dua.venue_id = order_row.venue_id
    and dua.is_active and d.is_active limit 1;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null or not actor_device.can_take_payments then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;
  select coalesce(sum(ol.quantity * ol.unit_price_cents), 0)::integer into subtotal_cents
  from public.order_lines ol where ol.order_id = order_row.id;
  if subtotal_cents <= 0 then raise exception 'No se puede cobrar una comanda vacia'; end if;
  discount_result := public.resolve_ticket_discount(order_row.tenant_id, order_row.venue_id, subtotal_cents, p_discount);
  total_cents := (discount_result ->> 'totalCents')::integer;
  if total_cents = 0 then
    if p_payment_method is not null then raise exception 'Un ticket a cero no requiere metodo de pago'; end if;
  elsif p_payment_method not in ('cash', 'card') then raise exception 'Metodo de pago no valido'; end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < total_cents then raise exception 'Importe recibido insuficiente'; end if;

  insert into public.tickets (id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, status,
    subtotal_cents, discount_id, discount_name, discount_type, discount_value_type, discount_value,
    discount_amount_cents, total_cents, local_created_at)
  values (ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id, order_row.venue_id,
    actor_device.id, auth.uid(), 'paid', subtotal_cents, nullif(discount_result ->> 'discountId', '')::uuid,
    discount_result ->> 'name', discount_result ->> 'type', discount_result ->> 'calculationType',
    nullif(discount_result ->> 'storedValue', '')::numeric, case when discount_result ->> 'type' is null then null
      else nullif(discount_result ->> 'amountCents', '')::integer end,
    total_cents, now());
  insert into public.ticket_lines (id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name, quantity, unit_price_cents, line_total_cents, modifiers)
  select gen_random_uuid(), ol.tenant_id, ticket_id, ol.product_id, ol.variant_id, ol.product_name, ol.variant_name,
    ol.quantity, ol.unit_price_cents, ol.quantity * ol.unit_price_cents,
    ol.modifiers || case when ol.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'id', 'mixer:' || ol.mixer_product_id::text, 'groupId', 'mixer', 'name', ol.mixer ->> 'name',
      'priceCents', (ol.mixer ->> 'priceCents')::integer)) end
  from public.order_lines ol where ol.order_id = order_row.id;
  insert into public.sales (id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, total_cents, payment_method, local_created_at)
  values (sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), total_cents, p_payment_method, now());
  if total_cents > 0 then
    insert into public.sale_payments (id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents)
    values (payment_id, order_row.tenant_id, sale_id, p_payment_method, total_cents,
      case when p_payment_method = 'cash' then p_received_cents else null end,
      case when p_payment_method = 'cash' then p_received_cents - total_cents else 0 end);
  end if;
  update public.orders o set status = 'paid', closed_at = now() where o.id = order_row.id;
  update public.order_tables ot set released_at = now() where ot.order_id = order_row.id and ot.released_at is null;
  return jsonb_build_object('orderId', order_row.id, 'ticketId', ticket_id, 'saleId', sale_id,
    'paymentId', case when total_cents > 0 then payment_id else null end, 'totalCents', total_cents);
end;
$$;

create or replace function public.close_restaurant_order_checked_v2(
  p_order_id uuid,
  p_payment_method text default null,
  p_received_cents integer default null,
  p_allow_pending boolean default false,
  p_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  pending_units integer;
  payment_result jsonb;
begin
  select o.* into order_row from public.orders o where o.id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0)::integer into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units);
  end if;
  payment_result := public.close_order_and_create_sale_v2(p_order_id, p_payment_method, p_received_cents, p_discount);
  return payment_result || jsonb_build_object('requiresConfirmation', false, 'pendingUnits', pending_units);
end;
$$;

revoke all on function public.validate_discount_scope() from public;
revoke all on function public.resolve_ticket_discount(uuid, uuid, integer, jsonb) from public;
revoke all on function public.sync_sale_created_v2(uuid, jsonb) from public;
revoke all on function public.close_order_and_create_sale_v2(uuid, text, integer, jsonb) from public;
revoke all on function public.close_restaurant_order_checked_v2(uuid, text, integer, boolean, jsonb) from public;
grant execute on function public.sync_sale_created_v2(uuid, jsonb) to authenticated;
grant execute on function public.close_restaurant_order_checked_v2(uuid, text, integer, boolean, jsonb) to authenticated;

commit;
