-- Validacion de actor, ventas atomicas y proteccion de cajas cerradas.
-- Ejecutar despues de schema.sql y de las migraciones de producto.
-- Si se usan cuentas separadas por dispositivo, ejecutar a continuacion
-- device-user-access-migration.sql para aplicar las politicas definitivas.

begin;

create or replace function public.validate_cash_session_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if current_user_id is not null and new.opened_by <> current_user_id then
      raise exception 'El usuario de apertura no coincide con auth.uid()' using errcode = '42501';
    end if;

    if new.status <> 'open' or new.closed_by is not null or new.closed_at is not null then
      raise exception 'Una caja nueva debe crearse abierta y sin datos de cierre';
    end if;

    return new;
  end if;

  if new.tenant_id is distinct from old.tenant_id
    or new.venue_id is distinct from old.venue_id
    or new.device_id is distinct from old.device_id
    or new.opened_by is distinct from old.opened_by
    or new.opened_at is distinct from old.opened_at then
    raise exception 'No se puede cambiar la identidad de una caja existente';
  end if;

  if old.status = 'closed' and new.status is distinct from old.status then
    raise exception 'Una caja cerrada no se puede volver a abrir';
  end if;

  if old.status = 'open' and new.status = 'closed' then
    if current_user_id is not null and new.closed_by <> current_user_id then
      raise exception 'El usuario de cierre no coincide con auth.uid()' using errcode = '42501';
    end if;

    if new.closed_by is null or new.closed_at is null then
      raise exception 'El cierre de caja requiere usuario y fecha';
    end if;
  elsif new.status = 'open' and (new.closed_by is not null or new.closed_at is not null) then
    raise exception 'Una caja abierta no puede contener datos de cierre';
  end if;

  return new;
end;
$$;

create or replace function public.validate_transaction_actor_and_cash()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  session_row public.cash_sessions%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'No se puede cambiar el usuario de una transaccion';
    end if;

    if new.tenant_id is distinct from old.tenant_id
      or new.cash_session_id is distinct from old.cash_session_id
      or new.venue_id is distinct from old.venue_id
      or new.device_id is distinct from old.device_id then
      raise exception 'No se puede cambiar la caja de una transaccion';
    end if;

    return new;
  end if;

  if current_user_id is not null and new.user_id <> current_user_id then
    raise exception 'El usuario de la transaccion no coincide con auth.uid()' using errcode = '42501';
  end if;

  select *
  into session_row
  from public.cash_sessions
  where id = new.cash_session_id
  for share;

  if not found then
    raise exception 'La caja indicada no existe';
  end if;

  if session_row.status <> 'open' then
    raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000';
  end if;

  if session_row.tenant_id <> new.tenant_id
    or session_row.venue_id <> new.venue_id
    or session_row.device_id <> new.device_id then
    raise exception 'La venta no coincide con el negocio, local o dispositivo de la caja';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_cash_session_write on public.cash_sessions;
create trigger validate_cash_session_write
before insert or update on public.cash_sessions
for each row execute function public.validate_cash_session_write();

drop trigger if exists validate_ticket_actor_and_cash on public.tickets;
create trigger validate_ticket_actor_and_cash
before insert or update on public.tickets
for each row execute function public.validate_transaction_actor_and_cash();

drop trigger if exists validate_sale_actor_and_cash on public.sales;
create trigger validate_sale_actor_and_cash
before insert or update on public.sales
for each row execute function public.validate_transaction_actor_and_cash();

create or replace function public.sync_sale_created(p_event_id uuid, p_payload jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  ticket_payload jsonb := p_payload -> 'ticket';
  sale_payload jsonb := p_payload -> 'sale';
  payment_payload jsonb := p_payload -> 'payment';
  tenant_id_value uuid;
  ticket_id_value uuid;
  sale_id_value uuid;
  cash_session_id_value uuid;
  venue_id_value uuid;
  device_id_value uuid;
  ticket_user_id_value uuid;
  sale_user_id_value uuid;
  total_cents_value bigint;
  payment_amount_value bigint;
  received_cents_value bigint;
  change_cents_value bigint;
  payment_method_value text;
  line_count integer;
  lines_total bigint;
  lines_are_valid boolean;
  session_row public.cash_sessions%rowtype;
  logged_event_id uuid;
begin
  if current_user_id is null then
    raise exception 'Se requiere un usuario autenticado' using errcode = '42501';
  end if;

  if p_event_id is null or jsonb_typeof(p_payload -> 'lines') is distinct from 'array' then
    raise exception 'El evento de venta no tiene un formato valido';
  end if;

  tenant_id_value := (ticket_payload ->> 'tenantId')::uuid;
  ticket_id_value := (ticket_payload ->> 'id')::uuid;
  sale_id_value := (sale_payload ->> 'id')::uuid;
  cash_session_id_value := (ticket_payload ->> 'cashSessionId')::uuid;
  venue_id_value := (ticket_payload ->> 'venueId')::uuid;
  device_id_value := (ticket_payload ->> 'deviceId')::uuid;
  ticket_user_id_value := (ticket_payload ->> 'userId')::uuid;
  sale_user_id_value := (sale_payload ->> 'userId')::uuid;
  total_cents_value := (ticket_payload ->> 'totalCents')::bigint;
  payment_amount_value := (payment_payload ->> 'amountCents')::bigint;
  received_cents_value := nullif(payment_payload ->> 'receivedCents', '')::bigint;
  change_cents_value := (payment_payload ->> 'changeCents')::bigint;
  payment_method_value := sale_payload ->> 'paymentMethod';

  if ticket_user_id_value <> current_user_id or sale_user_id_value <> current_user_id then
    raise exception 'El userId enviado no coincide con auth.uid()' using errcode = '42501';
  end if;

  if not public.user_has_tenant_access(tenant_id_value) then
    raise exception 'El usuario no tiene acceso al negocio' using errcode = '42501';
  end if;

  if (sale_payload ->> 'tenantId')::uuid <> tenant_id_value
    or (payment_payload ->> 'tenantId')::uuid <> tenant_id_value
    or (sale_payload ->> 'ticketId')::uuid <> ticket_id_value
    or (sale_payload ->> 'cashSessionId')::uuid <> cash_session_id_value
    or (sale_payload ->> 'venueId')::uuid <> venue_id_value
    or (sale_payload ->> 'deviceId')::uuid <> device_id_value
    or (payment_payload ->> 'saleId')::uuid <> sale_id_value
    or payment_payload ->> 'method' <> payment_method_value then
    raise exception 'Los datos relacionados de la venta no coinciden';
  end if;

  if exists (
    select 1
    from public.offline_event_log
    where tenant_id = tenant_id_value
      and client_event_id = p_event_id
  ) then
    return;
  end if;

  select
    count(*),
    coalesce(sum((line ->> 'lineTotalCents')::bigint), 0),
    coalesce(bool_and(
      (line ->> 'tenantId')::uuid = tenant_id_value
      and (line ->> 'ticketId')::uuid = ticket_id_value
      and (line ->> 'quantity')::integer > 0
      and (line ->> 'unitPriceCents')::bigint >= 0
      and (line ->> 'lineTotalCents')::bigint =
        (line ->> 'unitPriceCents')::bigint * (line ->> 'quantity')::integer
    ), false)
  into line_count, lines_total, lines_are_valid
  from jsonb_array_elements(p_payload -> 'lines') as line;

  if line_count = 0 or not lines_are_valid then
    raise exception 'Las lineas de la venta no son validas';
  end if;

  if total_cents_value <> lines_total
    or (sale_payload ->> 'totalCents')::bigint <> lines_total
    or payment_amount_value <> lines_total then
    raise exception 'Los totales de ticket, venta, lineas y pago no coinciden';
  end if;

  if payment_method_value = 'cash' then
    if received_cents_value is null
      or received_cents_value < total_cents_value
      or change_cents_value <> received_cents_value - total_cents_value then
      raise exception 'Los importes del pago en efectivo no son validos';
    end if;
  elsif change_cents_value <> 0 then
    raise exception 'Un pago no efectivo no puede tener cambio';
  end if;

  select *
  into session_row
  from public.cash_sessions
  where id = cash_session_id_value
  for update;

  if not found then
    raise exception 'La caja indicada no existe';
  end if;

  if session_row.status <> 'open' then
    raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000';
  end if;

  if session_row.tenant_id <> tenant_id_value
    or session_row.venue_id <> venue_id_value
    or session_row.device_id <> device_id_value then
    raise exception 'La venta no coincide con el negocio, local o dispositivo de la caja';
  end if;

  insert into public.offline_event_log (tenant_id, event_kind, client_event_id, payload)
  values (tenant_id_value, 'sale_created', p_event_id, p_payload)
  on conflict (tenant_id, client_event_id) do nothing
  returning id into logged_event_id;

  if logged_event_id is null then
    return;
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, venue_id, device_id, user_id, status,
    subtotal_cents, total_cents, local_created_at, created_at
  ) values (
    ticket_id_value,
    tenant_id_value,
    cash_session_id_value,
    venue_id_value,
    device_id_value,
    current_user_id,
    'paid',
    total_cents_value,
    total_cents_value,
    (ticket_payload ->> 'createdAt')::timestamptz,
    (ticket_payload ->> 'createdAt')::timestamptz
  )
  on conflict (id) do update set
    status = excluded.status,
    subtotal_cents = excluded.subtotal_cents,
    total_cents = excluded.total_cents;

  insert into public.ticket_lines (
    id, ticket_id, tenant_id, product_id, variant_id, product_name, variant_name,
    quantity, unit_price_cents, line_total_cents, modifiers
  )
  select
    (line ->> 'id')::uuid,
    ticket_id_value,
    tenant_id_value,
    (line ->> 'productId')::uuid,
    (line ->> 'variantId')::uuid,
    line ->> 'productName',
    line ->> 'variantName',
    (line ->> 'quantity')::integer,
    (line ->> 'unitPriceCents')::integer,
    (line ->> 'lineTotalCents')::integer,
    coalesce(line -> 'modifiers', '[]'::jsonb)
  from jsonb_array_elements(p_payload -> 'lines') as line
  on conflict (id) do update set
    product_id = excluded.product_id,
    variant_id = excluded.variant_id,
    product_name = excluded.product_name,
    variant_name = excluded.variant_name,
    quantity = excluded.quantity,
    unit_price_cents = excluded.unit_price_cents,
    line_total_cents = excluded.line_total_cents,
    modifiers = excluded.modifiers;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, venue_id, device_id, user_id,
    total_cents, payment_method, local_created_at, created_at
  ) values (
    sale_id_value,
    tenant_id_value,
    ticket_id_value,
    cash_session_id_value,
    venue_id_value,
    device_id_value,
    current_user_id,
    total_cents_value,
    payment_method_value,
    (sale_payload ->> 'createdAt')::timestamptz,
    (sale_payload ->> 'createdAt')::timestamptz
  )
  on conflict (id) do update set
    total_cents = excluded.total_cents,
    payment_method = excluded.payment_method;

  insert into public.sale_payments (
    id, sale_id, tenant_id, method, amount_cents, received_cents, change_cents
  ) values (
    (payment_payload ->> 'id')::uuid,
    sale_id_value,
    tenant_id_value,
    payment_method_value,
    payment_amount_value,
    received_cents_value,
    change_cents_value
  )
  on conflict (id) do update set
    method = excluded.method,
    amount_cents = excluded.amount_cents,
    received_cents = excluded.received_cents,
    change_cents = excluded.change_cents;
end;
$$;

revoke all on function public.validate_cash_session_write() from public;
revoke all on function public.validate_transaction_actor_and_cash() from public;
revoke all on function public.sync_sale_created(uuid, jsonb) from public;
grant execute on function public.sync_sale_created(uuid, jsonb) to authenticated;

drop policy if exists "cash_sessions_tenant_access" on public.cash_sessions;
drop policy if exists "cash_sessions_select" on public.cash_sessions;
drop policy if exists "cash_sessions_insert" on public.cash_sessions;
drop policy if exists "cash_sessions_update" on public.cash_sessions;
drop policy if exists "cash_sessions_delete" on public.cash_sessions;
create policy "cash_sessions_select" on public.cash_sessions
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "cash_sessions_insert" on public.cash_sessions
for insert to authenticated
with check (
  public.user_has_tenant_access(tenant_id)
  and opened_by = (select auth.uid())
  and status = 'open'
  and closed_by is null
);
create policy "cash_sessions_update" on public.cash_sessions
for update to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));
create policy "cash_sessions_delete" on public.cash_sessions
for delete to authenticated
using (public.user_has_tenant_access(tenant_id));

drop policy if exists "tickets_tenant_access" on public.tickets;
drop policy if exists "tickets_select" on public.tickets;
drop policy if exists "tickets_insert" on public.tickets;
drop policy if exists "tickets_update" on public.tickets;
drop policy if exists "tickets_delete" on public.tickets;
create policy "tickets_select" on public.tickets
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "tickets_insert" on public.tickets
for insert to authenticated
with check (public.user_has_tenant_access(tenant_id) and user_id = (select auth.uid()));
create policy "tickets_update" on public.tickets
for update to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));
create policy "tickets_delete" on public.tickets
for delete to authenticated
using (public.user_has_tenant_access(tenant_id));

drop policy if exists "sales_tenant_access" on public.sales;
drop policy if exists "sales_select" on public.sales;
drop policy if exists "sales_insert" on public.sales;
drop policy if exists "sales_update" on public.sales;
drop policy if exists "sales_delete" on public.sales;
create policy "sales_select" on public.sales
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "sales_insert" on public.sales
for insert to authenticated
with check (public.user_has_tenant_access(tenant_id) and user_id = (select auth.uid()));
create policy "sales_update" on public.sales
for update to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));
create policy "sales_delete" on public.sales
for delete to authenticated
using (public.user_has_tenant_access(tenant_id));

-- El bucket sigue siendo publico para getPublicUrl, pero no se permite listar objetos anonimamente.
drop policy if exists "product_images_public_read" on storage.objects;

commit;
