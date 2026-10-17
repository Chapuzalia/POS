-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Keeps routine signatures, grants, tenant/device scope and fiscal/payment RPCs unchanged. A paid current order is effectively served for production reads; open sibling orders and partial-payment orders remain pending. Historical commercial quantities are not mutated.

-- Use the CURRENT allocation owner after splits/moves, not the original source
-- order. Paying one split must not retire an unpaid split's kitchen work.
create or replace function public.production_allocation_progress(p_tenant_id uuid, p_venue_id uuid, p_line_ids uuid[])
returns table(batch_id uuid, source_order_line_id uuid, current_order_line_id uuid, component_id text,
  quantity numeric, ready_quantity numeric, served_quantity numeric, accepted_quantity numeric)
language sql stable set search_path = ''
as $$
  with allocations as (
    select a.id, a.batch_id, a.source_order_line_id, a.current_order_line_id, ''::text component_id,
      a.quantity - a.cancelled_quantity quantity, a.ready_quantity, a.created_at
    from public.production_line_allocations a
    where a.tenant_id = p_tenant_id and a.venue_id = p_venue_id and a.current_order_line_id = any(p_line_ids)
    union all
    select a.id, a.batch_id, a.source_order_line_id, a.current_order_line_id, a.source_component_id,
      a.quantity - a.cancelled_quantity, a.ready_quantity, a.created_at
    from public.production_component_allocations a
    where a.tenant_id = p_tenant_id and a.venue_id = p_venue_id and a.current_order_line_id = any(p_line_ids)
  ), ordered as (
    select a.*, case when current_order.status = 'paid' then line.quantity else line.served_quantity end line_served, coalesce(pass.skipped_quantity, 0) skipped,
      coalesce(sum(a.quantity) over(partition by a.current_order_line_id, a.component_id
        order by batch.created_at, batch.sequence, batch.id, a.created_at, a.id
        rows between unbounded preceding and 1 preceding), 0) prior_quantity
    from allocations a
    join public.order_lines line on line.id = a.current_order_line_id and line.tenant_id = p_tenant_id and line.venue_id = p_venue_id
    join public.orders current_order on current_order.id = line.order_id
      and current_order.tenant_id = p_tenant_id and current_order.venue_id = p_venue_id
    join public.production_batches batch on batch.id = a.batch_id
    left join public.order_line_production_passes pass on pass.order_line_id = line.id and pass.component_id = a.component_id
  )
  select a.batch_id, a.source_order_line_id, a.current_order_line_id, a.component_id, a.quantity, a.ready_quantity,
    least(a.quantity, greatest(0, a.line_served - a.skipped - a.prior_quantity)),
    case when coalesce((select bool_and(item.accepted_at is not null or item.ready_quantity > 0)
      from public.production_items item where item.tenant_id = p_tenant_id and item.venue_id = p_venue_id
        and item.batch_id = a.batch_id and item.source_order_line_id = a.source_order_line_id
        and coalesce(item.source_component_id, '') = a.component_id and item.cancelled_quantity < item.quantity), false)
      then a.quantity else 0 end
  from ordered a;
$$;

create or replace function public.get_kds_workflow_queue(p_device_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare device_row public.devices%rowtype;
begin
  select * into device_row from public.devices where id = p_device_id;
  if device_row.id is null or not device_row.is_active or device_row.device_mode <> 'kds'
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id)
    or not public.production_is_effective(device_row.tenant_id, device_row.venue_id)
    or not exists(select 1 from public.production_destinations d where d.id = device_row.production_destination_id
      and d.tenant_id = device_row.tenant_id and d.venue_id = device_row.venue_id and d.is_active and d.kds_enabled) then
    raise exception 'Producción no está activa para este local' using errcode = '42501';
  end if;
  return (
    with open_progress as materialized (
      select * from public.production_allocation_progress(device_row.tenant_id, device_row.venue_id,
        array(select line.id from public.order_lines line
          join public.orders current_order on current_order.id = line.order_id
            and current_order.tenant_id = line.tenant_id and current_order.venue_id = line.venue_id
          where line.tenant_id = device_row.tenant_id and line.venue_id = device_row.venue_id
            and line.served_quantity < line.quantity and current_order.status <> 'paid'))
    ), candidate_batches as (
      select distinct item.batch_id from public.production_items item join open_progress progress
        on progress.batch_id = item.batch_id and progress.source_order_line_id = item.source_order_line_id
        and progress.component_id = coalesce(item.source_component_id, '')
      where item.tenant_id = device_row.tenant_id and item.venue_id = device_row.venue_id
        and item.destination_id = device_row.production_destination_id and item.cancelled_quantity < item.quantity
        and progress.served_quantity < progress.quantity
    ), scoped_items as materialized (
      select item.* from public.production_items item join candidate_batches batch on batch.batch_id = item.batch_id
      where item.tenant_id = device_row.tenant_id and item.venue_id = device_row.venue_id
        and item.destination_id = device_row.production_destination_id and item.cancelled_quantity < item.quantity
    ), scoped_lines as (
      select a.current_order_line_id id from public.production_line_allocations a join scoped_items item
        on item.batch_id = a.batch_id and item.source_order_line_id = a.source_order_line_id and item.source_component_id is null
      union
      select a.current_order_line_id from public.production_component_allocations a join scoped_items item
        on item.batch_id = a.batch_id and item.source_order_line_id = a.source_order_line_id and item.source_component_id = a.source_component_id
    ), progress as materialized (
      select * from public.production_allocation_progress(device_row.tenant_id, device_row.venue_id, array(select id from scoped_lines))
    ), item_state as materialized (
      select item.*, least(item.quantity - item.cancelled_quantity, coalesce((select sum(p.served_quantity) from progress p
        where p.batch_id = item.batch_id and p.source_order_line_id = item.source_order_line_id
          and p.component_id = coalesce(item.source_component_id, '')), 0) * item.units_per_commercial_unit) served_quantity
      from scoped_items item
    )
    select jsonb_build_object('destinationId', device_row.production_destination_id,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', item.id, 'batchId', item.batch_id, 'batchSequence', batch.sequence, 'orderId', item.source_order_id,
          'tableName', coalesce(table_names.name, 'Comanda'), 'quantity', item.quantity,
          'readyQuantity', item.ready_quantity, 'cancelledQuantity', item.cancelled_quantity,
          'servedQuantity', item.served_quantity, 'acceptedAt', item.accepted_at,
          'snapshot', item.snapshot, 'sentAt', batch.created_at
        ) order by batch.created_at, batch.sequence, batch.id, item.created_at, item.id)
        from item_state item join public.production_batches batch on batch.id = item.batch_id
        left join lateral (
          select string_agg(table_ref.name, ' + ' order by table_ref.name) name
          from public.orders order_ref join public.order_tables link on link.order_group_id = order_ref.order_group_id and link.released_at is null
          join public.restaurant_tables table_ref on table_ref.id = link.table_id where order_ref.id = item.source_order_id
        ) table_names on true
        where exists(select 1 from item_state pending where pending.batch_id = item.batch_id and pending.served_quantity + pending.cancelled_quantity < pending.quantity)
      ), '[]'::jsonb),
      'events', coalesce((select jsonb_agg(to_jsonb(event) order by event.created_at desc) from (
        select id, event_type, quantity, payload, created_at from public.production_events
        where tenant_id = device_row.tenant_id and venue_id = device_row.venue_id and destination_id = device_row.production_destination_id
          and acknowledged_at is null and created_at > now() - interval '8 hours' order by created_at desc limit 50
      ) event), '[]'::jsonb)
    )
  );
end;
$$;

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
  return (
    with progress as materialized (
      select * from public.production_allocation_progress(order_row.tenant_id, order_row.venue_id,
        array(select id from public.order_lines where order_id = p_order_id))
    ), entry_state as materialized (
      select line.id line_id, assignment.component_id, line.quantity, (case when order_row.status = 'paid' then line.quantity else line.served_quantity end) served_quantity,
        coalesce(component.value->>'productName', line.product_name) product_name,
        case when assignment.component_id <> '' then line.product_name end parent_product_name,
        assignment.pass_id, assignment.pass_name, pass.sort_order,
        coalesce(assignment.skipped_quantity, 0) skipped_quantity,
        (select coalesce(sum(p.accepted_quantity), 0) from progress p where p.current_order_line_id = line.id and p.component_id = assignment.component_id) accepted_quantity,
        coalesce(case when assignment.component_id = '' then
          (select sum(quantity-cancelled_quantity) from public.production_line_allocations where current_order_line_id = line.id)
        else
          (select sum(quantity-cancelled_quantity) from public.production_component_allocations where current_order_line_id = line.id and source_component_id = assignment.component_id)
        end, 0) sent_quantity,
        coalesce(case when assignment.component_id = '' then
          (select sum(ready_quantity) from public.production_line_allocations where current_order_line_id = line.id)
        else
          (select sum(ready_quantity) from public.production_component_allocations where current_order_line_id = line.id and source_component_id = assignment.component_id)
        end, 0) ready_quantity,
        public.production_resolve_destination(line.tenant_id, line.venue_id,
          case when assignment.component_id = '' then line.product_id else (component.value->>'productId')::uuid end,
          case when assignment.component_id = '' then
            coalesce(nullif(line.catalog_snapshot->>'categoryId', '')::uuid, public.production_catalog_category(line.tenant_id, line.venue_id, line.product_id))
          else
            coalesce(nullif(component.value->'metadata'->>'categoryId', '')::uuid, public.production_catalog_category(line.tenant_id, line.venue_id, (component.value->>'productId')::uuid))
          end
        ) is not null has_destination
      from public.order_lines line
      join public.order_line_production_passes assignment on assignment.order_line_id = line.id
      join public.production_passes pass on pass.id = assignment.pass_id
      left join lateral (select value from jsonb_array_elements(line.components) where value->>'id' = assignment.component_id limit 1) component on true
      where line.order_id = p_order_id
    )
    select jsonb_build_object(
      'effective', public.production_is_effective(order_row.tenant_id, order_row.venue_id),
      'entries', coalesce((
        select jsonb_agg(jsonb_build_object(
          'lineId', line_id, 'componentId', nullif(component_id, ''),
          'productName', product_name, 'parentProductName', parent_product_name,
          'quantity', quantity, 'sentQuantity', sent_quantity, 'skippedQuantity', skipped_quantity,
          'readyQuantity', least(greatest(ready_quantity + skipped_quantity - served_quantity, 0), greatest(quantity - served_quantity, 0)),
          'unsentQuantity', greatest(0, quantity - greatest(sent_quantity + skipped_quantity, served_quantity)),
          'preparingQuantity', greatest(0,
            least(greatest(accepted_quantity + skipped_quantity - served_quantity, 0), greatest(quantity - served_quantity, 0))
            - least(greatest(ready_quantity + skipped_quantity - served_quantity, 0), greatest(quantity - served_quantity, 0))),
          'passId', pass_id, 'passName', pass_name, 'passSortOrder', sort_order,
          'hasProductionDestination', has_destination
        ) order by sort_order, pass_name, line_id, component_id) from entry_state
      ), '[]'::jsonb),
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
          'lineId', line.id,
          'sentQuantity', coalesce(state.sent_quantity, 0),
          'readyQuantity', least(greatest(coalesce(state.ready_quantity, 0) - (case when order_row.status = 'paid' then line.quantity else line.served_quantity end), 0), greatest(line.quantity - (case when order_row.status = 'paid' then line.quantity else line.served_quantity end), 0)),
          'unsentQuantity', greatest(0, line.quantity - greatest(coalesce(state.accounted_quantity, 0), (case when order_row.status = 'paid' then line.quantity else line.served_quantity end))),
          'preparingQuantity', greatest(0,
            least(greatest(coalesce(state.accepted_quantity, 0) - (case when order_row.status = 'paid' then line.quantity else line.served_quantity end), 0), greatest(line.quantity - (case when order_row.status = 'paid' then line.quantity else line.served_quantity end), 0))
            - least(greatest(coalesce(state.ready_quantity, 0) - (case when order_row.status = 'paid' then line.quantity else line.served_quantity end), 0), greatest(line.quantity - (case when order_row.status = 'paid' then line.quantity else line.served_quantity end), 0))),
          'hasProductionDestination', coalesce(state.has_destination, false)
        ) order by line.created_at, line.id)
        from public.order_lines line
        left join lateral (
          select min(entry.sent_quantity) sent_quantity,
            min(entry.sent_quantity + entry.skipped_quantity) accounted_quantity,
            min(entry.ready_quantity + entry.skipped_quantity) ready_quantity,
            min(entry.accepted_quantity + entry.skipped_quantity) accepted_quantity,
            bool_and(entry.has_destination) has_destination
          from entry_state entry where entry.line_id = line.id
        ) state on true
        where line.order_id = p_order_id
      ), '[]'::jsonb),
      'warnings', coalesce((
        select jsonb_agg(jsonb_build_object('destinationId', dispatch.destination_id, 'status', dispatch.status, 'message', coalesce(dispatch.error_message, 'No se puede confirmar la impresión')) order by dispatch.created_at desc)
        from public.production_printer_dispatches dispatch join public.production_batches batch on batch.id = dispatch.batch_id
        where batch.order_id = p_order_id and dispatch.status in ('failed', 'unknown')
      ), '[]'::jsonb)
    )
  );
end;
$$;

notify pgrst, 'reload schema';
