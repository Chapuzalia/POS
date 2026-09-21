-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Fixes UUID aggregation in the existing production RPC without changing its signature, result, permissions, or N-1 behavior.

create or replace function public.send_production_batch(
  p_order_id uuid, p_expected_revision integer, p_device_id uuid, p_request_id text, p_selection jsonb default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare order_row public.orders%rowtype; device_row public.devices%rowtype; line_row public.order_lines%rowtype;
  component jsonb; pass_snapshot public.order_line_production_passes%rowtype; destination_id uuid; category_id uuid;
  batch_id uuid; sequence_value integer; selected_quantity numeric(18,3); unsent_quantity numeric(18,3); sent_quantity numeric(18,3);
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
  batch_id := gen_random_uuid();
  insert into public.production_batches (id, tenant_id, venue_id, order_id, sequence, request_id, actor_user_id, actor_device_id, pass_id, pass_name) values (batch_id, order_row.tenant_id, order_row.venue_id, p_order_id, sequence_value, p_request_id, auth.uid(), device_row.id, selected_pass_id, selected_pass_name);
  for line_row in select * from public.order_lines where order_id = p_order_id order by created_at, id loop
    if jsonb_array_length(coalesce(line_row.components, '[]'::jsonb)) = 0 then
      perform public.production_upsert_pass_snapshot(line_row, '', line_row.product_id, coalesce(nullif(line_row.catalog_snapshot ->> 'categoryId', '')::uuid, public.production_catalog_category(line_row.tenant_id, line_row.venue_id, line_row.product_id)));
      select * into pass_snapshot from public.order_line_production_passes where order_line_id = line_row.id and component_id = '';
      if selected_pass_id is not null and pass_snapshot.pass_id <> selected_pass_id then continue; end if;
      select coalesce(sum(quantity - cancelled_quantity), 0) into sent_quantity from public.production_line_allocations where current_order_line_id = line_row.id;
      unsent_quantity := greatest(0, line_row.quantity - sent_quantity);
      if p_selection is null then selected_quantity := unsent_quantity; else select coalesce(sum((entry ->> 'quantity')::numeric(18,3)), 0) into selected_quantity from jsonb_array_elements(p_selection) entry where entry ->> 'lineId' = line_row.id::text and coalesce(entry ->> 'componentId', '') = ''; end if;
      if selected_quantity < 0 or selected_quantity > unsent_quantity then raise exception 'La cantidad seleccionada de % ya no está disponible', line_row.product_name using errcode = '40001'; end if;
      if selected_quantity = 0 then continue; end if;
      category_id := coalesce(nullif(line_row.catalog_snapshot ->> 'categoryId', '')::uuid, public.production_catalog_category(line_row.tenant_id, line_row.venue_id, line_row.product_id));
      destination_id := public.production_resolve_destination(line_row.tenant_id, line_row.venue_id, line_row.product_id, category_id);
      if destination_id is null then raise exception 'Sin routing de producción: %', line_row.product_name using errcode = 'P0001'; end if;
      insert into public.production_line_allocations (tenant_id, venue_id, batch_id, source_order_line_id, current_order_line_id, quantity) values (line_row.tenant_id, line_row.venue_id, batch_id, line_row.id, line_row.id, selected_quantity);
      insert into public.production_items (tenant_id, venue_id, batch_id, destination_id, source_order_id, source_order_line_id, product_id, variant_id, quantity, snapshot, pass_id, pass_name) values (line_row.tenant_id, line_row.venue_id, batch_id, destination_id, line_row.order_id, line_row.id, line_row.product_id, line_row.variant_id, selected_quantity, jsonb_build_object('productName', line_row.product_name, 'variantName', line_row.variant_name, 'lineModifiers', coalesce(line_row.modifiers, '[]'::jsonb), 'componentModifiers', '[]'::jsonb, 'note', line_row.note, 'destinationId', destination_id, 'sourceOrderId', line_row.order_id, 'sourceOrderLineId', line_row.id, 'passId', pass_snapshot.pass_id, 'passName', pass_snapshot.pass_name), pass_snapshot.pass_id, pass_snapshot.pass_name);
      selected_total := selected_total + selected_quantity; item_count := item_count + 1;
    else
      for component in select value from jsonb_array_elements(line_row.components) loop
        if nullif(component ->> 'productId', '') is null or nullif(component ->> 'id', '') is null then continue; end if;
        category_id := coalesce(nullif(component -> 'metadata' ->> 'categoryId', '')::uuid, public.production_catalog_category(line_row.tenant_id, line_row.venue_id, (component ->> 'productId')::uuid));
        perform public.production_upsert_pass_snapshot(line_row, component ->> 'id', (component ->> 'productId')::uuid, category_id);
        select * into pass_snapshot from public.order_line_production_passes where order_line_id = line_row.id and component_id = component ->> 'id';
        if selected_pass_id is not null and pass_snapshot.pass_id <> selected_pass_id then continue; end if;
        select coalesce(sum(quantity - cancelled_quantity), 0) into sent_quantity from public.production_component_allocations where current_order_line_id = line_row.id and source_component_id = component ->> 'id';
        unsent_quantity := greatest(0, line_row.quantity - sent_quantity);
        if p_selection is null then selected_quantity := unsent_quantity; else select coalesce(sum((entry ->> 'quantity')::numeric(18,3)), 0) into selected_quantity from jsonb_array_elements(p_selection) entry where entry ->> 'lineId' = line_row.id::text and entry ->> 'componentId' = component ->> 'id'; end if;
        if selected_quantity < 0 or selected_quantity > unsent_quantity then raise exception 'La cantidad seleccionada de % ya no está disponible', coalesce(component ->> 'productName', line_row.product_name) using errcode = '40001'; end if;
        if selected_quantity = 0 then continue; end if;
        destination_id := public.production_resolve_destination(line_row.tenant_id, line_row.venue_id, (component ->> 'productId')::uuid, category_id);
        if destination_id is null then raise exception 'Sin routing de producción: %', coalesce(component ->> 'productName', line_row.product_name) using errcode = 'P0001'; end if;
        multiplier := greatest(coalesce((component ->> 'quantity')::integer, 1), 1); item_quantity := selected_quantity * multiplier;
        insert into public.production_component_allocations (tenant_id, venue_id, batch_id, source_order_line_id, current_order_line_id, source_component_id, quantity) values (line_row.tenant_id, line_row.venue_id, batch_id, line_row.id, line_row.id, component ->> 'id', selected_quantity);
        insert into public.production_items (tenant_id, venue_id, batch_id, destination_id, source_order_id, source_order_line_id, source_component_id, product_id, variant_id, quantity, units_per_commercial_unit, snapshot, pass_id, pass_name) values (line_row.tenant_id, line_row.venue_id, batch_id, destination_id, line_row.order_id, line_row.id, component ->> 'id', (component ->> 'productId')::uuid, nullif(component ->> 'variantId', '')::uuid, item_quantity, multiplier, jsonb_build_object('productName', coalesce(component ->> 'productName', line_row.product_name), 'variantName', coalesce(component ->> 'variantName', ''), 'parentProductName', line_row.product_name, 'lineModifiers', coalesce(line_row.modifiers, '[]'::jsonb), 'componentModifiers', coalesce(component -> 'modifiers', '[]'::jsonb), 'note', line_row.note, 'destinationId', destination_id, 'sourceOrderId', line_row.order_id, 'sourceOrderLineId', line_row.id, 'sourceComponentId', component ->> 'id', 'passId', pass_snapshot.pass_id, 'passName', pass_snapshot.pass_name), pass_snapshot.pass_id, pass_snapshot.pass_name);
        selected_total := selected_total + selected_quantity; item_count := item_count + 1;
      end loop;
    end if;
  end loop;
  if selected_total = 0 or item_count = 0 then raise exception 'No hay productos nuevos que enviar' using errcode = 'P0001'; end if;
  update public.production_batches batch set pass_id = coalesce(batch.pass_id, (select min(item.pass_id::text)::uuid from public.production_items item where item.batch_id = batch.id)), pass_name = coalesce(batch.pass_name, (select min(item.pass_name) from public.production_items item where item.batch_id = batch.id)) where batch.id = batch_id;
  printer_dispatches := public.production_create_batch_dispatches(batch_id);
  return jsonb_build_object('batchId', batch_id, 'sequence', sequence_value, 'duplicate', false, 'sentUnits', selected_total, 'itemCount', item_count, 'printerDispatches', printer_dispatches);
end;
$$;
