-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Keeps existing RPC signatures and grants, adds durable KDS acknowledgement, and formats production-only template quantities without changing stored quantities or dispatch payloads already queued. The new acknowledgement RPC is restricted to authenticated users with access to the KDS device and destination.
-- The send RPC retains its order/device/line locks and request idempotency; skipped
-- quantities account for directly served units without resending them or changing sales.

-- Keep operational notices in the audit trail after the kitchen acknowledges them.
alter table public.production_events add column acknowledged_at timestamptz;

create function public.acknowledge_kds_event(p_device_id uuid, p_event_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare device_row public.devices%rowtype;
begin
  select * into device_row from public.devices where id = p_device_id;
  if device_row.id is null or not device_row.is_active or device_row.device_mode <> 'kds'
    or device_row.production_destination_id is null
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id)
    or not public.production_is_effective(device_row.tenant_id, device_row.venue_id)
    or not exists (
      select 1 from public.production_destinations destination
      where destination.id = device_row.production_destination_id
        and destination.tenant_id = device_row.tenant_id and destination.venue_id = device_row.venue_id
        and destination.is_active and destination.kds_enabled
    ) then
    raise exception 'El KDS no puede modificar este destino' using errcode = '42501';
  end if;
  update public.production_events
  set acknowledged_at = coalesce(acknowledged_at, now())
  where id = p_event_id and tenant_id = device_row.tenant_id and venue_id = device_row.venue_id
    and destination_id = device_row.production_destination_id;
  if not found then
    raise exception 'Aviso no disponible para este KDS' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.acknowledge_kds_event(uuid, uuid) from public, anon;
grant execute on function public.acknowledge_kds_event(uuid, uuid) to authenticated;

create or replace function public.get_kds_queue(p_device_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare device_row public.devices%rowtype;
begin
  select * into device_row from public.devices where id = p_device_id;
  if device_row.id is null or not device_row.is_active or device_row.device_mode <> 'kds'
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id)
    or not public.production_is_effective(device_row.tenant_id, device_row.venue_id)
    or not exists (
      select 1 from public.production_destinations destination
      where destination.id = device_row.production_destination_id
        and destination.tenant_id = device_row.tenant_id and destination.venue_id = device_row.venue_id
        and destination.is_active and destination.kds_enabled
    ) then
    raise exception 'Producción no está activa para este local' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'destinationId', device_row.production_destination_id,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'batchId', item.batch_id,
        'batchSequence', batch.sequence,
        'orderId', item.source_order_id,
        'tableName', coalesce(table_names.name, 'Comanda'),
        'quantity', item.quantity,
        'readyQuantity', item.ready_quantity,
        'cancelledQuantity', item.cancelled_quantity,
        'snapshot', item.snapshot,
        'sentAt', item.created_at
      ) order by item.created_at, item.id)
      from public.production_items item
      join public.production_batches batch on batch.id = item.batch_id
      left join lateral (
        select string_agg(table_ref.name, ' + ' order by table_ref.name) as name
        from public.orders order_ref
        join public.order_tables link on link.order_group_id = order_ref.order_group_id and link.released_at is null
        join public.restaurant_tables table_ref on table_ref.id = link.table_id
        where order_ref.id = item.source_order_id
      ) table_names on true
      where item.tenant_id = device_row.tenant_id and item.venue_id = device_row.venue_id
        and item.destination_id = device_row.production_destination_id
        and item.ready_quantity + item.cancelled_quantity < item.quantity
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(event_row) order by event_row.created_at desc)
      from (
        select id, event_type, quantity, payload, created_at
        from public.production_events
        where tenant_id = device_row.tenant_id and venue_id = device_row.venue_id
          and destination_id = device_row.production_destination_id
          and acknowledged_at is null
          and created_at > now() - interval '8 hours'
        order by created_at desc limit 50
      ) event_row
    ), '[]'::jsonb)
  );
end;
$$;

-- Quantities are display strings only in this production print context. The database
-- counters and existing immutable dispatch payloads retain their numeric values.
create function public.production_format_quantity(p_quantity numeric)
returns text
language sql immutable strict
set search_path = ''
as $$ select replace(trim_scale(p_quantity)::text, '.', ','); $$;

create or replace function public.production_item_lines(p_snapshot jsonb, p_quantity numeric)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  lines jsonb := jsonb_build_array(
    public.production_format_quantity(p_quantity) || 'x ' || coalesce(p_snapshot ->> 'productName', 'Producto')
  );
  modifier jsonb;
  note_value text;
begin
  if coalesce(p_snapshot ->> 'variantName', '') <> '' then
    lines := lines || jsonb_build_array('  ' || upper(p_snapshot ->> 'variantName'));
  end if;
  if coalesce(p_snapshot ->> 'parentProductName', '') <> '' then
    lines := lines || jsonb_build_array('  MENÚ: ' || upper(p_snapshot ->> 'parentProductName'));
  end if;
  for modifier in select value from jsonb_array_elements(coalesce(p_snapshot -> 'lineModifiers', '[]'::jsonb)) loop
    lines := lines || jsonb_build_array('  ' || upper(coalesce(modifier ->> 'name', '')));
  end loop;
  for modifier in select value from jsonb_array_elements(coalesce(p_snapshot -> 'componentModifiers', '[]'::jsonb)) loop
    lines := lines || jsonb_build_array('  ' || upper(coalesce(modifier ->> 'name', '')));
  end loop;
  note_value := nullif(btrim(coalesce(p_snapshot ->> 'note', '')), '');
  if note_value is not null then lines := lines || jsonb_build_array('  NOTA: ' || upper(note_value)); end if;
  return lines;
end;
$$;

create or replace function public.production_item_print_context(p_snapshot jsonb, p_quantity numeric)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare details jsonb := '[]'::jsonb; modifier jsonb; note_value text;
begin
  if nullif(btrim(coalesce(p_snapshot ->> 'variantName', '')), '') is not null then
    details := details || jsonb_build_array(jsonb_build_object('text', '  ' || upper(p_snapshot ->> 'variantName')));
  end if;
  if nullif(btrim(coalesce(p_snapshot ->> 'parentProductName', '')), '') is not null then
    details := details || jsonb_build_array(jsonb_build_object('text', '  MENÚ: ' || upper(p_snapshot ->> 'parentProductName')));
  end if;
  for modifier in select value from jsonb_array_elements(coalesce(p_snapshot -> 'lineModifiers', '[]'::jsonb)) loop
    details := details || jsonb_build_array(jsonb_build_object('text', '  ' || upper(coalesce(modifier ->> 'name', ''))));
  end loop;
  for modifier in select value from jsonb_array_elements(coalesce(p_snapshot -> 'componentModifiers', '[]'::jsonb)) loop
    details := details || jsonb_build_array(jsonb_build_object('text', '  ' || upper(coalesce(modifier ->> 'name', ''))));
  end loop;
  note_value := nullif(btrim(coalesce(p_snapshot ->> 'note', '')), '');
  if note_value is not null then
    details := details || jsonb_build_array(jsonb_build_object('text', '  NOTA: ' || upper(note_value)));
  end if;
  return jsonb_build_object(
    'quantity', public.production_format_quantity(p_quantity),
    'name', coalesce(nullif(btrim(p_snapshot ->> 'productName'), ''), 'Producto'),
    'details', details
  );
end;
$$;

-- Preserve the integer overloads for older clients and stored callers.
create or replace function public.production_item_lines(p_snapshot jsonb, p_quantity integer)
returns jsonb language sql immutable set search_path = ''
as $$ select public.production_item_lines(p_snapshot, p_quantity::numeric); $$;

create or replace function public.production_item_print_context(p_snapshot jsonb, p_quantity integer)
returns jsonb language sql immutable set search_path = ''
as $$ select public.production_item_print_context(p_snapshot, p_quantity::numeric); $$;

-- Units served directly before production starts must be consumed exactly once,
-- independently for each menu component. Never create fake kitchen items for them.
alter table public.order_line_production_passes add column skipped_quantity numeric(18,3) default 0;
alter table public.order_line_production_passes add constraint order_line_production_passes_skipped_check
  check (skipped_quantity >= 0) not valid;
create or replace function public.send_production_batch(
  p_order_id uuid, p_expected_revision integer, p_device_id uuid, p_request_id text, p_selection jsonb default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare order_row public.orders%rowtype; device_row public.devices%rowtype; line_row public.order_lines%rowtype;
  component jsonb; pass_snapshot public.order_line_production_passes%rowtype; destination_id uuid; category_id uuid;
  new_batch_id uuid; sequence_value integer; selected_quantity numeric(18,3); unsent_quantity numeric(18,3); sent_quantity numeric(18,3);
  multiplier integer; item_quantity numeric(18,3); item_count integer := 0; selected_total numeric(18,3) := 0; printer_dispatches integer := 0; existing_batch public.production_batches%rowtype; selected_pass_id uuid; selected_pass_name text;
begin
  if auth.uid() is null then raise exception 'Autenticación requerida' using errcode = '42501'; end if;
  if p_selection is not null and jsonb_typeof(p_selection) <> 'array' then raise exception 'La selección de producción no es válida' using errcode = '22023'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open' or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then raise exception 'Comanda no disponible' using errcode = '42501'; end if;
  select * into existing_batch from public.production_batches where venue_id = order_row.venue_id and request_id = p_request_id;
  if existing_batch.id is not null then return jsonb_build_object('batchId', existing_batch.id, 'sequence', existing_batch.sequence, 'duplicate', true, 'sentUnits', coalesce((select sum(quantity) from public.production_line_allocations where batch_id = existing_batch.id), (select sum(quantity) from public.production_component_allocations where batch_id = existing_batch.id), 0)); end if;
  if not public.production_is_effective(order_row.tenant_id, order_row.venue_id) then raise exception 'Producción no está activa para este local' using errcode = '42501'; end if;
  select * into device_row from public.devices where id = p_device_id for update;
  if device_row.id is null or not device_row.is_active or device_row.tenant_id <> order_row.tenant_id or device_row.venue_id <> order_row.venue_id or device_row.device_mode = 'kds' or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id) then raise exception 'El dispositivo no puede enviar esta comanda' using errcode = '42501'; end if;
  if order_row.revision <> p_expected_revision then raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001'; end if;
  perform 1 from public.order_lines where order_id = p_order_id order by id for update;
  if p_selection is not null then
    select nullif(entry ->> 'passId', '')::uuid, nullif(entry ->> 'passName', '') into selected_pass_id, selected_pass_name from jsonb_array_elements(p_selection) entry where nullif(entry ->> 'passId', '') is not null limit 1;
    if exists (select 1 from jsonb_array_elements(p_selection) entry where nullif(entry ->> 'passId', '')::uuid is distinct from selected_pass_id) then
      raise exception 'Una selección solo puede pertenecer a un pase' using errcode = '22023';
    end if;
  end if;
  if selected_pass_id is not null and not exists (select 1 from public.production_passes where id = selected_pass_id and venue_id = order_row.venue_id and is_active) then raise exception 'Pase no disponible' using errcode = '40001'; end if;
  sequence_value := coalesce((select max(sequence) from public.production_batches where order_id = p_order_id), 0) + 1;
  new_batch_id := gen_random_uuid();
  insert into public.production_batches (id, tenant_id, venue_id, order_id, sequence, request_id, actor_user_id, actor_device_id, pass_id, pass_name) values (new_batch_id, order_row.tenant_id, order_row.venue_id, p_order_id, sequence_value, p_request_id, auth.uid(), device_row.id, selected_pass_id, selected_pass_name);
  for line_row in select * from public.order_lines where order_id = p_order_id order by created_at, id loop
    if jsonb_array_length(coalesce(line_row.components, '[]'::jsonb)) = 0 then
      perform public.production_upsert_pass_snapshot(line_row, '', line_row.product_id, coalesce(nullif(line_row.catalog_snapshot ->> 'categoryId', '')::uuid, public.production_catalog_category(line_row.tenant_id, line_row.venue_id, line_row.product_id)));
      select * into pass_snapshot from public.order_line_production_passes where order_line_id = line_row.id and component_id = '';
      if selected_pass_id is not null and pass_snapshot.pass_id <> selected_pass_id then continue; end if;
      select coalesce(sum(quantity - cancelled_quantity), 0) into sent_quantity from public.production_line_allocations where current_order_line_id = line_row.id;
      update public.order_line_production_passes
      set skipped_quantity = greatest(coalesce(skipped_quantity, 0), line_row.served_quantity - sent_quantity)
      where order_line_id = line_row.id and component_id = pass_snapshot.component_id
      returning * into pass_snapshot;
      unsent_quantity := greatest(0, line_row.quantity - sent_quantity - pass_snapshot.skipped_quantity);
      if p_selection is null then selected_quantity := unsent_quantity; else select coalesce(sum((entry ->> 'quantity')::numeric(18,3)), 0) into selected_quantity from jsonb_array_elements(p_selection) entry where entry ->> 'lineId' = line_row.id::text and coalesce(entry ->> 'componentId', '') = ''; end if;
      if selected_quantity < 0 or selected_quantity > unsent_quantity then raise exception 'La cantidad seleccionada de % ya no está disponible', line_row.product_name using errcode = '40001'; end if;
      if selected_quantity = 0 then continue; end if;
      category_id := coalesce(nullif(line_row.catalog_snapshot ->> 'categoryId', '')::uuid, public.production_catalog_category(line_row.tenant_id, line_row.venue_id, line_row.product_id));
      destination_id := public.production_resolve_destination(line_row.tenant_id, line_row.venue_id, line_row.product_id, category_id);
      if destination_id is null then raise exception 'Sin routing de producción: %', line_row.product_name using errcode = 'P0001'; end if;
      insert into public.production_line_allocations (tenant_id, venue_id, batch_id, source_order_line_id, current_order_line_id, quantity) values (line_row.tenant_id, line_row.venue_id, new_batch_id, line_row.id, line_row.id, selected_quantity);
      insert into public.production_items (tenant_id, venue_id, batch_id, destination_id, source_order_id, source_order_line_id, product_id, variant_id, quantity, snapshot, pass_id, pass_name) values (line_row.tenant_id, line_row.venue_id, new_batch_id, destination_id, line_row.order_id, line_row.id, line_row.product_id, line_row.variant_id, selected_quantity, jsonb_build_object('productName', line_row.product_name, 'variantName', line_row.variant_name, 'lineModifiers', coalesce(line_row.modifiers, '[]'::jsonb), 'componentModifiers', '[]'::jsonb, 'note', line_row.note, 'destinationId', destination_id, 'sourceOrderId', line_row.order_id, 'sourceOrderLineId', line_row.id, 'passId', pass_snapshot.pass_id, 'passName', pass_snapshot.pass_name), pass_snapshot.pass_id, pass_snapshot.pass_name);
      selected_total := selected_total + selected_quantity; item_count := item_count + 1;
    else
      for component in select value from jsonb_array_elements(line_row.components) loop
        if nullif(component ->> 'productId', '') is null or nullif(component ->> 'id', '') is null then continue; end if;
        category_id := coalesce(nullif(component -> 'metadata' ->> 'categoryId', '')::uuid, public.production_catalog_category(line_row.tenant_id, line_row.venue_id, (component ->> 'productId')::uuid));
        perform public.production_upsert_pass_snapshot(line_row, component ->> 'id', (component ->> 'productId')::uuid, category_id);
        select * into pass_snapshot from public.order_line_production_passes where order_line_id = line_row.id and component_id = component ->> 'id';
        if selected_pass_id is not null and pass_snapshot.pass_id <> selected_pass_id then continue; end if;
        select coalesce(sum(quantity - cancelled_quantity), 0) into sent_quantity from public.production_component_allocations where current_order_line_id = line_row.id and source_component_id = component ->> 'id';
        update public.order_line_production_passes
      set skipped_quantity = greatest(coalesce(skipped_quantity, 0), line_row.served_quantity - sent_quantity)
      where order_line_id = line_row.id and component_id = pass_snapshot.component_id
      returning * into pass_snapshot;
      unsent_quantity := greatest(0, line_row.quantity - sent_quantity - pass_snapshot.skipped_quantity);
        if p_selection is null then selected_quantity := unsent_quantity; else select coalesce(sum((entry ->> 'quantity')::numeric(18,3)), 0) into selected_quantity from jsonb_array_elements(p_selection) entry where entry ->> 'lineId' = line_row.id::text and entry ->> 'componentId' = component ->> 'id'; end if;
        if selected_quantity < 0 or selected_quantity > unsent_quantity then raise exception 'La cantidad seleccionada de % ya no está disponible', coalesce(component ->> 'productName', line_row.product_name) using errcode = '40001'; end if;
        if selected_quantity = 0 then continue; end if;
        destination_id := public.production_resolve_destination(line_row.tenant_id, line_row.venue_id, (component ->> 'productId')::uuid, category_id);
        if destination_id is null then raise exception 'Sin routing de producción: %', coalesce(component ->> 'productName', line_row.product_name) using errcode = 'P0001'; end if;
        multiplier := greatest(coalesce((component ->> 'quantity')::integer, 1), 1); item_quantity := selected_quantity * multiplier;
        insert into public.production_component_allocations (tenant_id, venue_id, batch_id, source_order_line_id, current_order_line_id, source_component_id, quantity) values (line_row.tenant_id, line_row.venue_id, new_batch_id, line_row.id, line_row.id, component ->> 'id', selected_quantity);
        insert into public.production_items (tenant_id, venue_id, batch_id, destination_id, source_order_id, source_order_line_id, source_component_id, product_id, variant_id, quantity, units_per_commercial_unit, snapshot, pass_id, pass_name) values (line_row.tenant_id, line_row.venue_id, new_batch_id, destination_id, line_row.order_id, line_row.id, component ->> 'id', (component ->> 'productId')::uuid, nullif(component ->> 'variantId', '')::uuid, item_quantity, multiplier, jsonb_build_object('productName', coalesce(component ->> 'productName', line_row.product_name), 'variantName', coalesce(component ->> 'variantName', ''), 'parentProductName', line_row.product_name, 'lineModifiers', coalesce(line_row.modifiers, '[]'::jsonb), 'componentModifiers', coalesce(component -> 'modifiers', '[]'::jsonb), 'note', line_row.note, 'destinationId', destination_id, 'sourceOrderId', line_row.order_id, 'sourceOrderLineId', line_row.id, 'sourceComponentId', component ->> 'id', 'passId', pass_snapshot.pass_id, 'passName', pass_snapshot.pass_name), pass_snapshot.pass_id, pass_snapshot.pass_name);
        selected_total := selected_total + selected_quantity; item_count := item_count + 1;
      end loop;
    end if;
  end loop;
  if selected_total = 0 or item_count = 0 then raise exception 'No hay productos nuevos que enviar' using errcode = 'P0001'; end if;
  update public.production_batches batch set pass_id = coalesce(batch.pass_id, (select min(item.pass_id::text)::uuid from public.production_items item where item.batch_id = batch.id)), pass_name = coalesce(batch.pass_name, (select min(item.pass_name) from public.production_items item where item.batch_id = batch.id)) where batch.id = new_batch_id;
  printer_dispatches := public.production_create_batch_dispatches(new_batch_id);
  return jsonb_build_object('batchId', new_batch_id, 'sequence', sequence_value, 'duplicate', false, 'sentUnits', selected_total, 'itemCount', item_count, 'printerDispatches', printer_dispatches);
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
    with entry_state as materialized (
      select line.id line_id, assignment.component_id, line.quantity, line.served_quantity,
        coalesce(component.value->>'productName', line.product_name) product_name,
        case when assignment.component_id <> '' then line.product_name end parent_product_name,
        assignment.pass_id, assignment.pass_name, pass.sort_order,
        coalesce(assignment.skipped_quantity, 0) skipped_quantity,
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
          'passId', pass_id, 'passName', pass_name, 'passSortOrder', sort_order,
          'hasProductionDestination', has_destination
        ) order by sort_order, pass_name, line_id, component_id) from entry_state
      ), '[]'::jsonb),
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
          'lineId', line.id,
          'sentQuantity', coalesce(state.sent_quantity, 0),
          'readyQuantity', least(greatest(coalesce(state.ready_quantity, 0) - line.served_quantity, 0), greatest(line.quantity - line.served_quantity, 0)),
          'unsentQuantity', greatest(0, line.quantity - greatest(coalesce(state.accounted_quantity, 0), line.served_quantity)),
          'hasProductionDestination', coalesce(state.has_destination, false)
        ) order by line.created_at, line.id)
        from public.order_lines line
        left join lateral (
          select min(entry.sent_quantity) sent_quantity,
            min(entry.sent_quantity + entry.skipped_quantity) accounted_quantity,
            min(entry.ready_quantity + entry.skipped_quantity) ready_quantity,
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

-- Split directly served units first, matching the commercial split's served-first
-- rule. The existing allocation trigger then moves only the remaining units.
create or replace function public.production_copy_passes_after_split()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare assignment public.order_line_production_passes%rowtype; moved numeric;
begin
  if new.split_from_line_id is null then return new; end if;
  for assignment in select * from public.order_line_production_passes
    where order_line_id = new.split_from_line_id order by component_id for update
  loop
    moved := least(coalesce(assignment.skipped_quantity, 0), new.served_quantity);
    insert into public.order_line_production_passes(tenant_id, venue_id, order_line_id, component_id, pass_id, pass_name, skipped_quantity)
    values(assignment.tenant_id, assignment.venue_id, new.id, assignment.component_id, assignment.pass_id, assignment.pass_name, moved)
    on conflict(order_line_id, component_id) do nothing;
    update public.order_line_production_passes set skipped_quantity = coalesce(skipped_quantity, 0) - moved
    where order_line_id = new.split_from_line_id and component_id = assignment.component_id;
  end loop;
  return new;
end;
$$;

create or replace function public.production_move_allocations_to_split_line()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare allocation public.production_line_allocations%rowtype; component_allocation public.production_component_allocations%rowtype;
  assignment public.order_line_production_passes%rowtype; remaining numeric; moved numeric; moved_ready numeric;
begin
  if new.split_from_line_id is null then return new; end if;
  remaining := greatest(0, new.quantity - coalesce((select skipped_quantity from public.order_line_production_passes where order_line_id = new.id and component_id = ''), 0));
  for allocation in select * from public.production_line_allocations
    where current_order_line_id = new.split_from_line_id and quantity > cancelled_quantity
    order by created_at desc, id desc for update
  loop
    exit when remaining <= 0;
    moved := least(allocation.quantity - allocation.cancelled_quantity, remaining);
    moved_ready := least(allocation.ready_quantity, moved);
    update public.production_line_allocations set quantity = quantity - moved, ready_quantity = ready_quantity - moved_ready, updated_at = now() where id = allocation.id;
    insert into public.production_line_allocations(tenant_id, venue_id, batch_id, source_order_line_id, current_order_line_id, quantity, ready_quantity)
    values(allocation.tenant_id, allocation.venue_id, allocation.batch_id, allocation.source_order_line_id, new.id, moved, moved_ready)
    on conflict(batch_id, source_order_line_id, current_order_line_id) do update
      set quantity = public.production_line_allocations.quantity + excluded.quantity, ready_quantity = public.production_line_allocations.ready_quantity + excluded.ready_quantity, updated_at = now();
    remaining := remaining - moved;
  end loop;
  for assignment in select * from public.order_line_production_passes where order_line_id = new.id and component_id <> '' order by component_id
  loop
    remaining := greatest(0, new.quantity - coalesce(assignment.skipped_quantity, 0));
    for component_allocation in select * from public.production_component_allocations
      where current_order_line_id = new.split_from_line_id and source_component_id = assignment.component_id and quantity > cancelled_quantity
      order by created_at desc, id desc for update
    loop
      exit when remaining <= 0;
      moved := least(component_allocation.quantity - component_allocation.cancelled_quantity, remaining);
      moved_ready := least(component_allocation.ready_quantity, moved);
      update public.production_component_allocations set quantity = quantity - moved, ready_quantity = ready_quantity - moved_ready, updated_at = now() where id = component_allocation.id;
      insert into public.production_component_allocations(tenant_id, venue_id, batch_id, source_order_line_id, current_order_line_id, source_component_id, quantity, ready_quantity)
      values(component_allocation.tenant_id, component_allocation.venue_id, component_allocation.batch_id, component_allocation.source_order_line_id, new.id, component_allocation.source_component_id, moved, moved_ready)
      on conflict(batch_id, source_order_line_id, current_order_line_id, source_component_id) do update
        set quantity = public.production_component_allocations.quantity + excluded.quantity, ready_quantity = public.production_component_allocations.ready_quantity + excluded.ready_quantity, updated_at = now();
      remaining := remaining - moved;
    end loop;
  end loop;
  return new;
end;
$$;

notify pgrst, 'reload schema';
