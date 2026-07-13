-- Adapta la sincronizacion offline de venta rapida a las cajas logicas.
-- El dispositivo que cobra puede ser distinto del que abrio la sesion, pero
-- debe estar asignado al usuario, pertenecer al mismo local y poder cobrar.
-- La operacion se ejecuta en una unica transaccion protegida, igual que el
-- cobro de mesas, para no depender de las politicas RLS de cada tabla hija.
-- Baseline: logical-cash-registers-migration.sql.

begin;

create or replace function public.sync_sale_created(p_event_id uuid, p_payload jsonb)
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
  tenant_id_value uuid;
  ticket_id_value uuid;
  sale_id_value uuid;
  cash_session_id_value uuid;
  cash_register_id_value uuid;
  sale_cash_register_id_value uuid;
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
  device_row public.devices%rowtype;
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
  cash_register_id_value := nullif(ticket_payload ->> 'cashRegisterId', '')::uuid;
  sale_cash_register_id_value := nullif(sale_payload ->> 'cashRegisterId', '')::uuid;
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
    or (cash_register_id_value is not null and session_row.cash_register_id <> cash_register_id_value)
    or (sale_cash_register_id_value is not null and session_row.cash_register_id <> sale_cash_register_id_value) then
    raise exception 'La venta no coincide con el negocio, local o punto de caja';
  end if;

  cash_register_id_value := session_row.cash_register_id;

  select *
  into device_row
  from public.devices
  where id = device_id_value;

  if not found
    or device_row.tenant_id <> tenant_id_value
    or device_row.venue_id <> venue_id_value
    or device_row.is_active = false
    or device_row.can_take_payments = false
    or not public.user_has_device_access(tenant_id_value, venue_id_value, device_id_value) then
    raise exception 'El dispositivo no puede cobrar en esta caja' using errcode = '42501';
  end if;

  insert into public.offline_event_log (tenant_id, event_kind, client_event_id, payload)
  values (tenant_id_value, 'sale_created', p_event_id, p_payload)
  on conflict (tenant_id, client_event_id) do nothing
  returning id into logged_event_id;

  if logged_event_id is null then
    return;
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id,
    user_id, status, subtotal_cents, total_cents, local_created_at, created_at
  ) values (
    ticket_id_value, tenant_id_value, cash_session_id_value,
    cash_register_id_value, venue_id_value, device_id_value, current_user_id,
    'paid', total_cents_value, total_cents_value,
    (ticket_payload ->> 'createdAt')::timestamptz,
    (ticket_payload ->> 'createdAt')::timestamptz
  );

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
  from jsonb_array_elements(p_payload -> 'lines') as line;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id,
    device_id, user_id, total_cents, payment_method, local_created_at, created_at
  ) values (
    sale_id_value, tenant_id_value, ticket_id_value, cash_session_id_value,
    cash_register_id_value, venue_id_value, device_id_value, current_user_id,
    total_cents_value, payment_method_value,
    (sale_payload ->> 'createdAt')::timestamptz,
    (sale_payload ->> 'createdAt')::timestamptz
  );

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
  );
end;
$$;

revoke all on function public.sync_sale_created(uuid, jsonb) from public;
grant execute on function public.sync_sale_created(uuid, jsonb) to authenticated;

commit;
