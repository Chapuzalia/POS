-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Keep existing trigger and conversion signatures and grants; ancillary snapshot errors now retain sales with scoped diagnostics. No economic, fiscal, auth or cash-session validation is relaxed.

create table public.sale_auxiliary_failures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  venue_id uuid not null,
  entity_id uuid not null,
  stage text not null,
  error_code text not null,
  created_at timestamptz not null default now()
);
create index sale_auxiliary_failures_scope_idx on public.sale_auxiliary_failures(tenant_id, venue_id, created_at);
create index sale_auxiliary_failures_entity_idx on public.sale_auxiliary_failures(tenant_id, venue_id, entity_id, stage);
alter table public.sale_auxiliary_failures enable row level security;
create policy sale_auxiliary_failures_read on public.sale_auxiliary_failures for select to authenticated
  using (public.user_has_venue_access(tenant_id, venue_id));
grant select on public.sale_auxiliary_failures to authenticated;
grant all on public.sale_auxiliary_failures to service_role;

-- Only trusted triggers write diagnostics. Neither payloads nor SQL error messages
-- are copied here: they can contain customer or fiscal data.
create function public.record_sale_auxiliary_failure(p_tenant uuid, p_venue uuid, p_entity uuid, p_stage text, p_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.sale_auxiliary_failures(tenant_id, venue_id, entity_id, stage, error_code)
  values(p_tenant, p_venue, p_entity, p_stage, p_code);
exception when others then
  raise warning 'SALE_AUXILIARY_DIAGNOSTIC_UNAVAILABLE stage=% sqlstate=%', p_stage, sqlstate;
end;
$$;

-- A durable receipt for clients outside the local SIF path. Existing RPCs stay
-- available to older PWAs, while new clients replay the same operation safely.
create table public.restaurant_payment_operations (
  operation_id uuid primary key,
  tenant_id uuid not null,
  venue_id uuid not null,
  device_id uuid not null,
  user_id uuid not null,
  action text not null,
  params jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create index restaurant_payment_operations_scope_idx on public.restaurant_payment_operations(tenant_id, venue_id, created_at);
alter table public.restaurant_payment_operations enable row level security;
create policy restaurant_payment_operations_read on public.restaurant_payment_operations for select to authenticated
  using (public.user_has_device_access(tenant_id, venue_id, device_id));
grant select on public.restaurant_payment_operations to authenticated;
grant all on public.restaurant_payment_operations to service_role;

create function public.pay_restaurant_idempotent(p_operation_id uuid, p_tenant_id uuid, p_venue_id uuid, p_device_id uuid, p_action text, p_params jsonb)
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
    if nullif(p_params ->> 'cashlogyRequestId','') is not null then
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
revoke all on function public.pay_restaurant_idempotent(uuid,uuid,uuid,uuid,text,jsonb) from public, anon;
grant execute on function public.pay_restaurant_idempotent(uuid,uuid,uuid,uuid,text,jsonb) to authenticated;
revoke all on function public.record_sale_auxiliary_failure(uuid,uuid,uuid,text,text) from public, anon, authenticated;

-- Quantity conversion requires an explicit common content unit. Similar names
-- such as botella and botella 70 cl do not prove an equivalence.
create or replace function public.inventory_units_compatible(p_tenant_id uuid, p_venue_id uuid, p_left_unit_id uuid, p_right_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.inventory_units l join public.inventory_units r
      on r.tenant_id = l.tenant_id and r.venue_id = l.venue_id
    where l.id = p_left_unit_id and r.id = p_right_unit_id
      and l.tenant_id = p_tenant_id and l.venue_id = p_venue_id
      and l.content_unit_id = r.content_unit_id
      and l.content_quantity > 0 and r.content_quantity > 0
  );
$$;

create or replace function public.snapshot_ticket_line_theoretical_cost()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cost jsonb; v_known boolean; v_cents integer; v_venue uuid;
begin
  select venue_id into v_venue from public.tickets where id = new.ticket_id and tenant_id = new.tenant_id;
  begin
    -- A failed component snapshot must not produce a deceptively known cost.
    if exists (select 1 from public.sale_auxiliary_failures
      where tenant_id = new.tenant_id and venue_id = v_venue and entity_id = new.id and stage = 'components') then
      return new;
    end if;
    v_cost := public.theoretical_ticket_line_cost(new.id);
    v_known := coalesce((v_cost ->> 'known')::boolean, false);
    v_cents := case when v_known then round(coalesce((v_cost ->> 'cost')::numeric, 0) * 100)::integer else null end;
    update public.ticket_lines line set theoretical_cost_known = v_known, theoretical_cost_cents = v_cents
    where line.id = new.id and line.tenant_id = new.tenant_id
      and (line.theoretical_cost_known is distinct from v_known or line.theoretical_cost_cents is distinct from v_cents);
  exception when others then
    -- The BEFORE trigger already supplied false/null. The inner subtransaction
    -- rolls back cost writes, leaving the original economic line intact.
    perform public.record_sale_auxiliary_failure(new.tenant_id, v_venue, new.id, 'theoretical_cost', sqlstate);
  end;
  return new;
end;
$$;


create or replace function public.capture_ticket_line_components()
returns trigger
language plpgsql security definer
set search_path = 'public'
as $$
declare
  components_payload jsonb;
begin
  if new.source_order_line_id is not null then
    select ol.components into components_payload
    from public.order_lines ol
    where ol.id = new.source_order_line_id
      and ol.tenant_id = new.tenant_id;
  end if;

  if components_payload is null then
    select line -> 'components' into components_payload
    from public.offline_event_log e
    cross join lateral jsonb_array_elements(e.payload -> 'lines') line
    where e.tenant_id = new.tenant_id
      and e.event_kind = 'sale_created'
      and e.payload -> 'ticket' ->> 'id' = new.ticket_id::text
      and line ->> 'id' = new.id::text
    order by e.created_at desc
    limit 1;
  end if;

  -- Compatibility fallback for tickets created by an older application version.
  if components_payload is null then
    select (array_agg(ol.components order by ol.updated_at desc))[1]
      into components_payload
    from public.order_lines ol
    join public.orders o on o.id = ol.order_id
    join public.tickets t on t.id = new.ticket_id
    where ol.tenant_id = new.tenant_id
      and o.cash_session_id = t.cash_session_id
      and o.venue_id = t.venue_id
      and ol.product_id is not distinct from new.product_id
      and ol.variant_id is not distinct from new.variant_id
      and ol.product_name = new.product_name
      and ol.variant_name = new.variant_name
      and ol.unit_price_cents = new.unit_price_cents
      and jsonb_array_length(ol.components) > 0
    having count(*) = 1;
  end if;

  if jsonb_typeof(components_payload) = 'array' then
    insert into public.ticket_line_components (
      tenant_id, ticket_line_id, component_type, selection_group_id,
      selection_group_name_snapshot, product_id, variant_id,
      product_name_snapshot, variant_name_snapshot, quantity,
      price_delta_cents, sort_order, metadata
    )
    select new.tenant_id, new.id, c.type,
      nullif(c."selectionGroupId", '')::uuid,
      coalesce(c."selectionGroupName", ''),
      nullif(c."productId", '')::uuid,
      nullif(c."variantId", '')::uuid,
      c."productName", coalesce(c."variantName", ''),
      greatest(c.quantity, 1), c."priceDeltaCents", c."sortOrder",
      coalesce(c.metadata, '{}'::jsonb)
        || jsonb_build_object('modifiers', coalesce(c.modifiers, '[]'::jsonb))
    from jsonb_to_recordset(components_payload) c(
      type text, "selectionGroupId" text, "selectionGroupName" text,
      "productId" text, "variantId" text, "productName" text,
      "variantName" text, quantity integer, "priceDeltaCents" integer,
      "sortOrder" integer, modifiers jsonb, metadata jsonb
    );
  end if;
  return new;
exception when others then
  perform public.record_sale_auxiliary_failure(new.tenant_id, (select venue_id from public.tickets where id = new.ticket_id and tenant_id = new.tenant_id), new.id, 'components', sqlstate);
  
  return new;
end;
$$;


create or replace function public.capture_ticket_line_catalog_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  line_payload jsonb;
  snapshot_payload jsonb;
  ticket_session uuid;
  ticket_venue uuid;
  source_found boolean := false;
begin
  select t.cash_session_id, t.venue_id into ticket_session, ticket_venue
  from public.tickets t where t.id = new.ticket_id and t.tenant_id = new.tenant_id;

  -- New restaurant payments already identify the exact historical source.
  -- An empty snapshot on that source must not be replaced by another order's.
  if new.source_order_line_id is not null then
    select l.catalog_snapshot into snapshot_payload
    from public.order_lines l join public.orders o on o.id = l.order_id
    where l.id = new.source_order_line_id
      and l.tenant_id = new.tenant_id and o.tenant_id = new.tenant_id
      and l.venue_id = ticket_venue and o.venue_id = ticket_venue
      and o.cash_session_id = ticket_session
      and l.product_id is not distinct from new.product_id
      and l.variant_id is not distinct from new.variant_id
      and l.unit_price_cents = new.unit_price_cents;
    source_found := found;
  end if;

  if not source_found then
    -- These scalar keys are maintained for old and new offline clients by DB.
    select line into line_payload from public.offline_event_log e
    cross join lateral jsonb_array_elements(e.payload -> 'lines') line
    where e.tenant_id = new.tenant_id and e.event_kind = 'sale_created'
      and e.sale_cash_session_id = ticket_session::text
      and e.sale_ticket_id = new.ticket_id::text and line ->> 'id' = new.id::text
    order by e.created_at desc limit 1;
    snapshot_payload := line_payload -> 'catalogSnapshot';

    -- Compatibility for restaurant clients without source_order_line_id.
    if snapshot_payload is null then
      select (array_agg(l.catalog_snapshot order by l.updated_at desc))[1] into snapshot_payload
      from public.order_lines l join public.orders o on o.id = l.order_id
      where l.tenant_id = new.tenant_id and o.tenant_id = new.tenant_id
        and l.venue_id = ticket_venue and o.venue_id = ticket_venue
        and o.cash_session_id = ticket_session
        and l.product_id is not distinct from new.product_id
        and l.variant_id is not distinct from new.variant_id
        and l.unit_price_cents = new.unit_price_cents
        and l.catalog_snapshot <> '{}'::jsonb having count(*) = 1;
    end if;
  end if;

  if snapshot_payload is not null then
    new.category_id_snapshot := nullif(snapshot_payload ->> 'categoryId', '')::uuid;
    new.category_name_snapshot := nullif(snapshot_payload ->> 'categoryName', '');
    new.catalog_tab_id_snapshot := nullif(snapshot_payload ->> 'catalogTabId', '')::uuid;
    new.catalog_tab_name_snapshot := nullif(snapshot_payload ->> 'catalogTabName', '');
  end if;
  new.base_price_cents := coalesce(nullif(line_payload ->> 'basePriceCents', '')::integer, new.unit_price_cents);
  new.component_delta_cents := coalesce(nullif(line_payload ->> 'componentDeltaCents', '')::integer, 0);
  new.modifier_delta_cents := coalesce(nullif(line_payload ->> 'modifierDeltaCents', '')::integer, 0);
  new.gross_before_discount_cents := coalesce(nullif(line_payload ->> 'grossBeforeDiscountCents', '')::integer, new.unit_price_cents);
  return new;
exception when others then
  perform public.record_sale_auxiliary_failure(new.tenant_id, (select venue_id from public.tickets where id = new.ticket_id and tenant_id = new.tenant_id), new.id, 'catalog_snapshot', sqlstate);
  new.category_id_snapshot := null;
  new.category_name_snapshot := null;
  new.catalog_tab_id_snapshot := null;
  new.catalog_tab_name_snapshot := null;
  new.base_price_cents := new.unit_price_cents;
  new.component_delta_cents := 0;
  new.modifier_delta_cents := 0;
  new.gross_before_discount_cents := new.unit_price_cents;
  return new;
end;
$$;


create or replace function public.production_snapshot_line_passes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare component jsonb; category_id uuid;
begin
  if new.split_from_line_id is not null then return new; end if;
  if jsonb_array_length(coalesce(new.components, '[]'::jsonb)) = 0 then
    category_id := coalesce(nullif(new.catalog_snapshot ->> 'categoryId', '')::uuid, public.production_catalog_category(new.tenant_id, new.venue_id, new.product_id));
    perform public.production_upsert_pass_snapshot(new, '', new.product_id, category_id);
  else
    for component in select value from jsonb_array_elements(new.components) loop
      if nullif(component ->> 'productId', '') is null or nullif(component ->> 'id', '') is null then continue; end if;
      category_id := coalesce(nullif(component -> 'metadata' ->> 'categoryId', '')::uuid, public.production_catalog_category(new.tenant_id, new.venue_id, (component ->> 'productId')::uuid));
      perform public.production_upsert_pass_snapshot(new, component ->> 'id', (component ->> 'productId')::uuid, category_id);
    end loop;
  end if;
  return new;
exception when others then
  perform public.record_sale_auxiliary_failure(new.tenant_id, new.venue_id, new.id, 'production_pass', sqlstate);
  
  return new;
end;
$$;
