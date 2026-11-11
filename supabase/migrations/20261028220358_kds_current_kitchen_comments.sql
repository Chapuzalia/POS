-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Keep the KDS RPC signature, result shape, grants, device/tenant/venue checks and workflow unchanged; overlay the latest kitchen comment without rewriting historical snapshots.

create index production_events_kds_note_idx
  on public.production_events(production_item_id, created_at desc, id desc)
  where event_type = 'modified' and payload ? 'note';

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
          'snapshot', item.snapshot || coalesce(current_note.patch, '{}'::jsonb), 'sentAt', batch.created_at
        ) order by batch.created_at, batch.sequence, batch.id, item.created_at, item.id)
        from item_state item join public.production_batches batch on batch.id = item.batch_id
        -- Acknowledging/expiring an alert must not discard the current comment.
        -- Overlay only the response: the original production snapshot stays intact.
        left join lateral (
          select jsonb_build_object('note', event.payload->'note') patch
          from public.production_events event
          where event.production_item_id = item.id
            and event.tenant_id = device_row.tenant_id and event.venue_id = device_row.venue_id
            and event.destination_id = device_row.production_destination_id
            and event.event_type = 'modified' and event.payload ? 'note'
          order by event.created_at desc, event.id desc limit 1
        ) current_note on true
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
