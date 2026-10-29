-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Add opt-in cash/card allocations while preserving all legacy signatures, checkout locks, permissions, fiscal envelopes and replay receipts.

-- A tender is still one diner's share. Its optional allocations describe the two
-- real payments; old shares and N-1 callers keep their existing representation.
alter table public.restaurant_equal_split_tenders add column custom_payments jsonb;
create unique index restaurant_equal_split_custom_request_idx on public.restaurant_equal_split_tenders
  (tenant_id, (custom_payments -> 0 ->> 'cashlogyRequestId')) where custom_payments -> 0 ->> 'cashlogyRequestId' is not null;
create unique index restaurant_equal_split_custom_transaction_idx on public.restaurant_equal_split_tenders
  (tenant_id, (custom_payments -> 0 ->> 'cashlogyTransactionId')) where custom_payments -> 0 ->> 'cashlogyTransactionId' is not null;

-- Pure validation/construction, with integer cents and cash first.
create function public.custom_payment_parts(p_tenant uuid, p_sale uuid, p_total integer, p_card uuid, p_params jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare cash_cents integer; received integer; request_id text; transaction_id text;
begin
  if jsonb_typeof(p_params -> 'customCashCents') is distinct from 'number'
    or (p_params ->> 'customCashCents') !~ '^[0-9]+$' then
    raise exception 'Importe personalizado no válido' using errcode = '22023';
  end if;
  cash_cents := (p_params ->> 'customCashCents')::integer;
  if p_params ? 'customCashReceivedCents' and (jsonb_typeof(p_params -> 'customCashReceivedCents') is distinct from 'number'
    or (p_params ->> 'customCashReceivedCents') !~ '^[0-9]+$') then
    raise exception 'Importe recibido no válido' using errcode = '22023';
  end if;
  received := coalesce((p_params ->> 'customCashReceivedCents')::integer,cash_cents);
  request_id := nullif(p_params ->> 'cashlogyRequestId','');
  transaction_id := nullif(p_params ->> 'cashlogyTransactionId','');
  if p_total is null or p_card is null or cash_cents <= 0 or cash_cents >= p_total or received < cash_cents
    or (request_id is null) <> (transaction_id is null) then
    raise exception 'Los pagos deben sumar el total y el efectivo recibido debe cubrir su parte' using errcode = '22023';
  end if;
  return jsonb_build_array(
    jsonb_build_object('id',gen_random_uuid(),'tenantId',p_tenant,'saleId',p_sale,'method','cash',
      'amountCents',cash_cents,'receivedCents',received,'changeCents',received-cash_cents,
      'cashlogyRequestId',request_id,'cashlogyTransactionId',transaction_id),
    jsonb_build_object('id',p_card,'tenantId',p_tenant,'saleId',p_sale,'method','card',
      'amountCents',p_total-cash_cents,'receivedCents',null,'changeCents',0));
end;
$$;

-- Invoker rights retain tenant RLS for direct reads. Settlement callers already
-- hold the order group, split and cash session locks.
create function public.restaurant_equal_split_payment_parts(p_split uuid)
returns table(id uuid,tenant_id uuid,method text,amount_cents integer,received_cents integer,change_cents integer,
  cashlogy_request_id text,cashlogy_transaction_id text,created_at timestamptz,part_number integer)
language sql stable set search_path = '' as $$
  select p.id,t.tenant_id,p.method,p."amountCents",p."receivedCents",p."changeCents",
    p."cashlogyRequestId",p."cashlogyTransactionId",t.created_at,t.part_number
  from public.restaurant_equal_split_tenders t
  cross join lateral jsonb_to_recordset(coalesce(t.custom_payments,jsonb_build_array(jsonb_build_object(
    'id',t.id,'method',t.method,'amountCents',t.amount_cents,'receivedCents',t.received_cents,'changeCents',t.change_cents,
    'cashlogyRequestId',t.cashlogy_request_id,'cashlogyTransactionId',t.cashlogy_transaction_id))))
    as p(id uuid,method text,"amountCents" integer,"receivedCents" integer,"changeCents" integer,"cashlogyRequestId" text,"cashlogyTransactionId" text)
  where t.split_id = p_split and t.amount_cents > 0;
$$;


create or replace function public.guard_equal_split_cashlogy_identity() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'restaurant_equal_split_tenders' and nullif(to_jsonb(new) -> 'custom_payments','null'::jsonb) is not null then
    new.cashlogy_request_id := null; -- The header is a card aggregate for N-1 callers.
    new.cashlogy_transaction_id := null;
    if new.custom_payments -> 0 ->> 'cashlogyRequestId' is null then return new; end if;
    perform pg_advisory_xact_lock(hashtextextended('cashlogy-receipt:' || new.tenant_id::text || ':' || (new.custom_payments -> 0 ->> 'cashlogyTransactionId'),0));
    if exists(select 1 from public.sale_payments p where p.tenant_id = new.tenant_id
      and (p.cashlogy_request_id = new.custom_payments -> 0 ->> 'cashlogyRequestId' or p.cashlogy_transaction_id = new.custom_payments -> 0 ->> 'cashlogyTransactionId'))
      or exists(select 1 from public.restaurant_equal_split_tenders t where t.tenant_id = new.tenant_id and t.id <> new.id
      and (t.cashlogy_request_id = new.custom_payments -> 0 ->> 'cashlogyRequestId' or t.cashlogy_transaction_id = new.custom_payments -> 0 ->> 'cashlogyTransactionId'
        or t.custom_payments -> 0 ->> 'cashlogyRequestId' = new.custom_payments -> 0 ->> 'cashlogyRequestId'
        or t.custom_payments -> 0 ->> 'cashlogyTransactionId' = new.custom_payments -> 0 ->> 'cashlogyTransactionId')) then
      raise exception 'El cobro Cashlogy ya pertenece a otro pago' using errcode = '23505';
    end if;
    return new;
  end if;
  if new.cashlogy_request_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('cashlogy-receipt:' || new.tenant_id::text || ':' || new.cashlogy_transaction_id,0));
  if exists(select 1 from public.sale_payments p where p.tenant_id = new.tenant_id and p.id <> new.id
      and (p.cashlogy_request_id = new.cashlogy_request_id or p.cashlogy_transaction_id = new.cashlogy_transaction_id))
    or exists(select 1 from public.restaurant_equal_split_tenders t where t.tenant_id = new.tenant_id and t.id <> new.id
      and (t.custom_payments -> 0 ->> 'id') is distinct from new.id::text
      and (t.cashlogy_request_id = new.cashlogy_request_id or t.cashlogy_transaction_id = new.cashlogy_transaction_id
        or t.custom_payments -> 0 ->> 'cashlogyRequestId' = new.cashlogy_request_id
        or t.custom_payments -> 0 ->> 'cashlogyTransactionId' = new.cashlogy_transaction_id)) then
    raise exception 'El cobro Cashlogy ya pertenece a otro pago' using errcode = '23505';
  end if;
  return new;
end;
$$;

create or replace function public.pay_restaurant_equal_split_single(p_params jsonb) returns jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  p_split_id uuid := (p_params ->> 'splitId')::uuid;
  p_payment_method text := p_params ->> 'method';
  p_received_cents integer := (p_params ->> 'receivedCents')::integer;
  p_allow_pending boolean := coalesce((p_params ->> 'allowPending')::boolean, false);
  p_discount jsonb := p_params -> 'discount';
  p_use_default_discount boolean := coalesce((p_params ->> 'useDefaultDiscount')::boolean, true);
  v_device uuid := (p_params ->> 'deviceId')::uuid;
  v_subtotal integer;
  v_total integer;
  v_discount integer;
  v_method text;
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
  pending_units numeric(18,3);
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
  if split_row.single_ticket is not true or auth.uid() is null
    or split_row.paid_parts is distinct from (p_params ->> 'expectedPaidParts')::integer then
    raise exception 'El reparto ha cambiado. Actualiza antes de cobrar.' using errcode = '40001';
  end if;
  if split_row.status <> 'open' or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Division no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id for update;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0) into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not split_row.allow_pending_service and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units, 'split', public.restaurant_equal_split_single_snapshot(split_row));
  end if;
  if p_allow_pending and not split_row.allow_pending_service then
    update public.restaurant_order_equal_splits set allow_pending_service = true where id = split_row.id
    returning * into split_row;
  end if;

  select * into session_row from public.restaurant_checkout_session(order_row.tenant_id,order_row.venue_id);
  select d.* into actor_device from public.devices d where d.id = nullif(current_setting('app.restaurant_checkout_device',true),'')::uuid;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;

  if split_row.paid_parts = 0 then
    update public.restaurant_order_equal_splits set settlement_cash_session_id = session_row.id where id = split_row.id;
  elsif split_row.settlement_cash_session_id is distinct from session_row.id then
    raise exception 'Completa este reparto con ticket único en la caja que recibió el primer pago' using errcode = '55000';
  end if;
  base_amount := split_row.total_cents / split_row.part_count;
  remainder := mod(split_row.total_cents, split_row.part_count);
  part_number := split_row.paid_parts + 1;
  part_subtotal := base_amount + case when part_number <= remainder then 1 else 0 end;

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
  if p_params ? 'customCashCents' then
    if p_payment_method is distinct from 'card' then raise exception 'Método personalizado no válido'; end if;
    perform public.custom_payment_parts(order_row.tenant_id,null,part_total,payment_id,p_params);
  end if;

  if part_total = 0 then
    if p_payment_method is not null then raise exception 'Un ticket a cero no requiere metodo de pago'; end if;
  elsif p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Metodo de pago no valido';
  end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < part_total then
    raise exception 'Importe recibido insuficiente';
  end if;

  insert into public.restaurant_equal_split_tenders (
    id, tenant_id, venue_id, split_id, part_number, subtotal_cents, discount_amount_cents,
    discount, amount_cents, method, received_cents, change_cents, device_id, user_id,
    cashlogy_request_id, cashlogy_transaction_id, custom_payments
  ) values (
    payment_id, order_row.tenant_id, order_row.venue_id, split_row.id, part_number,
    part_subtotal, discount_amount, case when discount_result ->> 'type' is null then null else discount_result end,
    part_total, p_payment_method,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - part_total else 0 end,
    actor_device.id, auth.uid(),
    case when not p_params ? 'customCashCents' then nullif(p_params ->> 'cashlogyRequestId','') end,
    case when not p_params ? 'customCashCents' then nullif(p_params ->> 'cashlogyTransactionId','') end,
    case when p_params ? 'customCashCents' then public.custom_payment_parts(order_row.tenant_id,null,part_total,payment_id,p_params) end
  );
  ticket_id := null;
  sale_id := null;
  if part_number = split_row.part_count then
    ticket_id := gen_random_uuid(); sale_id := gen_random_uuid();
    select sum(subtotal_cents), sum(amount_cents), sum(discount_amount_cents),
      case when count(distinct method) = 1 and count(custom_payments) = 0 then min(method) else null end
    into v_subtotal, v_total, v_discount, v_method
    from public.restaurant_equal_split_tenders where split_id = split_row.id;
    if v_subtotal is distinct from split_row.total_cents then
      raise exception 'El importe del reparto no coincide con la comanda' using errcode = '22023';
    end if;
    insert into public.tickets (
      id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id,
      status, subtotal_cents, discount_name, discount_type, discount_value_type,
      discount_value, discount_amount_cents, total_cents, local_created_at, equal_split_id
    ) values (
      ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id,
      order_row.venue_id, actor_device.id, auth.uid(), 'paid', v_subtotal,
      case when v_discount > 0 then 'Descuentos por comensal' else null end,
      case when v_discount > 0 then 'manual' else null end,
      case when v_discount > 0 then 'fixed' else null end,
      case when v_discount > 0 then v_discount::numeric / 100 else null end,
      case when v_discount > 0 then v_discount else null end, v_total, now(), split_row.id
    );
    for line_row in select ol.* from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id loop
      insert into public.ticket_lines (
        id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
        quantity, unit_price_cents, line_total_cents, modifiers, source_order_line_id
      ) values (
        gen_random_uuid(), line_row.tenant_id, ticket_id, line_row.product_id, line_row.variant_id,
        line_row.product_name, line_row.variant_name, line_row.quantity, line_row.unit_price_cents,
        round(line_row.quantity * line_row.unit_price_cents)::integer,
        line_row.modifiers || case when line_row.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
          'id','mixer:' || line_row.mixer_product_id::text,'groupId','mixer',
          'name',line_row.mixer ->> 'name','priceCents',(line_row.mixer ->> 'priceCents')::integer)) end, line_row.id
      );
    end loop;
    insert into public.sales (
      id,tenant_id,ticket_id,cash_session_id,cash_register_id,venue_id,device_id,user_id,total_cents,payment_method,local_created_at
    ) values (sale_id,order_row.tenant_id,ticket_id,session_row.id,session_row.cash_register_id,
      order_row.venue_id,actor_device.id,auth.uid(),v_total,v_method,now());
    insert into public.sale_payments (
      id,tenant_id,sale_id,method,amount_cents,received_cents,change_cents,cashlogy_request_id,cashlogy_transaction_id,created_at,equal_split_part_number
    ) select t.id,t.tenant_id,sale_id,t.method,t.amount_cents,t.received_cents,t.change_cents,t.cashlogy_request_id,t.cashlogy_transaction_id,t.created_at,t.part_number
      from public.restaurant_equal_split_payment_parts(split_row.id) t order by t.part_number;
  end if;

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
    'split', public.restaurant_equal_split_single_snapshot(split_row),
    'ticketId', ticket_id,
    'saleId', sale_id,
    'paymentId', case when part_total > 0 then payment_id else null end,
    'paidAmountCents', part_total,
    'totalCents', v_total,
    'singleTicket', true,
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'tenantId',t.tenant_id,'saleId',sale_id,'partNumber',t.part_number,'method',t.method,'amountCents',t.amount_cents,'receivedCents',t.received_cents,'changeCents',t.change_cents,'cashlogyRequestId',t.cashlogy_request_id,'cashlogyTransactionId',t.cashlogy_transaction_id) order by t.part_number),'[]'::jsonb) from public.restaurant_equal_split_payment_parts(split_row.id) t),
    'completed', split_row.status = 'completed',
    'nextOrderId', next_order_id
  );
end;
$$;

create or replace function public.prepare_restaurant_checkout(
  p_operation_id uuid, p_tenant_id uuid, p_venue_id uuid, p_device_id uuid, p_action text, p_params jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  order_row public.orders%rowtype; device_row public.devices%rowtype; session_row public.cash_sessions%rowtype;
  split_row public.restaurant_order_equal_splits%rowtype; prior public.restaurant_checkout_claims%rowtype;
  order_id uuid; session_id uuid;
  economic_params jsonb := p_params - array['allowPending','receivedCents','customCashReceivedCents','cashlogyRequestId','cashlogyTransactionId','paymentOperationId'];
begin
  if auth.uid() is null or p_operation_id is null or p_action is null
    or p_action not in ('close','equal_part','selected_items') or jsonb_typeof(p_params) is distinct from 'object'
    or public.user_has_device_access(p_tenant_id, p_venue_id, p_device_id) is not true then
    raise exception 'PAYMENT_OPERATION_FORBIDDEN' using errcode = '42501';
  end if;
  select * into device_row from public.devices where id = p_device_id;
  if device_row.is_active is not true or device_row.can_take_payments is not true
    or (device_row.tenant_id, device_row.venue_id) is distinct from (p_tenant_id, p_venue_id) then
    raise exception 'El dispositivo no puede cobrar en este local' using errcode = '42501';
  end if;
  session_id := coalesce(nullif(p_params ->> 'cashSessionId','')::uuid, device_row.active_cash_session_id);
  select * into prior from public.restaurant_checkout_claims where operation_id = p_operation_id;
  if prior.operation_id is not null then
    if (prior.tenant_id,prior.venue_id,prior.device_id,prior.user_id,prior.cash_session_id,prior.action,prior.params)
      is distinct from (p_tenant_id,p_venue_id,p_device_id,auth.uid(),session_id,p_action,economic_params) then
      raise exception 'PAYMENT_OPERATION_CONFLICT' using errcode = '23505';
    end if;
    if prior.cancelled then raise exception 'Este intento de cobro se canceló. Inicia un cobro nuevo.' using errcode = '55000'; end if;
    -- Completed operations remain replayable after closing their cash session.
    if not prior.active then return; end if;
    order_id := prior.order_id;
  elsif p_action = 'equal_part' then
    select s.order_id into order_id from public.restaurant_order_equal_splits s
    where s.id = (p_params ->> 'splitId')::uuid and s.tenant_id = p_tenant_id and s.venue_id = p_venue_id;
  else order_id := (p_params ->> 'orderId')::uuid;
  end if;
  select * into order_row from public.orders where id = order_id and tenant_id = p_tenant_id and venue_id = p_venue_id;
  if order_row.id is null then raise exception 'PAYMENT_ORDER_FORBIDDEN' using errcode = '42501'; end if;
  -- Match the economic routines: group -> orders -> checkout session.
  perform 1 from public.order_groups where id = order_row.order_group_id for update;
  perform 1 from public.orders where order_group_id = order_row.order_group_id order by id for update;
  select * into order_row from public.orders where id = order_id;
  if order_row.status <> 'open' then raise exception 'La comanda ya no está abierta' using errcode = '55000'; end if;
  if exists(select 1 from public.restaurant_checkout_claims where order_group_id = order_row.order_group_id
    and active and operation_id <> p_operation_id) then
    raise exception 'Esta cuenta tiene un cobro en curso en otro terminal. Finalízalo o recupéralo allí.' using errcode = '55000';
  end if;
  if prior.operation_id is null and p_params ? 'expectedRevision'
    and order_row.revision is distinct from (p_params ->> 'expectedRevision')::integer then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  if p_action = 'equal_part' then
    select * into split_row from public.restaurant_order_equal_splits where id = (p_params ->> 'splitId')::uuid for update;
    if split_row.status <> 'open' or (prior.operation_id is null and p_params ? 'expectedPaidParts'
      and split_row.paid_parts is distinct from (p_params ->> 'expectedPaidParts')::integer) then
      raise exception 'El reparto ha cambiado en otro dispositivo' using errcode = '40001';
    end if;
    if split_row.single_ticket and split_row.paid_parts > 0
      and split_row.settlement_cash_session_id is distinct from session_id then
      raise exception 'Completa este reparto con ticket único en la caja que recibió el primer pago' using errcode = '55000';
    end if;
  end if;
  select * into session_row from public.cash_sessions where id = session_id for update;
  if session_row.id is null or session_row.status <> 'open'
    or (session_row.tenant_id,session_row.venue_id) is distinct from (p_tenant_id,p_venue_id)
    or device_row.active_cash_session_id is distinct from session_row.id then
    raise exception 'Selecciona una caja abierta de este local para cobrar' using errcode = '42501';
  end if;
  insert into public.restaurant_checkout_claims(operation_id,tenant_id,venue_id,order_group_id,order_id,cash_session_id,device_id,user_id,action,params)
  values(p_operation_id,p_tenant_id,p_venue_id,order_row.order_group_id,order_row.id,session_row.id,p_device_id,auth.uid(),p_action,economic_params)
  on conflict (operation_id) do nothing;
  perform set_config('app.restaurant_checkout_session',session_row.id::text,true);
  perform set_config('app.restaurant_checkout_device',p_device_id::text,true);
  perform set_config('app.restaurant_checkout_operation',p_operation_id::text,true);
end;
$$;

create or replace function public.pay_restaurant_idempotent(p_operation_id uuid, p_tenant_id uuid, p_venue_id uuid, p_device_id uuid, p_action text, p_params jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare prior public.restaurant_payment_operations%rowtype; answer jsonb; order_id uuid; custom_parts jsonb;
begin
  if auth.uid() is null or p_operation_id is null or p_action is null or p_action not in ('close','equal_part','selected_items')
    or jsonb_typeof(p_params) is distinct from 'object'
    or public.user_has_device_access(p_tenant_id, p_venue_id, p_device_id) is not true then
    raise exception 'PAYMENT_OPERATION_FORBIDDEN' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('restaurant-payment:' || p_operation_id::text, 0));
  select * into prior from public.restaurant_payment_operations where operation_id = p_operation_id;
  if prior.operation_id is not null then
    -- Confirmation of pending production is needed before first commit only.
    -- It cannot change the identity of an already committed economic operation.
    if (prior.tenant_id, prior.venue_id, prior.device_id, prior.user_id, prior.action, prior.params - 'allowPending')
      is distinct from (p_tenant_id, p_venue_id, p_device_id, auth.uid(), p_action, p_params - 'allowPending') then
      raise exception 'PAYMENT_OPERATION_CONFLICT' using errcode = '23505';
    end if;
    return prior.result;
  end if;
  if p_action = 'equal_part' then
    select s.order_id into order_id from public.restaurant_order_equal_splits s
      where s.id = (p_params ->> 'splitId')::uuid and s.tenant_id = p_tenant_id and s.venue_id = p_venue_id;
  else order_id := (p_params ->> 'orderId')::uuid;
  end if;
  if not exists(select 1 from public.orders o where o.id = order_id and o.tenant_id = p_tenant_id and o.venue_id = p_venue_id) then
    raise exception 'PAYMENT_ORDER_FORBIDDEN' using errcode = '42501';
  end if;
  perform public.prepare_restaurant_checkout(p_operation_id,p_tenant_id,p_venue_id,p_device_id,p_action,p_params);
  if p_action = 'close' then
    if nullif(p_params ->> 'cashlogyRequestId','') is not null and not p_params ? 'customCashCents' then
      answer := public.close_restaurant_order_cashlogy(order_id, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId', nullif(p_params ->> 'customerId','')::uuid);
    elsif nullif(p_params ->> 'customerId','') is not null then
      answer := public.close_restaurant_order_with_invoice(order_id, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'customerId')::uuid);
    else
      answer := public.close_restaurant_order_checked_v2(order_id, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  elsif p_action = 'equal_part' then
    if coalesce((p_params ->> 'singleTicket')::boolean,false) then
      answer := public.pay_restaurant_equal_split_single(p_params || jsonb_build_object('deviceId',p_device_id));
    elsif nullif(p_params ->> 'cashlogyRequestId','') is not null and not p_params ? 'customCashCents' then
      answer := public.pay_restaurant_order_equal_part_cashlogy((p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'useDefaultDiscount')::boolean,
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      answer := public.pay_restaurant_order_equal_part((p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'useDefaultDiscount')::boolean);
    end if;
  else
    if nullif(p_params ->> 'cashlogyRequestId','') is not null and not p_params ? 'customCashCents' then
      answer := public.pay_restaurant_order_items_cashlogy(order_id, (p_params ->> 'expectedRevision')::integer, p_params -> 'moves',
        p_params ->> 'method', (p_params ->> 'receivedCents')::integer, (p_params ->> 'allowPending')::boolean,
        p_params -> 'discount', p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      answer := public.pay_restaurant_order_items(order_id, (p_params ->> 'expectedRevision')::integer, p_params -> 'moves',
        p_params ->> 'method', (p_params ->> 'receivedCents')::integer, (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  end if;
  if coalesce((answer ->> 'requiresConfirmation')::boolean, false) then return answer; end if;

  if p_params ? 'customCashCents' and not coalesce((p_params ->> 'singleTicket')::boolean,false) and not coalesce((answer ->> 'requiresConfirmation')::boolean,false) then
    select public.custom_payment_parts(s.tenant_id,s.id,s.total_cents,(answer ->> 'paymentId')::uuid,p_params)
      into custom_parts from public.sales s where s.id = (answer ->> 'saleId')::uuid;
    if custom_parts is null then raise exception 'Falta la venta del pago personalizado' using errcode = '22023'; end if;
    update public.sale_payments set amount_cents = (custom_parts -> 1 ->> 'amountCents')::integer
      where id = (answer ->> 'paymentId')::uuid and method = 'card';
    if not found then raise exception 'El cobro personalizado requiere una venta nueva' using errcode = '22023'; end if;
    insert into public.sale_payments(id,tenant_id,sale_id,method,amount_cents,received_cents,change_cents,cashlogy_request_id,cashlogy_transaction_id)
      values((custom_parts -> 0 ->> 'id')::uuid,(custom_parts -> 0 ->> 'tenantId')::uuid,(answer ->> 'saleId')::uuid,'cash',
        (custom_parts -> 0 ->> 'amountCents')::integer,(custom_parts -> 0 ->> 'receivedCents')::integer,(custom_parts -> 0 ->> 'changeCents')::integer,
        custom_parts -> 0 ->> 'cashlogyRequestId',custom_parts -> 0 ->> 'cashlogyTransactionId');
    update public.sales set payment_method = null where id = (answer ->> 'saleId')::uuid;
    answer := answer || jsonb_build_object('payments',custom_parts);
  end if;
  insert into public.restaurant_payment_operations(operation_id,tenant_id,venue_id,device_id,user_id,action,params,result)
  values(p_operation_id,p_tenant_id,p_venue_id,p_device_id,auth.uid(),p_action,p_params,answer);
  update public.restaurant_checkout_claims set active = false where operation_id = p_operation_id;
  return answer;
end;
$$;

create or replace function public.pay_restaurant_local_fiscal(
  p_action text, p_params jsonb, p_record jsonb, p_invoice jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  custom_parts jsonb;
  v_installation public.fiscal_sif_installations%rowtype;
  v_subject public.fiscal_subjects%rowtype;
  v_prior public.fiscal_local_records%rowtype;
  v_existing public.fiscal_local_records%rowtype;
  v_series public.fiscal_local_series%rowtype;
  v_canonical jsonb := p_record -> 'canonicalRecord' -> 'RegistroAlta';
  v_type text := v_canonical ->> 'TipoFactura';
  v_idempotency uuid := (p_record ->> 'idempotencyKey')::uuid;
  v_position bigint := (p_record ->> 'chainPosition')::bigint;
  v_previous_hash text := p_record -> 'previous' ->> 'hash';
  v_hash text := p_record ->> 'hash';
  v_number bigint := (p_invoice ->> 'number')::bigint;
  v_series_name text := p_invoice ->> 'series';
  v_issued_at timestamptz := (p_invoice ->> 'issuedAt')::timestamptz;
  v_exercise integer := public.fiscal_series_exercise(v_series_name);
  v_timezone text;
  v_expected_series text;
  v_kind text;
  v_result jsonb;
  v_ticket uuid;
  v_sale uuid;
  v_payment uuid;
  v_total bigint;
  v_customer uuid := nullif(p_params ->> 'customerId', '')::uuid;
begin
  if auth.uid() is null or p_action not in ('close', 'equal_part', 'selected_items')
    or jsonb_typeof(p_params) <> 'object' or jsonb_typeof(p_record) <> 'object'
    or jsonb_typeof(p_invoice) <> 'object' or jsonb_typeof(v_canonical) <> 'object' then
    raise exception 'LOCAL_FISCAL_BAD_REQUEST' using errcode = '22023';
  end if;
  select * into v_existing from public.fiscal_local_records r
    where r.tenant_id = (p_record ->> 'tenantId')::uuid and r.idempotency_key = v_idempotency;
  if v_existing.id is not null then
    if v_existing.record_envelope is distinct from p_record
      or v_existing.invoice_snapshot is distinct from p_invoice
      or v_existing.rpc_result is null then
      raise exception 'LOCAL_FISCAL_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return v_existing.rpc_result;
  end if;
  select * into v_installation from public.fiscal_sif_installations i
    where i.id = (p_record ->> 'installationId')::uuid for update;
  if v_installation.id is null or (v_installation.retired_at is not null and ((p_record ->> 'generatedAt') is null or (p_record ->> 'generatedAt')::timestamptz >= v_installation.retired_at)) or v_installation.mode <> 'production'
    or (v_installation.tenant_id::text, v_installation.venue_id::text,
        v_installation.cash_register_id::text, v_installation.device_id::text)
      is distinct from (p_record ->> 'tenantId', p_record ->> 'venueId',
        p_record ->> 'cashRegisterId', p_record ->> 'deviceId')
    or not public.user_has_device_access(v_installation.tenant_id, v_installation.venue_id, v_installation.device_id) then
    raise exception 'LOCAL_FISCAL_INSTALLATION_FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_subject from public.fiscal_subjects s
    where s.id = v_installation.fiscal_subject_id and s.tenant_id = v_installation.tenant_id;
  select coalesce(v.timezone, 'Europe/Madrid') into v_timezone from public.venues v
    where v.id = v_installation.venue_id and v.tenant_id = v_installation.tenant_id;
  if v_subject.id is null or v_timezone is null
    or p_record ->> 'fiscalSubjectId' <> v_subject.id::text
    or p_record ->> 'issuerNif' <> v_subject.nif
    or p_record ->> 'environment' <> 'production'
    or p_record ->> 'generatedAt' <> p_invoice ->> 'issuedAt'
    or p_record ->> 'canonicalSchema' <> 'aeat-registro-v1'
    or p_record ->> 'invoiceId' <> p_invoice ->> 'invoiceId'
    or coalesce((p_record -> 'lease' ->> 'fencingToken')::bigint, 0) < 1
    or v_hash !~ '^[0-9A-F]{64}$'
    or v_canonical ->> 'Huella' <> v_hash
    or v_canonical -> 'IDFactura' ->> 'IDEmisorFactura' <> v_subject.nif
    or v_canonical -> 'IDFactura' ->> 'NumSerieFactura' <> v_series_name || '/' || v_number::text
    or v_canonical -> 'IDFactura' ->> 'FechaExpedicionFactura'
      <> to_char(v_issued_at at time zone v_timezone, 'DD-MM-YYYY')
    or v_canonical ->> 'FechaHoraHusoGenRegistro' <> p_record ->> 'generatedAt'
    or (v_canonical ->> 'ImporteTotal')::numeric * 100 <> (p_invoice ->> 'totalCents')::numeric then
    raise exception 'LOCAL_FISCAL_RECORD_MISMATCH' using errcode = '22023';
  end if;
  v_kind := case when v_type = 'F1' then 'complete' when v_type = 'F2' then 'simplified' else null end;
  v_expected_series := public.fiscal_installation_series_prefix(v_installation) || '-' || v_exercise::text || '-'
    || case when v_type = 'F1' then 'F' else 'S' end;
  if v_kind is null or v_number < 1 or v_series_name <> v_expected_series
    or v_exercise <> extract(year from v_issued_at at time zone v_timezone)::integer then
    raise exception 'LOCAL_FISCAL_SERIES_MISMATCH' using errcode = '22023';
  end if;
  if (v_type = 'F1' and (v_customer is null
      or p_params -> 'customerSnapshot' ->> 'taxId'
        <> v_canonical -> 'Destinatarios' -> 'IDDestinatario' -> 0 ->> 'NIF'
      or not exists (select 1 from public.customers c where c.id = v_customer and c.tenant_id = v_installation.tenant_id)))
    or (v_type = 'F2' and v_customer is not null) then
    raise exception 'LOCAL_FISCAL_RECIPIENT_MISMATCH' using errcode = '22023';
  end if;
  if exists (select 1 from public.fiscal_integration_settings s
    where s.tenant_id = v_installation.tenant_id and s.enabled) then
    raise exception 'LOCAL_FISCAL_LEGACY_PROVIDER_ENABLED' using errcode = '55000';
  end if;
  select * into v_prior from public.fiscal_local_records r
    where r.tenant_id = v_installation.tenant_id and r.fiscal_subject_id = v_subject.id
      and r.installation_id = v_installation.id
    order by r.chain_position desc limit 1;
  if v_position <> coalesce(v_prior.chain_position, 0) + 1
    or (v_prior.id is null and v_previous_hash is not null)
    or (v_prior.id is null and v_canonical -> 'Encadenamiento' ->> 'PrimerRegistro' is distinct from 'S')
    or (v_prior.id is not null and v_previous_hash is distinct from v_prior.hash)
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'issuerNif') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'IDEmisorFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'IDEmisorFacturaAnulada'))
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'seriesAndNumber') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'NumSerieFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'NumSerieFacturaAnulada'))
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'issueDate') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'FechaExpedicionFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'FechaExpedicionFacturaAnulada'))
    or (v_prior.id is not null and v_canonical -> 'Encadenamiento' -> 'RegistroAnterior' is distinct from
      jsonb_build_object('IDEmisorFactura', p_record -> 'previous' ->> 'issuerNif',
        'NumSerieFactura', p_record -> 'previous' ->> 'seriesAndNumber',
        'FechaExpedicionFactura', p_record -> 'previous' ->> 'issueDate', 'Huella', v_previous_hash)) then
    raise exception 'LOCAL_FISCAL_CHAIN_CONFLICT' using errcode = '23505';
  end if;
  insert into public.fiscal_local_series (
    tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,device_id,
    document_kind,exercise,series
  ) values (v_installation.tenant_id,v_subject.id,v_installation.id,v_installation.venue_id,
    v_installation.cash_register_id,v_installation.device_id,v_kind,v_exercise,v_series_name)
  on conflict (tenant_id,fiscal_subject_id,series) do nothing;
  select * into v_series from public.fiscal_local_series s
    where s.tenant_id = v_installation.tenant_id and s.fiscal_subject_id = v_subject.id
      and s.series = v_series_name for update;
  if v_series.id is null or v_series.installation_id <> v_installation.id
    or v_series.document_kind <> v_kind or v_series.last_number + 1 <> v_number then
    raise exception 'LOCAL_FISCAL_NUMBER_CONFLICT' using errcode = '23505';
  end if;

  perform public.prepare_restaurant_checkout((p_params ->> 'paymentOperationId')::uuid,
    v_installation.tenant_id,v_installation.venue_id,v_installation.device_id,p_action,p_params);
  perform set_config('app.local_fiscal_sale', 'yes', true);
  if p_action = 'close' then
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.close_restaurant_order_cashlogy(
        (p_params ->> 'orderId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId', null);
    else
      v_result := public.close_restaurant_order_checked_v2(
        (p_params ->> 'orderId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  elsif p_action = 'equal_part' then
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.pay_restaurant_order_equal_part_cashlogy(
        (p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        (p_params ->> 'useDefaultDiscount')::boolean,
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      v_result := public.pay_restaurant_order_equal_part(
        (p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        (p_params ->> 'useDefaultDiscount')::boolean);
    end if;
  else
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.pay_restaurant_order_items_cashlogy(
        (p_params ->> 'orderId')::uuid, (p_params ->> 'expectedRevision')::integer,
        p_params -> 'moves', p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      v_result := public.pay_restaurant_order_items(
        (p_params ->> 'orderId')::uuid, (p_params ->> 'expectedRevision')::integer,
        p_params -> 'moves', p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  end if;
  if coalesce((v_result ->> 'requiresConfirmation')::boolean, false) then return v_result; end if;

  if p_params ? 'customCashCents' and not coalesce((v_result ->> 'requiresConfirmation')::boolean,false) then
    select public.custom_payment_parts(s.tenant_id,s.id,s.total_cents,(v_result ->> 'paymentId')::uuid,p_params)
      into custom_parts from public.sales s where s.id = (v_result ->> 'saleId')::uuid;
    if custom_parts is null then raise exception 'Falta la venta del pago personalizado' using errcode = '22023'; end if;
    update public.sale_payments set amount_cents = (custom_parts -> 1 ->> 'amountCents')::integer
      where id = (v_result ->> 'paymentId')::uuid and method = 'card';
    if not found then raise exception 'El cobro personalizado requiere una venta nueva' using errcode = '22023'; end if;
    insert into public.sale_payments(id,tenant_id,sale_id,method,amount_cents,received_cents,change_cents,cashlogy_request_id,cashlogy_transaction_id)
      values((custom_parts -> 0 ->> 'id')::uuid,(custom_parts -> 0 ->> 'tenantId')::uuid,(v_result ->> 'saleId')::uuid,'cash',
        (custom_parts -> 0 ->> 'amountCents')::integer,(custom_parts -> 0 ->> 'receivedCents')::integer,(custom_parts -> 0 ->> 'changeCents')::integer,
        custom_parts -> 0 ->> 'cashlogyRequestId',custom_parts -> 0 ->> 'cashlogyTransactionId');
    update public.sales set payment_method = null where id = (v_result ->> 'saleId')::uuid;
    v_result := v_result || jsonb_build_object('payments',custom_parts);
  end if;
  v_ticket := (v_result ->> 'ticketId')::uuid;
  v_sale := (v_result ->> 'saleId')::uuid;
  v_payment := nullif(v_result ->> 'paymentId', '')::uuid;
  v_total := (coalesce(v_result ->> 'totalCents', v_result ->> 'paidAmountCents'))::bigint;
  -- Legacy restaurant RPCs choose the first assigned device for the cashier.
  -- Bind the new paid document to the authenticated checkout installation.
  update public.tickets t set device_id = v_installation.device_id
    where t.id = v_ticket and t.tenant_id = v_installation.tenant_id
      and t.venue_id = v_installation.venue_id and t.cash_register_id = v_installation.cash_register_id;
  update public.sales s set device_id = v_installation.device_id
    where s.id = v_sale and s.tenant_id = v_installation.tenant_id
      and s.venue_id = v_installation.venue_id and s.cash_register_id = v_installation.cash_register_id;
  if v_ticket is null or v_sale is null or v_total is null
    or v_total <> (p_invoice ->> 'totalCents')::bigint
    or not exists (select 1 from public.sales s where s.id = v_sale and s.ticket_id = v_ticket
      and s.tenant_id = v_installation.tenant_id and s.venue_id = v_installation.venue_id
      and s.cash_register_id = v_installation.cash_register_id and s.device_id = v_installation.device_id) then
    raise exception 'LOCAL_FISCAL_RESTAURANT_SALE_MISMATCH' using errcode = '22023';
  end if;
  if v_type = 'F1' then
    update public.tickets t set is_invoice = true, customer_id = v_customer,
      customer_snapshot = p_params -> 'customerSnapshot', invoice_series = v_series_name,
      invoice_number = v_number::text, invoice_issued_at = v_issued_at
    where t.id = v_ticket and t.tenant_id = v_installation.tenant_id and t.status = 'paid';
    if not found then raise exception 'LOCAL_FISCAL_TICKET_NOT_STORED' using errcode = '55000'; end if;
  end if;
  insert into public.fiscal_local_records (
    id,tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,
    invoice_id,ticket_id,sale_id,record_kind,chain_position,previous_hash,hash,
    canonical_schema,canonical_record,record_envelope,invoice_snapshot,
    generated_at,idempotency_key,rpc_result
  ) values (v_idempotency,v_installation.tenant_id,v_subject.id,v_installation.id,v_installation.venue_id,
    v_installation.cash_register_id,(p_record ->> 'invoiceId')::uuid,v_ticket,v_sale,'alta',v_position,
    v_previous_hash,v_hash,'aeat-registro-v1',p_record -> 'canonicalRecord',p_record,p_invoice,
    (p_record ->> 'generatedAt')::timestamptz,v_idempotency,v_result);
  update public.fiscal_local_series set last_number = v_number where id = v_series.id;
  update public.restaurant_checkout_claims set active = false where operation_id = (p_params ->> 'paymentOperationId')::uuid;
  return v_result;
end;
$$;

create or replace function public.sync_sale_created_v2(p_event_id uuid, p_payload jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  ticket_payload jsonb := p_payload -> 'ticket';
  sale_payload jsonb := p_payload -> 'sale';
  payment_payload jsonb := p_payload -> 'payment';
  custom_parts jsonb := p_payload -> 'payments';
  custom_part jsonb;
  custom_sum bigint := 0;
  custom_ids uuid[] := '{}';
  tenant_id_value uuid := (ticket_payload ->> 'tenantId')::uuid;
  ticket_id_value uuid := (ticket_payload ->> 'id')::uuid;
  sale_id_value uuid := (sale_payload ->> 'id')::uuid;
  cash_session_id_value uuid := (ticket_payload ->> 'cashSessionId')::uuid;
  cash_register_id_value uuid := nullif(ticket_payload ->> 'cashRegisterId', '')::uuid;
  venue_id_value uuid := (ticket_payload ->> 'venueId')::uuid;
  device_id_value uuid := (ticket_payload ->> 'deviceId')::uuid;
  payment_method_value text := nullif(sale_payload ->> 'paymentMethod', '');
  subtotal_cents_value integer := (ticket_payload ->> 'subtotalCents')::integer;
  discount_amount_cents_value integer := (ticket_payload ->> 'discountAmountCents')::integer;
  total_cents_value integer := (ticket_payload ->> 'totalCents')::integer;
  sale_total_cents_value integer := (sale_payload ->> 'totalCents')::integer;
  discount_snapshot_value jsonb := ticket_payload -> 'discount';
  discount_id_snapshot uuid;
  discount_id_value uuid;
  discount_stored_value numeric;
  line_count integer;
  lines_total bigint;
  lines_discount_total bigint;
  lines_net_total bigint;
  lines_are_valid boolean;
  allocations_are_valid boolean;
  allocation_count integer;
  snapshot_eligible_total bigint;
  generated_allocations jsonb;
  received_cents_value integer;
  change_cents_value integer;
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  logged_event_id uuid;
begin
  if current_user_id is null then raise exception 'Se requiere un usuario autenticado' using errcode = '42501'; end if;
  if p_event_id is null
    or jsonb_typeof(p_payload) is distinct from 'object'
    or jsonb_typeof(ticket_payload) is distinct from 'object'
    or jsonb_typeof(sale_payload) is distinct from 'object'
    or jsonb_typeof(p_payload -> 'lines') is distinct from 'array' then
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

  select
    count(*),
    coalesce(sum((line ->> 'lineTotalCents')::bigint), 0),
    coalesce(sum(coalesce((line ->> 'discountAmountCents')::bigint, 0)), 0),
    coalesce(sum(coalesce((line ->> 'netTotalCents')::bigint, (line ->> 'lineTotalCents')::bigint)), 0),
    coalesce(bool_and(
      (line ->> 'tenantId')::uuid = tenant_id_value
      and (line ->> 'ticketId')::uuid = ticket_id_value
      and (line ->> 'quantity')::numeric(18,3) > 0
      and (line ->> 'unitPriceCents')::bigint >= 0
      and (line ->> 'lineTotalCents')::bigint = round((line ->> 'unitPriceCents')::numeric * (line ->> 'quantity')::numeric(18,3))::bigint
      and coalesce((line ->> 'discountAmountCents')::bigint, 0) >= 0
      and coalesce((line ->> 'discountAmountCents')::bigint, 0) <= (line ->> 'lineTotalCents')::bigint
      and coalesce((line ->> 'netTotalCents')::bigint, (line ->> 'lineTotalCents')::bigint)
        = (line ->> 'lineTotalCents')::bigint - coalesce((line ->> 'discountAmountCents')::bigint, 0)
    ), false)
  into line_count, lines_total, lines_discount_total, lines_net_total, lines_are_valid
  from jsonb_array_elements(p_payload -> 'lines') as line;
  if line_count = 0 or not lines_are_valid then raise exception 'Las lineas de la venta no son validas'; end if;

  if subtotal_cents_value is null or discount_amount_cents_value is null or total_cents_value is null
    or subtotal_cents_value < 0 or discount_amount_cents_value < 0 or total_cents_value < 0
    or subtotal_cents_value - discount_amount_cents_value <> total_cents_value
    or subtotal_cents_value::bigint <> lines_total
    or discount_amount_cents_value::bigint <> lines_discount_total
    or total_cents_value::bigint <> lines_net_total
    or sale_total_cents_value is null or sale_total_cents_value <> total_cents_value then
    raise exception 'Los importes enviados no son internamente coherentes';
  end if;

  if discount_snapshot_value is not null and jsonb_typeof(discount_snapshot_value) = 'null' then
    discount_snapshot_value := null;
  end if;
  if discount_snapshot_value is null then
    if discount_amount_cents_value <> 0 then
      raise exception 'Falta el snapshot del descuento cobrado';
    end if;
  elsif jsonb_typeof(discount_snapshot_value) is distinct from 'object'
    or nullif(btrim(discount_snapshot_value ->> 'name'), '') is null
    or coalesce(discount_snapshot_value ->> 'type', '') not in ('percentage', 'fixed', 'manual')
    or coalesce(discount_snapshot_value ->> 'calculationType', '') not in ('percentage', 'fixed') then
    raise exception 'El snapshot del descuento no es valido';
  else
    if discount_snapshot_value ? 'amountCents'
      and (discount_snapshot_value ->> 'amountCents')::integer is distinct from discount_amount_cents_value then
      raise exception 'El importe del snapshot no coincide con el ticket';
    end if;
    if discount_snapshot_value ? 'discountAmountCents'
      and (discount_snapshot_value ->> 'discountAmountCents')::integer is distinct from discount_amount_cents_value then
      raise exception 'El importe del snapshot no coincide con el ticket';
    end if;
    if discount_snapshot_value ? 'totalCents'
      and (discount_snapshot_value ->> 'totalCents')::integer is distinct from total_cents_value then
      raise exception 'El total del snapshot no coincide con el ticket';
    end if;

    discount_id_snapshot := nullif(discount_snapshot_value ->> 'discountId', '')::uuid;
    if discount_id_snapshot is not null then
      select d.id into discount_id_value from public.discounts d
      where d.id = discount_id_snapshot and d.tenant_id = tenant_id_value and d.venue_id = venue_id_value;
      if discount_id_value is null and exists (select 1 from public.discounts d where d.id = discount_id_snapshot) then
        raise exception 'El descuento no pertenece al negocio y local de la venta' using errcode = '42501';
      end if;
    end if;

    discount_stored_value := coalesce(
      nullif(discount_snapshot_value ->> 'storedValue', '')::numeric,
      case when discount_snapshot_value ->> 'calculationType' = 'fixed'
        then (discount_snapshot_value ->> 'value')::numeric / 100
        else (discount_snapshot_value ->> 'value')::numeric end
    );
    if discount_stored_value is null or discount_stored_value <= 0 then
      raise exception 'El valor del snapshot del descuento no es valido';
    end if;

    if discount_snapshot_value ? 'lineAllocations' then
      if jsonb_typeof(discount_snapshot_value -> 'lineAllocations') is distinct from 'array' then
        raise exception 'Las asignaciones del descuento no son validas';
      end if;
      select count(*), coalesce(bool_and(
        (allocation ->> 'index')::integer = ordinality - 1
        and allocation ->> 'lineId' = source_line ->> 'id'
        and (allocation ->> 'grossCents')::bigint = (source_line ->> 'lineTotalCents')::bigint
        and (allocation ->> 'discountAmountCents')::bigint = coalesce((source_line ->> 'discountAmountCents')::bigint, 0)
        and (allocation ->> 'netCents')::bigint = coalesce((source_line ->> 'netTotalCents')::bigint, (source_line ->> 'lineTotalCents')::bigint)
      ), false), coalesce(sum(case when (allocation ->> 'eligible')::boolean
        then (allocation ->> 'grossCents')::bigint else 0 end), 0)
      into allocation_count, allocations_are_valid, snapshot_eligible_total
      from jsonb_array_elements(discount_snapshot_value -> 'lineAllocations') with ordinality as item(allocation, ordinality)
      cross join lateral (select (p_payload -> 'lines') -> ((ordinality - 1)::integer) as source_line) source;
      if allocation_count <> line_count or not allocations_are_valid then
        raise exception 'Las asignaciones del descuento no coinciden con las lineas cobradas';
      end if;
      if discount_snapshot_value ? 'eligibleSubtotalCents'
        and (discount_snapshot_value ->> 'eligibleSubtotalCents')::bigint is distinct from snapshot_eligible_total then
        raise exception 'El subtotal elegible no coincide con las asignaciones cobradas';
      end if;
    else
      select jsonb_agg(jsonb_build_object(
        'index', ordinality - 1,
        'lineId', line ->> 'id',
        'productId', line ->> 'productId',
        'variantId', nullif(line ->> 'variantId', ''),
        'eligible', coalesce((line ->> 'discountAmountCents')::integer, 0) > 0,
        'grossCents', (line ->> 'lineTotalCents')::integer,
        'discountAmountCents', coalesce((line ->> 'discountAmountCents')::integer, 0),
        'netCents', coalesce((line ->> 'netTotalCents')::integer, (line ->> 'lineTotalCents')::integer)
      ) order by ordinality)
      into generated_allocations
      from jsonb_array_elements(p_payload -> 'lines') with ordinality as item(line, ordinality);
      discount_snapshot_value := discount_snapshot_value || jsonb_build_object('lineAllocations', generated_allocations);
    end if;

    discount_snapshot_value := discount_snapshot_value || jsonb_build_object(
      'economicSource', 'pos_closed_sale',
      'economicSnapshotVersion', 1,
      'storedValue', discount_stored_value,
      'eligibleSubtotalCents', coalesce(
        nullif(discount_snapshot_value ->> 'eligibleSubtotalCents', '')::integer,
        subtotal_cents_value
      ),
      'discountAmountCents', discount_amount_cents_value,
      'amountCents', discount_amount_cents_value,
      'totalCents', total_cents_value
    );
  end if;

  if custom_parts is not null and jsonb_typeof(custom_parts) <> 'null' then
    if jsonb_typeof(custom_parts) is distinct from 'array' or jsonb_array_length(custom_parts) <> 2
      or payment_method_value is not null or jsonb_typeof(payment_payload) is distinct from 'null' then
      raise exception 'Desglose de pago no válido' using errcode = '22023';
    end if;
    for custom_part in select value from jsonb_array_elements(custom_parts) loop
      if jsonb_typeof(custom_part) is distinct from 'object'
        or (custom_part ->> 'tenantId')::uuid is distinct from tenant_id_value
        or (custom_part ->> 'saleId')::uuid is distinct from sale_id_value
        or (custom_part ->> 'id') is null or (custom_part ->> 'id')::uuid = any(custom_ids)
        or (custom_part ->> 'amountCents') is null or (custom_part ->> 'amountCents') !~ '^[0-9]+$'
        or (custom_part ->> 'amountCents')::integer <= 0
        or (custom_part ->> 'changeCents') is null or (custom_part ->> 'changeCents') !~ '^[0-9]+$'
        or coalesce(custom_part ->> 'method','') not in ('cash','card') then
        raise exception 'El pago no coincide con la venta' using errcode = '22023';
      end if;
      received_cents_value := (custom_part ->> 'receivedCents')::integer;
      change_cents_value := (custom_part ->> 'changeCents')::integer;
      if custom_part ->> 'method' = 'cash' then
        if jsonb_typeof(custom_part -> 'receivedCents') is distinct from 'number' or (custom_part ->> 'receivedCents') !~ '^[0-9]+$'
          or received_cents_value is null or received_cents_value < (custom_part ->> 'amountCents')::integer
          or change_cents_value <> received_cents_value - (custom_part ->> 'amountCents')::integer
          or (nullif(custom_part ->> 'cashlogyRequestId','') is null) <> (nullif(custom_part ->> 'cashlogyTransactionId','') is null) then
          raise exception 'Importes de efectivo no válidos' using errcode = '22023';
        end if;
      elsif received_cents_value is not null or change_cents_value <> 0
        or nullif(custom_part ->> 'cashlogyRequestId','') is not null or nullif(custom_part ->> 'cashlogyTransactionId','') is not null then
        raise exception 'Importes de tarjeta no válidos' using errcode = '22023';
      end if;
      custom_ids := array_append(custom_ids,(custom_part ->> 'id')::uuid);
      custom_sum := custom_sum + (custom_part ->> 'amountCents')::integer;
    end loop;
    if custom_sum <> total_cents_value or total_cents_value <= 0
      or custom_parts -> 0 ->> 'method' is not distinct from custom_parts -> 1 ->> 'method' then
      raise exception 'Los pagos no suman el total' using errcode = '22023';
    end if;
  else
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
    discount_value, discount_amount_cents, total_cents, discount_rounding_increment_cents,
    discount_rule_kind, discount_scope, discount_automatic, discount_snapshot,
    local_created_at, created_at
  ) values (
    ticket_id_value, tenant_id_value, cash_session_id_value, cash_register_id_value, venue_id_value,
    device_id_value, current_user_id, 'paid', subtotal_cents_value,
    discount_id_value, discount_snapshot_value ->> 'name', discount_snapshot_value ->> 'type',
    discount_snapshot_value ->> 'calculationType', discount_stored_value,
    case when discount_snapshot_value is null then null else discount_amount_cents_value end,
    total_cents_value, nullif(discount_snapshot_value ->> 'roundingIncrementCents', '')::integer,
    discount_snapshot_value ->> 'ruleKind', discount_snapshot_value ->> 'scope',
    coalesce((discount_snapshot_value ->> 'automatic')::boolean, false), discount_snapshot_value,
    (ticket_payload ->> 'createdAt')::timestamptz, (ticket_payload ->> 'createdAt')::timestamptz
  );
  insert into public.ticket_lines (
    id, ticket_id, tenant_id, product_id, variant_id, product_name, variant_name,
    quantity, unit_price_cents, line_total_cents, discount_amount_cents, net_total_cents, modifiers
  )
  select (line ->> 'id')::uuid, ticket_id_value, tenant_id_value, (line ->> 'productId')::uuid,
    (line ->> 'variantId')::uuid, line ->> 'productName', line ->> 'variantName',
    (line ->> 'quantity')::numeric(18,3), (line ->> 'unitPriceCents')::integer,
    (line ->> 'lineTotalCents')::integer, coalesce((line ->> 'discountAmountCents')::integer, 0),
    coalesce((line ->> 'netTotalCents')::integer, (line ->> 'lineTotalCents')::integer),
    coalesce(line -> 'modifiers', '[]'::jsonb)
  from jsonb_array_elements(p_payload -> 'lines') as line;
  insert into public.sales (id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, total_cents, payment_method, local_created_at, created_at)
  values (sale_id_value, tenant_id_value, ticket_id_value, cash_session_id_value, cash_register_id_value,
    venue_id_value, device_id_value, current_user_id, total_cents_value, payment_method_value,
    (sale_payload ->> 'createdAt')::timestamptz, (sale_payload ->> 'createdAt')::timestamptz);
  if custom_parts is not null and jsonb_typeof(custom_parts) <> 'null' then
    insert into public.sale_payments(id,sale_id,tenant_id,method,amount_cents,received_cents,change_cents,cashlogy_request_id,cashlogy_transaction_id)
    select (p ->> 'id')::uuid,sale_id_value,tenant_id_value,p ->> 'method',(p ->> 'amountCents')::integer,
      (p ->> 'receivedCents')::integer,(p ->> 'changeCents')::integer,nullif(p ->> 'cashlogyRequestId',''),nullif(p ->> 'cashlogyTransactionId','')
    from jsonb_array_elements(custom_parts) p;
  elsif total_cents_value > 0 then
    insert into public.sale_payments (id, sale_id, tenant_id, method, amount_cents, received_cents, change_cents)
    values ((payment_payload ->> 'id')::uuid, sale_id_value, tenant_id_value, payment_method_value,
      total_cents_value, received_cents_value, change_cents_value);
  end if;
end;
$$;

-- Keep the previous single-ticket entry point as a compatibility alias. Both
-- entry points previously had the same body and share the operation journal.
create or replace function public.pay_restaurant_equal_split_single_idempotent(p_operation_id uuid, p_tenant_id uuid, p_venue_id uuid, p_device_id uuid, p_action text, p_params jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return public.pay_restaurant_idempotent(p_operation_id,p_tenant_id,p_venue_id,p_device_id,p_action,p_params);
end;
$$;
