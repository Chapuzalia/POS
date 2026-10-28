-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserve existing routine signatures, grants, tenant/device checks, quantities, menu lifecycle and immutable snapshots. Add previous preparation fields to modification payloads and project current modifiers into KDS reads. Timestamp each emitted change so repeated edits in one transaction retain their order.

create index production_events_kds_modification_idx
  on public.production_events(production_item_id, created_at desc, id desc)
  where event_type = 'modified';

create or replace function public.production_reconcile_menu_line(p_old public.order_lines, p_new public.order_lines, p_deleted boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare previous jsonb; replacement jsonb; component jsonb; served numeric; target numeric;
  split_quantity numeric; effective boolean; changed boolean;
  item public.production_items%rowtype; event_id uuid;
begin
  effective := public.production_is_effective(p_old.tenant_id,p_old.venue_id);
  if not p_deleted and (p_new.product_id is distinct from p_old.product_id or p_new.variant_id is distinct from p_old.variant_id)
    and (p_old.served_quantity>0 or exists(select 1 from public.order_line_production_passes where order_line_id=p_old.id and served_quantity>0)) then
    raise exception 'No puedes sustituir un menú con platos ya servidos' using errcode='22023';
  end if;
  update public.order_line_production_passes set served_quantity=greatest(coalesce(served_quantity,0),p_old.served_quantity)
    where order_line_id=p_old.id and component_id in (select c->>'id' from jsonb_array_elements(p_old.components) c);
  select coalesce(sum(quantity),0) into split_quantity from public.order_lines
    where split_from_line_id=p_old.id and created_at>=transaction_timestamp();
  for previous in select value from jsonb_array_elements(coalesce(p_old.components,'[]')) loop
    select greatest(p_old.served_quantity,coalesce(assignment.served_quantity,0)) into served
    from public.order_line_production_passes assignment where order_line_id=p_old.id and component_id=previous->>'id';
    served := coalesce(served,p_old.served_quantity);
    if p_deleted then
      perform public.production_cancel_menu_component(p_old.id,previous->>'id',served,effective);
      continue;
    end if;
    select value into replacement from jsonb_array_elements(coalesce(p_new.components,'[]')) where value->>'id'=previous->>'id';
    changed := replacement is null or (previous-'priceDeltaCents'-'sortOrder') is distinct from (replacement-'priceDeltaCents'-'sortOrder');
    if changed then
      if served>0 then raise exception 'No puedes sustituir un plato del menú que ya se ha servido' using errcode='22023'; end if;
      perform public.production_cancel_menu_component(p_old.id,previous->>'id',0,effective);
      update public.order_line_production_passes set skipped_quantity=0,served_quantity=0 where order_line_id=p_old.id and component_id=previous->>'id';
    elsif p_new.quantity<p_old.quantity and split_quantity<p_old.quantity-p_new.quantity then
      if p_new.quantity<served then raise exception 'La cantidad no puede ser inferior a los platos servidos' using errcode='22023'; end if;
      target := greatest(0,p_new.quantity-coalesce((select skipped_quantity from public.order_line_production_passes
        where order_line_id=p_old.id and component_id=previous->>'id'),0));
      perform public.production_cancel_menu_component(p_old.id,previous->>'id',target,effective);
    end if;
    if not changed and served<p_new.quantity and effective and (p_new.note is distinct from p_old.note or p_new.modifiers is distinct from p_old.modifiers) then
      for item in select i.* from public.production_items i where i.source_component_id=previous->>'id'
        and i.cancelled_quantity<i.quantity and exists(select 1 from public.production_component_allocations a
          where a.current_order_line_id=p_old.id and a.source_component_id=previous->>'id'
            and a.batch_id=i.batch_id and a.source_order_line_id=i.source_order_line_id and a.quantity>a.cancelled_quantity)
      loop
        event_id := gen_random_uuid();
        insert into public.production_events(id,tenant_id,venue_id,batch_id,production_item_id,destination_id,event_type,quantity,payload,actor_user_id,created_at)
        values(event_id,item.tenant_id,item.venue_id,item.batch_id,item.id,item.destination_id,'modified',item.quantity-item.cancelled_quantity,
          jsonb_build_object('productName',item.snapshot->>'productName','parentProductName',p_new.product_name,
            'tableName',public.production_table_label_for_line(p_old.id),'lineModifiers',p_new.modifiers,'componentModifiers',replacement->'modifiers',
            'note',p_new.note,'previousSnapshot',item.snapshot,
            'previousState',jsonb_build_object('lineModifiers',p_old.modifiers,
              'componentModifiers',previous->'modifiers','note',p_old.note)),auth.uid(),clock_timestamp());
        perform public.production_create_event_dispatch(event_id);
      end loop;
    end if;
  end loop;
  if p_deleted then return; end if;
  for component in select value from jsonb_array_elements(coalesce(p_new.components,'[]')) loop
    perform public.production_upsert_pass_snapshot(p_new,component->>'id',(component->>'productId')::uuid,
      public.production_catalog_category(p_new.tenant_id,p_new.venue_id,(component->>'productId')::uuid));
  end loop;
  -- A later choice reopens only the commercial service summary. Previously served
  -- courses retain their own counters and can never be sent again.
  if p_old.served_quantity>0 and exists(select 1 from jsonb_array_elements(p_new.components) c
    where not exists(select 1 from jsonb_array_elements(p_old.components) old_c where old_c->>'id'=c->>'id')) then
    update public.order_lines set served_quantity=0,fully_served_at=null where id=p_new.id;
  end if;
end;
$$;

create or replace function public.production_notify_line_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare active_sent numeric(18,3);
  split_quantity numeric(18,3);
  item_row public.production_items%rowtype;
  event_id uuid;
  effective boolean;
begin
  if old.catalog_snapshot->>'productType'='menu' or new.catalog_snapshot->>'productType'='menu'
    or exists(select 1 from jsonb_array_elements(old.components||coalesce(new.components,'[]')) c where c->>'type'='menu_component') then
    perform public.production_reconcile_menu_line(old,new,tg_op='DELETE');
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    effective := public.production_is_effective(old.tenant_id, old.venue_id);
    -- Served units remain historical production truth even when the legacy
    -- confirmed-removal workflow deletes the commercial line.
    perform public.production_cancel_line_excess_decimal(old.id, old.served_quantity, effective);
    return old;
  end if;
  effective := public.production_is_effective(new.tenant_id, new.venue_id);
  if new.quantity < old.quantity then
    select coalesce(sum(quantity), 0) into split_quantity
    from public.order_lines
    where split_from_line_id = old.id and created_at >= transaction_timestamp();
    if split_quantity < old.quantity - new.quantity then
      perform public.production_cancel_line_excess_decimal(new.id, new.quantity, effective);
    end if;
  end if;
  if effective and (
    new.product_id is distinct from old.product_id
    or new.variant_id is distinct from old.variant_id
    or new.product_name is distinct from old.product_name
    or new.variant_name is distinct from old.variant_name
    or new.modifiers is distinct from old.modifiers
    or new.components is distinct from old.components
    or new.mixer is distinct from old.mixer
    or new.note is distinct from old.note
  ) then
    select coalesce(sum(quantity - cancelled_quantity), 0) into active_sent
    from public.production_line_allocations where current_order_line_id = new.id;
    if active_sent > 0 then
      for item_row in
        select distinct item.*
        from public.production_items item
        join public.production_line_allocations allocation
          on allocation.batch_id = item.batch_id
         and allocation.source_order_line_id = item.source_order_line_id
        where allocation.current_order_line_id = new.id
          and allocation.quantity > allocation.cancelled_quantity
      loop
        event_id := gen_random_uuid();
        insert into public.production_events (
          id, tenant_id, venue_id, batch_id, production_item_id, destination_id,
          event_type, quantity, payload, actor_user_id, created_at
        ) values (
          event_id, item_row.tenant_id, item_row.venue_id, item_row.batch_id,
          item_row.id, item_row.destination_id, 'modified', active_sent,
          jsonb_build_object(
            'productName', new.product_name,
            'tableName', public.production_table_label_for_line(new.id),
            'variantName', new.variant_name,
            'lineModifiers', new.modifiers,
            'components', new.components,
            'note', new.note,
            'previousSnapshot', item_row.snapshot,
            'previousState', jsonb_build_object('variantName', old.variant_name,
              'lineModifiers', old.modifiers, 'components', old.components, 'note', old.note)
          ), auth.uid(), clock_timestamp()
        );
        perform public.production_create_event_dispatch(event_id);
      end loop;
    end if;
  end if;
  return new;
end;
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
          'snapshot', item.snapshot || coalesce(current_details.patch, '{}'::jsonb), 'sentAt', batch.created_at
        ) order by batch.created_at, batch.sequence, batch.id, item.created_at, item.id)
        from item_state item join public.production_batches batch on batch.id = item.batch_id
        -- Read each mutable preparation field independently. Alerts may be
        -- acknowledged/expired and legacy payloads need not contain every field.
        -- Persisted production snapshots remain immutable.
        left join lateral (
          select jsonb_object_agg(field.key, latest.value) patch
          from unnest(array['note','lineModifiers','componentModifiers','variantName']) field(key)
          cross join lateral (
            select event.payload->field.key value
            from public.production_events event
            where event.production_item_id = item.id
              and event.tenant_id = device_row.tenant_id and event.venue_id = device_row.venue_id
              and event.destination_id = device_row.production_destination_id
              and event.event_type = 'modified' and event.payload ? field.key
            order by event.created_at desc, event.id desc limit 1
          ) latest
        ) current_details on true
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
