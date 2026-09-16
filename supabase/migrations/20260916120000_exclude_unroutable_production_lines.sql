-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Keeps the existing production-state RPC signature and result shape while adding routing metadata.
set lock_timeout = '5s';
set statement_timeout = '5min';

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
        'sentQuantity', coalesce(state.sent_quantity, 0),
        'readyQuantity', least(
          greatest(coalesce(state.ready_quantity, 0) - line.served_quantity, 0),
          greatest(line.quantity - line.served_quantity, 0)
        ),
        'unsentQuantity', greatest(line.quantity - coalesce(state.sent_quantity, 0), 0),
        'hasProductionDestination', case
          when jsonb_array_length(coalesce(line.components, '[]'::jsonb)) > 0 then exists (
            select 1
            from jsonb_array_elements(line.components) component
            where coalesce(component ->> 'productId', '') <> ''
          ) and not exists (
            select 1
            from jsonb_array_elements(line.components) component
            where coalesce(component ->> 'productId', '') <> ''
              and public.production_resolve_destination(
                line.tenant_id,
                line.venue_id,
                (component ->> 'productId')::uuid,
                coalesce(
                  nullif(component -> 'metadata' ->> 'categoryId', '')::uuid,
                  public.production_catalog_category(line.tenant_id, line.venue_id, (component ->> 'productId')::uuid)
                )
              ) is null
          )
          else public.production_resolve_destination(
            line.tenant_id,
            line.venue_id,
            line.product_id,
            coalesce(
              nullif(line.catalog_snapshot ->> 'categoryId', '')::uuid,
              public.production_catalog_category(line.tenant_id, line.venue_id, line.product_id)
            )
          ) is not null
        end
      ) order by line.created_at, line.id)
      from public.order_lines line
      left join lateral (
        select sum(quantity - cancelled_quantity)::integer as sent_quantity,
               sum(ready_quantity)::integer as ready_quantity
        from public.production_line_allocations allocation
        where allocation.current_order_line_id = line.id
      ) state on true
      where line.order_id = p_order_id
    ), '[]'::jsonb),
    'warnings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'destinationId', dispatch.destination_id,
        'status', dispatch.status,
        'message', coalesce(dispatch.error_message, 'No se puede confirmar la impresión')
      ) order by dispatch.created_at desc)
      from public.production_printer_dispatches dispatch
      join public.production_batches batch on batch.id = dispatch.batch_id
      where batch.order_id = p_order_id and dispatch.status in ('failed', 'unknown')
    ), '[]'::jsonb)
  );
end;
$$;
