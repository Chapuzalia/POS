-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserve the trigger signature, grants and legacy snapshot fallback; use scoped source-line lookup and existing indexed sale-event keys.

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
end;
$$;
