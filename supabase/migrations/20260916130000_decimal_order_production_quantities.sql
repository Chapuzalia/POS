drop trigger if exists production_notify_line_update on public.order_lines;
drop trigger if exists production_notify_line_delete on public.order_lines;

alter table public.order_lines
  alter column quantity type numeric(18,3) using quantity::numeric(18,3),
  alter column served_quantity type numeric(18,3) using served_quantity::numeric(18,3);

alter table public.ticket_lines
  alter column quantity type numeric(18,3) using quantity::numeric(18,3);

alter table public.production_items
  alter column quantity type numeric(18,3) using quantity::numeric(18,3),
  alter column ready_quantity type numeric(18,3) using ready_quantity::numeric(18,3),
  alter column cancelled_quantity type numeric(18,3) using cancelled_quantity::numeric(18,3);

alter table public.production_line_allocations
  alter column quantity type numeric(18,3) using quantity::numeric(18,3),
  alter column ready_quantity type numeric(18,3) using ready_quantity::numeric(18,3),
  alter column cancelled_quantity type numeric(18,3) using cancelled_quantity::numeric(18,3);

alter table public.production_events
  alter column quantity type numeric(18,3) using quantity::numeric(18,3);

alter table public.order_lines drop constraint if exists order_lines_quantity_check;
alter table public.order_lines drop constraint if exists order_lines_served_quantity_check;
alter table public.order_lines add constraint order_lines_quantity_check check (quantity > 0 and scale(quantity) <= 3);
alter table public.order_lines add constraint order_lines_served_quantity_check check (served_quantity >= 0 and served_quantity <= quantity and scale(served_quantity) <= 3);

alter table public.ticket_lines drop constraint if exists ticket_lines_quantity_check;
alter table public.ticket_lines add constraint ticket_lines_quantity_check check (quantity > 0 and scale(quantity) <= 3);

alter table public.production_items drop constraint if exists production_items_quantity_check;
alter table public.production_items drop constraint if exists production_items_ready_check;
alter table public.production_items drop constraint if exists production_items_cancelled_check;
alter table public.production_items add constraint production_items_quantity_check check (quantity > 0 and scale(quantity) <= 3);
alter table public.production_items add constraint production_items_ready_check check (ready_quantity between 0 and quantity and scale(ready_quantity) <= 3);
alter table public.production_items add constraint production_items_cancelled_check check (cancelled_quantity between 0 and quantity and ready_quantity + cancelled_quantity <= quantity and scale(cancelled_quantity) <= 3);

alter table public.production_line_allocations drop constraint if exists production_line_allocations_quantity_check;
alter table public.production_line_allocations drop constraint if exists production_line_allocations_state_check;
alter table public.production_line_allocations add constraint production_line_allocations_quantity_check check (quantity >= 0 and scale(quantity) <= 3);
alter table public.production_line_allocations add constraint production_line_allocations_state_check check (ready_quantity >= 0 and cancelled_quantity >= 0 and ready_quantity + cancelled_quantity <= quantity and scale(ready_quantity) <= 3 and scale(cancelled_quantity) <= 3);

alter table public.production_events drop constraint if exists production_events_quantity_check;
alter table public.production_events add constraint production_events_quantity_check check (quantity >= 0 and scale(quantity) <= 3);

create trigger production_notify_line_update
after update of quantity, product_id, variant_id, product_name, variant_name, modifiers, components, mixer, note
on public.order_lines for each row execute function public.production_notify_line_change();

create trigger production_notify_line_delete
before delete on public.order_lines for each row execute function public.production_notify_line_change();

create or replace function public.next_quantity_step(
  p_current numeric(18,3),
  p_total numeric(18,3),
  p_quantity numeric(18,3) default 1
)
returns numeric(18,3)
language plpgsql
immutable
set search_path = ''
as $$
declare remaining numeric(18,3);
begin
  if p_total <= 0 or p_current < 0 or p_current > p_total or p_quantity <= 0 then
    raise exception 'Cantidad no válida' using errcode = '22023';
  end if;
  remaining := p_total - p_current;
  if p_quantity >= remaining then return p_total; end if;
  if remaining <= 1.500 then return p_total; end if;
  return least(p_total, p_current + 1.000);
end;
$$;

create or replace function public.mark_order_line_units_served(p_order_line_id uuid, p_units integer default 1)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare line_row public.order_lines%rowtype; order_row public.orders%rowtype; next_served numeric(18,3);
begin
  select ol.* into line_row from public.order_lines ol where ol.id = p_order_line_id;
  if line_row.id is null then raise exception 'Linea no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = line_row.order_id for update;
  select ol.* into line_row from public.order_lines ol where ol.id = p_order_line_id for update;
  if line_row.id is null or order_row.status <> 'open' or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  next_served := public.next_quantity_step(line_row.served_quantity, line_row.quantity, p_units::numeric);
  update public.order_lines as ol set served_quantity = next_served,
    fully_served_at = case when next_served = ol.quantity then now() else null end where ol.id = line_row.id;
  update public.orders as o set revision = o.revision + 1 where o.id = order_row.id;
  return jsonb_build_object('lineId', line_row.id, 'servedQuantity', next_served, 'quantity', line_row.quantity);
end;
$$;

create or replace function public.mark_order_line_quantity_served(p_order_line_id uuid, p_quantity numeric)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare line_row public.order_lines%rowtype; order_row public.orders%rowtype; next_served numeric(18,3);
begin
  select ol.* into line_row from public.order_lines ol where ol.id = p_order_line_id;
  if line_row.id is null then raise exception 'Linea no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = line_row.order_id for update;
  select ol.* into line_row from public.order_lines ol where ol.id = p_order_line_id for update;
  if line_row.id is null or order_row.status <> 'open' or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  next_served := public.next_quantity_step(line_row.served_quantity, line_row.quantity, p_quantity::numeric(18,3));
  update public.order_lines as ol set served_quantity = next_served,
    fully_served_at = case when next_served = ol.quantity then now() else null end where ol.id = line_row.id;
  update public.orders as o set revision = o.revision + 1 where o.id = order_row.id;
  return jsonb_build_object('lineId', line_row.id, 'servedQuantity', next_served, 'quantity', line_row.quantity);
end;
$$;

create or replace function public.production_refresh_allocation_ready(p_batch_id uuid, p_source_order_line_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare commercially_ready numeric(18,3); remaining numeric(18,3); allocation_row public.production_line_allocations%rowtype; assigned numeric(18,3);
begin
  select coalesce(min(ready_quantity / units_per_commercial_unit), 0)::numeric(18,3) into commercially_ready
  from public.production_items where batch_id = p_batch_id and source_order_line_id = p_source_order_line_id and cancelled_quantity < quantity;
  remaining := commercially_ready;
  for allocation_row in select * from public.production_line_allocations
    where batch_id = p_batch_id and source_order_line_id = p_source_order_line_id order by created_at, id for update loop
    assigned := least(greatest(allocation_row.quantity - allocation_row.cancelled_quantity, 0), remaining);
    update public.production_line_allocations set ready_quantity = assigned, updated_at = now() where id = allocation_row.id;
    remaining := greatest(0, remaining - assigned);
  end loop;
end;
$$;

create or replace function public.mark_production_item_ready(p_item_id uuid, p_quantity integer, p_device_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare item_row public.production_items%rowtype; device_row public.devices%rowtype; next_ready numeric(18,3);
begin
  select * into item_row from public.production_items where id = p_item_id for update;
  select * into device_row from public.devices where id = p_device_id for update;
  if item_row.id is null or device_row.id is null or not device_row.is_active or device_row.device_mode <> 'kds'
    or device_row.tenant_id <> item_row.tenant_id or device_row.venue_id <> item_row.venue_id
    or device_row.production_destination_id <> item_row.destination_id
    or not public.production_is_effective(item_row.tenant_id, item_row.venue_id)
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id) then
    raise exception 'El KDS no puede modificar este destino' using errcode = '42501';
  end if;
  next_ready := case when p_quantity::numeric >= item_row.quantity - item_row.cancelled_quantity - item_row.ready_quantity
    then item_row.quantity - item_row.cancelled_quantity
    else public.next_quantity_step(
      item_row.ready_quantity / item_row.units_per_commercial_unit,
      (item_row.quantity - item_row.cancelled_quantity) / item_row.units_per_commercial_unit,
      p_quantity::numeric
    ) * item_row.units_per_commercial_unit
  end;
  update public.production_items set ready_quantity = next_ready, updated_at = now() where id = item_row.id;
  perform public.production_refresh_allocation_ready(item_row.batch_id, item_row.source_order_line_id);
  return jsonb_build_object('itemId', item_row.id, 'readyQuantity', next_ready, 'quantity', item_row.quantity);
end;
$$;

create or replace function public.mark_production_item_quantity_ready(p_item_id uuid, p_quantity numeric, p_device_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare item_row public.production_items%rowtype; device_row public.devices%rowtype; next_ready numeric(18,3);
begin
  select * into item_row from public.production_items where id = p_item_id for update;
  select * into device_row from public.devices where id = p_device_id for update;
  if item_row.id is null or device_row.id is null or not device_row.is_active or device_row.device_mode <> 'kds'
    or device_row.tenant_id <> item_row.tenant_id or device_row.venue_id <> item_row.venue_id
    or device_row.production_destination_id <> item_row.destination_id
    or not public.production_is_effective(item_row.tenant_id, item_row.venue_id)
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id) then
    raise exception 'El KDS no puede modificar este destino' using errcode = '42501';
  end if;
  next_ready := case when p_quantity::numeric(18,3) >= item_row.quantity - item_row.cancelled_quantity - item_row.ready_quantity
    then item_row.quantity - item_row.cancelled_quantity
    else public.next_quantity_step(item_row.ready_quantity, item_row.quantity - item_row.cancelled_quantity, p_quantity::numeric(18,3))
  end;
  update public.production_items set ready_quantity = next_ready, updated_at = now() where id = item_row.id;
  perform public.production_refresh_allocation_ready(item_row.batch_id, item_row.source_order_line_id);
  return jsonb_build_object('itemId', item_row.id, 'readyQuantity', next_ready, 'quantity', item_row.quantity);
end;
$$;

DO $$
declare definition text;
begin
  select pg_get_functiondef('public.persist_catalog_order_line_draft(uuid,integer,jsonb)'::regprocedure) into definition;
  if position('quantity_value integer' in definition) = 0 or position('(item->>''quantity'')::integer' in definition) = 0 then raise exception 'DECIMAL_PERSIST_ORDER_LINES_SIGNATURE_NOT_FOUND'; end if;
  definition := replace(definition, 'quantity_value integer', 'quantity_value numeric(18,3)');
  definition := replace(definition, '(item->>''quantity'')::integer', '(item->>''quantity'')::numeric(18,3)');
  definition := replace(definition, 'quantity_value>9999', 'quantity_value>999999999999999');
  execute definition;

  select pg_get_functiondef('public.move_restaurant_order_lines(uuid,uuid,integer,integer,jsonb)'::regprocedure) into definition;
  if position('move_quantity integer' in definition) = 0 or position('sum((value ->> ''quantity'')::integer)::integer' in definition) = 0 then raise exception 'DECIMAL_MOVE_ORDER_LINES_SIGNATURE_NOT_FOUND'; end if;
  definition := replace(definition, 'move_quantity integer', 'move_quantity numeric(18,3)');
  definition := replace(definition, 'moved_served integer', 'moved_served numeric(18,3)');
  definition := replace(definition, 'sum((value ->> ''quantity'')::integer)::integer', 'sum((value ->> ''quantity'')::numeric(18,3))::numeric(18,3)');
  execute definition;

  select pg_get_functiondef('public.send_production_batch(uuid,integer,uuid,text,jsonb)'::regprocedure) into definition;
  if position('selected_quantity integer' in definition) = 0 or position('(entry ->> ''quantity'')::integer' in definition) = 0 then raise exception 'DECIMAL_SEND_PRODUCTION_SIGNATURE_NOT_FOUND'; end if;
  definition := replace(definition, 'selected_quantity integer', 'selected_quantity numeric(18,3)');
  definition := replace(definition, 'sent_quantity integer', 'sent_quantity numeric(18,3)');
  definition := replace(definition, 'unsent_quantity integer', 'unsent_quantity numeric(18,3)');
  definition := replace(definition, 'item_quantity integer', 'item_quantity numeric(18,3)');
  definition := replace(definition, 'selected_total integer', 'selected_total numeric(18,3)');
  definition := replace(definition, '(entry ->> ''quantity'')::integer', '(entry ->> ''quantity'')::numeric(18,3)');
  execute definition;

  select pg_get_functiondef('public.get_order_production_state(uuid)'::regprocedure) into definition;
  if position('sum(quantity - cancelled_quantity)::integer' in definition) = 0 then raise exception 'DECIMAL_PRODUCTION_STATE_SIGNATURE_NOT_FOUND'; end if;
  definition := replace(definition, 'sum(quantity - cancelled_quantity)::integer', 'sum(quantity - cancelled_quantity)::numeric(18,3)');
  definition := replace(definition, 'sum(ready_quantity)::integer', 'sum(ready_quantity)::numeric(18,3)');
  execute definition;

  select pg_get_functiondef('public.production_move_allocations_to_split_line()'::regprocedure) into definition;
  if position('remaining integer := new.quantity' in definition) = 0 then raise exception 'DECIMAL_PRODUCTION_SPLIT_SIGNATURE_NOT_FOUND'; end if;
  definition := replace(definition, 'remaining integer := new.quantity', 'remaining numeric(18,3) := new.quantity');
  definition := replace(definition, 'moved integer', 'moved numeric(18,3)');
  definition := replace(definition, 'moved_ready integer', 'moved_ready numeric(18,3)');
  execute definition;

  select pg_get_functiondef('public.production_notify_line_change()'::regprocedure) into definition;
  if position('public.production_cancel_line_excess(' in definition) = 0 then raise exception 'DECIMAL_PRODUCTION_CANCEL_CALL_NOT_FOUND'; end if;
  definition := replace(definition, 'public.production_cancel_line_excess(', 'public.production_cancel_line_excess_decimal(');
  definition := replace(definition, 'active_sent integer', 'active_sent numeric(18,3)');
  definition := replace(definition, 'split_quantity integer', 'split_quantity numeric(18,3)');
  execute definition;
end;
$$;

create or replace function public.production_cancel_line_excess_decimal(p_line_id uuid, p_target_active_quantity numeric, p_notify boolean)
returns numeric(18,3)
language plpgsql security definer
set search_path = ''
as $$
declare allocation_row public.production_line_allocations%rowtype; item_row public.production_items%rowtype; current_active numeric(18,3); remaining numeric(18,3); cancelled numeric(18,3); event_id uuid;
begin
  select coalesce(sum(quantity - cancelled_quantity), 0) into current_active from public.production_line_allocations where current_order_line_id = p_line_id;
  remaining := greatest(0, current_active - greatest(p_target_active_quantity, 0));
  if remaining = 0 then return 0; end if;
  for allocation_row in select * from public.production_line_allocations where current_order_line_id = p_line_id and quantity > cancelled_quantity order by created_at desc, id desc for update loop
    exit when remaining = 0;
    cancelled := least(allocation_row.quantity - allocation_row.cancelled_quantity, remaining);
    update public.production_line_allocations set cancelled_quantity = cancelled_quantity + cancelled, ready_quantity = least(ready_quantity, quantity - cancelled_quantity - cancelled), updated_at = now() where id = allocation_row.id;
    for item_row in select * from public.production_items where batch_id = allocation_row.batch_id and source_order_line_id = allocation_row.source_order_line_id order by id for update loop
      update public.production_items set ready_quantity = greatest(0, ready_quantity - cancelled * units_per_commercial_unit), cancelled_quantity = least(quantity, cancelled_quantity + cancelled * units_per_commercial_unit), updated_at = now() where id = item_row.id;
      if p_notify then
        event_id := gen_random_uuid();
        insert into public.production_events (id, tenant_id, venue_id, batch_id, production_item_id, destination_id, event_type, quantity, payload, actor_user_id)
        values (event_id, item_row.tenant_id, item_row.venue_id, item_row.batch_id, item_row.id, item_row.destination_id, 'cancelled', cancelled * item_row.units_per_commercial_unit, jsonb_build_object('productName', item_row.snapshot ->> 'productName', 'tableName', public.production_table_label_for_line(p_line_id), 'sourceOrderLineId', p_line_id, 'snapshot', item_row.snapshot), auth.uid());
        perform public.production_create_event_dispatch(event_id);
      end if;
    end loop;
    perform public.production_refresh_allocation_ready(allocation_row.batch_id, allocation_row.source_order_line_id);
    remaining := remaining - cancelled;
  end loop;
  return current_active - greatest(p_target_active_quantity, 0) - remaining;
end;
$$;

DO $$
declare definition text;
begin
  select pg_get_functiondef('public.pay_restaurant_order_items(uuid,integer,jsonb,text,integer,boolean,jsonb)'::regprocedure) into definition;
  if position('sum((item ->> ''quantity'')::integer)::integer quantity' in definition) = 0 then raise exception 'DECIMAL_PAY_ITEMS_SIGNATURE_NOT_FOUND'; end if;
  definition := replace(definition, 'pending_units integer', 'pending_units numeric(18,3)');
  definition := replace(definition, 'where coalesce((item ->> ''quantity'')::integer, 0) <= 0', 'where coalesce((item ->> ''quantity'')::numeric, 0) <= 0');
  definition := replace(definition, 'sum((item ->> ''quantity'')::integer)::integer quantity', 'sum((item ->> ''quantity'')::numeric(18,3))::numeric(18,3) quantity');
  definition := replace(definition, 'selected.quantity * ol.unit_price_cents', 'round(selected.quantity * ol.unit_price_cents)::integer');
  execute definition;

  select pg_get_functiondef('public.pay_restaurant_order_equal_part(uuid,text,integer,boolean,jsonb,boolean)'::regprocedure) into definition;
  if position('line_start integer := 0' in definition) = 0 or position('allocated_cents := greatest(0, least(line_end, part_end) - greatest(line_start, part_start));' in definition) = 0 then raise exception 'DECIMAL_PAY_EQUAL_SIGNATURE_NOT_FOUND'; end if;
  definition := replace(definition, 'pending_units integer', 'pending_units numeric(18,3)');
  definition := replace(definition, 'line_start integer := 0', 'line_start numeric(18,3) := 0');
  definition := replace(definition, 'line_end integer', 'line_end numeric(18,3)');
  definition := replace(definition, 'allocated_cents := greatest(0, least(line_end, part_end) - greatest(line_start, part_start));', 'allocated_cents := round(greatest(0, least(line_end, part_end) - greatest(line_start, part_start)))::integer;');
  execute definition;

  select pg_get_functiondef('public.sync_sale_created_v2(uuid,jsonb)'::regprocedure) into definition;
  if position('(line ->> ''quantity'')::integer > 0' in definition) = 0 then raise exception 'DECIMAL_OFFLINE_SALE_SIGNATURE_NOT_FOUND'; end if;
  definition := replace(definition, '(line ->> ''quantity'')::integer > 0', '(line ->> ''quantity'')::numeric(18,3) > 0');
  definition := replace(definition, '(line ->> ''unitPriceCents'')::bigint * (line ->> ''quantity'')::integer', 'round((line ->> ''unitPriceCents'')::numeric * (line ->> ''quantity'')::numeric(18,3))::bigint');
  definition := replace(definition, '(line ->> ''quantity'')::integer,', '(line ->> ''quantity'')::numeric(18,3),');
  execute definition;
end;
$$;

revoke all on function public.next_quantity_step(numeric, numeric, numeric) from public, anon;
revoke all on function public.mark_order_line_quantity_served(uuid, numeric) from public, anon;
revoke all on function public.mark_production_item_quantity_ready(uuid, numeric, uuid) from public, anon;
revoke all on function public.production_refresh_allocation_ready(uuid, uuid) from public, anon, authenticated;
revoke all on function public.production_cancel_line_excess_decimal(uuid, numeric, boolean) from public, anon, authenticated;
grant execute on function public.next_quantity_step(numeric, numeric, numeric), public.mark_order_line_quantity_served(uuid, numeric), public.mark_production_item_quantity_ready(uuid, numeric, uuid) to authenticated;
grant execute on function public.production_refresh_allocation_ready(uuid, uuid), public.production_cancel_line_excess_decimal(uuid, numeric, boolean) to service_role;

notify pgrst, 'reload schema';
