-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Opt-in protocol: existing PWAs and already-paid legacy splits retain their APIs.
alter table public.restaurant_order_equal_splits add column single_ticket boolean default false;
alter table public.sale_payments add column equal_split_part_number integer;
create table public.restaurant_equal_split_tenders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  venue_id uuid not null references public.venues(id),
  split_id uuid not null references public.restaurant_order_equal_splits(id),
  part_number integer not null check (part_number > 0),
  subtotal_cents integer not null check (subtotal_cents > 0),
  discount_amount_cents integer not null check (discount_amount_cents >= 0 and discount_amount_cents <= subtotal_cents),
  discount jsonb,
  amount_cents integer not null check (amount_cents = subtotal_cents - discount_amount_cents),
  method text check (method in ('cash','card')),
  received_cents integer,
  change_cents integer not null default 0 check (change_cents >= 0),
  device_id uuid not null references public.devices(id),
  user_id uuid not null references auth.users(id),
  cashlogy_request_id text,
  cashlogy_transaction_id text,
  created_at timestamptz not null default now(),
  unique(split_id,part_number),
  check ((amount_cents = 0 and method is null) or (amount_cents > 0 and method is not null)),
  check ((method = 'cash' and received_cents is not null and received_cents >= amount_cents and change_cents = received_cents - amount_cents)
    or (method is distinct from 'cash' and received_cents is null and change_cents = 0)),
  check ((cashlogy_request_id is null and cashlogy_transaction_id is null) or
    (method is not distinct from 'cash' and nullif(btrim(cashlogy_request_id),'') is not null and nullif(btrim(cashlogy_transaction_id),'') is not null))
);
create index restaurant_equal_split_tenders_scope_idx on public.restaurant_equal_split_tenders(tenant_id,venue_id,split_id);
create index restaurant_equal_split_tenders_device_idx on public.restaurant_equal_split_tenders(device_id);
create index restaurant_equal_split_tenders_user_idx on public.restaurant_equal_split_tenders(user_id);
create unique index restaurant_equal_split_tenders_request_idx on public.restaurant_equal_split_tenders(tenant_id,cashlogy_request_id) where cashlogy_request_id is not null;
create unique index restaurant_equal_split_tenders_transaction_idx on public.restaurant_equal_split_tenders(tenant_id,cashlogy_transaction_id) where cashlogy_transaction_id is not null;
alter table public.restaurant_equal_split_tenders enable row level security;
create policy restaurant_equal_split_tenders_read on public.restaurant_equal_split_tenders for select to authenticated
  using (public.user_has_venue_access(tenant_id,venue_id));
grant select on public.restaurant_equal_split_tenders to authenticated;
grant all on public.restaurant_equal_split_tenders to service_role;

create function public.restaurant_equal_split_single_snapshot(p_split public.restaurant_order_equal_splits)
returns jsonb language sql stable set search_path = '' as $$
  select public.restaurant_equal_split_to_json(p_split) || jsonb_build_object('singleTicket',coalesce(p_split.single_ticket,false),'tenders',
    (select coalesce(jsonb_agg(to_jsonb(t) order by t.part_number),'[]'::jsonb) from public.restaurant_equal_split_tenders t where t.split_id = p_split.id));
$$;

create function public.configure_restaurant_equal_split_single(p_order_id uuid,p_part_count integer,p_expected_order_revision integer,p_default_discount jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare answer jsonb; s public.restaurant_order_equal_splits%rowtype;
begin
  answer := public.configure_restaurant_order_equal_split(p_order_id,p_part_count,p_expected_order_revision,p_default_discount);
  select * into s from public.restaurant_order_equal_splits where id = (answer ->> 'id')::uuid for update;
  if s.paid_parts = 0 then
    update public.restaurant_order_equal_splits set single_ticket = true where id = s.id returning * into s;
  end if;
  return public.restaurant_equal_split_single_snapshot(s);
end;
$$;

-- Prevent an older client from producing a per-part ticket inside the new protocol.
create function public.guard_single_equal_split_ticket() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.equal_split_part_number is not null and exists(select 1 from public.restaurant_order_equal_splits where id = new.equal_split_id and single_ticket) then
    raise exception 'Actualiza el TPV para completar este reparto con un solo ticket' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger guard_single_equal_split_ticket before insert on public.tickets for each row execute function public.guard_single_equal_split_ticket();

-- Pending tenders must be settled in their original open cash session.
create function public.guard_pending_equal_split_cash_session() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status <> 'open' and exists (
    select 1 from public.restaurant_order_equal_splits s join public.orders o on o.id = s.order_id
    where o.cash_session_id = old.id and s.single_ticket and s.status = 'open' and s.paid_parts > 0
  ) then raise exception 'Completa los repartos parcialmente cobrados antes de cerrar caja' using errcode = '55000'; end if;
  return new;
end;
$$;
create trigger guard_pending_equal_split_cash_session before update on public.cash_sessions for each row execute function public.guard_pending_equal_split_cash_session();

create function public.guard_pending_equal_split_order_transfer() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.cash_session_id,new.status) is distinct from (old.cash_session_id,old.status) and exists (
    select 1 from public.restaurant_order_equal_splits s where s.order_id = old.id and s.single_ticket and s.status = 'open' and s.paid_parts > 0
  ) then raise exception 'Completa el reparto antes de trasladar o cancelar la comanda' using errcode = '55000'; end if;
  return new;
end;
$$;
create trigger guard_pending_equal_split_order_transfer before update on public.orders for each row execute function public.guard_pending_equal_split_order_transfer();

-- The same physical Cashlogy receipt cannot fund both a pending share and another sale.
create function public.guard_equal_split_cashlogy_identity() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.cashlogy_request_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('cashlogy-receipt:' || new.tenant_id::text || ':' || new.cashlogy_transaction_id,0));
  if exists(select 1 from public.sale_payments p where p.tenant_id = new.tenant_id and p.id <> new.id
      and (p.cashlogy_request_id = new.cashlogy_request_id or p.cashlogy_transaction_id = new.cashlogy_transaction_id))
    or exists(select 1 from public.restaurant_equal_split_tenders t where t.tenant_id = new.tenant_id and t.id <> new.id
      and (t.cashlogy_request_id = new.cashlogy_request_id or t.cashlogy_transaction_id = new.cashlogy_transaction_id)) then
    raise exception 'El cobro Cashlogy ya pertenece a otro pago' using errcode = '23505';
  end if;
  return new;
end;
$$;
create trigger guard_equal_split_tender_cashlogy before insert on public.restaurant_equal_split_tenders for each row execute function public.guard_equal_split_cashlogy_identity();
create trigger guard_equal_split_sale_cashlogy before insert or update of cashlogy_request_id,cashlogy_transaction_id on public.sale_payments for each row execute function public.guard_equal_split_cashlogy_identity();

create function public.pay_restaurant_equal_split_single(p_params jsonb) returns jsonb
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

  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d
  join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id
    and dua.venue_id = order_row.venue_id and dua.is_active and d.is_active
    and d.can_take_payments and d.id = v_device
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
  elsif p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Metodo de pago no valido';
  end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < part_total then
    raise exception 'Importe recibido insuficiente';
  end if;

  insert into public.restaurant_equal_split_tenders (
    id, tenant_id, venue_id, split_id, part_number, subtotal_cents, discount_amount_cents,
    discount, amount_cents, method, received_cents, change_cents, device_id, user_id,
    cashlogy_request_id, cashlogy_transaction_id
  ) values (
    payment_id, order_row.tenant_id, order_row.venue_id, split_row.id, part_number,
    part_subtotal, discount_amount, case when discount_result ->> 'type' is null then null else discount_result end,
    part_total, p_payment_method,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - part_total else 0 end,
    actor_device.id, auth.uid(), nullif(p_params ->> 'cashlogyRequestId',''), nullif(p_params ->> 'cashlogyTransactionId','')
  );
  ticket_id := null;
  sale_id := null;
  if part_number = split_row.part_count then
    ticket_id := gen_random_uuid(); sale_id := gen_random_uuid();
    select sum(subtotal_cents), sum(amount_cents), sum(discount_amount_cents),
      case when count(distinct method) = 1 then min(method) else null end
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
      from public.restaurant_equal_split_tenders t where t.split_id = split_row.id and t.amount_cents > 0 order by t.part_number;
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
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'tenantId',t.tenant_id,'saleId',sale_id,'partNumber',t.part_number,'method',t.method,'amountCents',t.amount_cents,'receivedCents',t.received_cents,'changeCents',t.change_cents,'cashlogyRequestId',t.cashlogy_request_id,'cashlogyTransactionId',t.cashlogy_transaction_id) order by t.part_number),'[]'::jsonb) from public.restaurant_equal_split_tenders t where t.split_id = split_row.id and t.amount_cents > 0),
    'completed', split_row.status = 'completed',
    'nextOrderId', next_order_id
  );
end;
$$;

create function public.pay_restaurant_equal_split_single_idempotent(p_operation_id uuid, p_tenant_id uuid, p_venue_id uuid, p_device_id uuid, p_action text, p_params jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare prior public.restaurant_payment_operations%rowtype; answer jsonb; order_id uuid;
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
  if p_action = 'close' then
    if nullif(p_params ->> 'cashlogyRequestId','') is not null then
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
    elsif nullif(p_params ->> 'cashlogyRequestId','') is not null then
      answer := public.pay_restaurant_order_equal_part_cashlogy((p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'useDefaultDiscount')::boolean,
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      answer := public.pay_restaurant_order_equal_part((p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'useDefaultDiscount')::boolean);
    end if;
  else
    if nullif(p_params ->> 'cashlogyRequestId','') is not null then
      answer := public.pay_restaurant_order_items_cashlogy(order_id, (p_params ->> 'expectedRevision')::integer, p_params -> 'moves',
        p_params ->> 'method', (p_params ->> 'receivedCents')::integer, (p_params ->> 'allowPending')::boolean,
        p_params -> 'discount', p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      answer := public.pay_restaurant_order_items(order_id, (p_params ->> 'expectedRevision')::integer, p_params -> 'moves',
        p_params ->> 'method', (p_params ->> 'receivedCents')::integer, (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  end if;
  if coalesce((answer ->> 'requiresConfirmation')::boolean, false) then return answer; end if;
  insert into public.restaurant_payment_operations(operation_id,tenant_id,venue_id,device_id,user_id,action,params,result)
  values(p_operation_id,p_tenant_id,p_venue_id,p_device_id,auth.uid(),p_action,p_params,answer);
  return answer;
end;
$$;

create function public.pay_restaurant_equal_split_single_fiscal(
  p_action text, p_params jsonb, p_record jsonb, p_invoice jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
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
  v_expected_series := public.fiscal_installation_series_prefix(v_installation) || '-'
    || v_exercise::text || '-'
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
    if coalesce((p_params ->> 'singleTicket')::boolean,false) then
      v_result := public.pay_restaurant_equal_split_single(p_params || jsonb_build_object('deviceId',v_installation.device_id));
    elsif nullif(p_params ->> 'cashlogyRequestId', '') is not null then
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
  return v_result;
end;
$$;
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: New privileged RPCs are authenticated only. CRM read RPCs retain signatures, invoker RLS, grants and scope; they sum tender amounts while preserving one-sale counts and the legacy fallback.
revoke all on function public.configure_restaurant_equal_split_single(uuid,integer,integer,jsonb) from public,anon;
grant execute on function public.configure_restaurant_equal_split_single(uuid,integer,integer,jsonb) to authenticated;
revoke all on function public.pay_restaurant_equal_split_single(jsonb) from public,anon,authenticated;
revoke all on function public.pay_restaurant_equal_split_single_idempotent(uuid,uuid,uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.pay_restaurant_equal_split_single_idempotent(uuid,uuid,uuid,uuid,text,jsonb) to authenticated;
revoke all on function public.pay_restaurant_equal_split_single_fiscal(text,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.pay_restaurant_equal_split_single_fiscal(text,jsonb,jsonb,jsonb) to authenticated;

create or replace function public.crm_stats_period(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_period_kind text,
  p_period_start_date date,
  p_period_end_date date,
  p_effective_end_date date,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_time_zone text,
  p_day_change_time time without time zone default null
)
returns jsonb
language sql
stable
parallel safe
security invoker
set search_path = ''
as $$
  with paid_tickets as (
    select t.id, t.local_created_at, t.total_cents,
      coalesce(t.discount_amount_cents, 0)::bigint as discount_amount_cents,
      t.discount_id, t.discount_name
    from public.tickets t
    where t.tenant_id = p_tenant_id and t.venue_id = p_venue_id
      and t.status = 'paid' and t.local_created_at >= p_period_start and t.local_created_at < p_period_end
  ), paid_lines as (
    select tl.id, tl.product_id, tl.product_name, tl.category_id_snapshot, tl.category_name_snapshot,
      coalesce(tl.allocated_quantity, tl.quantity::numeric) as quantity, tl.line_total_cents,
      tl.modifiers,
      coalesce((select jsonb_agg(jsonb_build_object('type', c.component_type, 'productName', c.product_name_snapshot, 'sortOrder', c.sort_order, 'modifiers', coalesce(c.metadata -> 'modifiers', '[]'::jsonb)) order by c.sort_order, c.id)
        from public.ticket_line_components c where c.ticket_line_id = tl.id and c.tenant_id = p_tenant_id), '[]'::jsonb) as components
    from public.ticket_lines tl join paid_tickets pt on pt.id = tl.ticket_id
    where tl.tenant_id = p_tenant_id
  ), categories as (
    select coalesce(category_id_snapshot::text, 'uncategorized') id, coalesce(nullif(btrim(category_name_snapshot), ''), 'Sin categoría') label,
      sum(quantity) quantity, sum(line_total_cents)::bigint total_cents
    from paid_lines group by 1, 2
  ), products as (
    select coalesce(product_id::text, 'deleted:' || lower(btrim(product_name))) id, coalesce(nullif(btrim(product_name), ''), 'Producto sin nombre') label,
      sum(quantity) quantity, sum(line_total_cents)::bigint total_cents
    from paid_lines group by 1, 2
  ), combinations as (
    select product_name,
      coalesce((select jsonb_agg(name order by lower(name)) from (select distinct btrim(value ->> 'productName') name from jsonb_array_elements(components) where value ->> 'type' = 'mixer' and nullif(btrim(value ->> 'productName'), '') is not null) x), '[]'::jsonb) mixers,
      coalesce((select jsonb_agg(name order by lower(name)) from (select distinct btrim(value ->> 'name') name from jsonb_array_elements(coalesce(modifiers, '[]'::jsonb)) where coalesce(value ->> 'groupId', '') <> 'mixer' and coalesce(value ->> 'id', '') not like 'mixer:%' and nullif(btrim(value ->> 'name'), '') is not null) x), '[]'::jsonb) modifiers,
      sum(quantity) quantity, sum(line_total_cents)::bigint total_cents
    from paid_lines group by product_name, components, modifiers
  ), grouped_combinations as (
    select product_name, mixers, modifiers, sum(quantity) quantity, sum(total_cents)::bigint total_cents
    from combinations group by product_name, mixers, modifiers
  ), discounts as (
    select coalesce(discount_id::text, 'manual') id, discount_name name, count(*) applications,
      sum(discount_amount_cents)::bigint discounted_cents, sum(total_cents)::bigint net_sales_cents
    from paid_tickets where discount_name is not null and discount_amount_cents > 0 group by 1, 2
  ), hourly as (
    select extract(hour from (local_created_at at time zone p_time_zone))::integer as hour_of_day, count(*) as ticket_count, sum(total_cents)::bigint as total_cents
    from paid_tickets group by 1
  ), open_days as (
    select distinct ((local_created_at at time zone p_time_zone)::date - case when (local_created_at at time zone p_time_zone)::time < coalesce(p_day_change_time, time '00:00') then 1 else 0 end)::date day_key from paid_tickets
    union
    select distinct ((opened_at at time zone p_time_zone)::date - case when (opened_at at time zone p_time_zone)::time < coalesce(p_day_change_time, time '00:00') then 1 else 0 end)::date
    from public.cash_sessions where tenant_id = p_tenant_id and venue_id = p_venue_id and opened_at >= p_period_start and opened_at < p_period_end
  ), payment_totals as (
    select tender.method, sum(tender.amount_cents)::bigint total_cents, count(distinct s.id) count
    from public.sales s cross join lateral (
      select p.method,p.amount_cents from public.sale_payments p where p.sale_id = s.id and p.tenant_id = s.tenant_id
      union all select s.payment_method,s.total_cents where not exists(select 1 from public.sale_payments p where p.sale_id = s.id and p.tenant_id = s.tenant_id)
    ) tender
    where s.tenant_id = p_tenant_id and s.venue_id = p_venue_id and s.local_created_at >= p_period_start and s.local_created_at < p_period_end and tender.method in ('cash','card')
    group by tender.method
  )
  select jsonb_build_object(
    'averageTicketCents', coalesce(round(sum(pt.total_cents)::numeric / nullif(count(*), 0)), 0),
    'byPayment', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'totalCents', total_cents, 'count', count) order by total_cents desc) from payment_totals), '[]'::jsonb),
    'discountApplications', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'applications', applications, 'discountedCents', discounted_cents, 'netSalesCents', net_sales_cents, 'ticketPercentage', round(applications::numeric * 1000 / nullif((select count(*) from paid_tickets), 0)) / 10) order by discounted_cents desc) from discounts), '[]'::jsonb),
    'discountedTicketCount', count(*) filter (where discount_amount_cents > 0),
    'discountsCents', coalesce(sum(discount_amount_cents), 0)::bigint,
    'hourlySales', coalesce((select jsonb_agg(jsonb_build_object('hour', hour_series.hour_of_day, 'ticketCount', coalesce(x.ticket_count, 0), 'totalCents', coalesce(x.total_cents, 0)) order by hour_series.hour_of_day) from generate_series(0, 23) as hour_series(hour_of_day) left join hourly x on x.hour_of_day = hour_series.hour_of_day), '[]'::jsonb),
    'monthKey', to_char(p_period_start_date, 'YYYY-MM'), 'monthSalesCents', coalesce(sum(pt.total_cents), 0)::bigint, 'monthTicketCount', count(*),
    'period', jsonb_build_object('kind', p_period_kind, 'startDate', p_period_start_date, 'endDate', p_period_end_date, 'effectiveEndDate', p_effective_end_date, 'dayCount', p_period_end_date - p_period_start_date + 1, 'openDayCount', (select count(*) from open_days)),
    'salesByCategory', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'quantity', quantity, 'totalCents', total_cents) order by total_cents desc, quantity desc, label) from categories), '[]'::jsonb),
    'salesByProduct', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'quantity', quantity, 'totalCents', total_cents) order by total_cents desc, quantity desc, label) from products), '[]'::jsonb),
    'topProducts', coalesce((select jsonb_agg(jsonb_build_object('productName', label, 'quantity', quantity, 'totalCents', total_cents) order by quantity desc, total_cents desc, label) from (select * from products order by quantity desc, total_cents desc, label limit 8) x), '[]'::jsonb),
    'topProductCombinations', coalesce((select jsonb_agg(jsonb_build_object('productName', product_name, 'mixers', mixers, 'modifiers', modifiers, 'quantity', quantity, 'totalCents', total_cents) order by quantity desc, total_cents desc, product_name) from (select * from grouped_combinations order by quantity desc, total_cents desc, product_name limit 8) x), '[]'::jsonb),
    'dayActivity', jsonb_build_object('totalCents', 0, 'cashCents', 0, 'cardCents', 0, 'ticketCount', 0), 'openCashSessions', '[]'::jsonb
  ) from paid_tickets pt;
$$;

create or replace function public.crm_stats_live(p_tenant_id uuid, p_venue_id uuid, p_day_start timestamptz, p_day_end timestamptz)
returns jsonb language sql stable parallel safe security invoker set search_path = '' as $$
  with day_tickets as (select id, total_cents from public.tickets where tenant_id = p_tenant_id and venue_id = p_venue_id and status = 'paid' and local_created_at >= p_day_start and local_created_at < p_day_end),
  day_sales as (select tender.method payment_method,tender.amount_cents total_cents from public.sales s cross join lateral (
      select p.method,p.amount_cents from public.sale_payments p where p.sale_id = s.id and p.tenant_id = s.tenant_id
      union all select s.payment_method,s.total_cents where not exists(select 1 from public.sale_payments p where p.sale_id = s.id and p.tenant_id = s.tenant_id)
    ) tender where s.tenant_id = p_tenant_id and s.venue_id = p_venue_id and s.local_created_at >= p_day_start and s.local_created_at < p_day_end),
  sessions as (select cs.id, cs.venue_id, coalesce(v.name, 'Local sin nombre') venue_name, coalesce(d.name, 'Caja sin nombre') device_name, cs.opened_at, cs.opening_float_cents from public.cash_sessions cs left join public.venues v on v.id = cs.venue_id and v.tenant_id = p_tenant_id left join public.devices d on d.id = cs.device_id and d.tenant_id = p_tenant_id where cs.tenant_id = p_tenant_id and cs.status = 'open'),
  session_sales as (
    select s.id,s.cash_session_id,s.total_cents,
      coalesce(sum(tender.amount_cents) filter(where tender.method = 'cash'),0)::bigint cash_cents,
      coalesce(sum(tender.amount_cents) filter(where tender.method = 'card'),0)::bigint card_cents,
      coalesce(sum(tender.amount_cents) filter(where tender.method = 'invitation'),0)::bigint invitation_cents,
      coalesce(sum(tender.amount_cents) filter(where tender.method not in ('cash','card','invitation') or tender.method is null),0)::bigint other_cents
    from public.sales s join sessions active on active.id = s.cash_session_id cross join lateral (
      select p.method,p.amount_cents from public.sale_payments p where p.sale_id = s.id and p.tenant_id = s.tenant_id
      union all select s.payment_method,s.total_cents where not exists(select 1 from public.sale_payments p where p.sale_id = s.id and p.tenant_id = s.tenant_id)
    ) tender
    where s.tenant_id = p_tenant_id group by s.id,s.cash_session_id,s.total_cents
  ), session_totals as (
    select s.*,coalesce(sum(x.total_cents),0)::bigint sales_cents,count(x.id) ticket_count,
      coalesce(sum(x.cash_cents),0)::bigint cash_cents,coalesce(sum(x.card_cents),0)::bigint card_cents,
      coalesce(sum(x.invitation_cents),0)::bigint invitation_cents,coalesce(sum(x.other_cents),0)::bigint other_cents
    from sessions s left join session_sales x on x.cash_session_id = s.id
    group by s.id,s.venue_id,s.venue_name,s.device_name,s.opened_at,s.opening_float_cents
  )
  select jsonb_build_object('dayActivity', jsonb_build_object('totalCents', coalesce((select sum(total_cents) from day_tickets), 0), 'cashCents', coalesce((select sum(total_cents) from day_sales where payment_method = 'cash'), 0), 'cardCents', coalesce((select sum(total_cents) from day_sales where payment_method = 'card'), 0), 'ticketCount', (select count(*) from day_tickets)), 'openCashSessions', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'venueId', venue_id, 'venueName', venue_name, 'deviceName', device_name, 'openedAt', opened_at, 'openingFloatCents', opening_float_cents, 'salesCents', sales_cents, 'ticketCount', ticket_count, 'cashCents', cash_cents, 'cardCents', card_cents, 'invitationCents', invitation_cents, 'otherCents', other_cents) order by opened_at desc) from session_totals), '[]'::jsonb));
$$;
