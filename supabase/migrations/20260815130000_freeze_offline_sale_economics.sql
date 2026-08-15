-- Paid offline sales are immutable economic facts. The POS calculates the
-- definitive amounts at payment time; synchronization validates and persists
-- that snapshot without resolving today's discount or promotion rules.

create or replace function public.set_ticket_discount_rounding_snapshot()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.discount_snapshot ->> 'economicSource' = 'pos_closed_sale' then
    return new;
  end if;
  if new.discount_id is null or new.discount_type = 'manual' then
    new.discount_rounding_increment_cents := null;
  else
    select d.rounding_increment_cents
      into new.discount_rounding_increment_cents
    from public.discounts d
    where d.id = new.discount_id
      and d.tenant_id = new.tenant_id
      and d.venue_id = new.venue_id;
  end if;
  return new;
end;
$$;

create or replace function public.capture_ticket_discount_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rule_row public.discounts%rowtype;
  targets jsonb := '[]'::jsonb;
begin
  if new.discount_type is null then
    new.discount_rule_kind := null;
    new.discount_scope := null;
    new.discount_automatic := false;
    new.discount_snapshot := null;
    return new;
  end if;

  -- Closed POS sales already carry the authoritative snapshot. Never replace
  -- it with the current CRM row, which may have changed or disappeared.
  if new.discount_snapshot ->> 'economicSource' = 'pos_closed_sale' then
    new.discount_rule_kind := coalesce(nullif(new.discount_snapshot ->> 'ruleKind', ''), 'discount');
    new.discount_scope := coalesce(nullif(new.discount_snapshot ->> 'scope', ''), 'general');
    new.discount_automatic := coalesce((new.discount_snapshot ->> 'automatic')::boolean, false);
    new.discount_rounding_increment_cents := nullif(new.discount_snapshot ->> 'roundingIncrementCents', '')::integer;
    return new;
  end if;

  if new.discount_id is not null then
    select d.* into rule_row from public.discounts d where d.id = new.discount_id;
    select coalesce(jsonb_agg(jsonb_build_object('productId', t.product_id, 'variantId', t.variant_id)), '[]'::jsonb)
    into targets from public.discount_targets t where t.discount_id = new.discount_id;
    new.discount_rounding_increment_cents := rule_row.rounding_increment_cents;
  end if;
  new.discount_rule_kind := coalesce(rule_row.rule_kind, 'discount');
  new.discount_scope := coalesce(rule_row.scope, 'general');
  new.discount_automatic := coalesce(rule_row.auto_apply, false);
  new.discount_snapshot := jsonb_build_object(
    'discountId', new.discount_id,
    'name', new.discount_name,
    'type', new.discount_type,
    'calculationType', new.discount_value_type,
    'storedValue', new.discount_value,
    'amountCents', new.discount_amount_cents,
    'fixedApplication', coalesce(rule_row.fixed_application, 'ticket'),
    'roundingIncrementCents', new.discount_rounding_increment_cents,
    'ruleKind', new.discount_rule_kind,
    'scope', new.discount_scope,
    'targets', targets,
    'automatic', new.discount_automatic,
    'activeWeekdays', coalesce(to_jsonb(rule_row.active_weekdays), '[]'::jsonb),
    'startsAt', rule_row.starts_at,
    'endsAt', rule_row.ends_at
  );
  return new;
end;
$$;

create or replace function public.allocate_inserted_ticket_line_discounts()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ticket_row public.tickets%rowtype;
  ticket_id_value uuid;
  line_row public.ticket_lines%rowtype;
  eligible_total integer;
  fixed_value_cents integer;
  requested_amount integer;
  base_net_total integer;
  remaining_gross integer;
  remaining_net integer;
  remaining_weight integer;
  remaining_adjustment integer;
  line_base_net integer;
  line_weight integer;
  line_adjustment integer;
  line_net integer;
  eligible boolean;
  fixed_per_line boolean;
  persisted_discount_total bigint;
  persisted_net_total bigint;
begin
  for ticket_id_value in select distinct n.ticket_id from new_ticket_lines n
  loop
    select t.* into ticket_row from public.tickets t where t.id = ticket_id_value;

    -- sync_sale_created_v2 has already validated and inserted these definitive
    -- allocations. Reallocating here would be another economic decision.
    if ticket_row.discount_snapshot ->> 'economicSource' = 'pos_closed_sale' then
      select coalesce(sum(tl.discount_amount_cents), 0), coalesce(sum(tl.net_total_cents), 0)
      into persisted_discount_total, persisted_net_total
      from public.ticket_lines tl where tl.ticket_id = ticket_id_value;
      if persisted_discount_total <> coalesce(ticket_row.discount_amount_cents, 0)
        or persisted_net_total <> ticket_row.total_cents then
        raise exception 'Las asignaciones por linea no coinciden con el ticket cobrado';
      end if;
      continue;
    end if;

    if coalesce(ticket_row.discount_amount_cents, 0) = 0 then
      update public.ticket_lines set discount_amount_cents = 0, net_total_cents = line_total_cents
      where ticket_id = ticket_id_value;
      continue;
    end if;
    select coalesce(sum(tl.line_total_cents), 0)::integer into eligible_total
    from public.ticket_lines tl
    where tl.ticket_id = ticket_id_value and (
      coalesce(ticket_row.discount_scope, 'general') = 'general'
      or exists (
        select 1 from jsonb_array_elements(coalesce(ticket_row.discount_snapshot -> 'targets', '[]'::jsonb)) target
        where target ->> 'productId' = tl.product_id::text
          and (target ->> 'variantId' is null or target ->> 'variantId' = tl.variant_id::text)
      )
    );
    if ticket_row.discount_amount_cents > eligible_total then
      raise exception 'El descuento supera el subtotal elegible';
    end if;
    fixed_per_line := ticket_row.discount_value_type = 'fixed'
      and coalesce(ticket_row.discount_snapshot ->> 'fixedApplication', 'ticket') = 'line';
    remaining_gross := eligible_total;
    remaining_net := eligible_total - ticket_row.discount_amount_cents;
    if fixed_per_line then
      fixed_value_cents := round((ticket_row.discount_snapshot ->> 'storedValue')::numeric * 100)::integer;
      select coalesce(sum(least(tl.line_total_cents, fixed_value_cents)), 0)::integer
      into requested_amount
      from public.ticket_lines tl
      where tl.ticket_id = ticket_id_value and (
        coalesce(ticket_row.discount_scope, 'general') = 'general'
        or exists (
          select 1 from jsonb_array_elements(coalesce(ticket_row.discount_snapshot -> 'targets', '[]'::jsonb)) target
          where target ->> 'productId' = tl.product_id::text
            and (target ->> 'variantId' is null or target ->> 'variantId' = tl.variant_id::text)
        )
      );
      base_net_total := eligible_total - requested_amount;
      if remaining_net <= base_net_total then
        remaining_weight := base_net_total;
        remaining_adjustment := remaining_net;
      else
        remaining_weight := requested_amount;
        remaining_adjustment := remaining_net - base_net_total;
      end if;
    end if;
    for line_row in select * from public.ticket_lines where ticket_id = ticket_id_value order by created_at, id
    loop
      eligible := coalesce(ticket_row.discount_scope, 'general') = 'general'
        or exists (
          select 1 from jsonb_array_elements(coalesce(ticket_row.discount_snapshot -> 'targets', '[]'::jsonb)) target
          where target ->> 'productId' = line_row.product_id::text
            and (target ->> 'variantId' is null or target ->> 'variantId' = line_row.variant_id::text)
        );
      if eligible and fixed_per_line then
        line_base_net := greatest(0, line_row.line_total_cents - fixed_value_cents);
        line_weight := case when remaining_net <= base_net_total
          then line_base_net else line_row.line_total_cents - line_base_net end;
        line_adjustment := case when remaining_weight <= 0 then 0
          else round(line_weight::numeric * remaining_adjustment / remaining_weight)::integer end;
        line_net := case when remaining_net <= base_net_total
          then line_adjustment else line_base_net + line_adjustment end;
        remaining_weight := remaining_weight - line_weight;
        remaining_adjustment := remaining_adjustment - line_adjustment;
      elsif eligible then
        line_net := case when remaining_gross <= 0 then 0
          else round(line_row.line_total_cents::numeric * remaining_net / remaining_gross)::integer end;
        remaining_gross := remaining_gross - line_row.line_total_cents;
        remaining_net := remaining_net - line_net;
      else line_net := line_row.line_total_cents; end if;
      update public.ticket_lines
      set net_total_cents = line_net,
          discount_amount_cents = line_total_cents - line_net
      where id = line_row.id;
    end loop;
  end loop;
  return null;
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
      and (line ->> 'quantity')::integer > 0
      and (line ->> 'unitPriceCents')::bigint >= 0
      and (line ->> 'lineTotalCents')::bigint = (line ->> 'unitPriceCents')::bigint * (line ->> 'quantity')::integer
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
    (line ->> 'quantity')::integer, (line ->> 'unitPriceCents')::integer,
    (line ->> 'lineTotalCents')::integer, coalesce((line ->> 'discountAmountCents')::integer, 0),
    coalesce((line ->> 'netTotalCents')::integer, (line ->> 'lineTotalCents')::integer),
    coalesce(line -> 'modifiers', '[]'::jsonb)
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

revoke all on function public.sync_sale_created_v2(uuid, jsonb) from public;
grant execute on function public.sync_sale_created_v2(uuid, jsonb) to authenticated;
