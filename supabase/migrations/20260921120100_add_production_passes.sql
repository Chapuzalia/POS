-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Extends the existing production batch contract with pass snapshots and component-level selections while retaining the existing RPC signature.
set lock_timeout = '5s';
set statement_timeout = '5min';

create table public.production_passes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint production_passes_name_check check (char_length(btrim(name)) between 1 and 80),
  constraint production_passes_sort_order_check check (sort_order >= 0),
  unique (id, tenant_id, venue_id),
  unique (venue_id, name)
);

create table public.production_category_pass_routes (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  pass_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (venue_id, category_id),
  foreign key (pass_id, tenant_id, venue_id)
    references public.production_passes(id, tenant_id, venue_id) on delete restrict
);

create table public.production_product_pass_routes (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  pass_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (venue_id, product_id),
  foreign key (pass_id, tenant_id, venue_id)
    references public.production_passes(id, tenant_id, venue_id) on delete restrict
);

create table public.order_line_production_passes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  order_line_id uuid not null references public.order_lines(id) on delete cascade,
  component_id text not null default '',
  pass_id uuid not null,
  pass_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_line_production_passes_component_check check (char_length(component_id) <= 200),
  constraint order_line_production_passes_name_check check (char_length(btrim(pass_name)) between 1 and 80),
  unique (order_line_id, component_id),
  foreign key (pass_id, tenant_id, venue_id)
    references public.production_passes(id, tenant_id, venue_id) on delete restrict
);

create table public.production_component_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  batch_id uuid not null references public.production_batches(id) on delete restrict,
  source_order_line_id uuid not null,
  current_order_line_id uuid not null,
  source_component_id text not null,
  quantity numeric(18,3) not null,
  ready_quantity numeric(18,3) not null default 0,
  cancelled_quantity numeric(18,3) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint production_component_allocations_quantity_check check (quantity >= 0 and scale(quantity) <= 3),
  constraint production_component_allocations_state_check check (ready_quantity >= 0 and cancelled_quantity >= 0 and ready_quantity + cancelled_quantity <= quantity and scale(ready_quantity) <= 3 and scale(cancelled_quantity) <= 3),
  unique (batch_id, source_order_line_id, current_order_line_id, source_component_id)
);

alter table public.production_batches add column pass_id uuid;
alter table public.production_batches add column pass_name text;
alter table public.production_items add column pass_id uuid;
alter table public.production_items add column pass_name text;

create index production_passes_venue_active_idx on public.production_passes(venue_id, sort_order, id) where is_active;
create index production_component_allocations_current_idx on public.production_component_allocations(current_order_line_id, source_component_id, batch_id);
create index order_line_production_passes_line_idx on public.order_line_production_passes(order_line_id);

insert into public.production_passes (tenant_id, venue_id, name, sort_order)
select venue.tenant_id, venue.id, 'Directo', 0
from public.venues venue
on conflict (venue_id, name) do nothing;

create or replace function public.production_resolve_pass(
  p_tenant_id uuid, p_venue_id uuid, p_product_id uuid, p_category_id uuid
)
returns public.production_passes
language sql stable
set search_path = ''
as $$
  select pass.*
  from public.production_passes pass
  where pass.tenant_id = p_tenant_id
    and pass.venue_id = p_venue_id
    and pass.is_active
    and pass.id = coalesce(
      (select route.pass_id from public.production_product_pass_routes route where route.venue_id = p_venue_id and route.product_id = p_product_id),
      (select route.pass_id from public.production_category_pass_routes route where route.venue_id = p_venue_id and route.category_id = p_category_id),
      (select fallback.id from public.production_passes fallback where fallback.tenant_id = p_tenant_id and fallback.venue_id = p_venue_id and fallback.is_active order by fallback.sort_order, fallback.created_at, fallback.id limit 1)
    )
  limit 1;
$$;

create or replace function public.production_upsert_pass_snapshot(
  p_line public.order_lines,
  p_component_id text,
  p_product_id uuid,
  p_category_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare resolved public.production_passes%rowtype;
begin
  select * into resolved from public.production_resolve_pass(p_line.tenant_id, p_line.venue_id, p_product_id, p_category_id);
  if resolved.id is null then raise exception 'No hay pase activo configurado para el local' using errcode = 'P0001'; end if;
  insert into public.order_line_production_passes (tenant_id, venue_id, order_line_id, component_id, pass_id, pass_name)
  values (p_line.tenant_id, p_line.venue_id, p_line.id, coalesce(p_component_id, ''), resolved.id, resolved.name)
  on conflict (order_line_id, component_id) do nothing;
end;
$$;

create or replace function public.production_snapshot_line_passes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare component jsonb; category_id uuid;
begin
  if new.split_from_line_id is not null then return new; end if;
  if jsonb_array_length(coalesce(new.components, '[]'::jsonb)) = 0 then
    category_id := coalesce(nullif(new.catalog_snapshot ->> 'categoryId', '')::uuid, public.production_catalog_category(new.tenant_id, new.venue_id, new.product_id));
    perform public.production_upsert_pass_snapshot(new, '', new.product_id, category_id);
  else
    for component in select value from jsonb_array_elements(new.components) loop
      if nullif(component ->> 'productId', '') is null or nullif(component ->> 'id', '') is null then continue; end if;
      category_id := coalesce(nullif(component -> 'metadata' ->> 'categoryId', '')::uuid, public.production_catalog_category(new.tenant_id, new.venue_id, (component ->> 'productId')::uuid));
      perform public.production_upsert_pass_snapshot(new, component ->> 'id', (component ->> 'productId')::uuid, category_id);
    end loop;
  end if;
  return new;
end;
$$;

create trigger production_snapshot_line_passes_after_insert
  after insert on public.order_lines
  for each row execute function public.production_snapshot_line_passes();

insert into public.order_line_production_passes (tenant_id, venue_id, order_line_id, component_id, pass_id, pass_name)
select line.tenant_id, line.venue_id, line.id, '', pass.id, pass.name
from public.order_lines line
cross join lateral (select * from public.production_resolve_pass(line.tenant_id, line.venue_id, line.product_id, coalesce(nullif(line.catalog_snapshot ->> 'categoryId', '')::uuid, public.production_catalog_category(line.tenant_id, line.venue_id, line.product_id)))) pass
where jsonb_array_length(coalesce(line.components, '[]'::jsonb)) = 0
on conflict (order_line_id, component_id) do nothing;

insert into public.order_line_production_passes (tenant_id, venue_id, order_line_id, component_id, pass_id, pass_name)
select line.tenant_id, line.venue_id, line.id, component.value ->> 'id', pass.id, pass.name
from public.order_lines line
cross join lateral jsonb_array_elements(coalesce(line.components, '[]'::jsonb)) component
cross join lateral (select * from public.production_resolve_pass(line.tenant_id, line.venue_id, (component.value ->> 'productId')::uuid, coalesce(nullif(component.value -> 'metadata' ->> 'categoryId', '')::uuid, public.production_catalog_category(line.tenant_id, line.venue_id, (component.value ->> 'productId')::uuid)))) pass
where nullif(component.value ->> 'id', '') is not null and nullif(component.value ->> 'productId', '') is not null
on conflict (order_line_id, component_id) do nothing;

create or replace function public.production_copy_passes_after_split()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.split_from_line_id is null then return new; end if;
  insert into public.order_line_production_passes (tenant_id, venue_id, order_line_id, component_id, pass_id, pass_name)
  select tenant_id, venue_id, new.id, component_id, pass_id, pass_name
  from public.order_line_production_passes
  where order_line_id = new.split_from_line_id
  on conflict (order_line_id, component_id) do nothing;
  return new;
end;
$$;

create trigger production_copy_passes_after_split
  after insert on public.order_lines
  for each row when (new.split_from_line_id is not null)
  execute function public.production_copy_passes_after_split();

create or replace function public.set_order_line_production_pass(
  p_order_line_id uuid, p_component_id text, p_pass_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare line_row public.order_lines%rowtype; pass_row public.production_passes%rowtype; sent_quantity numeric(18,3);
begin
  select * into line_row from public.order_lines where id = p_order_line_id for update;
  if line_row.id is null or not public.user_has_venue_access(line_row.tenant_id, line_row.venue_id) then raise exception 'Línea no disponible' using errcode = '42501'; end if;
  select * into pass_row from public.production_passes where id = p_pass_id and tenant_id = line_row.tenant_id and venue_id = line_row.venue_id and is_active;
  if pass_row.id is null then raise exception 'Pase no disponible' using errcode = '42501'; end if;
  if p_component_id is null then p_component_id := ''; end if;
  select coalesce(sum(quantity - cancelled_quantity), 0) into sent_quantity
  from public.production_component_allocations
  where current_order_line_id = line_row.id and source_component_id = p_component_id;
  if p_component_id = '' then
    select sent_quantity + coalesce(sum(quantity - cancelled_quantity), 0) into sent_quantity from public.production_line_allocations where current_order_line_id = line_row.id;
  end if;
  if sent_quantity > 0 then raise exception 'No se puede cambiar el pase de un producto ya enviado' using errcode = '40001'; end if;
  insert into public.order_line_production_passes (tenant_id, venue_id, order_line_id, component_id, pass_id, pass_name)
  values (line_row.tenant_id, line_row.venue_id, line_row.id, p_component_id, pass_row.id, pass_row.name)
  on conflict (order_line_id, component_id) do update set pass_id = excluded.pass_id, pass_name = excluded.pass_name, updated_at = now();
  return jsonb_build_object('lineId', line_row.id, 'componentId', nullif(p_component_id, ''), 'passId', pass_row.id, 'passName', pass_row.name);
end;
$$;

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
      unsent_quantity := greatest(0, line_row.quantity - greatest(sent_quantity, line_row.served_quantity));
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
        unsent_quantity := greatest(0, line_row.quantity - greatest(sent_quantity, line_row.served_quantity));
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
  update public.production_batches batch set pass_id = coalesce(batch.pass_id, (select min(item.pass_id) from public.production_items item where item.batch_id = batch.id)), pass_name = coalesce(batch.pass_name, (select min(item.pass_name) from public.production_items item where item.batch_id = batch.id)) where batch.id = batch_id;
  printer_dispatches := public.production_create_batch_dispatches(batch_id);
  return jsonb_build_object('batchId', batch_id, 'sequence', sequence_value, 'duplicate', false, 'sentUnits', selected_total, 'itemCount', item_count, 'printerDispatches', printer_dispatches);
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
  if order_row.id is null or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then raise exception 'Comanda no disponible' using errcode = '42501'; end if;
  return jsonb_build_object(
    'effective', public.production_is_effective(order_row.tenant_id, order_row.venue_id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('lineId', line.id, 'sentQuantity', coalesce(legacy.sent_quantity, component_state.sent_quantity, 0), 'readyQuantity', least(greatest(coalesce(legacy.ready_quantity, component_state.ready_quantity, 0) - line.served_quantity, 0), greatest(line.quantity - line.served_quantity, 0)), 'unsentQuantity', greatest(line.quantity - greatest(coalesce(legacy.sent_quantity, component_state.sent_quantity, 0), line.served_quantity), 0), 'hasProductionDestination', true) order by line.created_at, line.id) from public.order_lines line left join lateral (select sum(quantity-cancelled_quantity)::numeric(18,3) sent_quantity, sum(ready_quantity)::numeric(18,3) ready_quantity from public.production_line_allocations where current_order_line_id=line.id) legacy on true left join lateral (select min(sum_value)::numeric(18,3) sent_quantity, min(ready_value)::numeric(18,3) ready_quantity from (select source_component_id, sum(quantity-cancelled_quantity)::numeric(18,3) sum_value, sum(ready_quantity)::numeric(18,3) ready_value from public.production_component_allocations where current_order_line_id=line.id group by source_component_id) grouped) component_state on true where line.order_id=p_order_id), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(entry order by entry->>'passSortOrder', entry->>'passName', entry->>'lineId', entry->>'componentId') from (select jsonb_build_object('lineId', line.id, 'componentId', nullif(assignment.component_id, ''), 'productName', coalesce(component.value->>'productName', line.product_name), 'parentProductName', case when assignment.component_id <> '' then line.product_name else null end, 'quantity', line.quantity, 'sentQuantity', coalesce(case when assignment.component_id = '' then (select sum(quantity-cancelled_quantity) from public.production_line_allocations where current_order_line_id=line.id) else (select sum(quantity-cancelled_quantity) from public.production_component_allocations where current_order_line_id=line.id and source_component_id=assignment.component_id) end, 0), 'readyQuantity', 0, 'unsentQuantity', greatest(0, line.quantity - greatest(coalesce(case when assignment.component_id = '' then (select sum(quantity-cancelled_quantity) from public.production_line_allocations where current_order_line_id=line.id) else (select sum(quantity-cancelled_quantity) from public.production_component_allocations where current_order_line_id=line.id and source_component_id=assignment.component_id) end, 0), line.served_quantity)), 'passId', assignment.pass_id, 'passName', assignment.pass_name, 'passSortOrder', pass.sort_order, 'hasProductionDestination', true) entry from public.order_line_production_passes assignment join public.order_lines line on line.id=assignment.order_line_id join public.production_passes pass on pass.id=assignment.pass_id left join lateral (select value from jsonb_array_elements(line.components) where value->>'id'=assignment.component_id limit 1) component on true where line.order_id=p_order_id) rows), '[]'::jsonb),
    'warnings', coalesce((select jsonb_agg(jsonb_build_object('destinationId', dispatch.destination_id, 'status', dispatch.status, 'message', coalesce(dispatch.error_message, 'No se puede confirmar la impresión')) order by dispatch.created_at desc) from public.production_printer_dispatches dispatch join public.production_batches batch on batch.id=dispatch.batch_id where batch.order_id=p_order_id and dispatch.status in ('failed','unknown')), '[]'::jsonb)
  );
end;
$$;

alter table public.production_passes enable row level security;
alter table public.production_category_pass_routes enable row level security;
alter table public.production_product_pass_routes enable row level security;
alter table public.order_line_production_passes enable row level security;
alter table public.production_component_allocations enable row level security;
create policy production_passes_admin_all on public.production_passes for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));
create policy production_category_pass_routes_admin_all on public.production_category_pass_routes for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));
create policy production_product_pass_routes_admin_all on public.production_product_pass_routes for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));
create policy order_line_production_passes_read on public.order_line_production_passes for select to authenticated using (public.user_has_venue_access(tenant_id, venue_id));
create policy production_component_allocations_read on public.production_component_allocations for select to authenticated using (public.user_has_venue_access(tenant_id, venue_id));
revoke all on table public.production_passes, public.production_category_pass_routes, public.production_product_pass_routes, public.order_line_production_passes, public.production_component_allocations from public, anon;
grant select, insert, update, delete on public.production_passes, public.production_category_pass_routes, public.production_product_pass_routes to authenticated;
grant select on public.order_line_production_passes, public.production_component_allocations to authenticated;
grant all on table public.production_passes, public.production_category_pass_routes, public.production_product_pass_routes, public.order_line_production_passes, public.production_component_allocations to service_role;
revoke all on function public.set_order_line_production_pass(uuid, text, uuid) from public, anon;
grant execute on function public.set_order_line_production_pass(uuid, text, uuid), public.send_production_batch(uuid, integer, uuid, text, jsonb), public.get_order_production_state(uuid) to authenticated;
notify pgrst, 'reload schema';
