-- Descuentos independientes por cada cobro a partes iguales.
-- El descuento previo de la comanda queda como valor heredado; los importes
-- fijos se distribuyen entre partes para no multiplicar el descuento.

begin;

alter table public.restaurant_order_equal_splits
  add column if not exists default_discount jsonb;

alter table public.restaurant_order_equal_split_payments
  add column if not exists subtotal_cents integer,
  add column if not exists discount_amount_cents integer not null default 0,
  add column if not exists discount jsonb;

update public.restaurant_order_equal_split_payments
set subtotal_cents = amount_cents
where subtotal_cents is null;

alter table public.restaurant_order_equal_split_payments
  alter column subtotal_cents set not null,
  alter column payment_method drop not null;

alter table public.restaurant_order_equal_split_payments
  drop constraint if exists restaurant_order_equal_split_payments_amount_cents_check;
alter table public.restaurant_order_equal_split_payments
  add constraint restaurant_order_equal_split_payments_amount_cents_check check (amount_cents >= 0);
alter table public.restaurant_order_equal_split_payments
  drop constraint if exists restaurant_order_equal_split_payments_payment_method_check;
alter table public.restaurant_order_equal_split_payments
  add constraint restaurant_order_equal_split_payments_payment_method_check check (
    payment_method is null or payment_method in ('cash', 'card')
  );
alter table public.restaurant_order_equal_split_payments
  drop constraint if exists restaurant_order_equal_split_payments_discount_check;
alter table public.restaurant_order_equal_split_payments
  add constraint restaurant_order_equal_split_payments_discount_check check (
    subtotal_cents > 0
    and discount_amount_cents between 0 and subtotal_cents
    and amount_cents = subtotal_cents - discount_amount_cents
    and ((amount_cents = 0 and payment_method is null) or (amount_cents > 0 and payment_method is not null))
  );

create or replace function public.restaurant_equal_split_to_json(p_split public.restaurant_order_equal_splits)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  next_part_number integer := p_split.paid_parts + 1;
  next_subtotal integer := 0;
  next_discount_amount integer := 0;
  next_discount jsonb := null;
  calculation_type text;
  configured_value numeric;
begin
  if p_split.status = 'open' then
    next_subtotal := (p_split.total_cents / p_split.part_count)
      + case when next_part_number <= mod(p_split.total_cents, p_split.part_count) then 1 else 0 end;
  end if;

  if next_subtotal > 0 and p_split.default_discount is not null then
    calculation_type := p_split.default_discount ->> 'calculationType';
    next_discount_amount := (coalesce((p_split.default_discount ->> 'amountCents')::integer, 0) / p_split.part_count)
      + case when next_part_number <= mod(coalesce((p_split.default_discount ->> 'amountCents')::integer, 0), p_split.part_count) then 1 else 0 end;
    next_discount_amount := least(next_subtotal, next_discount_amount);
    if next_discount_amount = 0 then
      next_discount := null;
    elsif calculation_type = 'percentage' then
      configured_value := (p_split.default_discount ->> 'value')::numeric;
      next_discount := jsonb_build_object(
        'discountId', nullif(p_split.default_discount ->> 'discountId', ''),
        'name', p_split.default_discount ->> 'name',
        'type', p_split.default_discount ->> 'type',
        'calculationType', 'percentage',
        'value', configured_value,
        'color', p_split.default_discount -> 'color'
      );
    elsif calculation_type = 'fixed' then
      if next_discount_amount > 0 then
        next_discount := jsonb_build_object(
          'discountId', nullif(p_split.default_discount ->> 'discountId', ''),
          'name', p_split.default_discount ->> 'name',
          'type', p_split.default_discount ->> 'type',
          'calculationType', 'fixed',
          'value', next_discount_amount,
          'color', p_split.default_discount -> 'color'
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'id', p_split.id,
    'orderId', p_split.order_id,
    'orderGroupId', p_split.order_group_id,
    'totalCents', p_split.total_cents,
    'partCount', p_split.part_count,
    'paidParts', p_split.paid_parts,
    'paidCents', p_split.paid_cents,
    'remainingParts', p_split.part_count - p_split.paid_parts,
    'remainingCents', p_split.total_cents - p_split.paid_cents,
    'nextPartCents', next_subtotal,
    'nextDefaultDiscount', next_discount,
    'nextDefaultDiscountAmountCents', next_discount_amount,
    'nextDefaultTotalCents', next_subtotal - next_discount_amount,
    'status', p_split.status,
    'revision', p_split.revision,
    'allowPendingService', p_split.allow_pending_service
  );
end;
$$;

drop function if exists public.configure_restaurant_order_equal_split(uuid, integer, integer);
create function public.configure_restaurant_order_equal_split(
  p_order_id uuid,
  p_part_count integer,
  p_expected_order_revision integer,
  p_default_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  split_row public.restaurant_order_equal_splits%rowtype;
  order_total integer;
  discount_result jsonb;
  discount_snapshot jsonb;
begin
  if p_part_count < 2 or p_part_count > 99 then
    raise exception 'El numero de comensales debe estar entre 2 y 99' using errcode = '22023';
  end if;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' or order_row.revision <> p_expected_order_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  select coalesce(sum(ol.quantity * ol.unit_price_cents), 0)::integer into order_total
  from public.order_lines ol where ol.order_id = order_row.id;
  if order_total <= 0 then raise exception 'No se puede dividir una comanda vacia'; end if;
  if p_part_count > order_total then raise exception 'El numero de partes supera los centimos cobrables' using errcode = '22023'; end if;

  select s.* into split_row from public.restaurant_order_equal_splits s
  where s.order_id = order_row.id for update;
  if split_row.id is not null and split_row.status = 'completed' then
    raise exception 'Esta comanda ya se cobro por completo';
  end if;
  if split_row.id is not null and split_row.paid_parts > 0 then
    if split_row.part_count <> p_part_count or split_row.total_cents <> order_total then
      raise exception 'No se puede cambiar el reparto despues del primer cobro' using errcode = '55000';
    end if;
    return public.restaurant_equal_split_to_json(split_row);
  end if;

  discount_result := public.resolve_ticket_discount(
    order_row.tenant_id, order_row.venue_id, order_total, p_default_discount
  );
  discount_snapshot := case when discount_result ->> 'type' is null then null
    else discount_result || jsonb_build_object('color', p_default_discount -> 'color') end;

  insert into public.restaurant_order_equal_splits (
    tenant_id, venue_id, order_group_id, order_id, total_cents, part_count,
    default_discount, status
  ) values (
    order_row.tenant_id, order_row.venue_id, order_row.order_group_id, order_row.id,
    order_total, p_part_count, discount_snapshot, 'open'
  )
  on conflict (order_id) do update set
    total_cents = excluded.total_cents,
    part_count = excluded.part_count,
    paid_parts = 0,
    paid_cents = 0,
    default_discount = excluded.default_discount,
    allow_pending_service = false,
    status = 'open',
    revision = public.restaurant_order_equal_splits.revision + 1,
    updated_at = now(),
    completed_at = null
  returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_started', jsonb_build_object(
    'splitId', split_row.id, 'partCount', split_row.part_count, 'totalCents', split_row.total_cents,
    'defaultDiscountAmountCents', coalesce((discount_snapshot ->> 'amountCents')::integer, 0)
  ));
  return public.restaurant_equal_split_to_json(split_row);
end;
$$;

drop function if exists public.pay_restaurant_order_equal_part(uuid, text, integer, boolean);
create function public.pay_restaurant_order_equal_part(
  p_split_id uuid,
  p_payment_method text default null,
  p_received_cents integer default null,
  p_allow_pending boolean default false,
  p_discount jsonb default null,
  p_use_default_discount boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  split_row public.restaurant_order_equal_splits%rowtype;
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  line_row public.order_lines%rowtype;
  part_number integer;
  part_subtotal integer;
  part_total integer;
  discount_amount integer;
  discount_result jsonb;
  base_amount integer;
  remainder integer;
  part_start integer;
  part_end integer;
  line_start integer := 0;
  line_end integer;
  allocated_cents integer;
  allocated_quantity numeric;
  pending_units integer;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
  remaining_orders integer;
  next_order_id uuid;
begin
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id;
  if split_row.id is null or split_row.status <> 'open' then raise exception 'Division no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  perform 1 from public.order_groups og where og.id = split_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = split_row.order_group_id order by o.id for update;
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id for update;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  if split_row.status <> 'open' or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Division no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id for update;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0)::integer into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not split_row.allow_pending_service and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units, 'split', public.restaurant_equal_split_to_json(split_row));
  end if;
  if p_allow_pending and not split_row.allow_pending_service then
    update public.restaurant_order_equal_splits set allow_pending_service = true where id = split_row.id
    returning * into split_row;
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

  base_amount := split_row.total_cents / split_row.part_count;
  remainder := mod(split_row.total_cents, split_row.part_count);
  part_number := split_row.paid_parts + 1;
  part_subtotal := base_amount + case when part_number <= remainder then 1 else 0 end;
  part_start := (part_number - 1) * base_amount + least(part_number - 1, remainder);
  part_end := part_start + part_subtotal;

  if p_use_default_discount and split_row.default_discount is not null then
    discount_amount := (coalesce((split_row.default_discount ->> 'amountCents')::integer, 0) / split_row.part_count)
      + case when part_number <= mod(coalesce((split_row.default_discount ->> 'amountCents')::integer, 0), split_row.part_count) then 1 else 0 end;
    discount_amount := least(part_subtotal, discount_amount);
    if discount_amount = 0 then
      discount_result := jsonb_build_object('amountCents', 0, 'totalCents', part_subtotal);
    elsif split_row.default_discount ->> 'calculationType' = 'percentage' then
      discount_result := split_row.default_discount || jsonb_build_object(
        'amountCents', discount_amount,
        'totalCents', part_subtotal - discount_amount
      );
    else
      discount_result := split_row.default_discount || jsonb_build_object(
        'value', discount_amount,
        'storedValue', discount_amount::numeric / 100,
        'amountCents', discount_amount,
        'totalCents', part_subtotal - discount_amount
      );
    end if;
  else
    discount_result := public.resolve_ticket_discount(
      order_row.tenant_id, order_row.venue_id, part_subtotal, p_discount
    );
    discount_amount := coalesce((discount_result ->> 'amountCents')::integer, 0);
  end if;
  discount_amount := coalesce(discount_amount, 0);
  part_total := part_subtotal - discount_amount;

  if part_total = 0 then
    if p_payment_method is not null then raise exception 'Un ticket a cero no requiere metodo de pago'; end if;
  elsif p_payment_method not in ('cash', 'card') then
    raise exception 'Metodo de pago no valido';
  end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < part_total then
    raise exception 'Importe recibido insuficiente';
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id,
    status, subtotal_cents, discount_id, discount_name, discount_type,
    discount_value_type, discount_value, discount_amount_cents, total_cents,
    local_created_at, equal_split_id, equal_split_part_number
  ) values (
    ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), 'paid', part_subtotal,
    nullif(discount_result ->> 'discountId', '')::uuid,
    discount_result ->> 'name', discount_result ->> 'type',
    discount_result ->> 'calculationType',
    nullif(discount_result ->> 'storedValue', '')::numeric,
    case when discount_result ->> 'type' is null then null else discount_amount end,
    part_total, now(), split_row.id, part_number
  );

  for line_row in select ol.* from public.order_lines ol
    where ol.order_id = order_row.id order by ol.created_at, ol.id
  loop
    line_end := line_start + line_row.quantity * line_row.unit_price_cents;
    allocated_cents := greatest(0, least(line_end, part_end) - greatest(line_start, part_start));
    if allocated_cents > 0 or (line_end = line_start and part_number = 1) then
      allocated_quantity := case when line_end = line_start then line_row.quantity::numeric
        else line_row.quantity::numeric * allocated_cents::numeric / (line_end - line_start)::numeric end;
      insert into public.ticket_lines (
        id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
        quantity, allocated_quantity, unit_price_cents, line_total_cents, modifiers
      ) values (
        gen_random_uuid(), line_row.tenant_id, ticket_id, line_row.product_id, line_row.variant_id,
        line_row.product_name, line_row.variant_name, 1, allocated_quantity,
        allocated_cents, allocated_cents,
        line_row.modifiers || case when line_row.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
          'id', 'mixer:' || line_row.mixer_product_id::text, 'groupId', 'mixer',
          'name', line_row.mixer ->> 'name', 'priceCents', (line_row.mixer ->> 'priceCents')::integer
        )) end
      );
    end if;
    line_start := line_end;
  end loop;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id,
    device_id, user_id, total_cents, payment_method, local_created_at
  ) values (
    sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), part_total, p_payment_method, now()
  );
  if part_total > 0 then
    insert into public.sale_payments (
      id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents
    ) values (
      payment_id, order_row.tenant_id, sale_id, p_payment_method, part_total,
      case when p_payment_method = 'cash' then p_received_cents else null end,
      case when p_payment_method = 'cash' then p_received_cents - part_total else 0 end
    );
  end if;
  insert into public.restaurant_order_equal_split_payments (
    tenant_id, venue_id, split_id, part_number, subtotal_cents,
    discount_amount_cents, discount, amount_cents, payment_method,
    received_cents, change_cents, ticket_id, sale_id
  ) values (
    order_row.tenant_id, order_row.venue_id, split_row.id, part_number, part_subtotal,
    discount_amount, case when discount_result ->> 'type' is null then null else discount_result end,
    part_total, p_payment_method,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - part_total else 0 end,
    ticket_id, sale_id
  );

  update public.restaurant_order_equal_splits s set
    paid_parts = s.paid_parts + 1,
    paid_cents = s.paid_cents + part_subtotal,
    status = case when s.paid_parts + 1 = s.part_count then 'completed' else 'open' end,
    completed_at = case when s.paid_parts + 1 = s.part_count then now() else null end,
    revision = s.revision + 1,
    updated_at = now()
  where s.id = split_row.id returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_part_paid', jsonb_build_object(
    'splitId', split_row.id, 'partNumber', part_number, 'partCount', split_row.part_count,
    'subtotalCents', part_subtotal, 'discountAmountCents', discount_amount,
    'amountCents', part_total, 'ticketId', ticket_id, 'saleId', sale_id
  ));

  if split_row.status = 'completed' then
    perform set_config('app.equal_split_finalizing', split_row.id::text, true);
    update public.orders o set status = 'paid', closed_at = now(), updated_at = now()
    where o.id = order_row.id;
    select count(*) into remaining_orders from public.orders o
    where o.order_group_id = order_row.order_group_id and o.status = 'open';
    if remaining_orders = 0 then
      update public.order_groups set status = 'closed', closed_at = now(), updated_at = now()
      where id = order_row.order_group_id;
      update public.order_tables set released_at = now()
      where order_group_id = order_row.order_group_id and released_at is null;
    else
      select o.id into next_order_id from public.orders o
      where o.order_group_id = order_row.order_group_id and o.status = 'open'
      order by o.split_sequence limit 1;
    end if;
    perform public.record_restaurant_order_event(order_row.id, 'equal_split_completed', jsonb_build_object('splitId', split_row.id));
  end if;

  return jsonb_build_object(
    'requiresConfirmation', false,
    'pendingUnits', pending_units,
    'split', public.restaurant_equal_split_to_json(split_row),
    'ticketId', ticket_id,
    'saleId', sale_id,
    'paymentId', case when part_total > 0 then payment_id else null end,
    'paidAmountCents', part_total,
    'completed', split_row.status = 'completed',
    'nextOrderId', next_order_id
  );
end;
$$;

revoke all on function public.restaurant_equal_split_to_json(public.restaurant_order_equal_splits) from public, anon, authenticated;
revoke all on function public.configure_restaurant_order_equal_split(uuid, integer, integer, jsonb) from public;
revoke all on function public.pay_restaurant_order_equal_part(uuid, text, integer, boolean, jsonb, boolean) from public;
grant execute on function public.configure_restaurant_order_equal_split(uuid, integer, integer, jsonb) to authenticated;
grant execute on function public.pay_restaurant_order_equal_part(uuid, text, integer, boolean, jsonb, boolean) to authenticated;

commit;
