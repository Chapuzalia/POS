-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserves deployed signatures, grants, monetary/payment contracts and N-1 whole-line service. Adds independent menu-course service and allows deferred menu choices only in restaurant drafts; internal helpers are not client-callable.

alter table public.order_line_production_passes add column served_quantity numeric(18,3) default 0;
alter table public.order_line_production_passes add constraint order_line_production_passes_served_check
  check (served_quantity >= 0) not valid;

-- Keep the proven draft/revision and catalog validation routines. Never clear
-- existing components between their two updates: triggers must see the real diff.
do $patch$
declare definition text; patched text;
begin
  definition := replace(pg_get_functiondef('public.persist_catalog_order_line_draft(uuid,integer,jsonb)'::regprocedure), chr(13), '');
  patched := replace(definition, $$quantity=quantity_value,modifiers='[]',components='[]',catalog_snapshot=$$, $$quantity=quantity_value,catalog_snapshot=$$);
  if patched=definition then raise exception 'FLEXIBLE_MENU_DRAFT_UPDATE_SIGNATURE_NOT_FOUND'; end if;
  patched := replace(patched, $$mixer_product_id=null,mixer=null,note=note_value,$$, $$note=note_value,$$);
  patched := replace(patched, $$if signature=any(signatures) then$$,
    $$if signature=any(signatures) and not exists (select 1 from public.products where id=selected_product_id and venue_id=o.venue_id and product_type='menu') then$$);
  if patched = definition or position($$quantity=quantity_value,modifiers='[]',components='[]'$$ in patched) > 0 then
    raise exception 'FLEXIBLE_MENU_DRAFT_SIGNATURE_NOT_FOUND';
  end if;
  if position($$if signature=any(signatures) then$$ in patched)>0 then raise exception 'FLEXIBLE_MENU_DUPLICATE_SIGNATURE_NOT_FOUND'; end if;
  patched := replace(patched,
    $$if exists(select 1 from public.order_lines where order_id=o.id and not(id=any(retained)) and served_quantity>0) then$$,
    $$if exists(select 1 from public.order_lines l where l.order_id=o.id and not(l.id=any(retained)) and
      (l.served_quantity>0 or exists(select 1 from public.order_line_production_passes p where p.order_line_id=l.id and p.served_quantity>0))) then$$);
  if position('p.served_quantity>0' in patched)=0 then raise exception 'FLEXIBLE_MENU_DELETE_GUARD_SIGNATURE_NOT_FOUND'; end if;
  execute patched;

  definition := replace(pg_get_functiondef('public.remove_restaurant_order_line(uuid)'::regprocedure),chr(13),'');
  patched := replace(definition, $$if line_row.served_quantity > 0 then$$,
    $$if line_row.served_quantity > 0 or exists(select 1 from public.order_line_production_passes where order_line_id=line_row.id and served_quantity>0) then$$);
  if patched=definition then raise exception 'FLEXIBLE_MENU_REMOVE_GUARD_SIGNATURE_NOT_FOUND'; end if;
  execute patched;

  definition := replace(pg_get_functiondef('public.save_catalog_order_lines_canonical(uuid,integer,jsonb)'::regprocedure), chr(13), '');
  patched := replace(definition,
    $$and (chosen.amount < a.min_selection or chosen.amount > a.max_selection)
    ) then raise exception 'CATALOG_SELECTION_LIMITS';$$,
    $$and ((chosen.amount < a.min_selection and g.kind <> 'menu_component') or chosen.amount > a.max_selection)
    ) then raise exception 'CATALOG_SELECTION_LIMITS';$$);
  if patched = definition then raise exception 'FLEXIBLE_MENU_SELECTION_SIGNATURE_NOT_FOUND'; end if;
  -- Duplicate component ids must not bypass group capacity or share allocations.
  patched := replace(patched, $$if v_component_count <> v_sent_count then$$,
    $$if (select count(distinct c->>'id') from jsonb_array_elements(v_components) c) <> v_component_count then raise exception 'CATALOG_DUPLICATE_COMPONENT'; end if;
    if v_component_count <> v_sent_count then$$);
  patched := replace(patched, $$v_unit_price := v_base_price$$, $body$
    select coalesce(jsonb_agg(coalesce(previous.value,c.value) order by c.ordinality),'[]') into v_components
    from jsonb_array_elements(v_components) with ordinality c(value,ordinality)
    left join lateral (
      select old_component value from public.order_lines line cross join lateral jsonb_array_elements(line.components) old_component
      where line.id=v_line_id and old_component->>'id'=c.value->>'id'
        and old_component->>'productId'=c.value->>'productId' and old_component->>'variantId'=c.value->>'variantId'
        and old_component->>'quantity'=c.value->>'quantity'
        and (select coalesce(jsonb_agg(m->>'id' order by m->>'id'),'[]') from jsonb_array_elements(coalesce(old_component->'modifiers','[]')) m)
          = (select coalesce(jsonb_agg(m->>'id' order by m->>'id'),'[]') from jsonb_array_elements(coalesce(c.value->'modifiers','[]')) m)
      limit 1
    ) previous on true;
    v_unit_price := v_base_price$body$);
  execute patched;
end;
$patch$;

-- Cancel only this component, including physical quantities and durable kitchen
-- notices. Other components and their immutable production snapshots are untouched.
create function public.production_cancel_menu_component(p_line_id uuid, p_component_id text, p_target numeric, p_notify boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare allocation public.production_component_allocations%rowtype; item public.production_items%rowtype;
  remaining numeric; cancelled numeric; cancelled_ready numeric; event_id uuid;
begin
  select greatest(0, coalesce(sum(quantity-cancelled_quantity),0) - greatest(0,p_target)) into remaining
  from public.production_component_allocations where current_order_line_id=p_line_id and source_component_id=p_component_id;
  for allocation in select * from public.production_component_allocations
    where current_order_line_id=p_line_id and source_component_id=p_component_id and quantity>cancelled_quantity
    order by created_at desc,id desc for update
  loop
    exit when remaining<=0;
    cancelled := least(remaining,allocation.quantity-allocation.cancelled_quantity);
    cancelled_ready := greatest(0,allocation.ready_quantity-(allocation.quantity-allocation.cancelled_quantity-cancelled));
    update public.production_component_allocations set cancelled_quantity=cancelled_quantity+cancelled,
      ready_quantity=least(ready_quantity,quantity-cancelled_quantity-cancelled),updated_at=now() where id=allocation.id;
    for item in select * from public.production_items where batch_id=allocation.batch_id
      and source_order_line_id=allocation.source_order_line_id and source_component_id=p_component_id order by id for update
    loop
      update public.production_items set cancelled_quantity=least(quantity,cancelled_quantity+cancelled*units_per_commercial_unit),
        ready_quantity=greatest(0,ready_quantity-cancelled_ready*units_per_commercial_unit),updated_at=now() where id=item.id;
      if p_notify then
        event_id := gen_random_uuid();
        insert into public.production_events(id,tenant_id,venue_id,batch_id,production_item_id,destination_id,event_type,quantity,payload,actor_user_id)
        values(event_id,item.tenant_id,item.venue_id,item.batch_id,item.id,item.destination_id,'cancelled',cancelled*item.units_per_commercial_unit,
          jsonb_build_object('productName',item.snapshot->>'productName','tableName',public.production_table_label_for_line(p_line_id),
            'sourceOrderLineId',p_line_id,'sourceComponentId',p_component_id,'snapshot',item.snapshot),auth.uid());
        perform public.production_create_event_dispatch(event_id);
      end if;
    end loop;
    perform public.production_refresh_allocation_ready(allocation.batch_id,allocation.source_order_line_id);
    remaining := remaining-cancelled;
  end loop;
end;
$$;
revoke all on function public.production_cancel_menu_component(uuid,text,numeric,boolean) from public, anon, authenticated;

create function public.production_reconcile_menu_line(p_old public.order_lines, p_new public.order_lines, p_deleted boolean)
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
        insert into public.production_events(id,tenant_id,venue_id,batch_id,production_item_id,destination_id,event_type,quantity,payload,actor_user_id)
        values(event_id,item.tenant_id,item.venue_id,item.batch_id,item.id,item.destination_id,'modified',item.quantity-item.cancelled_quantity,
          jsonb_build_object('productName',item.snapshot->>'productName','parentProductName',p_new.product_name,
            'tableName',public.production_table_label_for_line(p_old.id),'lineModifiers',p_new.modifiers,'componentModifiers',replacement->'modifiers',
            'note',p_new.note,'previousSnapshot',item.snapshot),auth.uid());
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
revoke all on function public.production_reconcile_menu_line(public.order_lines,public.order_lines,boolean) from public, anon, authenticated;

-- Extend existing triggers instead of replacing their direct-product behavior.
do $patch$
declare definition text; patched text;
begin
  definition := replace(pg_get_functiondef('public.production_notify_line_change()'::regprocedure),chr(13),'');
  patched := replace(definition, E'begin\n', $body$begin
  if old.catalog_snapshot->>'productType'='menu' or new.catalog_snapshot->>'productType'='menu'
    or exists(select 1 from jsonb_array_elements(old.components||coalesce(new.components,'[]')) c where c->>'type'='menu_component') then
    perform public.production_reconcile_menu_line(old,new,tg_op='DELETE');
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
$body$);
  if patched=definition then raise exception 'FLEXIBLE_MENU_NOTIFY_SIGNATURE_NOT_FOUND'; end if;
  execute patched;

  definition := replace(pg_get_functiondef('public.production_copy_passes_after_split()'::regprocedure),chr(13),'');
  patched := replace(definition, $$moved := least(coalesce(assignment.skipped_quantity, 0), new.served_quantity);$$,
    $$moved := least(coalesce(assignment.skipped_quantity, 0), greatest(new.served_quantity,least(coalesce(assignment.served_quantity,0),new.quantity)));$$);
  patched := replace(patched, $$pass_name, skipped_quantity)$$, $$pass_name, skipped_quantity, served_quantity)$$);
  patched := replace(patched, $$assignment.pass_name, moved)$$, $$assignment.pass_name, moved, least(coalesce(assignment.served_quantity,0),new.quantity))$$);
  patched := replace(patched, $$set skipped_quantity = coalesce(skipped_quantity, 0) - moved$$,
    $$set served_quantity = greatest(0,coalesce(served_quantity,0)-new.quantity), skipped_quantity = coalesce(skipped_quantity, 0) - moved$$);
  if patched=definition then raise exception 'FLEXIBLE_MENU_SPLIT_SIGNATURE_NOT_FOUND'; end if;
  execute patched;

  definition := replace(pg_get_functiondef('public.send_production_batch(uuid,integer,uuid,text,jsonb)'::regprocedure),chr(13),'');
  patched := replace(definition, $$if jsonb_array_length(coalesce(line_row.components, '[]'::jsonb)) = 0 then$$,
    $$if jsonb_array_length(coalesce(line_row.components, '[]'::jsonb)) = 0 and line_row.catalog_snapshot->>'productType'='menu' then continue; end if;
    if jsonb_array_length(coalesce(line_row.components, '[]'::jsonb)) = 0 then$$);
  patched := replace(patched, $$line_row.served_quantity - sent_quantity$$, $$greatest(line_row.served_quantity,coalesce(pass_snapshot.served_quantity,0)) - sent_quantity$$);
  if patched=definition then raise exception 'FLEXIBLE_MENU_SEND_SIGNATURE_NOT_FOUND'; end if;
  execute patched;

  definition := replace(pg_get_functiondef('public.production_allocation_progress(uuid,uuid,uuid[])'::regprocedure),chr(13),'');
  patched := replace(definition, $$else line.served_quantity end line_served$$,
    $$else greatest(line.served_quantity,coalesce(pass.served_quantity,0)) end line_served$$);
  if patched=definition then raise exception 'FLEXIBLE_MENU_PROGRESS_SIGNATURE_NOT_FOUND'; end if;
  execute patched;

  definition := replace(pg_get_functiondef('public.get_order_production_state(uuid)'::regprocedure),chr(13),'');
  patched := replace(definition, $$else line.served_quantity end) served_quantity$$,
    $$else greatest(line.served_quantity,coalesce(assignment.served_quantity,0)) end) served_quantity$$);
  patched := replace(patched, $$'quantity', quantity, 'sentQuantity'$$, $$'servedQuantity', served_quantity, 'quantity', quantity, 'sentQuantity'$$);
  patched := replace(patched, $$where line.order_id = p_order_id
    )$$, $$where line.order_id = p_order_id and (assignment.component_id='' and jsonb_array_length(line.components)=0 and coalesce(line.catalog_snapshot->>'productType','')<>'menu' or component.value is not null)
    )$$);
  patched := replace(patched, 'bool_and(entry.has_destination)', 'bool_or(entry.has_destination)');
  if patched=definition or position($$'servedQuantity', served_quantity$$ in patched)=0 or position('component.value is not null' in patched)=0
    then raise exception 'FLEXIBLE_MENU_STATE_SIGNATURE_NOT_FOUND'; end if;
  execute patched;
end;
$patch$;

-- Absolute served targets plus an order revision make retries safe and prevent
-- two terminals from silently serving or replacing the same course concurrently.
create function public.serve_restaurant_menu_component(p_order_id uuid,p_line_id uuid,p_component_id text,p_quantity numeric,p_expected_revision integer,p_device_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare order_row public.orders%rowtype; line_row public.order_lines%rowtype; assignment public.order_line_production_passes%rowtype;
  sent numeric; completed numeric;
begin
  select * into order_row from public.orders where id=p_order_id for update;
  if auth.uid() is null or order_row.id is null or order_row.status<>'open'
    or not public.user_has_venue_access(order_row.tenant_id,order_row.venue_id)
    or not public.user_has_device_access(order_row.tenant_id,order_row.venue_id,p_device_id)
    or not exists(select 1 from public.devices where id=p_device_id and tenant_id=order_row.tenant_id and venue_id=order_row.venue_id and is_active and can_take_orders and device_mode<>'kds') then
    raise exception 'Comanda no disponible' using errcode='42501';
  end if;
  if order_row.revision<>p_expected_revision then raise exception 'La comanda ha cambiado en otro dispositivo' using errcode='40001'; end if;
  select * into line_row from public.order_lines where id=p_line_id and order_id=order_row.id and tenant_id=order_row.tenant_id and venue_id=order_row.venue_id for update;
  if line_row.id is null or not exists(select 1 from jsonb_array_elements(line_row.components) c where c->>'id'=p_component_id and c->>'type'='menu_component') then
    raise exception 'Plato de menú no disponible' using errcode='22023';
  end if;
  select * into assignment from public.order_line_production_passes where order_line_id=p_line_id and component_id=p_component_id for update;
  if assignment.order_line_id is null or p_quantity is null or p_quantity::text in ('NaN','Infinity','-Infinity') or scale(p_quantity)>3
    or p_quantity<greatest(line_row.served_quantity,coalesce(assignment.served_quantity,0)) or p_quantity>line_row.quantity then
    raise exception 'Cantidad de servicio no válida' using errcode='22023';
  end if;
  select coalesce(sum(quantity-cancelled_quantity),0) into sent from public.production_component_allocations
    where current_order_line_id=p_line_id and source_component_id=p_component_id;
  update public.order_line_production_passes set served_quantity=p_quantity,
    skipped_quantity=greatest(coalesce(skipped_quantity,0),p_quantity-sent) where order_line_id=p_line_id and component_id=p_component_id;
  -- A menu is complete only after its chosen courses are served and every
  -- required choice has been made. In particular the first never serves dessert.
  if not exists(
    select 1 from public.product_selection_group_assignments a join public.selection_groups g on g.id=a.group_id and g.is_active and g.kind='menu_component'
    where a.product_id=line_row.product_id and a.venue_id=line_row.venue_id and a.is_active
      and (a.applies_to_all_variants or exists(select 1 from public.product_selection_group_assignment_variants av where av.assignment_id=a.id and av.variant_id=line_row.variant_id))
      and a.min_selection>(select coalesce(sum((c->>'quantity')::integer),0) from jsonb_array_elements(line_row.components) c where c->>'selectionGroupId'=g.id::text)
  ) then
    select min(greatest(line_row.served_quantity,coalesce(p.served_quantity,0))) into completed
    from jsonb_array_elements(line_row.components) c left join public.order_line_production_passes p on p.order_line_id=p_line_id and p.component_id=c->>'id';
    update public.order_lines set served_quantity=completed,
      fully_served_at=case when completed=quantity then coalesce(fully_served_at,now()) else null end where id=p_line_id;
  end if;
  update public.orders set revision=revision+1 where id=p_order_id;
end;
$$;
revoke all on function public.serve_restaurant_menu_component(uuid,uuid,text,numeric,integer,uuid) from public, anon;
grant execute on function public.serve_restaurant_menu_component(uuid,uuid,text,numeric,integer,uuid) to authenticated;

notify pgrst, 'reload schema';
