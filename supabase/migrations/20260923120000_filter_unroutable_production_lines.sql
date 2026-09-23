-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Exposes the existing production destination contract accurately so clients can block unroutable products before sending them.

create or replace function public.get_order_production_state(p_order_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare order_row public.orders%rowtype;
begin
  select * into order_row from public.orders where id = p_order_id;
  if order_row.id is null or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'effective', public.production_is_effective(order_row.tenant_id, order_row.venue_id),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lineId', line.id,
        'sentQuantity', coalesce(legacy.sent_quantity, component_state.sent_quantity, 0),
        'readyQuantity', least(greatest(coalesce(legacy.ready_quantity, component_state.ready_quantity, 0) - line.served_quantity, 0), greatest(line.quantity - line.served_quantity, 0)),
        'unsentQuantity', greatest(line.quantity - greatest(coalesce(legacy.sent_quantity, component_state.sent_quantity, 0), line.served_quantity), 0),
        'hasProductionDestination', case
          when jsonb_array_length(coalesce(line.components, '[]'::jsonb)) > 0 then not exists (
            select 1 from jsonb_array_elements(line.components) component
            where coalesce(component ->> 'productId', '') <> ''
              and public.production_resolve_destination(
                line.tenant_id,
                line.venue_id,
                (component ->> 'productId')::uuid,
                coalesce(nullif(component -> 'metadata' ->> 'categoryId', '')::uuid, public.production_catalog_category(line.tenant_id, line.venue_id, (component ->> 'productId')::uuid))
              ) is null
          )
          else public.production_resolve_destination(
            line.tenant_id,
            line.venue_id,
            line.product_id,
            coalesce(nullif(line.catalog_snapshot ->> 'categoryId', '')::uuid, public.production_catalog_category(line.tenant_id, line.venue_id, line.product_id))
          ) is not null
        end
      ) order by line.created_at, line.id)
      from public.order_lines line
      left join lateral (
        select sum(quantity - cancelled_quantity)::numeric(18,3) sent_quantity, sum(ready_quantity)::numeric(18,3) ready_quantity
        from public.production_line_allocations allocation
        where allocation.current_order_line_id = line.id
      ) legacy on true
      left join lateral (
        select min(sum_value)::numeric(18,3) sent_quantity, min(ready_value)::numeric(18,3) ready_quantity
        from (
          select source_component_id, sum(quantity - cancelled_quantity)::numeric(18,3) sum_value, sum(ready_quantity)::numeric(18,3) ready_value
          from public.production_component_allocations
          where current_order_line_id = line.id
          group by source_component_id
        ) grouped
      ) component_state on true
      where line.order_id = p_order_id
    ), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(entry order by entry->>'passSortOrder', entry->>'passName', entry->>'lineId', entry->>'componentId')
      from (
        select jsonb_build_object(
          'lineId', line.id,
          'componentId', nullif(assignment.component_id, ''),
          'productName', coalesce(component.value->>'productName', line.product_name),
          'parentProductName', case when assignment.component_id <> '' then line.product_name else null end,
          'quantity', line.quantity,
          'sentQuantity', coalesce(case when assignment.component_id = '' then (select sum(quantity-cancelled_quantity) from public.production_line_allocations where current_order_line_id=line.id) else (select sum(quantity-cancelled_quantity) from public.production_component_allocations where current_order_line_id=line.id and source_component_id=assignment.component_id) end, 0),
          'readyQuantity', 0,
          'unsentQuantity', greatest(0, line.quantity - greatest(coalesce(case when assignment.component_id = '' then (select sum(quantity-cancelled_quantity) from public.production_line_allocations where current_order_line_id=line.id) else (select sum(quantity-cancelled_quantity) from public.production_component_allocations where current_order_line_id=line.id and source_component_id=assignment.component_id) end, 0), line.served_quantity)),
          'passId', assignment.pass_id,
          'passName', assignment.pass_name,
          'passSortOrder', pass.sort_order,
          'hasProductionDestination', case
            when assignment.component_id = '' then public.production_resolve_destination(
              line.tenant_id,
              line.venue_id,
              line.product_id,
              coalesce(nullif(line.catalog_snapshot ->> 'categoryId', '')::uuid, public.production_catalog_category(line.tenant_id, line.venue_id, line.product_id))
            ) is not null
            else public.production_resolve_destination(
              line.tenant_id,
              line.venue_id,
              (component.value->>'productId')::uuid,
              coalesce(nullif(component.value -> 'metadata' ->> 'categoryId', '')::uuid, public.production_catalog_category(line.tenant_id, line.venue_id, (component.value->>'productId')::uuid))
            ) is not null
          end
        ) entry
        from public.order_line_production_passes assignment
        join public.order_lines line on line.id=assignment.order_line_id
        join public.production_passes pass on pass.id=assignment.pass_id
        left join lateral (select value from jsonb_array_elements(line.components) where value->>'id'=assignment.component_id limit 1) component on true
        where line.order_id=p_order_id
      ) rows
    ), '[]'::jsonb),
    'warnings', coalesce((
      select jsonb_agg(jsonb_build_object('destinationId', dispatch.destination_id, 'status', dispatch.status, 'message', coalesce(dispatch.error_message, 'No se puede confirmar la impresión')) order by dispatch.created_at desc)
      from public.production_printer_dispatches dispatch
      join public.production_batches batch on batch.id = dispatch.batch_id
      where batch.order_id = p_order_id and dispatch.status in ('failed','unknown')
    ), '[]'::jsonb)
  );
end;
$$;
