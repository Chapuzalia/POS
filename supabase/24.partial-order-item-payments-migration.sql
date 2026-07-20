-- Cobro parcial por items sin crear ni cerrar subcomandas.
create or replace function public.pay_restaurant_order_items(
  p_order_id uuid,
  p_expected_revision integer,
  p_items jsonb,
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
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  subtotal_cents integer;
  total_cents integer;
  pending_units integer;
  requested_lines integer;
  matched_lines integer;
  next_revision integer;
  discount_result jsonb;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Selecciona al menos un producto' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce((item ->> 'quantity')::integer, 0) <= 0
      or nullif(item ->> 'lineId', '') is null
  ) then
    raise exception 'La seleccion contiene cantidades no validas' using errcode = '22023';
  end if;

  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;

  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id for update;

  if exists (
    select 1 from public.restaurant_order_equal_splits s
    where s.order_id = order_row.id and s.status = 'open' and s.paid_parts > 0
  ) then
    raise exception 'Esta comanda ya se esta cobrando a partes iguales' using errcode = '23514';
  end if;

  with selected as (
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  select count(*)::integer,
    count(ol.id)::integer,
    coalesce(sum(case when ol.id is null then 0 else selected.quantity * ol.unit_price_cents end), 0)::integer,
    coalesce(sum(case when ol.id is null then 0 else greatest(selected.quantity - least(ol.served_quantity, selected.quantity), 0) end), 0)::integer
  into requested_lines, matched_lines, subtotal_cents, pending_units
  from selected left join public.order_lines ol
    on ol.id = selected.line_id and ol.order_id = order_row.id
  where ol.id is null or selected.quantity <= ol.quantity;

  if matched_lines <> requested_lines or exists (
    with selected as (
      select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::integer)::integer quantity
      from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
    )
    select 1 from selected join public.order_lines ol on ol.id = selected.line_id
    where ol.order_id <> order_row.id or selected.quantity > ol.quantity
  ) then
    raise exception 'La seleccion ya no coincide con la comanda' using errcode = '40001';
  end if;
  if subtotal_cents <= 0 then raise exception 'No se puede cobrar una seleccion vacia'; end if;
  if pending_units > 0 and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units);
  end if;

  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d
  join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id
    and dua.venue_id = order_row.venue_id and dua.is_active and d.is_active
    and d.can_take_payments
  order by case when d.id = order_row.opened_by_device_id then 0 else 1 end, d.id limit 1;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;

  discount_result := public.resolve_ticket_discount(order_row.tenant_id, order_row.venue_id, subtotal_cents, p_discount);
  total_cents := (discount_result ->> 'totalCents')::integer;
  if total_cents = 0 then
    if p_payment_method is not null then raise exception 'Un ticket a cero no requiere metodo de pago'; end if;
  elsif p_payment_method not in ('cash', 'card') then
    raise exception 'Metodo de pago no valido';
  end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < total_cents then
    raise exception 'Importe recibido insuficiente';
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id,
    status, subtotal_cents, discount_id, discount_name, discount_type,
    discount_value_type, discount_value, discount_amount_cents, total_cents, local_created_at
  ) values (
    ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), 'paid', subtotal_cents,
    nullif(discount_result ->> 'discountId', '')::uuid,
    discount_result ->> 'name', discount_result ->> 'type', discount_result ->> 'calculationType',
    nullif(discount_result ->> 'storedValue', '')::numeric,
    case when discount_result ->> 'type' is null then null else nullif(discount_result ->> 'amountCents', '')::integer end,
    total_cents, now()
  );

  with selected as (
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  insert into public.ticket_lines (
    id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
    quantity, unit_price_cents, line_total_cents, modifiers
  )
  select gen_random_uuid(), ol.tenant_id, ticket_id, ol.product_id, ol.variant_id,
    ol.product_name, ol.variant_name, selected.quantity, ol.unit_price_cents,
    selected.quantity * ol.unit_price_cents,
    ol.modifiers || case when ol.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'id', 'mixer:' || ol.mixer_product_id::text, 'groupId', 'mixer', 'name', ol.mixer ->> 'name',
      'priceCents', (ol.mixer ->> 'priceCents')::integer
    )) end
  from selected join public.order_lines ol on ol.id = selected.line_id;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id,
    device_id, user_id, total_cents, payment_method, local_created_at
  ) values (
    sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), total_cents, p_payment_method, now()
  );
  if total_cents > 0 then
    insert into public.sale_payments (
      id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents
    ) values (
      payment_id, order_row.tenant_id, sale_id, p_payment_method, total_cents,
      case when p_payment_method = 'cash' then p_received_cents else null end,
      case when p_payment_method = 'cash' then p_received_cents - total_cents else 0 end
    );
  end if;

  with selected as (
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  delete from public.order_lines ol using selected
  where ol.id = selected.line_id and selected.quantity = ol.quantity;

  with selected as (
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  update public.order_lines ol set
    quantity = ol.quantity - selected.quantity,
    served_quantity = greatest(0, ol.served_quantity - least(ol.served_quantity, selected.quantity)),
    fully_served_at = case
      when ol.quantity - selected.quantity > 0
        and greatest(0, ol.served_quantity - least(ol.served_quantity, selected.quantity)) = ol.quantity - selected.quantity
      then coalesce(ol.fully_served_at, now()) else null end,
    updated_at = now()
  from selected
  where ol.id = selected.line_id and selected.quantity < ol.quantity;
  update public.restaurant_order_equal_splits
    set status = 'cancelled', updated_at = now(), revision = revision + 1
    where order_id = order_row.id and status = 'open' and paid_parts = 0;
  update public.orders o set revision = o.revision + 1, updated_at = now()
    where o.id = order_row.id returning o.revision into next_revision;

  return jsonb_build_object(
    'requiresConfirmation', false,
    'pendingUnits', pending_units,
    'orderId', order_row.id,
    'revision', next_revision,
    'ticketId', ticket_id,
    'saleId', sale_id,
    'paymentId', case when total_cents > 0 then payment_id else null end,
    'subtotalCents', subtotal_cents,
    'totalCents', total_cents
  );
end;
$$;

revoke all on function public.pay_restaurant_order_items(uuid, integer, jsonb, text, integer, boolean, jsonb) from public;
grant execute on function public.pay_restaurant_order_items(uuid, integer, jsonb, text, integer, boolean, jsonb) to authenticated;