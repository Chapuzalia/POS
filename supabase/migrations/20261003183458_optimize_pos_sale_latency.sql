-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserve legacy trigger contracts and grant the new invoker-only stats RPC exclusively to authenticated callers.
-- Existing trigger signatures, security checks and legacy callers are preserved.

-- Scalar search keys allow index conditions before the existing payload-based RLS.
-- They are always derived by the database, including for N-1 offline clients.
alter table public.offline_event_log
  add column if not exists sale_ticket_id text,
  add column if not exists sale_cash_session_id text;

create or replace function public.set_offline_sale_search_keys()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.sale_ticket_id := case when new.event_kind = 'sale_created' then new.payload -> 'ticket' ->> 'id' end;
  new.sale_cash_session_id := case when new.event_kind = 'sale_created' then new.payload -> 'ticket' ->> 'cashSessionId' end;
  return new;
end;
$$;

create trigger set_offline_sale_search_keys
before insert or update on public.offline_event_log
for each row execute function public.set_offline_sale_search_keys();

update public.offline_event_log
set sale_ticket_id = payload -> 'ticket' ->> 'id',
    sale_cash_session_id = payload -> 'ticket' ->> 'cashSessionId'
where event_kind = 'sale_created'
  and (sale_ticket_id is distinct from payload -> 'ticket' ->> 'id'
    or sale_cash_session_id is distinct from payload -> 'ticket' ->> 'cashSessionId');

create index concurrently if not exists offline_event_log_sale_session_ticket_idx
on public.offline_event_log (tenant_id, sale_cash_session_id, sale_ticket_id, id)
where event_kind = 'sale_created';

create index concurrently if not exists offline_event_log_sale_id_idx
on public.offline_event_log (tenant_id, ((payload -> 'sale') ->> 'id'), created_at desc)
where event_kind = 'sale_created';

-- Full close was missing the correlation already supplied by partial/equal payments.
-- Guarded replacement preserves the installed economic routine and its permissions.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public.close_order_and_create_sale_v2(uuid,text,integer,jsonb)'::regprocedure);
  if position('quantity, source_order_line_id, unit_price_cents' in definition) = 0 then
    if position('quantity, unit_price_cents, line_total_cents, modifiers' in definition) = 0
      or position('ol.quantity, ol.unit_price_cents,' in definition) = 0 then
      raise exception 'POS_CLOSE_SOURCE_LINE_SIGNATURE_NOT_FOUND';
    end if;
    definition := replace(definition, 'quantity, unit_price_cents, line_total_cents, modifiers',
      'quantity, source_order_line_id, unit_price_cents, line_total_cents, modifiers');
    definition := replace(definition, 'ol.quantity, ol.unit_price_cents,', 'ol.quantity, ol.id, ol.unit_price_cents,');
    execute definition;
  end if;
end;
$$;

-- Aggregate all authorized lines, rather than silently truncating at the API row limit.
-- SECURITY INVOKER deliberately retains the tickets/ticket_lines policies.
create or replace function public.pos_product_sales_stats(
  p_tenant_id uuid, p_venue_id uuid, p_after_product_id uuid default null,
  p_limit integer default 500
) returns table(product_id uuid, quantity numeric, total_cents bigint)
language sql stable security invoker set search_path = '' as $$
  select l.product_id, sum(coalesce(l.allocated_quantity, l.quantity)), sum(l.line_total_cents)::bigint
  from public.tickets t join public.ticket_lines l on l.ticket_id = t.id and l.tenant_id = t.tenant_id
  where auth.uid() is not null and t.tenant_id = p_tenant_id and t.venue_id = p_venue_id
    and t.status = 'paid' and l.product_id is not null
    and (p_after_product_id is null or l.product_id > p_after_product_id)
  group by l.product_id order by l.product_id
  limit greatest(1, least(coalesce(p_limit, 500), 500));
$$;
-- New authenticated read RPC; anonymous and PUBLIC execution is unnecessary.
revoke all on function public.pos_product_sales_stats(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.pos_product_sales_stats(uuid, uuid, uuid, integer) to authenticated;

create or replace function public.apply_cashlogy_identity_from_sale_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment_payload jsonb;
begin
  if new.method is distinct from 'cash' or new.cashlogy_request_id is not null or new.cashlogy_transaction_id is not null then
    return new;
  end if;

  select event.payload -> 'payment'
  into payment_payload
  from public.offline_event_log event
  where event.tenant_id = new.tenant_id
    and event.event_kind = 'sale_created'
    and event.payload -> 'sale' ->> 'id' = new.sale_id::text
  order by event.created_at desc
  limit 1;

  if jsonb_typeof(payment_payload) = 'object'
    and nullif(btrim(payment_payload ->> 'cashlogyRequestId'), '') is not null
    and nullif(btrim(payment_payload ->> 'cashlogyTransactionId'), '') is not null then
    new.cashlogy_request_id := payment_payload ->> 'cashlogyRequestId';
    new.cashlogy_transaction_id := payment_payload ->> 'cashlogyTransactionId';
  end if;

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
end;
$$;

