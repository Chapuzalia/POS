-- Optional restaurant production domain (KDS + durable printer dispatches).
-- This migration is intentionally additive. Existing POS, payment and local-printing
-- paths do not depend on any object introduced here.

create extension if not exists pgcrypto;

insert into public.platform_features (
  key, name, description, is_core, is_active, enabled_by_default, sort_order
)
values (
  'production', 'Producción', 'Envíos a barra/cocina, KDS e impresión de producción.',
  false, true, false, 150
)
on conflict (key) do update
set name = excluded.name,
    description = excluded.description,
    is_core = excluded.is_core,
    is_active = excluded.is_active,
    enabled_by_default = excluded.enabled_by_default,
    sort_order = excluded.sort_order,
    updated_at = now();

alter table public.venues
  add column if not exists production_enabled boolean not null default false;

create table public.production_destinations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  kds_enabled boolean not null default false,
  printer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint production_destinations_name_check check (char_length(btrim(name)) between 1 and 80),
  constraint production_destinations_sort_check check (sort_order >= 0),
  constraint production_destinations_output_check check (
    not is_active or kds_enabled or printer_id is not null
  ),
  unique (id, tenant_id, venue_id),
  unique (venue_id, name)
);

alter table public.devices drop constraint if exists devices_device_mode_check;
alter table public.devices drop constraint if exists devices_satellite_capabilities_check;
alter table public.devices
  add column if not exists production_destination_id uuid,
  add constraint devices_device_mode_check
    check (device_mode in ('satellite', 'checkout', 'hybrid', 'kds')),
  add constraint devices_non_cash_capabilities_check check (
    (device_mode not in ('satellite', 'kds'))
    or (
      not can_take_payments
      and not can_open_cash_session
      and not can_close_cash_session
      and not can_manage_cash
    )
  ),
  add constraint devices_kds_capabilities_check check (
    device_mode <> 'kds'
    or (
      not can_take_orders
      and default_cash_register_id is null
      and active_cash_session_id is null
      and production_destination_id is not null
    )
  );

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'devices_production_destination_fkey'
      and conrelid = 'public.devices'::regclass
  ) then
    alter table public.devices
      add constraint devices_production_destination_fkey
      foreign key (production_destination_id, tenant_id, venue_id)
      references public.production_destinations(id, tenant_id, venue_id)
      on delete restrict;
  end if;
end;
$$;

create index if not exists devices_production_destination_idx
  on public.devices(production_destination_id)
  where device_mode = 'kds';

create table public.production_category_routes (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  destination_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (venue_id, category_id),
  foreign key (destination_id, tenant_id, venue_id)
    references public.production_destinations(id, tenant_id, venue_id) on delete restrict
);

create table public.production_product_routes (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  destination_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (venue_id, product_id),
  foreign key (destination_id, tenant_id, venue_id)
    references public.production_destinations(id, tenant_id, venue_id) on delete restrict
);

create table public.production_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  sequence integer not null,
  request_id text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_device_id uuid references public.devices(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint production_batches_sequence_check check (sequence > 0),
  constraint production_batches_request_check check (char_length(request_id) between 3 and 200),
  unique (venue_id, request_id),
  unique (order_id, sequence)
);

create table public.production_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  batch_id uuid not null references public.production_batches(id) on delete restrict,
  destination_id uuid not null,
  source_order_id uuid not null,
  source_order_line_id uuid not null,
  source_component_id text,
  product_id uuid,
  variant_id uuid,
  quantity integer not null,
  units_per_commercial_unit integer not null default 1,
  ready_quantity integer not null default 0,
  cancelled_quantity integer not null default 0,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint production_items_quantity_check check (quantity > 0),
  constraint production_items_unit_multiplier_check check (units_per_commercial_unit > 0),
  constraint production_items_ready_check check (ready_quantity between 0 and quantity),
  constraint production_items_cancelled_check check (
    cancelled_quantity between 0 and quantity
    and ready_quantity + cancelled_quantity <= quantity
  ),
  constraint production_items_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  foreign key (destination_id, tenant_id, venue_id)
    references public.production_destinations(id, tenant_id, venue_id) on delete restrict
);

-- Mutable operational lineage. The immutable item above keeps the original source
-- snapshot; these rows only say where its commercial units live after a split/move.
create table public.production_line_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  batch_id uuid not null references public.production_batches(id) on delete restrict,
  source_order_line_id uuid not null,
  current_order_line_id uuid not null,
  quantity integer not null,
  ready_quantity integer not null default 0,
  cancelled_quantity integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint production_line_allocations_quantity_check check (quantity >= 0),
  constraint production_line_allocations_state_check check (
    ready_quantity >= 0
    and cancelled_quantity >= 0
    and ready_quantity + cancelled_quantity <= quantity
  ),
  unique (batch_id, source_order_line_id, current_order_line_id)
);

create table public.production_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  batch_id uuid references public.production_batches(id) on delete restrict,
  production_item_id uuid references public.production_items(id) on delete restrict,
  destination_id uuid not null,
  event_type text not null,
  quantity integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_device_id uuid references public.devices(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint production_events_type_check check (event_type in ('modified', 'cancelled', 'table_moved', 'manual_reprint')),
  constraint production_events_quantity_check check (quantity >= 0),
  constraint production_events_payload_check check (jsonb_typeof(payload) = 'object'),
  foreign key (destination_id, tenant_id, venue_id)
    references public.production_destinations(id, tenant_id, venue_id) on delete restrict
);

create table public.production_print_agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  instance_id text not null,
  secret_hash text not null,
  is_active boolean not null default true,
  version text,
  production_capability boolean not null default false,
  worker_state text not null default 'disabled',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint production_print_agents_worker_check check (worker_state in ('disabled', 'idle', 'polling', 'error')),
  unique (venue_id),
  unique (instance_id)
);

create table public.production_agent_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index production_print_agents_secret_hash_idx
  on public.production_print_agents(secret_hash);

create table public.production_agent_printers (
  agent_id uuid not null references public.production_print_agents(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  printer_id text not null,
  display_name text not null,
  paper_width integer not null,
  character_set text not null,
  available boolean not null default true,
  last_seen_at timestamptz not null default now(),
  primary key (agent_id, printer_id),
  constraint production_agent_printers_width_check check (paper_width in (58, 80))
);

create table public.production_printer_dispatches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  batch_id uuid references public.production_batches(id) on delete restrict,
  event_id uuid references public.production_events(id) on delete restrict,
  destination_id uuid not null,
  agent_id uuid not null references public.production_print_agents(id) on delete restrict,
  printer_id text not null,
  request_id text not null unique,
  payload jsonb not null,
  paper_width integer not null,
  character_set text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint production_dispatch_target_check check ((batch_id is null) <> (event_id is null)),
  constraint production_dispatch_payload_check check (jsonb_typeof(payload) = 'object'),
  constraint production_dispatch_status_check check (status in ('pending', 'claimed', 'printed', 'failed', 'unknown')),
  constraint production_dispatch_width_check check (paper_width in (58, 80)),
  foreign key (destination_id, tenant_id, venue_id)
    references public.production_destinations(id, tenant_id, venue_id) on delete restrict
);

create index production_batches_order_idx on public.production_batches(order_id, sequence);
create index production_items_destination_queue_idx on public.production_items(destination_id, created_at)
  where ready_quantity + cancelled_quantity < quantity;
create index production_items_line_idx on public.production_items(source_order_line_id, created_at);
create index production_allocations_current_line_idx on public.production_line_allocations(current_order_line_id, batch_id);
create index production_events_destination_idx on public.production_events(destination_id, created_at desc);
create index production_dispatch_claim_idx on public.production_printer_dispatches(agent_id, status, lease_expires_at, created_at)
  where status in ('pending', 'claimed');

create or replace function public.production_is_effective(p_tenant_id uuid, p_venue_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.venues venue
    join public.tenant_feature_assignments assignment
      on assignment.tenant_id = venue.tenant_id
     and assignment.feature_key = 'production'
    join public.platform_features feature
      on feature.key = assignment.feature_key
     and feature.is_active
    where venue.id = p_venue_id
      and venue.tenant_id = p_tenant_id
      and venue.is_active
      and venue.production_enabled
  );
$$;

create or replace function public.production_can_access_destination(
  p_tenant_id uuid, p_venue_id uuid, p_destination_id uuid
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.user_is_tenant_admin(p_tenant_id)
    or exists (
      select 1
      from public.device_user_assignments assignment
      join public.devices device on device.id = assignment.device_id
      where assignment.tenant_id = p_tenant_id
        and assignment.venue_id = p_venue_id
        and assignment.user_id = auth.uid()
        and assignment.is_active
        and device.is_active
        and (
          device.device_mode <> 'kds'
          or device.production_destination_id = p_destination_id
        )
    );
$$;

create or replace function public.set_venue_production_enabled(p_venue_id uuid, p_enabled boolean)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare venue_row public.venues%rowtype;
begin
  select * into venue_row from public.venues where id = p_venue_id for update;
  if venue_row.id is null or not public.user_is_tenant_admin(venue_row.tenant_id) then
    raise exception 'Local no disponible' using errcode = '42501';
  end if;
  if p_enabled and not exists (
    select 1 from public.tenant_feature_assignments
    where tenant_id = venue_row.tenant_id and feature_key = 'production'
  ) then
    raise exception 'La feature Producción no está habilitada para el negocio' using errcode = '42501';
  end if;
  update public.venues set production_enabled = p_enabled, updated_at = now() where id = p_venue_id;
  return p_enabled;
end;
$$;

create or replace function public.validate_production_destination()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_active and not public.production_is_effective(new.tenant_id, new.venue_id) then
    raise exception 'Producción no está activa para este local' using errcode = '42501';
  end if;
  if new.is_active and not new.kds_enabled and new.printer_id is null then
    raise exception 'Un destino activo necesita KDS, impresora o ambos' using errcode = '23514';
  end if;
  if new.printer_id is not null and not exists (
    select 1
    from public.production_agent_printers printer
    join public.production_print_agents agent on agent.id = printer.agent_id
    where printer.tenant_id = new.tenant_id
      and printer.venue_id = new.venue_id
      and printer.printer_id = new.printer_id
      and agent.is_active
      and agent.production_capability
  ) then
    raise exception 'La impresora no está publicada por un Print Agent vinculado' using errcode = '23503';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger validate_production_destination_before_write
before insert or update on public.production_destinations
for each row execute function public.validate_production_destination();

create or replace function public.production_resolve_destination(
  p_tenant_id uuid, p_venue_id uuid, p_product_id uuid, p_category_id uuid
)
returns uuid
language sql stable
set search_path = ''
as $$
  select destination.id
  from public.production_destinations destination
  where destination.tenant_id = p_tenant_id
    and destination.venue_id = p_venue_id
    and destination.is_active
    and destination.id = coalesce(
      (
        select route.destination_id
        from public.production_product_routes route
        where route.venue_id = p_venue_id and route.product_id = p_product_id
      ),
      (
        select route.destination_id
        from public.production_category_routes route
        where route.venue_id = p_venue_id and route.category_id = p_category_id
      )
    )
  limit 1;
$$;

create or replace function public.production_catalog_category(
  p_tenant_id uuid, p_venue_id uuid, p_product_id uuid
)
returns uuid
language sql stable
set search_path = ''
as $$
  select placement.category_id
  from public.catalog_placements placement
  where placement.tenant_id = p_tenant_id
    and placement.venue_id = p_venue_id
    and placement.product_id = p_product_id
    and placement.is_active
    and placement.category_id is not null
  order by placement.sort_order, placement.id
  limit 1;
$$;

create or replace function public.production_item_lines(p_snapshot jsonb, p_quantity integer)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  lines jsonb := jsonb_build_array(
    p_quantity::text || 'x ' || coalesce(p_snapshot ->> 'productName', 'Producto')
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

create or replace function public.production_render_batch_lines(p_batch_id uuid, p_destination_id uuid)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  batch_row public.production_batches%rowtype;
  venue_row public.venues%rowtype;
  item_row public.production_items%rowtype;
  table_label text;
  lines jsonb;
begin
  select * into batch_row from public.production_batches where id = p_batch_id;
  select * into venue_row from public.venues where id = batch_row.venue_id;
  select coalesce(string_agg(table_ref.name, ' + ' order by table_ref.name), 'COMANDA') into table_label
  from public.orders order_ref
  join public.order_tables link on link.order_group_id = order_ref.order_group_id and link.released_at is null
  join public.restaurant_tables table_ref on table_ref.id = link.table_id
  where order_ref.id = batch_row.order_id;
  lines := jsonb_build_array(
    '----------------',
    'MESA ' || upper(table_label),
    'ENVÍO #' || batch_row.sequence::text,
    to_char(batch_row.created_at at time zone venue_row.timezone, 'HH24:MI'),
    '----------------',
    ''
  );
  for item_row in
    select * from public.production_items
    where batch_id = p_batch_id and destination_id = p_destination_id
    order by created_at, id
  loop
    lines := lines || public.production_item_lines(item_row.snapshot, item_row.quantity) || jsonb_build_array('');
  end loop;
  return lines || jsonb_build_array('----------------');
end;
$$;

create or replace function public.production_create_batch_dispatches(p_batch_id uuid)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  target record;
  dispatch_id uuid;
  created_count integer := 0;
begin
  for target in
    select distinct destination.id as destination_id, destination.tenant_id, destination.venue_id,
      destination.printer_id, agent.id as agent_id, printer.paper_width, printer.character_set
    from public.production_items item
    join public.production_destinations destination on destination.id = item.destination_id
    join public.production_print_agents agent
      on agent.tenant_id = destination.tenant_id and agent.venue_id = destination.venue_id
      and agent.is_active and agent.production_capability
    join public.production_agent_printers printer
      on printer.agent_id = agent.id and printer.printer_id = destination.printer_id
    where item.batch_id = p_batch_id and destination.printer_id is not null
  loop
    dispatch_id := gen_random_uuid();
    insert into public.production_printer_dispatches (
      id, tenant_id, venue_id, batch_id, destination_id, agent_id, printer_id,
      request_id, payload, paper_width, character_set
    ) values (
      dispatch_id, target.tenant_id, target.venue_id, p_batch_id, target.destination_id,
      target.agent_id, target.printer_id, 'production:' || dispatch_id::text,
      jsonb_build_object(
        'requestId', 'production:' || dispatch_id::text,
        'printerId', target.printer_id,
        'lines', public.production_render_batch_lines(p_batch_id, target.destination_id),
        'options', jsonb_build_object('cut', true, 'openCashDrawer', false, 'copies', 1)
      ),
      target.paper_width, target.character_set
    );
    created_count := created_count + 1;
  end loop;
  return created_count;
end;
$$;

create or replace function public.send_production_batch(
  p_order_id uuid,
  p_expected_revision integer,
  p_device_id uuid,
  p_request_id text,
  p_selection jsonb default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  device_row public.devices%rowtype;
  line_row public.order_lines%rowtype;
  component jsonb;
  destination_id uuid;
  category_id uuid;
  batch_id uuid;
  allocation_id uuid;
  item_id uuid;
  selected_quantity integer;
  sent_quantity integer;
  unsent_quantity integer;
  item_quantity integer;
  multiplier integer;
  sequence_value integer;
  item_count integer := 0;
  selected_total integer := 0;
  printer_dispatches integer := 0;
  existing_batch public.production_batches%rowtype;
begin
  if auth.uid() is null then raise exception 'Autenticación requerida' using errcode = '42501'; end if;
  if p_selection is not null and jsonb_typeof(p_selection) <> 'array' then
    raise exception 'La selección de producción no es válida' using errcode = '22023';
  end if;

  select * into order_row from public.orders where id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  select * into existing_batch
  from public.production_batches
  where venue_id = order_row.venue_id and request_id = p_request_id;
  if existing_batch.id is not null then
    return jsonb_build_object(
      'batchId', existing_batch.id, 'sequence', existing_batch.sequence,
      'duplicate', true,
      'sentUnits', (
        select coalesce(sum(quantity), 0) from public.production_line_allocations
        where batch_id = existing_batch.id
      )
    );
  end if;
  if not public.production_is_effective(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Producción no está activa para este local' using errcode = '42501';
  end if;
  select * into device_row from public.devices where id = p_device_id for update;
  if device_row.id is null or not device_row.is_active
    or device_row.tenant_id <> order_row.tenant_id or device_row.venue_id <> order_row.venue_id
    or device_row.device_mode = 'kds'
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id) then
    raise exception 'El dispositivo no puede enviar esta comanda' using errcode = '42501';
  end if;
  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;

  perform 1 from public.order_lines where order_id = p_order_id order by id for update;
  sequence_value := coalesce((select max(sequence) from public.production_batches where order_id = p_order_id), 0) + 1;
  batch_id := gen_random_uuid();
  insert into public.production_batches (
    id, tenant_id, venue_id, order_id, sequence, request_id, actor_user_id, actor_device_id
  ) values (
    batch_id, order_row.tenant_id, order_row.venue_id, p_order_id, sequence_value,
    p_request_id, auth.uid(), device_row.id
  );

  for line_row in
    select * from public.order_lines where order_id = p_order_id order by created_at, id
  loop
    select coalesce(sum(quantity - cancelled_quantity), 0) into sent_quantity
    from public.production_line_allocations
    where current_order_line_id = line_row.id;
    unsent_quantity := greatest(0, line_row.quantity - sent_quantity);
    if p_selection is null then
      selected_quantity := unsent_quantity;
    else
      select coalesce(sum((entry ->> 'quantity')::integer), 0) into selected_quantity
      from jsonb_array_elements(p_selection) entry
      where entry ->> 'lineId' = line_row.id::text;
    end if;
    if selected_quantity < 0 or selected_quantity > unsent_quantity then
      raise exception 'La cantidad seleccionada de % ya no está disponible', line_row.product_name using errcode = '40001';
    end if;
    if selected_quantity = 0 then continue; end if;

    allocation_id := gen_random_uuid();
    insert into public.production_line_allocations (
      id, tenant_id, venue_id, batch_id, source_order_line_id, current_order_line_id, quantity
    ) values (
      allocation_id, line_row.tenant_id, line_row.venue_id, batch_id, line_row.id, line_row.id, selected_quantity
    );
    selected_total := selected_total + selected_quantity;

    if jsonb_array_length(coalesce(line_row.components, '[]'::jsonb)) > 0 then
      for component in select value from jsonb_array_elements(line_row.components) loop
        if coalesce(component ->> 'productId', '') = '' then continue; end if;
        category_id := coalesce(
          nullif(component -> 'metadata' ->> 'categoryId', '')::uuid,
          public.production_catalog_category(line_row.tenant_id, line_row.venue_id, (component ->> 'productId')::uuid)
        );
        destination_id := public.production_resolve_destination(
          line_row.tenant_id, line_row.venue_id, (component ->> 'productId')::uuid, category_id
        );
        if destination_id is null then
          raise exception 'Sin routing de producción: %', coalesce(component ->> 'productName', line_row.product_name) using errcode = 'P0001';
        end if;
        multiplier := greatest(coalesce((component ->> 'quantity')::integer, 1), 1);
        item_quantity := selected_quantity * multiplier;
        item_id := gen_random_uuid();
        insert into public.production_items (
          id, tenant_id, venue_id, batch_id, destination_id, source_order_id,
          source_order_line_id, source_component_id, product_id, variant_id,
          quantity, units_per_commercial_unit, snapshot
        ) values (
          item_id, line_row.tenant_id, line_row.venue_id, batch_id, destination_id, line_row.order_id,
          line_row.id, component ->> 'id', (component ->> 'productId')::uuid,
          nullif(component ->> 'variantId', '')::uuid, item_quantity, multiplier,
          jsonb_build_object(
            'productName', coalesce(component ->> 'productName', line_row.product_name),
            'variantName', coalesce(component ->> 'variantName', ''),
            'parentProductName', line_row.product_name,
            'lineModifiers', coalesce(line_row.modifiers, '[]'::jsonb),
            'componentModifiers', coalesce(component -> 'modifiers', '[]'::jsonb),
            'note', line_row.note,
            'destinationId', destination_id,
            'sourceOrderId', line_row.order_id,
            'sourceOrderLineId', line_row.id,
            'sourceComponentId', component ->> 'id'
          )
        );
        item_count := item_count + 1;
      end loop;
    else
      category_id := coalesce(
        nullif(line_row.catalog_snapshot ->> 'categoryId', '')::uuid,
        public.production_catalog_category(line_row.tenant_id, line_row.venue_id, line_row.product_id)
      );
      destination_id := public.production_resolve_destination(
        line_row.tenant_id, line_row.venue_id, line_row.product_id, category_id
      );
      if destination_id is null then
        raise exception 'Sin routing de producción: %', line_row.product_name using errcode = 'P0001';
      end if;
      item_id := gen_random_uuid();
      insert into public.production_items (
        id, tenant_id, venue_id, batch_id, destination_id, source_order_id,
        source_order_line_id, product_id, variant_id, quantity, snapshot
      ) values (
        item_id, line_row.tenant_id, line_row.venue_id, batch_id, destination_id, line_row.order_id,
        line_row.id, line_row.product_id, line_row.variant_id, selected_quantity,
        jsonb_build_object(
          'productName', line_row.product_name,
          'variantName', line_row.variant_name,
          'lineModifiers', coalesce(line_row.modifiers, '[]'::jsonb),
          'componentModifiers', '[]'::jsonb,
          'note', line_row.note,
          'destinationId', destination_id,
          'sourceOrderId', line_row.order_id,
          'sourceOrderLineId', line_row.id
        )
      );
      item_count := item_count + 1;
    end if;
  end loop;

  if selected_total = 0 then raise exception 'No hay productos nuevos que enviar' using errcode = 'P0001'; end if;
  if item_count = 0 then raise exception 'No se pudo generar producción para la selección' using errcode = 'P0001'; end if;

  printer_dispatches := public.production_create_batch_dispatches(batch_id);
  return jsonb_build_object(
    'batchId', batch_id,
    'sequence', sequence_value,
    'duplicate', false,
    'sentUnits', selected_total,
    'itemCount', item_count,
    'printerDispatches', printer_dispatches
  );
end;
$$;

create or replace function public.production_refresh_allocation_ready(
  p_batch_id uuid, p_source_order_line_id uuid
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  commercially_ready integer;
  remaining integer;
  allocation_row public.production_line_allocations%rowtype;
  assigned integer;
begin
  select coalesce(min((ready_quantity / units_per_commercial_unit)), 0)
  into commercially_ready
  from public.production_items
  where batch_id = p_batch_id and source_order_line_id = p_source_order_line_id
    and cancelled_quantity < quantity;
  remaining := commercially_ready;
  for allocation_row in
    select * from public.production_line_allocations
    where batch_id = p_batch_id and source_order_line_id = p_source_order_line_id
    order by created_at, id for update
  loop
    assigned := least(greatest(allocation_row.quantity - allocation_row.cancelled_quantity, 0), remaining);
    update public.production_line_allocations
    set ready_quantity = assigned, updated_at = now()
    where id = allocation_row.id;
    remaining := greatest(0, remaining - assigned);
  end loop;
end;
$$;

create or replace function public.mark_production_item_ready(
  p_item_id uuid, p_quantity integer, p_device_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  item_row public.production_items%rowtype;
  device_row public.devices%rowtype;
  next_ready integer;
begin
  if p_quantity < 1 then raise exception 'La cantidad debe ser positiva' using errcode = '22023'; end if;
  select * into item_row from public.production_items where id = p_item_id for update;
  select * into device_row from public.devices where id = p_device_id for update;
  if item_row.id is null or device_row.id is null or not device_row.is_active
    or device_row.device_mode <> 'kds'
    or device_row.tenant_id <> item_row.tenant_id or device_row.venue_id <> item_row.venue_id
    or device_row.production_destination_id <> item_row.destination_id
    or not public.production_is_effective(item_row.tenant_id, item_row.venue_id)
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id) then
    raise exception 'El KDS no puede modificar este destino' using errcode = '42501';
  end if;
  next_ready := least(item_row.quantity - item_row.cancelled_quantity, item_row.ready_quantity + p_quantity);
  if next_ready = item_row.ready_quantity then raise exception 'No quedan unidades pendientes' using errcode = '22023'; end if;
  update public.production_items set ready_quantity = next_ready, updated_at = now() where id = item_row.id;
  perform public.production_refresh_allocation_ready(item_row.batch_id, item_row.source_order_line_id);
  return jsonb_build_object('itemId', item_row.id, 'readyQuantity', next_ready, 'quantity', item_row.quantity);
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
        'unsentQuantity', greatest(line.quantity - coalesce(state.sent_quantity, 0), 0)
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
      where item.destination_id = device_row.production_destination_id
        and item.ready_quantity + item.cancelled_quantity < item.quantity
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(event_row) order by event_row.created_at desc)
      from (
        select id, event_type, quantity, payload, created_at
        from public.production_events
        where destination_id = device_row.production_destination_id
          and created_at > now() - interval '8 hours'
        order by created_at desc limit 50
      ) event_row
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.production_move_allocations_to_split_line()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare allocation_row public.production_line_allocations%rowtype;
  remaining integer := new.quantity;
  moved integer;
  moved_ready integer;
begin
  if new.split_from_line_id is null then return new; end if;
  for allocation_row in
    select * from public.production_line_allocations
    where current_order_line_id = new.split_from_line_id
      and quantity > cancelled_quantity
    order by created_at desc, id desc for update
  loop
    exit when remaining <= 0;
    moved := least(allocation_row.quantity - allocation_row.cancelled_quantity, remaining);
    moved_ready := least(allocation_row.ready_quantity, moved);
    update public.production_line_allocations
    set quantity = quantity - moved,
        ready_quantity = ready_quantity - moved_ready,
        updated_at = now()
    where id = allocation_row.id;
    insert into public.production_line_allocations (
      tenant_id, venue_id, batch_id, source_order_line_id, current_order_line_id,
      quantity, ready_quantity
    ) values (
      allocation_row.tenant_id, allocation_row.venue_id, allocation_row.batch_id,
      allocation_row.source_order_line_id, new.id, moved, moved_ready
    )
    on conflict (batch_id, source_order_line_id, current_order_line_id) do update
      set quantity = public.production_line_allocations.quantity + excluded.quantity,
          ready_quantity = public.production_line_allocations.ready_quantity + excluded.ready_quantity,
          updated_at = now();
    remaining := remaining - moved;
  end loop;
  delete from public.production_line_allocations where quantity = 0;
  return new;
end;
$$;

-- Older split RPCs predate menu snapshots and therefore omit these newer columns
-- from their INSERT. Preserve the complete commercial selection before lineage is
-- redistributed to the newly-created line.
create or replace function public.production_copy_split_line_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare source_line public.order_lines%rowtype;
begin
  if new.split_from_line_id is null then return new; end if;
  select * into source_line from public.order_lines where id = new.split_from_line_id;
  if source_line.id is null then return new; end if;
  new.components := source_line.components;
  new.catalog_snapshot := source_line.catalog_snapshot;
  return new;
end;
$$;

create trigger production_copy_split_snapshot_before_insert
before insert on public.order_lines
for each row when (new.split_from_line_id is not null)
execute function public.production_copy_split_line_snapshot();

create trigger production_move_allocations_after_split
after insert on public.order_lines
for each row when (new.split_from_line_id is not null)
execute function public.production_move_allocations_to_split_line();

create or replace function public.production_table_label_for_line(p_line_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  select coalesce(string_agg(table_ref.name, ' + ' order by table_ref.name), 'COMANDA')
  from public.order_lines line
  join public.orders order_ref on order_ref.id = line.order_id
  join public.order_tables link
    on link.order_group_id = order_ref.order_group_id and link.released_at is null
  join public.restaurant_tables table_ref on table_ref.id = link.table_id
  where line.id = p_line_id;
$$;

create or replace function public.production_render_event_lines(p_event_id uuid)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare event_row public.production_events%rowtype;
  title text;
begin
  select * into event_row from public.production_events where id = p_event_id;
  title := case event_row.event_type
    when 'cancelled' then '******** ANULACIÓN ********'
    when 'table_moved' then '******* CAMBIO DE MESA *******'
    else '******** MODIFICACIÓN ********'
  end;
  if event_row.event_type = 'table_moved' then
    return jsonb_build_array(
      title,
      'MESA ' || upper(coalesce(event_row.payload ->> 'tableName', 'COMANDA')),
      coalesce(event_row.payload ->> 'detail', 'La comanda ha cambiado de mesa'),
      '****************************'
    );
  end if;
  return jsonb_build_array(
    title,
    'MESA ' || upper(coalesce(event_row.payload ->> 'tableName', 'COMANDA')),
    event_row.quantity::text || 'x ' || coalesce(event_row.payload ->> 'productName', 'Producto'),
    coalesce(event_row.payload ->> 'detail', ''),
    '****************************'
  );
end;
$$;

create or replace function public.production_notify_table_link()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare target record;
  event_id uuid;
  table_label text;
begin
  if new.released_at is not null or not public.production_is_effective(new.tenant_id, new.venue_id) then
    return new;
  end if;
  select coalesce(string_agg(table_ref.name, ' + ' order by table_ref.name), 'COMANDA')
  into table_label
  from public.order_tables link
  join public.restaurant_tables table_ref on table_ref.id = link.table_id
  where link.order_group_id = new.order_group_id and link.released_at is null;
  for target in
    select distinct item.batch_id, item.destination_id
    from public.production_items item
    join public.orders order_ref on order_ref.id = item.source_order_id
    where order_ref.order_group_id = new.order_group_id
  loop
    event_id := gen_random_uuid();
    insert into public.production_events (
      id, tenant_id, venue_id, batch_id, destination_id, event_type,
      payload, actor_user_id
    ) values (
      event_id, new.tenant_id, new.venue_id, target.batch_id,
      target.destination_id, 'table_moved',
      jsonb_build_object('tableName', table_label, 'detail', 'Reubicar la comanda en esta mesa'),
      auth.uid()
    );
    perform public.production_create_event_dispatch(event_id);
  end loop;
  return new;
end;
$$;

create trigger production_notify_table_link_after_insert
after insert on public.order_tables
for each row execute function public.production_notify_table_link();

create or replace function public.production_create_event_dispatch(p_event_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare target record; dispatch_id uuid;
begin
  select event.tenant_id, event.venue_id, event.destination_id, destination.printer_id,
    agent.id as agent_id, printer.paper_width, printer.character_set
  into target
  from public.production_events event
  join public.production_destinations destination on destination.id = event.destination_id
  join public.production_print_agents agent
    on agent.tenant_id = event.tenant_id and agent.venue_id = event.venue_id
    and agent.is_active and agent.production_capability
  join public.production_agent_printers printer
    on printer.agent_id = agent.id and printer.printer_id = destination.printer_id
  where event.id = p_event_id and destination.printer_id is not null;
  if target.agent_id is null then return; end if;
  dispatch_id := gen_random_uuid();
  insert into public.production_printer_dispatches (
    id, tenant_id, venue_id, event_id, destination_id, agent_id, printer_id,
    request_id, payload, paper_width, character_set
  ) values (
    dispatch_id, target.tenant_id, target.venue_id, p_event_id, target.destination_id,
    target.agent_id, target.printer_id, 'production:' || dispatch_id::text,
    jsonb_build_object(
      'requestId', 'production:' || dispatch_id::text,
      'printerId', target.printer_id,
      'lines', public.production_render_event_lines(p_event_id),
      'options', jsonb_build_object('cut', true, 'openCashDrawer', false, 'copies', 1)
    ), target.paper_width, target.character_set
  );
end;
$$;

create or replace function public.production_cancel_line_excess(
  p_line_id uuid, p_target_active_quantity integer, p_notify boolean
)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare allocation_row public.production_line_allocations%rowtype;
  item_row public.production_items%rowtype;
  current_active integer;
  remaining integer;
  cancelled integer;
  event_id uuid;
begin
  select coalesce(sum(quantity - cancelled_quantity), 0) into current_active
  from public.production_line_allocations where current_order_line_id = p_line_id;
  remaining := greatest(0, current_active - greatest(p_target_active_quantity, 0));
  if remaining = 0 then return 0; end if;
  for allocation_row in
    select * from public.production_line_allocations
    where current_order_line_id = p_line_id and quantity > cancelled_quantity
    order by created_at desc, id desc for update
  loop
    exit when remaining = 0;
    cancelled := least(allocation_row.quantity - allocation_row.cancelled_quantity, remaining);
    update public.production_line_allocations
    set cancelled_quantity = cancelled_quantity + cancelled,
        ready_quantity = least(ready_quantity, quantity - cancelled_quantity - cancelled),
        updated_at = now()
    where id = allocation_row.id;
    for item_row in
      select * from public.production_items
      where batch_id = allocation_row.batch_id
        and source_order_line_id = allocation_row.source_order_line_id
      order by id for update
    loop
      update public.production_items
      set ready_quantity = greatest(
            0,
            ready_quantity - cancelled * units_per_commercial_unit
          ),
          cancelled_quantity = least(
            quantity,
            cancelled_quantity + cancelled * units_per_commercial_unit
          ),
          updated_at = now()
      where id = item_row.id;
      if p_notify then
        event_id := gen_random_uuid();
        insert into public.production_events (
          id, tenant_id, venue_id, batch_id, production_item_id, destination_id,
          event_type, quantity, payload, actor_user_id
        ) values (
          event_id, item_row.tenant_id, item_row.venue_id, item_row.batch_id,
          item_row.id, item_row.destination_id, 'cancelled',
          cancelled * item_row.units_per_commercial_unit,
          jsonb_build_object(
            'productName', item_row.snapshot ->> 'productName',
            'tableName', public.production_table_label_for_line(p_line_id),
            'sourceOrderLineId', p_line_id,
            'snapshot', item_row.snapshot
          ), auth.uid()
        );
        perform public.production_create_event_dispatch(event_id);
      end if;
    end loop;
    perform public.production_refresh_allocation_ready(allocation_row.batch_id, allocation_row.source_order_line_id);
    remaining := remaining - cancelled;
  end loop;
  return current_active - greatest(p_target_active_quantity, 0) - remaining;
end;
$$;

create or replace function public.production_notify_line_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare active_sent integer;
  split_quantity integer;
  item_row public.production_items%rowtype;
  event_id uuid;
  effective boolean;
begin
  if tg_op = 'DELETE' then
    effective := public.production_is_effective(old.tenant_id, old.venue_id);
    -- Served units remain historical production truth even when the legacy
    -- confirmed-removal workflow deletes the commercial line.
    perform public.production_cancel_line_excess(old.id, old.served_quantity, effective);
    return old;
  end if;
  effective := public.production_is_effective(new.tenant_id, new.venue_id);
  if new.quantity < old.quantity then
    select coalesce(sum(quantity), 0) into split_quantity
    from public.order_lines
    where split_from_line_id = old.id and created_at >= transaction_timestamp();
    if split_quantity < old.quantity - new.quantity then
      perform public.production_cancel_line_excess(new.id, new.quantity, effective);
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
          event_type, quantity, payload, actor_user_id
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
            'previousSnapshot', item_row.snapshot
          ), auth.uid()
        );
        perform public.production_create_event_dispatch(event_id);
      end loop;
    end if;
  end if;
  return new;
end;
$$;

create trigger production_notify_line_update
after update of quantity, product_id, variant_id, product_name, variant_name, modifiers, components, mixer, note
on public.order_lines for each row execute function public.production_notify_line_change();

create trigger production_notify_line_delete
before delete on public.order_lines for each row execute function public.production_notify_line_change();

create or replace function public.create_print_agent_pairing_code(p_venue_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare venue_row public.venues%rowtype;
  raw_code text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  expiry timestamptz := now() + interval '10 minutes';
begin
  select * into venue_row from public.venues where id = p_venue_id;
  if venue_row.id is null or not public.user_is_tenant_admin(venue_row.tenant_id)
    or not public.production_is_effective(venue_row.tenant_id, venue_row.id) then
    raise exception 'Producción no está activa para este local' using errcode = '42501';
  end if;
  delete from public.production_agent_pairing_codes
  where venue_id = p_venue_id and (used_at is not null or expires_at < now());
  insert into public.production_agent_pairing_codes (
    tenant_id, venue_id, code_hash, expires_at, created_by
  ) values (
    venue_row.tenant_id, venue_row.id,
    encode(digest(raw_code, 'sha256'), 'hex'), expiry, auth.uid()
  );
  return jsonb_build_object('code', raw_code, 'expiresAt', expiry);
end;
$$;

create or replace function public.exchange_print_agent_pairing(
  p_code_hash text, p_instance_id text, p_secret_hash text, p_version text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare pairing_row public.production_agent_pairing_codes%rowtype;
  agent_id uuid;
begin
  select * into pairing_row
  from public.production_agent_pairing_codes
  where code_hash = p_code_hash and used_at is null and expires_at > now()
  for update;
  if pairing_row.id is null then raise exception 'Código de vinculación inválido o caducado' using errcode = '42501'; end if;
  select id into agent_id from public.production_print_agents
  where venue_id = pairing_row.venue_id for update;
  if agent_id is null then
    insert into public.production_print_agents (
      tenant_id, venue_id, instance_id, secret_hash, is_active, version,
      production_capability, worker_state, last_seen_at
    ) values (
      pairing_row.tenant_id, pairing_row.venue_id, p_instance_id, p_secret_hash,
      true, p_version, true, 'idle', now()
    ) returning id into agent_id;
  else
    update public.production_print_agents
    set instance_id = p_instance_id, secret_hash = p_secret_hash, is_active = true,
        version = p_version, production_capability = true, worker_state = 'idle',
        last_seen_at = now(), updated_at = now()
    where id = agent_id;
  end if;
  update public.production_agent_pairing_codes set used_at = now() where id = pairing_row.id;
  return jsonb_build_object(
    'agentId', agent_id, 'tenantId', pairing_row.tenant_id, 'venueId', pairing_row.venue_id
  );
end;
$$;

create or replace function public.unlink_print_agent(p_venue_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare venue_row public.venues%rowtype;
begin
  select * into venue_row from public.venues where id = p_venue_id;
  if venue_row.id is null or not public.user_is_tenant_admin(venue_row.tenant_id) then
    raise exception 'Local no disponible' using errcode = '42501';
  end if;
  update public.production_print_agents
  set is_active = false, secret_hash = encode(digest(gen_random_uuid()::text, 'sha256'), 'hex'),
      worker_state = 'disabled', updated_at = now()
  where venue_id = p_venue_id;
  update public.production_printer_dispatches
  set status = 'unknown', error_code = 'AGENT_UNLINKED',
      error_message = 'El agente se desvinculó antes de confirmar la impresión',
      completed_at = now(), updated_at = now()
  where venue_id = p_venue_id and status in ('pending', 'claimed');
end;
$$;

create or replace function public.heartbeat_print_agent(
  p_agent_id uuid, p_version text, p_capability boolean, p_worker_state text, p_printers jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare agent_row public.production_print_agents%rowtype;
begin
  select * into agent_row from public.production_print_agents where id = p_agent_id and is_active for update;
  if agent_row.id is null then raise exception 'Print Agent revocado' using errcode = '42501'; end if;
  update public.production_print_agents
  set version = p_version, production_capability = p_capability,
      worker_state = p_worker_state, last_seen_at = now(), updated_at = now()
  where id = agent_row.id;
  delete from public.production_agent_printers where agent_id = agent_row.id;
  insert into public.production_agent_printers (
    agent_id, tenant_id, venue_id, printer_id, display_name, paper_width,
    character_set, available, last_seen_at
  )
  select agent_row.id, agent_row.tenant_id, agent_row.venue_id,
    printer ->> 'printerId', printer ->> 'displayName',
    (printer ->> 'paperWidth')::integer, printer ->> 'characterSet',
    coalesce((printer ->> 'available')::boolean, true), now()
  from jsonb_array_elements(coalesce(p_printers, '[]'::jsonb)) printer;
  return jsonb_build_object('ok', true, 'serverTime', now());
end;
$$;

create or replace function public.claim_production_dispatches(
  p_agent_id uuid, p_lease_token uuid, p_limit integer default 5
)
returns setof public.production_printer_dispatches
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.production_print_agents where id = p_agent_id and is_active) then
    raise exception 'Print Agent revocado' using errcode = '42501';
  end if;
  return query
  with candidates as (
    select dispatch.id
    from public.production_printer_dispatches dispatch
    where dispatch.agent_id = p_agent_id
      and (
        dispatch.status = 'pending'
        or (dispatch.status = 'claimed' and dispatch.lease_expires_at < now())
      )
    order by dispatch.created_at
    for update skip locked
    limit least(greatest(p_limit, 1), 20)
  ), claimed as (
    update public.production_printer_dispatches dispatch
    set status = 'claimed', lease_token = p_lease_token,
        lease_expires_at = now() + interval '30 seconds',
        attempts = attempts + 1, updated_at = now()
    from candidates
    where dispatch.id = candidates.id
    returning dispatch.*
  )
  select * from claimed;
end;
$$;

create or replace function public.ack_production_dispatch(
  p_agent_id uuid, p_dispatch_id uuid, p_lease_token uuid,
  p_status text, p_error_code text default null, p_error_message text default null,
  p_result jsonb default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare dispatch_row public.production_printer_dispatches%rowtype;
begin
  if p_status not in ('printed', 'failed', 'unknown') then
    raise exception 'Estado de impresión inválido' using errcode = '22023';
  end if;
  select * into dispatch_row from public.production_printer_dispatches
  where id = p_dispatch_id and agent_id = p_agent_id for update;
  if dispatch_row.id is null then raise exception 'Dispatch no disponible' using errcode = '42501'; end if;
  if dispatch_row.status in ('printed', 'failed', 'unknown') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', dispatch_row.status);
  end if;
  if dispatch_row.status <> 'claimed' or dispatch_row.lease_token <> p_lease_token then
    raise exception 'Lease de dispatch inválido' using errcode = '40001';
  end if;
  update public.production_printer_dispatches
  set status = p_status, error_code = p_error_code, error_message = p_error_message,
      result = p_result, lease_token = null, lease_expires_at = null,
      completed_at = now(), updated_at = now()
  where id = dispatch_row.id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'status', p_status);
end;
$$;

create or replace function public.reprint_production_dispatch(p_dispatch_id uuid, p_printer_id text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare original public.production_printer_dispatches%rowtype;
  printer_row public.production_agent_printers%rowtype;
  new_id uuid := gen_random_uuid();
begin
  select * into original from public.production_printer_dispatches where id = p_dispatch_id;
  if original.id is null or not public.user_is_tenant_admin(original.tenant_id) then
    raise exception 'Dispatch no disponible' using errcode = '42501';
  end if;
  select * into printer_row from public.production_agent_printers
  where agent_id = original.agent_id and printer_id = coalesce(p_printer_id, original.printer_id);
  if printer_row.printer_id is null then raise exception 'Impresora no disponible'; end if;
  insert into public.production_printer_dispatches (
    id, tenant_id, venue_id, batch_id, event_id, destination_id, agent_id,
    printer_id, request_id, payload, paper_width, character_set
  ) values (
    new_id, original.tenant_id, original.venue_id, original.batch_id, original.event_id,
    original.destination_id, original.agent_id, printer_row.printer_id,
    'production:reprint:' || new_id::text,
    jsonb_set(
      jsonb_set(original.payload, '{requestId}', to_jsonb(('production:reprint:' || new_id::text)::text)),
      '{printerId}', to_jsonb(printer_row.printer_id::text)
    ),
    printer_row.paper_width, printer_row.character_set
  );
  return new_id;
end;
$$;

alter table public.production_destinations enable row level security;
alter table public.production_category_routes enable row level security;
alter table public.production_product_routes enable row level security;
alter table public.production_batches enable row level security;
alter table public.production_items enable row level security;
alter table public.production_line_allocations enable row level security;
alter table public.production_events enable row level security;
alter table public.production_print_agents enable row level security;
alter table public.production_agent_pairing_codes enable row level security;
alter table public.production_agent_printers enable row level security;
alter table public.production_printer_dispatches enable row level security;

create policy production_destinations_admin_all on public.production_destinations
for all to authenticated using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));
create policy production_category_routes_admin_all on public.production_category_routes
for all to authenticated using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));
create policy production_product_routes_admin_all on public.production_product_routes
for all to authenticated using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));
create policy production_batches_read on public.production_batches
for select to authenticated using (public.user_has_venue_access(tenant_id, venue_id));
create policy production_items_read on public.production_items
for select to authenticated using (public.production_can_access_destination(tenant_id, venue_id, destination_id));
create policy production_events_read on public.production_events
for select to authenticated using (public.production_can_access_destination(tenant_id, venue_id, destination_id));
create policy production_allocations_read on public.production_line_allocations
for select to authenticated using (public.user_has_venue_access(tenant_id, venue_id));
create policy production_agents_admin_read on public.production_print_agents
for select to authenticated using (public.user_is_tenant_admin(tenant_id));
create policy production_printers_admin_read on public.production_agent_printers
for select to authenticated using (public.user_is_tenant_admin(tenant_id));
create policy production_dispatches_admin_read on public.production_printer_dispatches
for select to authenticated using (public.user_is_tenant_admin(tenant_id));

revoke all on table public.production_destinations, public.production_category_routes,
  public.production_product_routes, public.production_batches, public.production_items,
  public.production_line_allocations, public.production_events, public.production_print_agents,
  public.production_agent_pairing_codes, public.production_agent_printers,
  public.production_printer_dispatches from public, anon;
grant select, insert, update, delete on public.production_destinations,
  public.production_category_routes, public.production_product_routes to authenticated;
grant select on public.production_batches, public.production_items,
  public.production_line_allocations, public.production_events,
  public.production_print_agents, public.production_agent_printers,
  public.production_printer_dispatches to authenticated;
grant all on public.production_destinations, public.production_category_routes,
  public.production_product_routes, public.production_batches, public.production_items,
  public.production_line_allocations, public.production_events, public.production_print_agents,
  public.production_agent_pairing_codes, public.production_agent_printers,
  public.production_printer_dispatches to service_role;

revoke all on function public.set_venue_production_enabled(uuid, boolean),
  public.send_production_batch(uuid, integer, uuid, text, jsonb),
  public.mark_production_item_ready(uuid, integer, uuid),
  public.get_order_production_state(uuid), public.get_kds_queue(uuid),
  public.create_print_agent_pairing_code(uuid), public.unlink_print_agent(uuid),
  public.reprint_production_dispatch(uuid, text)
from public, anon;
grant execute on function public.set_venue_production_enabled(uuid, boolean),
  public.send_production_batch(uuid, integer, uuid, text, jsonb),
  public.mark_production_item_ready(uuid, integer, uuid),
  public.get_order_production_state(uuid), public.get_kds_queue(uuid),
  public.create_print_agent_pairing_code(uuid), public.unlink_print_agent(uuid),
  public.reprint_production_dispatch(uuid, text)
to authenticated;

revoke all on function public.exchange_print_agent_pairing(text, text, text, text),
  public.heartbeat_print_agent(uuid, text, boolean, text, jsonb),
  public.claim_production_dispatches(uuid, uuid, integer),
  public.ack_production_dispatch(uuid, uuid, uuid, text, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.exchange_print_agent_pairing(text, text, text, text),
  public.heartbeat_print_agent(uuid, text, boolean, text, jsonb),
  public.claim_production_dispatches(uuid, uuid, integer),
  public.ack_production_dispatch(uuid, uuid, uuid, text, text, text, jsonb)
to service_role;

revoke all on function public.production_create_batch_dispatches(uuid),
  public.production_refresh_allocation_ready(uuid, uuid),
  public.production_create_event_dispatch(uuid),
  public.production_cancel_line_excess(uuid, integer, boolean)
from public, anon, authenticated;
grant execute on function public.production_create_batch_dispatches(uuid),
  public.production_refresh_allocation_ready(uuid, uuid),
  public.production_create_event_dispatch(uuid),
  public.production_cancel_line_excess(uuid, integer, boolean)
to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'production_items'
  ) then alter publication supabase_realtime add table public.production_items; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'production_events'
  ) then alter publication supabase_realtime add table public.production_events; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'production_line_allocations'
  ) then alter publication supabase_realtime add table public.production_line_allocations; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'production_printer_dispatches'
  ) then alter publication supabase_realtime add table public.production_printer_dispatches; end if;
end;
$$;

comment on table public.production_batches is 'Immutable explicit ENVIAR actions.';
comment on table public.production_items is 'Immutable production snapshots; only readiness/cancellation counters are operational.';
comment on table public.production_line_allocations is 'Mutable lineage mapping used for server-authoritative unsent and ready quantities.';
comment on table public.production_printer_dispatches is 'Durable cloud output queue claimed by the venue Print Agent.';
