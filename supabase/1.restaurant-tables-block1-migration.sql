-- Bloque 1: gestion de mesas y comandas para restauracion.
-- Baseline: supabase/complete-database.sql

alter table public.venues
add column if not exists tables_enabled boolean not null default false;

create table if not exists public.dining_areas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  canvas_width integer not null default 1200 check (canvas_width between 320 and 4000),
  canvas_height integer not null default 800 check (canvas_height between 320 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id, venue_id)
);

create table if not exists public.restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  area_id uuid not null,
  name text not null,
  capacity integer not null default 2 check (capacity between 1 and 99),
  shape text not null default 'square' check (shape in ('square', 'rectangle', 'round')),
  position_x numeric(8, 3) not null default 0 check (position_x between 0 and 100),
  position_y numeric(8, 3) not null default 0 check (position_y between 0 and 100),
  width numeric(8, 3) not null default 12 check (width between 4 and 100),
  height numeric(8, 3) not null default 12 check (height between 4 and 100),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  reserved_until timestamptz,
  reservation_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id, venue_id),
  constraint restaurant_tables_area_fk foreign key (area_id, tenant_id, venue_id)
    references public.dining_areas (id, tenant_id, venue_id) on delete restrict
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  opened_by_user_id uuid not null references auth.users(id) on delete restrict,
  opened_by_device_id uuid not null references public.devices(id) on delete restrict,
  guest_count integer not null default 1 check (guest_count between 1 and 999),
  status text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  revision integer not null default 0 check (revision >= 0),
  unique (id, tenant_id, venue_id),
  constraint orders_closed_state_check check (
    (status = 'open' and closed_at is null)
    or (status in ('paid', 'cancelled') and closed_at is not null)
  )
);

alter table public.orders
add column if not exists revision integer not null default 0;

create table if not exists public.order_tables (
  tenant_id uuid not null,
  venue_id uuid not null,
  order_id uuid not null,
  table_id uuid not null,
  joined_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (order_id, table_id),
  constraint order_tables_order_fk foreign key (order_id, tenant_id, venue_id)
    references public.orders (id, tenant_id, venue_id) on delete cascade,
  constraint order_tables_table_fk foreign key (table_id, tenant_id, venue_id)
    references public.restaurant_tables (id, tenant_id, venue_id) on delete restrict
);

create table if not exists public.order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  venue_id uuid not null,
  order_id uuid not null,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_name text not null,
  variant_name text not null,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  quantity integer not null check (quantity > 0),
  modifiers jsonb not null default '[]'::jsonb,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_lines_order_fk foreign key (order_id, tenant_id, venue_id)
    references public.orders (id, tenant_id, venue_id) on delete cascade,
  constraint order_lines_modifiers_array check (jsonb_typeof(modifiers) = 'array')
);

create unique index if not exists one_active_order_per_restaurant_table
on public.order_tables (table_id)
where released_at is null;

create index if not exists dining_areas_venue_active_idx
on public.dining_areas (tenant_id, venue_id, is_active, sort_order);
create index if not exists restaurant_tables_area_active_idx
on public.restaurant_tables (tenant_id, venue_id, area_id, is_active, sort_order);
create index if not exists restaurant_tables_reserved_idx
on public.restaurant_tables (venue_id, reserved_until)
where is_active = true and reserved_until is not null;
create index if not exists orders_venue_open_idx
on public.orders (tenant_id, venue_id, opened_at)
where status = 'open';
create index if not exists orders_cash_session_open_idx
on public.orders (cash_session_id, opened_at)
where status = 'open';
create index if not exists order_tables_order_active_idx
on public.order_tables (order_id, table_id)
where released_at is null;
create index if not exists order_lines_order_idx
on public.order_lines (order_id, created_at);

drop trigger if exists set_dining_areas_updated_at on public.dining_areas;
create trigger set_dining_areas_updated_at before update on public.dining_areas
for each row execute function public.set_updated_at();
drop trigger if exists set_restaurant_tables_updated_at on public.restaurant_tables;
create trigger set_restaurant_tables_updated_at before update on public.restaurant_tables
for each row execute function public.set_updated_at();
drop trigger if exists set_orders_updated_at on public.orders;
create trigger set_orders_updated_at before update on public.orders
for each row execute function public.set_updated_at();
drop trigger if exists set_order_lines_updated_at on public.order_lines;
create trigger set_order_lines_updated_at before update on public.order_lines
for each row execute function public.set_updated_at();

alter table public.dining_areas enable row level security;
alter table public.restaurant_tables enable row level security;
alter table public.orders enable row level security;
alter table public.order_tables enable row level security;
alter table public.order_lines enable row level security;

drop policy if exists "dining_areas_select" on public.dining_areas;
drop policy if exists "dining_areas_admin_manage" on public.dining_areas;
create policy "dining_areas_select" on public.dining_areas for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy "dining_areas_admin_manage" on public.dining_areas for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "restaurant_tables_select" on public.restaurant_tables;
drop policy if exists "restaurant_tables_admin_manage" on public.restaurant_tables;
create policy "restaurant_tables_select" on public.restaurant_tables for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy "restaurant_tables_admin_manage" on public.restaurant_tables for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "orders_select" on public.orders;
create policy "orders_select" on public.orders for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

drop policy if exists "order_tables_select" on public.order_tables;
create policy "order_tables_select" on public.order_tables for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

drop policy if exists "order_lines_select" on public.order_lines;
create policy "order_lines_select" on public.order_lines for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

create or replace function public.set_venue_tables_enabled(p_venue_id uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  venue_row public.venues%rowtype;
begin
  select * into venue_row from public.venues where id = p_venue_id for update;
  if venue_row.id is null or not public.user_is_tenant_admin(venue_row.tenant_id) then
    raise exception 'No autorizado para configurar este local' using errcode = '42501';
  end if;
  if not p_enabled and exists (
    select 1 from public.orders o
    where o.tenant_id = venue_row.tenant_id and o.venue_id = venue_row.id and o.status = 'open'
  ) then
    raise exception 'No se puede desactivar: existen comandas abiertas';
  end if;
  update public.venues set tables_enabled = p_enabled where id = venue_row.id;
  return p_enabled;
end;
$$;

create or replace function public.open_restaurant_order(
  p_table_ids uuid[],
  p_guest_count integer,
  p_cash_session_id uuid,
  p_device_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_table public.restaurant_tables%rowtype;
  new_order_id uuid := gen_random_uuid();
  table_count integer;
  locked_count integer;
  session_row public.cash_sessions%rowtype;
begin
  if coalesce(array_length(p_table_ids, 1), 0) = 0 or p_guest_count < 1 then
    raise exception 'Seleccion de mesas o numero de comensales no valido';
  end if;
  select count(distinct value) into table_count from unnest(p_table_ids) as selected(value);
  if table_count <> array_length(p_table_ids, 1) then raise exception 'Hay mesas duplicadas'; end if;

  select rt.* into first_table from public.restaurant_tables rt
  where rt.id = p_table_ids[1] for update;
  if first_table.id is null
    or not public.user_has_venue_access(first_table.tenant_id, first_table.venue_id)
    or not first_table.is_active then
    raise exception 'Mesa no disponible o sin acceso' using errcode = '42501';
  end if;

  perform 1 from public.restaurant_tables rt
  where rt.id = any(p_table_ids)
  order by rt.id for update;
  select count(*) into locked_count from public.restaurant_tables rt
  where rt.id = any(p_table_ids)
    and rt.tenant_id = first_table.tenant_id and rt.venue_id = first_table.venue_id
    and rt.is_active and (rt.reserved_until is null or rt.reserved_until <= now());
  if locked_count <> table_count then raise exception 'Todas las mesas deben estar libres, activas y en el mismo local'; end if;
  if exists (select 1 from public.order_tables ot where ot.table_id = any(p_table_ids) and ot.released_at is null) then
    raise exception 'Una de las mesas ya esta ocupada';
  end if;

  select * into session_row from public.cash_sessions where id = p_cash_session_id for update;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> first_table.tenant_id or session_row.venue_id <> first_table.venue_id
    or session_row.device_id <> p_device_id
    or not public.user_can_view_device(session_row.tenant_id, session_row.venue_id, p_device_id) then
    raise exception 'La caja o el dispositivo no son validos';
  end if;

  insert into public.orders (
    id, tenant_id, venue_id, cash_session_id, opened_by_user_id, opened_by_device_id, guest_count
  ) values (
    new_order_id, first_table.tenant_id, first_table.venue_id, session_row.id, auth.uid(), p_device_id, p_guest_count
  );
  insert into public.order_tables (tenant_id, venue_id, order_id, table_id)
  select first_table.tenant_id, first_table.venue_id, new_order_id, value from unnest(p_table_ids) as selected(value);
  return new_order_id;
end;
$$;

create or replace function public.add_restaurant_order_line(
  p_order_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_modifier_ids uuid[] default '{}'::uuid[],
  p_quantity integer default 1,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  product_row public.products%rowtype;
  variant_row public.product_variants%rowtype;
  modifiers_json jsonb := '[]'::jsonb;
  modifier_total integer := 0;
  modifier_count integer := 0;
  new_line_id uuid := gen_random_uuid();
begin
  if p_quantity < 1 then raise exception 'Cantidad no valida'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  select * into product_row from public.products
  where id = p_product_id and tenant_id = order_row.tenant_id and venue_id = order_row.venue_id and is_active;
  select * into variant_row from public.product_variants
  where id = p_variant_id and tenant_id = order_row.tenant_id and product_id = p_product_id;
  if product_row.id is null or variant_row.id is null then raise exception 'Producto o variante no validos'; end if;

  if coalesce(array_length(p_modifier_ids, 1), 0) > 0 then
    if (select count(distinct value) from unnest(p_modifier_ids) as selected(value)) <> array_length(p_modifier_ids, 1) then
      raise exception 'Hay modificadores duplicados';
    end if;
    select count(*), coalesce(sum(m.price_cents), 0),
      coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'groupId', m.group_id, 'name', m.name, 'priceCents', m.price_cents) order by m.sort_order), '[]'::jsonb)
    into modifier_count, modifier_total, modifiers_json
    from public.modifiers m
    join public.modifier_groups mg on mg.id = m.group_id
    where m.id = any(p_modifier_ids) and m.tenant_id = order_row.tenant_id and mg.product_id = p_product_id;
    if modifier_count <> array_length(p_modifier_ids, 1) then raise exception 'Modificadores no validos'; end if;
  end if;

  if exists (
    select 1
    from public.modifier_groups mg
    where mg.product_id = p_product_id
      and mg.tenant_id = order_row.tenant_id
      and (
        (select count(*) from unnest(coalesce(p_modifier_ids, '{}'::uuid[])) as selected(selected_id)
          join public.modifiers selected_modifier on selected_modifier.id = selected.selected_id
          where selected_modifier.group_id = mg.id) < mg.min_select
        or
        (select count(*) from unnest(coalesce(p_modifier_ids, '{}'::uuid[])) as selected(selected_id)
          join public.modifiers selected_modifier on selected_modifier.id = selected.selected_id
          where selected_modifier.group_id = mg.id) > mg.max_select
      )
  ) then
    raise exception 'La seleccion de modificadores no cumple los limites del producto';
  end if;

  insert into public.order_lines (
    id, tenant_id, venue_id, order_id, product_id, variant_id, product_name, variant_name,
    unit_price_cents, quantity, modifiers, note
  ) values (
    new_line_id, order_row.tenant_id, order_row.venue_id, order_row.id, product_row.id, variant_row.id,
    product_row.name, variant_row.name, variant_row.price_cents + modifier_total, p_quantity, modifiers_json, nullif(trim(p_note), '')
  );
  return new_line_id;
end;
$$;

create or replace function public.set_restaurant_order_line_quantity(p_line_id uuid, p_quantity integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare line_row public.order_lines%rowtype; order_row public.orders%rowtype;
begin
  if p_quantity < 1 then raise exception 'Cantidad no valida'; end if;
  select * into line_row from public.order_lines where id = p_line_id for update;
  select * into order_row from public.orders where id = line_row.order_id for update;
  if line_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Linea no disponible' using errcode = '42501';
  end if;
  update public.order_lines set quantity = p_quantity where id = line_row.id;
end;
$$;

create or replace function public.remove_restaurant_order_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare line_row public.order_lines%rowtype; order_row public.orders%rowtype;
begin
  select * into line_row from public.order_lines where id = p_line_id for update;
  select * into order_row from public.orders where id = line_row.order_id for update;
  if line_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Linea no disponible' using errcode = '42501';
  end if;
  delete from public.order_lines where id = line_row.id;
end;
$$;

create or replace function public.save_restaurant_order_lines(
  p_order_id uuid,
  p_expected_revision integer,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  line_item jsonb;
  line_id uuid;
  product_id uuid;
  variant_id uuid;
  modifier_ids uuid[];
  quantity_value integer;
  note_value text;
  signature_value text;
  signatures text[] := '{}'::text[];
  retained_snapshot_ids uuid[] := '{}'::uuid[];
  next_revision integer;
  result_lines jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 500 then
    raise exception 'El borrador de comanda no es valido';
  end if;

  select * into order_row
  from public.orders
  where id = p_order_id
  for update;

  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;

  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo'
      using errcode = '40001',
      detail = jsonb_build_object('expectedRevision', p_expected_revision, 'currentRevision', order_row.revision)::text;
  end if;

  -- Las lineas con catalogo se reconstruyen mediante la RPC autoritativa.
  -- Las lineas cuyo producto fue eliminado conservan su snapshot y solo
  -- permiten cambiar cantidad/nota.
  delete from public.order_lines as ol
  where ol.order_id = order_row.id and ol.product_id is not null;

  for line_item in select value from jsonb_array_elements(p_lines)
  loop
    quantity_value := (line_item ->> 'quantity')::integer;
    note_value := nullif(trim(line_item ->> 'note'), '');

    if quantity_value < 1 or quantity_value > 9999 then
      raise exception 'Cantidad de linea no valida';
    end if;

    if nullif(line_item ->> 'productId', '') is null then
      line_id := (line_item ->> 'id')::uuid;
      update public.order_lines as ol
      set quantity = quantity_value, note = note_value
      where ol.id = line_id
        and ol.order_id = order_row.id
        and ol.product_id is null;
      if not found then
        raise exception 'No se puede reconstruir una linea sin producto';
      end if;
      retained_snapshot_ids := array_append(retained_snapshot_ids, line_id);
      continue;
    end if;

    product_id := (line_item ->> 'productId')::uuid;
    variant_id := (line_item ->> 'variantId')::uuid;
    select coalesce(array_agg(value::uuid order by value), '{}'::uuid[])
    into modifier_ids
    from jsonb_array_elements_text(coalesce(line_item -> 'modifierIds', '[]'::jsonb)) selected(value);

    signature_value := concat_ws(
      '|',
      product_id::text,
      variant_id::text,
      array_to_string(modifier_ids, ','),
      coalesce(note_value, '')
    );
    if signature_value = any(signatures) then
      raise exception 'El borrador contiene lineas duplicadas';
    end if;
    signatures := array_append(signatures, signature_value);

    perform public.add_restaurant_order_line(
      order_row.id,
      product_id,
      variant_id,
      modifier_ids,
      quantity_value,
      note_value
    );
  end loop;

  delete from public.order_lines as ol
  where ol.order_id = order_row.id
    and ol.product_id is null
    and not (ol.id = any(retained_snapshot_ids));

  update public.orders as o
  set revision = o.revision + 1
  where o.id = order_row.id
  returning o.revision into next_revision;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', ol.id,
        'tenantId', ol.tenant_id,
        'venueId', ol.venue_id,
        'orderId', ol.order_id,
        'productId', ol.product_id,
        'variantId', ol.variant_id,
        'productName', ol.product_name,
        'variantName', ol.variant_name,
        'unitPriceCents', ol.unit_price_cents,
        'quantity', ol.quantity,
        'modifiers', ol.modifiers,
        'note', ol.note,
        'createdAt', ol.created_at,
        'updatedAt', ol.updated_at
      )
      order by ol.created_at
    ),
    '[]'::jsonb
  )
  into result_lines
  from public.order_lines ol
  where ol.order_id = order_row.id;

  return jsonb_build_object('revision', next_revision, 'lines', result_lines);
end;
$$;

create or replace function public.move_restaurant_order(p_order_id uuid, p_target_table_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare order_row public.orders%rowtype; target_row public.restaurant_tables%rowtype;
begin
  select * into target_row from public.restaurant_tables where id = p_target_table_id for update;
  select * into order_row from public.orders where id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  if target_row.id is null or target_row.tenant_id <> order_row.tenant_id or target_row.venue_id <> order_row.venue_id
    or not target_row.is_active or target_row.reserved_until > now()
    or exists (select 1 from public.order_tables where table_id = target_row.id and released_at is null) then
    raise exception 'La mesa destino no esta libre';
  end if;
  update public.order_tables set released_at = now() where order_id = order_row.id and released_at is null;
  insert into public.order_tables (tenant_id, venue_id, order_id, table_id)
  values (order_row.tenant_id, order_row.venue_id, order_row.id, target_row.id)
  on conflict (order_id, table_id) do update set joined_at = now(), released_at = null;
end;
$$;

create or replace function public.group_restaurant_tables(
  p_table_ids uuid[],
  p_guest_count integer,
  p_cash_session_id uuid,
  p_device_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare base_table public.restaurant_tables%rowtype; order_row public.orders%rowtype; existing_order_ids uuid[]; result_order_id uuid; table_count integer;
begin
  if coalesce(array_length(p_table_ids, 1), 0) < 2 then raise exception 'Selecciona al menos dos mesas'; end if;
  select count(distinct value) into table_count from unnest(p_table_ids) as selected(value);
  if table_count <> array_length(p_table_ids, 1) then raise exception 'Hay mesas duplicadas'; end if;
  perform 1 from public.restaurant_tables where id = any(p_table_ids) order by id for update;
  select * into base_table from public.restaurant_tables where id = p_table_ids[1];
  if base_table.id is null or not public.user_has_venue_access(base_table.tenant_id, base_table.venue_id) then
    raise exception 'Mesas no disponibles' using errcode = '42501';
  end if;
  if (select count(*) from public.restaurant_tables rt where rt.id = any(p_table_ids)
      and rt.tenant_id = base_table.tenant_id and rt.venue_id = base_table.venue_id and rt.is_active
      and (rt.reserved_until is null or rt.reserved_until <= now())) <> table_count then
    raise exception 'Todas las mesas deben estar activas, no reservadas y en el mismo local';
  end if;
  select array_agg(distinct ot.order_id) into existing_order_ids
  from public.order_tables ot join public.orders o on o.id = ot.order_id
  where ot.table_id = any(p_table_ids) and ot.released_at is null and o.status = 'open';
  if coalesce(array_length(existing_order_ids, 1), 0) > 1 then raise exception 'No se pueden unir dos comandas existentes'; end if;
  if coalesce(array_length(existing_order_ids, 1), 0) = 0 then
    result_order_id := public.open_restaurant_order(p_table_ids, p_guest_count, p_cash_session_id, p_device_id);
  else
    result_order_id := existing_order_ids[1];
    select * into order_row from public.orders where id = result_order_id for update;
    if order_row.status <> 'open' then raise exception 'La comanda ha dejado de estar abierta'; end if;
    insert into public.order_tables (tenant_id, venue_id, order_id, table_id)
    select base_table.tenant_id, base_table.venue_id, result_order_id, value from unnest(p_table_ids) as selected(value)
    on conflict (order_id, table_id) do update set joined_at = now(), released_at = null;
  end if;
  return result_order_id;
end;
$$;

create or replace function public.close_order_and_create_sale(
  p_order_id uuid,
  p_payment_method text,
  p_received_cents integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype; session_row public.cash_sessions%rowtype;
  total_cents integer; ticket_id uuid := gen_random_uuid(); sale_id uuid := gen_random_uuid(); payment_id uuid := gen_random_uuid();
begin
  if p_payment_method not in ('cash', 'card', 'invitation', 'other') then raise exception 'Metodo de pago no valido'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  if not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then raise exception 'Sin acceso a la comanda' using errcode = '42501'; end if;
  select * into session_row from public.cash_sessions where id = order_row.cash_session_id for update;
  if session_row.status <> 'open' or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or not public.user_can_view_device(session_row.tenant_id, session_row.venue_id, session_row.device_id) then
    raise exception 'La caja asociada ya no esta disponible';
  end if;
  select coalesce(sum(quantity * unit_price_cents), 0)::integer into total_cents
  from public.order_lines where order_id = order_row.id;
  if total_cents <= 0 then raise exception 'No se puede cobrar una comanda vacia'; end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < total_cents then raise exception 'Importe recibido insuficiente'; end if;

  insert into public.tickets (id, tenant_id, cash_session_id, venue_id, device_id, user_id, status, subtotal_cents, total_cents, local_created_at)
  values (ticket_id, order_row.tenant_id, session_row.id, order_row.venue_id, session_row.device_id, auth.uid(), 'paid', total_cents, total_cents, now());
  insert into public.ticket_lines (id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name, quantity, unit_price_cents, line_total_cents, modifiers)
  select gen_random_uuid(), tenant_id, ticket_id, product_id, variant_id, product_name, variant_name, quantity, unit_price_cents,
    quantity * unit_price_cents, modifiers from public.order_lines where order_id = order_row.id;
  insert into public.sales (id, tenant_id, ticket_id, cash_session_id, venue_id, device_id, user_id, total_cents, payment_method, local_created_at)
  values (sale_id, order_row.tenant_id, ticket_id, session_row.id, order_row.venue_id, session_row.device_id, auth.uid(), total_cents, p_payment_method, now());
  insert into public.sale_payments (id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents)
  values (payment_id, order_row.tenant_id, sale_id, p_payment_method, total_cents,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - total_cents else 0 end);
  update public.orders set status = 'paid', closed_at = now() where id = order_row.id;
  update public.order_tables set released_at = now() where order_id = order_row.id and released_at is null;
  return jsonb_build_object('orderId', order_row.id, 'ticketId', ticket_id, 'saleId', sale_id, 'paymentId', payment_id, 'totalCents', total_cents);
end;
$$;

revoke all on function public.set_venue_tables_enabled(uuid, boolean) from public;
revoke all on function public.open_restaurant_order(uuid[], integer, uuid, uuid) from public;
revoke all on function public.add_restaurant_order_line(uuid, uuid, uuid, uuid[], integer, text) from public;
revoke all on function public.set_restaurant_order_line_quantity(uuid, integer) from public;
revoke all on function public.remove_restaurant_order_line(uuid) from public;
revoke all on function public.save_restaurant_order_lines(uuid, integer, jsonb) from public;
revoke all on function public.move_restaurant_order(uuid, uuid) from public;
revoke all on function public.group_restaurant_tables(uuid[], integer, uuid, uuid) from public;
revoke all on function public.close_order_and_create_sale(uuid, text, integer) from public;
grant execute on function public.set_venue_tables_enabled(uuid, boolean) to authenticated;
grant execute on function public.open_restaurant_order(uuid[], integer, uuid, uuid) to authenticated;
grant execute on function public.add_restaurant_order_line(uuid, uuid, uuid, uuid[], integer, text) to authenticated;
grant execute on function public.set_restaurant_order_line_quantity(uuid, integer) to authenticated;
grant execute on function public.remove_restaurant_order_line(uuid) to authenticated;
grant execute on function public.save_restaurant_order_lines(uuid, integer, jsonb) to authenticated;
grant execute on function public.move_restaurant_order(uuid, uuid) to authenticated;
grant execute on function public.group_restaurant_tables(uuid[], integer, uuid, uuid) to authenticated;
grant execute on function public.close_order_and_create_sale(uuid, text, integer) to authenticated;

grant select on public.dining_areas, public.restaurant_tables, public.orders, public.order_tables, public.order_lines to authenticated;
grant insert, update, delete on public.dining_areas, public.restaurant_tables to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.orders; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.order_tables; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.order_lines; exception when duplicate_object then null; end;
end $$;
