-- ============================================================================
-- CLUB POS - BASE DE DATOS COMPLETA
-- Esquema consolidado para Supabase.
-- Ejecutar completo en Supabase SQL Editor con permisos de administrador.
--
-- schema.sql ya incorpora el resultado final de estas migraciones historicas:
-- alcohol-catalog, mixer-supplement, sale-formats, product-featured,
-- product-images y crm-open-cash-realtime. No se repiten para evitar aplicar
-- transformaciones antiguas sobre el esquema definitivo.
--
-- La activacion de la primera cuenta superadmin queda documentada en la seccion
-- superadmin-migration.sql. El bootstrap de un tenant real se incluye al final
-- comentado porque requiere un usuario previo en Supabase Authentication.
-- ============================================================================

-- ============================================================================
-- INICIO: schema.sql
-- ============================================================================
-- Club POS / TPV discotecas
-- Ejecutar en Supabase SQL Editor con un rol con permisos de administraciÃ³n.

create extension if not exists pgcrypto;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 1048576, array['image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  is_active boolean not null default true,
  max_venues integer not null default 1 check (max_venues >= 1),
  max_devices integer not null default 5 check (max_devices >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  is_superadmin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'manager', 'cashier')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create or replace function public.user_has_tenant_access(target_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.is_active = true
      and t.is_active = true
  );
$$;

create or replace function public.user_has_tenant_role(target_tenant uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.role = any(allowed_roles)
      and tm.is_active = true
      and t.is_active = true
  );
$$;

create table if not exists public.venues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, venue_id, name)
);

create or replace function public.enforce_tenant_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_usage integer;
  resource_limit integer;
  resource_label text;
begin
  if tg_table_name = 'venues' then
    select max_venues into resource_limit from public.tenants where id = new.tenant_id for update;
    select count(*) into current_usage from public.venues where tenant_id = new.tenant_id;
    resource_label := 'locales';
  elsif tg_table_name = 'devices' then
    select max_devices into resource_limit from public.tenants where id = new.tenant_id for update;
    select count(*) into current_usage from public.devices where tenant_id = new.tenant_id;
    resource_label := 'dispositivos';
  elsif tg_table_name = 'tenant_memberships' then
    if new.role <> 'cashier' then
      return new;
    end if;
    select max_devices into resource_limit from public.tenants where id = new.tenant_id for update;
    select count(*) into current_usage from public.tenant_memberships where tenant_id = new.tenant_id and role = 'cashier';
    resource_label := 'usuarios';
  else
    return new;
  end if;

  if resource_limit is null then
    raise exception 'El negocio no existe.' using errcode = 'P0001';
  end if;
  if current_usage >= resource_limit then
    raise exception 'Has alcanzado el límite de % de tu plan (%).', resource_label, resource_limit using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_venue_plan_limit on public.venues;
create trigger enforce_venue_plan_limit before insert on public.venues
for each row execute function public.enforce_tenant_plan_limit();

drop trigger if exists enforce_device_plan_limit on public.devices;
create trigger enforce_device_plan_limit before insert on public.devices
for each row execute function public.enforce_tenant_plan_limit();

drop trigger if exists enforce_user_plan_limit on public.tenant_memberships;
create trigger enforce_user_plan_limit before insert on public.tenant_memberships
for each row execute function public.enforce_tenant_plan_limit();

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('beer', 'mixed', 'shot', 'other', 'alcohol', 'mixer', 'beer_bottle', 'soft_bottle', 'cocktail')),
  icon text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sale_formats (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null,
  label text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key),
  constraint sale_formats_key_check check (key ~ '^[a-z0-9_]+$' and key not in ('all', 'top'))
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  category_id uuid not null references public.categories(id) on delete restrict,
  name text not null,
  description text,
  image_path text,
  kind text not null check (kind in ('beer', 'mixed', 'shot', 'other', 'alcohol', 'mixer', 'beer_bottle', 'soft_bottle', 'cocktail')),
  sale_formats text[] not null default '{}'::text[],
  can_sell_standalone boolean not null default true,
  can_use_as_mixer boolean not null default false,
  is_featured boolean not null default false,
  mixer_supplement_cents integer not null default 0 check (mixer_supplement_cents >= 0),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Compatibilidad al ejecutar el esquema consolidado sobre una instalacion
-- anterior; la migracion de acceso por dispositivo completa despues la FK y
-- convierte la columna en obligatoria.
alter table public.products
add column if not exists venue_id uuid;

alter table public.products
drop constraint if exists products_sale_formats_check;

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  sku text,
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer not null default 1 check (max_select >= 1),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.modifiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  group_id uuid not null references public.modifier_groups(id) on delete cascade,
  name text not null,
  price_cents integer not null default 0 check (price_cents >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  device_id uuid not null references public.devices(id) on delete restrict,
  opened_by uuid not null references auth.users(id) on delete restrict,
  closed_by uuid references auth.users(id) on delete restrict,
  status text not null check (status in ('open', 'closed')),
  opening_float_cents integer not null default 0 check (opening_float_cents >= 0),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  expected_cash_cents integer,
  expected_card_cents integer,
  expected_invitation_cents integer,
  expected_other_cents integer,
  counted_cash_cents integer,
  counted_card_cents integer,
  counted_invitation_cents integer,
  counted_other_cents integer,
  discrepancy_cents integer,
  notes text,
  sync_source text not null default 'online',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists one_open_cash_session_per_device
on public.cash_sessions (tenant_id, device_id)
where status = 'open';

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  device_id uuid not null references public.devices(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  status text not null check (status in ('paid', 'void')),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  local_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ticket_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_name text not null,
  variant_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  line_total_cents integer not null check (line_total_cents >= 0),
  modifiers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete restrict,
  cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  device_id uuid not null references public.devices(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  total_cents integer not null check (total_cents >= 0),
  payment_method text not null check (payment_method in ('cash', 'card', 'invitation', 'other')),
  local_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  method text not null check (method in ('cash', 'card', 'invitation', 'other')),
  amount_cents integer not null check (amount_cents >= 0),
  received_cents integer,
  change_cents integer not null default 0 check (change_cents >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.offline_event_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_kind text not null,
  client_event_id uuid not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, client_event_id)
);

create or replace function public.validate_cash_session_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if current_user_id is not null and new.opened_by <> current_user_id then
      raise exception 'El usuario de apertura no coincide con auth.uid()' using errcode = '42501';
    end if;

    if new.status <> 'open' or new.closed_by is not null or new.closed_at is not null then
      raise exception 'Una caja nueva debe crearse abierta y sin datos de cierre';
    end if;

    return new;
  end if;

  if new.tenant_id is distinct from old.tenant_id
    or new.venue_id is distinct from old.venue_id
    or new.device_id is distinct from old.device_id
    or new.opened_by is distinct from old.opened_by
    or new.opened_at is distinct from old.opened_at then
    raise exception 'No se puede cambiar la identidad de una caja existente';
  end if;

  if old.status = 'closed' and new.status is distinct from old.status then
    raise exception 'Una caja cerrada no se puede volver a abrir';
  end if;

  if old.status = 'open' and new.status = 'closed' then
    if current_user_id is not null and new.closed_by <> current_user_id then
      raise exception 'El usuario de cierre no coincide con auth.uid()' using errcode = '42501';
    end if;

    if new.closed_by is null or new.closed_at is null then
      raise exception 'El cierre de caja requiere usuario y fecha';
    end if;
  elsif new.status = 'open' and (new.closed_by is not null or new.closed_at is not null) then
    raise exception 'Una caja abierta no puede contener datos de cierre';
  end if;

  return new;
end;
$$;

create or replace function public.validate_transaction_actor_and_cash()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  session_row public.cash_sessions%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'No se puede cambiar el usuario de una transaccion';
    end if;

    if new.tenant_id is distinct from old.tenant_id
      or new.cash_session_id is distinct from old.cash_session_id
      or new.venue_id is distinct from old.venue_id
      or new.device_id is distinct from old.device_id then
      raise exception 'No se puede cambiar la caja de una transaccion';
    end if;

    return new;
  end if;

  if current_user_id is not null and new.user_id <> current_user_id then
    raise exception 'El usuario de la transaccion no coincide con auth.uid()' using errcode = '42501';
  end if;

  select *
  into session_row
  from public.cash_sessions
  where id = new.cash_session_id
  for share;

  if not found then
    raise exception 'La caja indicada no existe';
  end if;

  if session_row.status <> 'open' then
    raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000';
  end if;

  if session_row.tenant_id <> new.tenant_id
    or session_row.venue_id <> new.venue_id
    or session_row.device_id <> new.device_id then
    raise exception 'La venta no coincide con el negocio, local o dispositivo de la caja';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_cash_session_write on public.cash_sessions;
create trigger validate_cash_session_write
before insert or update on public.cash_sessions
for each row execute function public.validate_cash_session_write();

drop trigger if exists validate_ticket_actor_and_cash on public.tickets;
create trigger validate_ticket_actor_and_cash
before insert or update on public.tickets
for each row execute function public.validate_transaction_actor_and_cash();

drop trigger if exists validate_sale_actor_and_cash on public.sales;
create trigger validate_sale_actor_and_cash
before insert or update on public.sales
for each row execute function public.validate_transaction_actor_and_cash();

create or replace function public.sync_sale_created(p_event_id uuid, p_payload jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  ticket_payload jsonb := p_payload -> 'ticket';
  sale_payload jsonb := p_payload -> 'sale';
  payment_payload jsonb := p_payload -> 'payment';
  tenant_id_value uuid;
  ticket_id_value uuid;
  sale_id_value uuid;
  cash_session_id_value uuid;
  venue_id_value uuid;
  device_id_value uuid;
  ticket_user_id_value uuid;
  sale_user_id_value uuid;
  total_cents_value bigint;
  payment_amount_value bigint;
  received_cents_value bigint;
  change_cents_value bigint;
  payment_method_value text;
  line_count integer;
  lines_total bigint;
  lines_are_valid boolean;
  session_row public.cash_sessions%rowtype;
  logged_event_id uuid;
begin
  if current_user_id is null then
    raise exception 'Se requiere un usuario autenticado' using errcode = '42501';
  end if;

  if p_event_id is null or jsonb_typeof(p_payload -> 'lines') is distinct from 'array' then
    raise exception 'El evento de venta no tiene un formato valido';
  end if;

  tenant_id_value := (ticket_payload ->> 'tenantId')::uuid;
  ticket_id_value := (ticket_payload ->> 'id')::uuid;
  sale_id_value := (sale_payload ->> 'id')::uuid;
  cash_session_id_value := (ticket_payload ->> 'cashSessionId')::uuid;
  venue_id_value := (ticket_payload ->> 'venueId')::uuid;
  device_id_value := (ticket_payload ->> 'deviceId')::uuid;
  ticket_user_id_value := (ticket_payload ->> 'userId')::uuid;
  sale_user_id_value := (sale_payload ->> 'userId')::uuid;
  total_cents_value := (ticket_payload ->> 'totalCents')::bigint;
  payment_amount_value := (payment_payload ->> 'amountCents')::bigint;
  received_cents_value := nullif(payment_payload ->> 'receivedCents', '')::bigint;
  change_cents_value := (payment_payload ->> 'changeCents')::bigint;
  payment_method_value := sale_payload ->> 'paymentMethod';

  if ticket_user_id_value <> current_user_id or sale_user_id_value <> current_user_id then
    raise exception 'El userId enviado no coincide con auth.uid()' using errcode = '42501';
  end if;

  if not public.user_has_tenant_access(tenant_id_value) then
    raise exception 'El usuario no tiene acceso al negocio' using errcode = '42501';
  end if;

  if (sale_payload ->> 'tenantId')::uuid <> tenant_id_value
    or (payment_payload ->> 'tenantId')::uuid <> tenant_id_value
    or (sale_payload ->> 'ticketId')::uuid <> ticket_id_value
    or (sale_payload ->> 'cashSessionId')::uuid <> cash_session_id_value
    or (sale_payload ->> 'venueId')::uuid <> venue_id_value
    or (sale_payload ->> 'deviceId')::uuid <> device_id_value
    or (payment_payload ->> 'saleId')::uuid <> sale_id_value
    or payment_payload ->> 'method' <> payment_method_value then
    raise exception 'Los datos relacionados de la venta no coinciden';
  end if;

  if exists (
    select 1
    from public.offline_event_log
    where tenant_id = tenant_id_value
      and client_event_id = p_event_id
  ) then
    return;
  end if;

  select
    count(*),
    coalesce(sum((line ->> 'lineTotalCents')::bigint), 0),
    coalesce(bool_and(
      (line ->> 'tenantId')::uuid = tenant_id_value
      and (line ->> 'ticketId')::uuid = ticket_id_value
      and (line ->> 'quantity')::integer > 0
      and (line ->> 'unitPriceCents')::bigint >= 0
      and (line ->> 'lineTotalCents')::bigint =
        (line ->> 'unitPriceCents')::bigint * (line ->> 'quantity')::integer
    ), false)
  into line_count, lines_total, lines_are_valid
  from jsonb_array_elements(p_payload -> 'lines') as line;

  if line_count = 0 or not lines_are_valid then
    raise exception 'Las lineas de la venta no son validas';
  end if;

  if total_cents_value <> lines_total
    or (sale_payload ->> 'totalCents')::bigint <> lines_total
    or payment_amount_value <> lines_total then
    raise exception 'Los totales de ticket, venta, lineas y pago no coinciden';
  end if;

  if payment_method_value = 'cash' then
    if received_cents_value is null
      or received_cents_value < total_cents_value
      or change_cents_value <> received_cents_value - total_cents_value then
      raise exception 'Los importes del pago en efectivo no son validos';
    end if;
  elsif change_cents_value <> 0 then
    raise exception 'Un pago no efectivo no puede tener cambio';
  end if;

  select *
  into session_row
  from public.cash_sessions
  where id = cash_session_id_value
  for update;

  if not found then
    raise exception 'La caja indicada no existe';
  end if;

  if session_row.status <> 'open' then
    raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000';
  end if;

  if session_row.tenant_id <> tenant_id_value
    or session_row.venue_id <> venue_id_value
    or session_row.device_id <> device_id_value then
    raise exception 'La venta no coincide con el negocio, local o dispositivo de la caja';
  end if;

  insert into public.offline_event_log (tenant_id, event_kind, client_event_id, payload)
  values (tenant_id_value, 'sale_created', p_event_id, p_payload)
  on conflict (tenant_id, client_event_id) do nothing
  returning id into logged_event_id;

  if logged_event_id is null then
    return;
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, venue_id, device_id, user_id, status,
    subtotal_cents, total_cents, local_created_at, created_at
  ) values (
    ticket_id_value, tenant_id_value, cash_session_id_value, venue_id_value,
    device_id_value, current_user_id, 'paid', total_cents_value, total_cents_value,
    (ticket_payload ->> 'createdAt')::timestamptz,
    (ticket_payload ->> 'createdAt')::timestamptz
  )
  on conflict (id) do update set
    status = excluded.status,
    subtotal_cents = excluded.subtotal_cents,
    total_cents = excluded.total_cents;

  insert into public.ticket_lines (
    id, ticket_id, tenant_id, product_id, variant_id, product_name, variant_name,
    quantity, unit_price_cents, line_total_cents, modifiers
  )
  select
    (line ->> 'id')::uuid, ticket_id_value, tenant_id_value,
    (line ->> 'productId')::uuid, (line ->> 'variantId')::uuid,
    line ->> 'productName', line ->> 'variantName',
    (line ->> 'quantity')::integer, (line ->> 'unitPriceCents')::integer,
    (line ->> 'lineTotalCents')::integer, coalesce(line -> 'modifiers', '[]'::jsonb)
  from jsonb_array_elements(p_payload -> 'lines') as line
  on conflict (id) do update set
    product_id = excluded.product_id,
    variant_id = excluded.variant_id,
    product_name = excluded.product_name,
    variant_name = excluded.variant_name,
    quantity = excluded.quantity,
    unit_price_cents = excluded.unit_price_cents,
    line_total_cents = excluded.line_total_cents,
    modifiers = excluded.modifiers;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, venue_id, device_id, user_id,
    total_cents, payment_method, local_created_at, created_at
  ) values (
    sale_id_value, tenant_id_value, ticket_id_value, cash_session_id_value,
    venue_id_value, device_id_value, current_user_id, total_cents_value,
    payment_method_value, (sale_payload ->> 'createdAt')::timestamptz,
    (sale_payload ->> 'createdAt')::timestamptz
  )
  on conflict (id) do update set
    total_cents = excluded.total_cents,
    payment_method = excluded.payment_method;

  insert into public.sale_payments (
    id, sale_id, tenant_id, method, amount_cents, received_cents, change_cents
  ) values (
    (payment_payload ->> 'id')::uuid, sale_id_value, tenant_id_value,
    payment_method_value, payment_amount_value, received_cents_value, change_cents_value
  )
  on conflict (id) do update set
    method = excluded.method,
    amount_cents = excluded.amount_cents,
    received_cents = excluded.received_cents,
    change_cents = excluded.change_cents;
end;
$$;

revoke all on function public.validate_cash_session_write() from public;
revoke all on function public.validate_transaction_actor_and_cash() from public;
revoke all on function public.sync_sale_created(uuid, jsonb) from public;
grant execute on function public.sync_sale_created(uuid, jsonb) to authenticated;

create index if not exists tenant_memberships_user_idx on public.tenant_memberships (user_id);
create index if not exists venues_tenant_idx on public.venues (tenant_id);
create index if not exists devices_tenant_idx on public.devices (tenant_id, venue_id);
create index if not exists categories_tenant_idx on public.categories (tenant_id, sort_order);
create index if not exists sale_formats_tenant_idx on public.sale_formats (tenant_id, sort_order);
create index if not exists products_tenant_idx on public.products (tenant_id, category_id, sort_order);
create index if not exists product_variants_product_idx on public.product_variants (product_id, sort_order);
create index if not exists modifier_groups_product_idx on public.modifier_groups (product_id, sort_order);
create index if not exists modifiers_group_idx on public.modifiers (group_id, sort_order);
create index if not exists cash_sessions_tenant_idx on public.cash_sessions (tenant_id, opened_at desc);
create index if not exists tickets_tenant_idx on public.tickets (tenant_id, created_at desc);
create index if not exists sales_tenant_idx on public.sales (tenant_id, created_at desc);

do $$
begin
  alter publication supabase_realtime add table public.cash_sessions;
exception
  when duplicate_object or undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.sales;
exception
  when duplicate_object or undefined_object then null;
end $$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tenants',
    'profiles',
    'tenant_memberships',
    'venues',
    'devices',
    'categories',
    'sale_formats',
    'products',
    'product_variants',
    'modifier_groups',
    'modifiers',
    'cash_sessions',
    'tickets',
    'ticket_lines',
    'sales',
    'sale_payments',
    'offline_event_log'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end $$;

drop policy if exists "tenants_select_member" on public.tenants;
create policy "tenants_select_member"
on public.tenants for select
using (public.user_has_tenant_access(id));

drop policy if exists "profiles_self_select" on public.profiles;
create policy "profiles_self_select"
on public.profiles for select
using (id = auth.uid());

drop policy if exists "profiles_self_upsert" on public.profiles;
-- Los perfiles se escriben exclusivamente desde funciones de backend con
-- service_role para impedir que un usuario se conceda is_superadmin.

drop policy if exists "memberships_self_select" on public.tenant_memberships;
create policy "memberships_self_select"
on public.tenant_memberships for select
using (user_id = auth.uid());

drop policy if exists "memberships_admin_all" on public.tenant_memberships;
create policy "memberships_admin_all"
on public.tenant_memberships for all
using (public.user_has_tenant_role(tenant_id, array['owner', 'admin']))
with check (public.user_has_tenant_role(tenant_id, array['owner', 'admin']));

drop policy if exists "venues_tenant_access" on public.venues;
create policy "venues_tenant_access"
on public.venues for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "devices_tenant_access" on public.devices;
create policy "devices_tenant_access"
on public.devices for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "categories_tenant_access" on public.categories;
create policy "categories_tenant_access"
on public.categories for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "sale_formats_tenant_access" on public.sale_formats;
create policy "sale_formats_tenant_access"
on public.sale_formats for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "products_tenant_access" on public.products;
create policy "products_tenant_access"
on public.products for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "product_variants_tenant_access" on public.product_variants;
create policy "product_variants_tenant_access"
on public.product_variants for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "modifier_groups_tenant_access" on public.modifier_groups;
create policy "modifier_groups_tenant_access"
on public.modifier_groups for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "modifiers_tenant_access" on public.modifiers;
create policy "modifiers_tenant_access"
on public.modifiers for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "cash_sessions_tenant_access" on public.cash_sessions;
drop policy if exists "cash_sessions_select" on public.cash_sessions;
drop policy if exists "cash_sessions_insert" on public.cash_sessions;
drop policy if exists "cash_sessions_update" on public.cash_sessions;
drop policy if exists "cash_sessions_delete" on public.cash_sessions;
create policy "cash_sessions_select" on public.cash_sessions
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "cash_sessions_insert" on public.cash_sessions
for insert to authenticated
with check (
  public.user_has_tenant_access(tenant_id)
  and opened_by = (select auth.uid())
  and status = 'open'
  and closed_by is null
);
create policy "cash_sessions_update" on public.cash_sessions
for update to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));
create policy "cash_sessions_delete" on public.cash_sessions
for delete to authenticated
using (public.user_has_tenant_access(tenant_id));

drop policy if exists "tickets_tenant_access" on public.tickets;
drop policy if exists "tickets_select" on public.tickets;
drop policy if exists "tickets_insert" on public.tickets;
drop policy if exists "tickets_update" on public.tickets;
drop policy if exists "tickets_delete" on public.tickets;
create policy "tickets_select" on public.tickets
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "tickets_insert" on public.tickets
for insert to authenticated
with check (public.user_has_tenant_access(tenant_id) and user_id = (select auth.uid()));
create policy "tickets_update" on public.tickets
for update to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));
create policy "tickets_delete" on public.tickets
for delete to authenticated
using (public.user_has_tenant_access(tenant_id));

drop policy if exists "ticket_lines_tenant_access" on public.ticket_lines;
create policy "ticket_lines_tenant_access"
on public.ticket_lines for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "sales_tenant_access" on public.sales;
drop policy if exists "sales_select" on public.sales;
drop policy if exists "sales_insert" on public.sales;
drop policy if exists "sales_update" on public.sales;
drop policy if exists "sales_delete" on public.sales;
create policy "sales_select" on public.sales
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "sales_insert" on public.sales
for insert to authenticated
with check (public.user_has_tenant_access(tenant_id) and user_id = (select auth.uid()));
create policy "sales_update" on public.sales
for update to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));
create policy "sales_delete" on public.sales
for delete to authenticated
using (public.user_has_tenant_access(tenant_id));

drop policy if exists "sale_payments_tenant_access" on public.sale_payments;
create policy "sale_payments_tenant_access"
on public.sale_payments for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "offline_event_log_tenant_access" on public.offline_event_log;
create policy "offline_event_log_tenant_access"
on public.offline_event_log for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "product_images_public_read" on storage.objects;
-- El bucket es publico para descarga por URL. El SELECT de metadatos se limita
-- a miembros del tenant porque Storage lo necesita para upload/upsert.

drop policy if exists "product_images_tenant_select" on storage.objects;
create policy "product_images_tenant_select"
on storage.objects for select to authenticated
using (
  bucket_id = 'product-images'
  and public.user_has_tenant_access(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "product_images_tenant_insert" on storage.objects;
create policy "product_images_tenant_insert"
on storage.objects for insert
with check (
  bucket_id = 'product-images'
  and public.user_has_tenant_access(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "product_images_tenant_update" on storage.objects;
create policy "product_images_tenant_update"
on storage.objects for update
using (
  bucket_id = 'product-images'
  and public.user_has_tenant_access(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'product-images'
  and public.user_has_tenant_access(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "product_images_tenant_delete" on storage.objects;
create policy "product_images_tenant_delete"
on storage.objects for delete
using (
  bucket_id = 'product-images'
  and public.user_has_tenant_access(((storage.foldername(name))[1])::uuid)
);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tenants',
    'profiles',
    'tenant_memberships',
    'venues',
    'devices',
    'categories',
    'sale_formats',
    'products',
    'product_variants',
    'modifier_groups',
    'modifiers',
    'cash_sessions',
    'tickets',
    'sales'
  ]
  loop
    execute format('drop trigger if exists set_%I_updated_at on public.%I', table_name, table_name);
    execute format(
      'create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      table_name,
      table_name
    );
  end loop;
end $$;

-- Datos de ejemplo para una discoteca. Ajusta el slug y aÃ±ade un usuario a tenant_memberships.
insert into public.tenants (id, name, slug)
values ('11111111-1111-1111-1111-111111111111', 'Demo Club', 'demo-club')
on conflict (slug) do nothing;

insert into public.venues (id, tenant_id, name, sort_order)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Sala principal', 1)
on conflict do nothing;

insert into public.categories (id, tenant_id, name, kind, icon, sort_order)
values
  ('33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', 'Ginebra', 'alcohol', 'alcohol', 1),
  ('33333333-3333-3333-3333-333333333332', '11111111-1111-1111-1111-111111111111', 'Ron', 'alcohol', 'alcohol', 2),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Mixers y refrescos', 'mixer', 'glass', 3),
  ('33333333-3333-3333-3333-333333333334', '11111111-1111-1111-1111-111111111111', 'Cervezas', 'beer_bottle', 'beer', 4),
  ('33333333-3333-3333-3333-333333333335', '11111111-1111-1111-1111-111111111111', 'Cocteles', 'cocktail', 'martini', 5)
on conflict do nothing;

insert into public.sale_formats (tenant_id, key, label, sort_order, is_active)
select tenants.id, defaults.key, defaults.label, defaults.sort_order, true
from public.tenants as tenants
cross join (
  values
    ('cubata', 'Cubata', 1),
    ('copa', 'Copa', 2),
    ('shot', 'Chupito', 3),
    ('beer_bottle', 'Botellin cerveza', 4),
    ('soft_bottle', 'Botellin refresco', 5),
    ('cocktail', 'Coctel', 6)
) as defaults(key, label, sort_order)
on conflict (tenant_id, key) do nothing;

insert into public.products (
  id,
  tenant_id,
  venue_id,
  category_id,
  name,
  description,
  kind,
  sale_formats,
  can_sell_standalone,
  can_use_as_mixer,
  sort_order
)
values
  ('44444444-4444-4444-4444-444444444441', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333331', 'Seagrams', 'Ginebra', 'alcohol', array['cubata', 'copa', 'shot'], true, false, 1),
  ('44444444-4444-4444-4444-444444444442', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333332', 'Barcelo', 'Ron', 'alcohol', array['cubata', 'copa', 'shot'], true, false, 1),
  ('44444444-4444-4444-4444-444444444443', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'Tonica', 'Botellin y mixer', 'mixer', array['soft_bottle'], true, true, 1),
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333334', 'Estrella Damm', 'Botellin de cerveza', 'beer_bottle', array['beer_bottle'], true, false, 1),
  ('44444444-4444-4444-4444-444444444445', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333335', 'Mojito', 'Coctel preparado', 'cocktail', array['cocktail'], true, false, 1)
on conflict do nothing;

insert into public.product_variants (id, tenant_id, product_id, name, price_cents, is_default, sort_order)
values
  ('55555555-5555-5555-5555-555555555551', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444441', 'Cubata', 900, true, 1),
  ('55555555-5555-5555-5555-555555555552', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444441', 'Copa', 700, false, 2),
  ('55555555-5555-5555-5555-555555555553', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444441', 'Chupito', 350, false, 3),
  ('55555555-5555-5555-5555-555555555554', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444442', 'Cubata', 850, true, 1),
  ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444442', 'Copa', 650, false, 2),
  ('55555555-5555-5555-5555-555555555556', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444443', 'Botellin', 300, true, 1),
  ('55555555-5555-5555-5555-555555555557', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'Botellin', 350, true, 1),
  ('55555555-5555-5555-5555-555555555558', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444445', 'Coctel', 900, true, 1)
on conflict do nothing;

-- Vincula un usuario ya creado en Supabase Auth:
-- insert into public.tenant_memberships (tenant_id, user_id, role)
-- values ('11111111-1111-1111-1111-111111111111', '<AUTH_USER_UUID>', 'owner')
-- on conflict (tenant_id, user_id) do update set role = excluded.role, is_active = true;

-- FIN: schema.sql

-- ============================================================================
-- INICIO: pos-security-hardening-migration.sql
-- ============================================================================
-- Validacion de actor, ventas atomicas y proteccion de cajas cerradas.
-- Ejecutar despues de schema.sql y de las migraciones de producto.
-- Si se usan cuentas separadas por dispositivo, ejecutar a continuacion
-- device-user-access-migration.sql para aplicar las politicas definitivas.

begin;

create or replace function public.validate_cash_session_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if current_user_id is not null and new.opened_by <> current_user_id then
      raise exception 'El usuario de apertura no coincide con auth.uid()' using errcode = '42501';
    end if;

    if new.status <> 'open' or new.closed_by is not null or new.closed_at is not null then
      raise exception 'Una caja nueva debe crearse abierta y sin datos de cierre';
    end if;

    return new;
  end if;

  if new.tenant_id is distinct from old.tenant_id
    or new.venue_id is distinct from old.venue_id
    or new.device_id is distinct from old.device_id
    or new.opened_by is distinct from old.opened_by
    or new.opened_at is distinct from old.opened_at then
    raise exception 'No se puede cambiar la identidad de una caja existente';
  end if;

  if old.status = 'closed' and new.status is distinct from old.status then
    raise exception 'Una caja cerrada no se puede volver a abrir';
  end if;

  if old.status = 'open' and new.status = 'closed' then
    if current_user_id is not null and new.closed_by <> current_user_id then
      raise exception 'El usuario de cierre no coincide con auth.uid()' using errcode = '42501';
    end if;

    if new.closed_by is null or new.closed_at is null then
      raise exception 'El cierre de caja requiere usuario y fecha';
    end if;
  elsif new.status = 'open' and (new.closed_by is not null or new.closed_at is not null) then
    raise exception 'Una caja abierta no puede contener datos de cierre';
  end if;

  return new;
end;
$$;

create or replace function public.validate_transaction_actor_and_cash()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  session_row public.cash_sessions%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'No se puede cambiar el usuario de una transaccion';
    end if;

    if new.tenant_id is distinct from old.tenant_id
      or new.cash_session_id is distinct from old.cash_session_id
      or new.venue_id is distinct from old.venue_id
      or new.device_id is distinct from old.device_id then
      raise exception 'No se puede cambiar la caja de una transaccion';
    end if;

    return new;
  end if;

  if current_user_id is not null and new.user_id <> current_user_id then
    raise exception 'El usuario de la transaccion no coincide con auth.uid()' using errcode = '42501';
  end if;

  select *
  into session_row
  from public.cash_sessions
  where id = new.cash_session_id
  for share;

  if not found then
    raise exception 'La caja indicada no existe';
  end if;

  if session_row.status <> 'open' then
    raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000';
  end if;

  if session_row.tenant_id <> new.tenant_id
    or session_row.venue_id <> new.venue_id
    or session_row.device_id <> new.device_id then
    raise exception 'La venta no coincide con el negocio, local o dispositivo de la caja';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_cash_session_write on public.cash_sessions;
create trigger validate_cash_session_write
before insert or update on public.cash_sessions
for each row execute function public.validate_cash_session_write();

drop trigger if exists validate_ticket_actor_and_cash on public.tickets;
create trigger validate_ticket_actor_and_cash
before insert or update on public.tickets
for each row execute function public.validate_transaction_actor_and_cash();

drop trigger if exists validate_sale_actor_and_cash on public.sales;
create trigger validate_sale_actor_and_cash
before insert or update on public.sales
for each row execute function public.validate_transaction_actor_and_cash();

create or replace function public.sync_sale_created(p_event_id uuid, p_payload jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  ticket_payload jsonb := p_payload -> 'ticket';
  sale_payload jsonb := p_payload -> 'sale';
  payment_payload jsonb := p_payload -> 'payment';
  tenant_id_value uuid;
  ticket_id_value uuid;
  sale_id_value uuid;
  cash_session_id_value uuid;
  venue_id_value uuid;
  device_id_value uuid;
  ticket_user_id_value uuid;
  sale_user_id_value uuid;
  total_cents_value bigint;
  payment_amount_value bigint;
  received_cents_value bigint;
  change_cents_value bigint;
  payment_method_value text;
  line_count integer;
  lines_total bigint;
  lines_are_valid boolean;
  session_row public.cash_sessions%rowtype;
  logged_event_id uuid;
begin
  if current_user_id is null then
    raise exception 'Se requiere un usuario autenticado' using errcode = '42501';
  end if;

  if p_event_id is null or jsonb_typeof(p_payload -> 'lines') is distinct from 'array' then
    raise exception 'El evento de venta no tiene un formato valido';
  end if;

  tenant_id_value := (ticket_payload ->> 'tenantId')::uuid;
  ticket_id_value := (ticket_payload ->> 'id')::uuid;
  sale_id_value := (sale_payload ->> 'id')::uuid;
  cash_session_id_value := (ticket_payload ->> 'cashSessionId')::uuid;
  venue_id_value := (ticket_payload ->> 'venueId')::uuid;
  device_id_value := (ticket_payload ->> 'deviceId')::uuid;
  ticket_user_id_value := (ticket_payload ->> 'userId')::uuid;
  sale_user_id_value := (sale_payload ->> 'userId')::uuid;
  total_cents_value := (ticket_payload ->> 'totalCents')::bigint;
  payment_amount_value := (payment_payload ->> 'amountCents')::bigint;
  received_cents_value := nullif(payment_payload ->> 'receivedCents', '')::bigint;
  change_cents_value := (payment_payload ->> 'changeCents')::bigint;
  payment_method_value := sale_payload ->> 'paymentMethod';

  if ticket_user_id_value <> current_user_id or sale_user_id_value <> current_user_id then
    raise exception 'El userId enviado no coincide con auth.uid()' using errcode = '42501';
  end if;

  if not public.user_has_tenant_access(tenant_id_value) then
    raise exception 'El usuario no tiene acceso al negocio' using errcode = '42501';
  end if;

  if (sale_payload ->> 'tenantId')::uuid <> tenant_id_value
    or (payment_payload ->> 'tenantId')::uuid <> tenant_id_value
    or (sale_payload ->> 'ticketId')::uuid <> ticket_id_value
    or (sale_payload ->> 'cashSessionId')::uuid <> cash_session_id_value
    or (sale_payload ->> 'venueId')::uuid <> venue_id_value
    or (sale_payload ->> 'deviceId')::uuid <> device_id_value
    or (payment_payload ->> 'saleId')::uuid <> sale_id_value
    or payment_payload ->> 'method' <> payment_method_value then
    raise exception 'Los datos relacionados de la venta no coinciden';
  end if;

  if exists (
    select 1
    from public.offline_event_log
    where tenant_id = tenant_id_value
      and client_event_id = p_event_id
  ) then
    return;
  end if;

  select
    count(*),
    coalesce(sum((line ->> 'lineTotalCents')::bigint), 0),
    coalesce(bool_and(
      (line ->> 'tenantId')::uuid = tenant_id_value
      and (line ->> 'ticketId')::uuid = ticket_id_value
      and (line ->> 'quantity')::integer > 0
      and (line ->> 'unitPriceCents')::bigint >= 0
      and (line ->> 'lineTotalCents')::bigint =
        (line ->> 'unitPriceCents')::bigint * (line ->> 'quantity')::integer
    ), false)
  into line_count, lines_total, lines_are_valid
  from jsonb_array_elements(p_payload -> 'lines') as line;

  if line_count = 0 or not lines_are_valid then
    raise exception 'Las lineas de la venta no son validas';
  end if;

  if total_cents_value <> lines_total
    or (sale_payload ->> 'totalCents')::bigint <> lines_total
    or payment_amount_value <> lines_total then
    raise exception 'Los totales de ticket, venta, lineas y pago no coinciden';
  end if;

  if payment_method_value = 'cash' then
    if received_cents_value is null
      or received_cents_value < total_cents_value
      or change_cents_value <> received_cents_value - total_cents_value then
      raise exception 'Los importes del pago en efectivo no son validos';
    end if;
  elsif change_cents_value <> 0 then
    raise exception 'Un pago no efectivo no puede tener cambio';
  end if;

  select *
  into session_row
  from public.cash_sessions
  where id = cash_session_id_value
  for update;

  if not found then
    raise exception 'La caja indicada no existe';
  end if;

  if session_row.status <> 'open' then
    raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000';
  end if;

  if session_row.tenant_id <> tenant_id_value
    or session_row.venue_id <> venue_id_value
    or session_row.device_id <> device_id_value then
    raise exception 'La venta no coincide con el negocio, local o dispositivo de la caja';
  end if;

  insert into public.offline_event_log (tenant_id, event_kind, client_event_id, payload)
  values (tenant_id_value, 'sale_created', p_event_id, p_payload)
  on conflict (tenant_id, client_event_id) do nothing
  returning id into logged_event_id;

  if logged_event_id is null then
    return;
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, venue_id, device_id, user_id, status,
    subtotal_cents, total_cents, local_created_at, created_at
  ) values (
    ticket_id_value,
    tenant_id_value,
    cash_session_id_value,
    venue_id_value,
    device_id_value,
    current_user_id,
    'paid',
    total_cents_value,
    total_cents_value,
    (ticket_payload ->> 'createdAt')::timestamptz,
    (ticket_payload ->> 'createdAt')::timestamptz
  )
  on conflict (id) do update set
    status = excluded.status,
    subtotal_cents = excluded.subtotal_cents,
    total_cents = excluded.total_cents;

  insert into public.ticket_lines (
    id, ticket_id, tenant_id, product_id, variant_id, product_name, variant_name,
    quantity, unit_price_cents, line_total_cents, modifiers
  )
  select
    (line ->> 'id')::uuid,
    ticket_id_value,
    tenant_id_value,
    (line ->> 'productId')::uuid,
    (line ->> 'variantId')::uuid,
    line ->> 'productName',
    line ->> 'variantName',
    (line ->> 'quantity')::integer,
    (line ->> 'unitPriceCents')::integer,
    (line ->> 'lineTotalCents')::integer,
    coalesce(line -> 'modifiers', '[]'::jsonb)
  from jsonb_array_elements(p_payload -> 'lines') as line
  on conflict (id) do update set
    product_id = excluded.product_id,
    variant_id = excluded.variant_id,
    product_name = excluded.product_name,
    variant_name = excluded.variant_name,
    quantity = excluded.quantity,
    unit_price_cents = excluded.unit_price_cents,
    line_total_cents = excluded.line_total_cents,
    modifiers = excluded.modifiers;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, venue_id, device_id, user_id,
    total_cents, payment_method, local_created_at, created_at
  ) values (
    sale_id_value,
    tenant_id_value,
    ticket_id_value,
    cash_session_id_value,
    venue_id_value,
    device_id_value,
    current_user_id,
    total_cents_value,
    payment_method_value,
    (sale_payload ->> 'createdAt')::timestamptz,
    (sale_payload ->> 'createdAt')::timestamptz
  )
  on conflict (id) do update set
    total_cents = excluded.total_cents,
    payment_method = excluded.payment_method;

  insert into public.sale_payments (
    id, sale_id, tenant_id, method, amount_cents, received_cents, change_cents
  ) values (
    (payment_payload ->> 'id')::uuid,
    sale_id_value,
    tenant_id_value,
    payment_method_value,
    payment_amount_value,
    received_cents_value,
    change_cents_value
  )
  on conflict (id) do update set
    method = excluded.method,
    amount_cents = excluded.amount_cents,
    received_cents = excluded.received_cents,
    change_cents = excluded.change_cents;
end;
$$;

revoke all on function public.validate_cash_session_write() from public;
revoke all on function public.validate_transaction_actor_and_cash() from public;
revoke all on function public.sync_sale_created(uuid, jsonb) from public;
grant execute on function public.sync_sale_created(uuid, jsonb) to authenticated;

drop policy if exists "cash_sessions_tenant_access" on public.cash_sessions;
drop policy if exists "cash_sessions_select" on public.cash_sessions;
drop policy if exists "cash_sessions_insert" on public.cash_sessions;
drop policy if exists "cash_sessions_update" on public.cash_sessions;
drop policy if exists "cash_sessions_delete" on public.cash_sessions;
create policy "cash_sessions_select" on public.cash_sessions
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "cash_sessions_insert" on public.cash_sessions
for insert to authenticated
with check (
  public.user_has_tenant_access(tenant_id)
  and opened_by = (select auth.uid())
  and status = 'open'
  and closed_by is null
);
create policy "cash_sessions_update" on public.cash_sessions
for update to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));
create policy "cash_sessions_delete" on public.cash_sessions
for delete to authenticated
using (public.user_has_tenant_access(tenant_id));

drop policy if exists "tickets_tenant_access" on public.tickets;
drop policy if exists "tickets_select" on public.tickets;
drop policy if exists "tickets_insert" on public.tickets;
drop policy if exists "tickets_update" on public.tickets;
drop policy if exists "tickets_delete" on public.tickets;
create policy "tickets_select" on public.tickets
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "tickets_insert" on public.tickets
for insert to authenticated
with check (public.user_has_tenant_access(tenant_id) and user_id = (select auth.uid()));
create policy "tickets_update" on public.tickets
for update to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));
create policy "tickets_delete" on public.tickets
for delete to authenticated
using (public.user_has_tenant_access(tenant_id));

drop policy if exists "sales_tenant_access" on public.sales;
drop policy if exists "sales_select" on public.sales;
drop policy if exists "sales_insert" on public.sales;
drop policy if exists "sales_update" on public.sales;
drop policy if exists "sales_delete" on public.sales;
create policy "sales_select" on public.sales
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "sales_insert" on public.sales
for insert to authenticated
with check (public.user_has_tenant_access(tenant_id) and user_id = (select auth.uid()));
create policy "sales_update" on public.sales
for update to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));
create policy "sales_delete" on public.sales
for delete to authenticated
using (public.user_has_tenant_access(tenant_id));

-- El bucket sigue siendo publico para getPublicUrl, pero no se permite listar objetos anonimamente.
drop policy if exists "product_images_public_read" on storage.objects;

commit;

-- FIN: pos-security-hardening-migration.sql

-- ============================================================================
-- INICIO: device-user-access-migration.sql
-- ============================================================================
-- Accesos separados para administracion, locales y dispositivos TPV.
-- Ejecutar despues de pos-security-hardening-migration.sql.

begin;

create table if not exists public.device_user_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index if not exists device_user_assignments_user_idx
on public.device_user_assignments (user_id, tenant_id)
where is_active = true;

create unique index if not exists one_active_user_per_device
on public.device_user_assignments (tenant_id, device_id)
where is_active = true;

alter table public.products
add column if not exists catalog_by_venue boolean not null default false;

alter table public.products
add column if not exists venue_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_venue_id_fkey'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
    add constraint products_venue_id_fkey
    foreign key (venue_id) references public.venues(id) on delete restrict;
  end if;
end $$;

create table if not exists public.product_venue_settings (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, venue_id)
);

create index if not exists product_venue_settings_tenant_venue_idx
on public.product_venue_settings (tenant_id, venue_id, product_id);

-- Convierte el catalogo compartido anterior en productos independientes por local.
do $$
declare
  source_product public.products%rowtype;
  target_venue_ids uuid[];
  target_venue_id uuid;
  cloned_product_id uuid;
  source_group record;
  cloned_group_id uuid;
begin
  for source_product in
    select * from public.products where venue_id is null
  loop
    if source_product.catalog_by_venue then
      select array_agg(pvs.venue_id order by v.sort_order, v.name)
      into target_venue_ids
      from public.product_venue_settings pvs
      join public.venues v on v.id = pvs.venue_id
      where pvs.product_id = source_product.id
        and pvs.tenant_id = source_product.tenant_id
        and pvs.is_available = true;
    else
      select array_agg(v.id order by v.sort_order, v.name)
      into target_venue_ids
      from public.venues v
      where v.tenant_id = source_product.tenant_id
        and v.is_active = true;
    end if;

    if coalesce(array_length(target_venue_ids, 1), 0) = 0 then
      select array[v.id]
      into target_venue_ids
      from public.venues v
      where v.tenant_id = source_product.tenant_id
      order by v.sort_order, v.name
      limit 1;

      update public.products
      set is_active = false
      where id = source_product.id;
    end if;

    if coalesce(array_length(target_venue_ids, 1), 0) = 0 then
      raise exception 'El negocio % necesita al menos un local antes de separar su catalogo', source_product.tenant_id;
    end if;

    update public.products
    set venue_id = target_venue_ids[1], catalog_by_venue = false
    where id = source_product.id;

    foreach target_venue_id in array coalesce(target_venue_ids[2:], array[]::uuid[])
    loop
      insert into public.products (
        tenant_id, venue_id, category_id, name, description, image_path, kind,
        sale_formats, can_sell_standalone, can_use_as_mixer, is_featured,
        mixer_supplement_cents, is_active, sort_order, catalog_by_venue
      ) values (
        source_product.tenant_id, target_venue_id, source_product.category_id,
        source_product.name, source_product.description, source_product.image_path,
        source_product.kind, source_product.sale_formats, source_product.can_sell_standalone,
        source_product.can_use_as_mixer, source_product.is_featured,
        source_product.mixer_supplement_cents, source_product.is_active,
        source_product.sort_order, false
      ) returning id into cloned_product_id;

      insert into public.product_variants (
        tenant_id, product_id, name, price_cents, sku, is_default, sort_order
      )
      select tenant_id, cloned_product_id, name, price_cents, sku, is_default, sort_order
      from public.product_variants
      where product_id = source_product.id;

      for source_group in
        select * from public.modifier_groups where product_id = source_product.id
      loop
        insert into public.modifier_groups (
          tenant_id, product_id, name, min_select, max_select, sort_order
        ) values (
          source_group.tenant_id, cloned_product_id, source_group.name,
          source_group.min_select, source_group.max_select, source_group.sort_order
        ) returning id into cloned_group_id;

        insert into public.modifiers (tenant_id, group_id, name, price_cents, sort_order)
        select tenant_id, cloned_group_id, name, price_cents, sort_order
        from public.modifiers
        where group_id = source_group.id;
      end loop;
    end loop;
  end loop;
end $$;

alter table public.products
alter column venue_id set not null;

create or replace function public.validate_product_venue()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.venues v
    where v.id = new.venue_id and v.tenant_id = new.tenant_id
  ) then
    raise exception 'El producto debe pertenecer a un local del mismo negocio';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_product_venue on public.products;
create trigger validate_product_venue
before insert or update of tenant_id, venue_id on public.products
for each row execute function public.validate_product_venue();

revoke all on function public.validate_product_venue() from public;

create or replace function public.validate_ticket_line_product_venue()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.product_id is not null and not exists (
    select 1
    from public.tickets t
    join public.products p
      on p.id = new.product_id
     and p.tenant_id = t.tenant_id
     and p.venue_id = t.venue_id
    where t.id = new.ticket_id
      and t.tenant_id = new.tenant_id
  ) then
    raise exception 'El producto de la linea no pertenece al local del ticket';
  end if;

  if new.variant_id is not null and not exists (
    select 1
    from public.product_variants pv
    where pv.id = new.variant_id
      and pv.product_id = new.product_id
      and pv.tenant_id = new.tenant_id
  ) then
    raise exception 'La variante no pertenece al producto de la linea';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_ticket_line_product_venue on public.ticket_lines;
create trigger validate_ticket_line_product_venue
before insert or update of tenant_id, ticket_id, product_id, variant_id on public.ticket_lines
for each row execute function public.validate_ticket_line_product_venue();

revoke all on function public.validate_ticket_line_product_venue() from public;

create index if not exists products_tenant_venue_idx
on public.products (tenant_id, venue_id, sort_order);

create table if not exists public.user_login_leases (
  user_id uuid primary key references auth.users(id) on delete cascade,
  auth_session_id text not null,
  client_id uuid not null,
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes')
);

create index if not exists user_login_leases_expiry_idx
on public.user_login_leases (expires_at);

alter table public.device_user_assignments enable row level security;
alter table public.product_venue_settings enable row level security;
alter table public.user_login_leases enable row level security;

create or replace function public.validate_product_venue_setting()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.products p
    where p.id = new.product_id and p.tenant_id = new.tenant_id
  ) or not exists (
    select 1 from public.venues v
    where v.id = new.venue_id and v.tenant_id = new.tenant_id
  ) then
    raise exception 'El producto y el local deben pertenecer al mismo negocio';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_product_venue_setting on public.product_venue_settings;
create trigger validate_product_venue_setting
before insert or update on public.product_venue_settings
for each row execute function public.validate_product_venue_setting();

revoke all on function public.validate_product_venue_setting() from public;

create or replace function public.claim_user_login(p_client_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
  claimed boolean := false;
begin
  if current_user_id is null or current_session_id is null or p_client_id is null then
    return false;
  end if;

  insert into public.user_login_leases (
    user_id, auth_session_id, client_id, heartbeat_at, expires_at
  ) values (
    current_user_id, current_session_id, p_client_id, now(), now() + interval '30 minutes'
  )
  on conflict (user_id) do update set
    auth_session_id = excluded.auth_session_id,
    client_id = excluded.client_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at
  where (
    public.user_login_leases.auth_session_id = excluded.auth_session_id
    and public.user_login_leases.client_id = excluded.client_id
  ) or public.user_login_leases.expires_at <= now()
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

create or replace function public.heartbeat_user_login(p_client_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
  refreshed boolean := false;
begin
  update public.user_login_leases
  set heartbeat_at = now(),
      expires_at = now() + interval '30 minutes'
  where user_id = current_user_id
    and auth_session_id = current_session_id
    and client_id = p_client_id
    and expires_at > now()
  returning true into refreshed;

  return coalesce(refreshed, false);
end;
$$;

create or replace function public.force_claim_user_login(p_client_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
begin
  if current_user_id is null or current_session_id is null or p_client_id is null then
    return false;
  end if;

  insert into public.user_login_leases (
    user_id, auth_session_id, client_id, heartbeat_at, expires_at
  ) values (
    current_user_id, current_session_id, p_client_id, now(), now() + interval '30 minutes'
  )
  on conflict (user_id) do update set
    auth_session_id = excluded.auth_session_id,
    client_id = excluded.client_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at;

  return true;
end;
$$;

create or replace function public.check_user_login(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_login_leases
    where user_id = auth.uid()
      and auth_session_id = (auth.jwt() ->> 'session_id')
      and client_id = p_client_id
      and expires_at > now()
  );
$$;

create or replace function public.release_user_login(p_client_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.user_login_leases
  where user_id = auth.uid()
    and auth_session_id = (auth.jwt() ->> 'session_id')
    and client_id = p_client_id;
$$;

revoke all on function public.claim_user_login(uuid) from public;
revoke all on function public.heartbeat_user_login(uuid) from public;
revoke all on function public.force_claim_user_login(uuid) from public;
revoke all on function public.check_user_login(uuid) from public;
revoke all on function public.release_user_login(uuid) from public;
grant execute on function public.claim_user_login(uuid) to authenticated;
grant execute on function public.heartbeat_user_login(uuid) to authenticated;
grant execute on function public.force_claim_user_login(uuid) to authenticated;
grant execute on function public.check_user_login(uuid) to authenticated;
grant execute on function public.release_user_login(uuid) to authenticated;

create or replace function public.user_is_tenant_admin(target_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'admin')
      and tm.is_active = true
  );
$$;

create or replace function public.user_has_device_access(
  target_tenant uuid,
  target_venue uuid,
  target_device uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.device_user_assignments dua
    join public.tenant_memberships tm
      on tm.tenant_id = dua.tenant_id
     and tm.user_id = dua.user_id
    where dua.tenant_id = target_tenant
      and dua.venue_id = target_venue
      and dua.device_id = target_device
      and dua.user_id = auth.uid()
      and dua.is_active = true
      and tm.is_active = true
      and tm.role = 'cashier'
  );
$$;

create or replace function public.user_can_view_device(
  target_tenant uuid,
  target_venue uuid,
  target_device uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.user_is_tenant_admin(target_tenant)
    or public.user_has_device_access(target_tenant, target_venue, target_device);
$$;

create or replace function public.user_has_venue_access(target_tenant uuid, target_venue uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.device_user_assignments dua
    join public.tenant_memberships tm
      on tm.tenant_id = dua.tenant_id and tm.user_id = dua.user_id
    where dua.tenant_id = target_tenant
      and dua.venue_id = target_venue
      and dua.user_id = auth.uid()
      and dua.is_active = true
      and tm.is_active = true
      and tm.role = 'cashier'
  );
$$;

create or replace function public.validate_device_user_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.devices d
    where d.id = new.device_id
      and d.tenant_id = new.tenant_id
      and d.venue_id = new.venue_id
  ) then
    raise exception 'El dispositivo no pertenece al negocio y local indicados';
  end if;

  if not exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = new.tenant_id
      and tm.user_id = new.user_id
      and tm.role = 'cashier'
  ) then
    raise exception 'La asignacion requiere una membresia con rol cashier';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_device_user_assignment on public.device_user_assignments;
create trigger validate_device_user_assignment
before insert or update on public.device_user_assignments
for each row execute function public.validate_device_user_assignment();

drop trigger if exists set_device_user_assignments_updated_at on public.device_user_assignments;
create trigger set_device_user_assignments_updated_at
before update on public.device_user_assignments
for each row execute function public.set_updated_at();

revoke all on function public.user_is_tenant_admin(uuid) from public;
revoke all on function public.user_has_device_access(uuid, uuid, uuid) from public;
revoke all on function public.user_can_view_device(uuid, uuid, uuid) from public;
revoke all on function public.user_has_venue_access(uuid, uuid) from public;
revoke all on function public.validate_device_user_assignment() from public;
grant execute on function public.user_is_tenant_admin(uuid) to authenticated;
grant execute on function public.user_has_device_access(uuid, uuid, uuid) to authenticated;
grant execute on function public.user_can_view_device(uuid, uuid, uuid) to authenticated;
grant execute on function public.user_has_venue_access(uuid, uuid) to authenticated;

drop policy if exists "device_assignments_select" on public.device_user_assignments;
drop policy if exists "device_assignments_admin_manage" on public.device_user_assignments;
create policy "device_assignments_select" on public.device_user_assignments
for select to authenticated
using (user_id = (select auth.uid()) or public.user_is_tenant_admin(tenant_id));
create policy "device_assignments_admin_manage" on public.device_user_assignments
for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

-- Los cajeros solo ven su local/dispositivo; administracion gestiona toda la estructura.
drop policy if exists "venues_tenant_access" on public.venues;
drop policy if exists "venues_select" on public.venues;
drop policy if exists "venues_admin_manage" on public.venues;
create policy "venues_select" on public.venues
for select to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or exists (
    select 1 from public.device_user_assignments dua
    where dua.tenant_id = venues.tenant_id
      and dua.venue_id = venues.id
      and dua.user_id = (select auth.uid())
      and dua.is_active = true
  )
);
create policy "venues_admin_manage" on public.venues
for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "devices_tenant_access" on public.devices;
drop policy if exists "devices_select" on public.devices;
drop policy if exists "devices_admin_manage" on public.devices;
create policy "devices_select" on public.devices
for select to authenticated
using (public.user_can_view_device(tenant_id, venue_id, id));
create policy "devices_admin_manage" on public.devices
for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "product_venue_settings_select" on public.product_venue_settings;
drop policy if exists "product_venue_settings_admin_manage" on public.product_venue_settings;
create policy "product_venue_settings_select" on public.product_venue_settings
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "product_venue_settings_admin_manage" on public.product_venue_settings
for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop trigger if exists set_product_venue_settings_updated_at on public.product_venue_settings;
create trigger set_product_venue_settings_updated_at
before update on public.product_venue_settings
for each row execute function public.set_updated_at();

-- Catalogo legible para todos los miembros, modificable solo por administracion.
do $$
declare
  table_name text;
  old_policy text;
begin
  foreach table_name in array array[
    'categories', 'sale_formats'
  ]
  loop
    old_policy := table_name || '_tenant_access';
    execute format('drop policy if exists %I on public.%I', old_policy, table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_select', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_admin_manage', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.user_has_tenant_access(tenant_id))',
      table_name || '_select', table_name
    );
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id))',
      table_name || '_admin_manage', table_name
    );
  end loop;
end $$;

drop policy if exists "products_tenant_access" on public.products;
drop policy if exists "products_select" on public.products;
drop policy if exists "products_admin_manage" on public.products;
create policy "products_select" on public.products for select to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);
create policy "products_admin_manage" on public.products for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "product_variants_tenant_access" on public.product_variants;
drop policy if exists "product_variants_select" on public.product_variants;
drop policy if exists "product_variants_admin_manage" on public.product_variants;
create policy "product_variants_select" on public.product_variants for select to authenticated
using (exists (
  select 1 from public.products p
  where p.id = product_variants.product_id
    and (public.user_is_tenant_admin(p.tenant_id) or public.user_has_venue_access(p.tenant_id, p.venue_id))
));
create policy "product_variants_admin_manage" on public.product_variants for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "modifier_groups_tenant_access" on public.modifier_groups;
drop policy if exists "modifier_groups_select" on public.modifier_groups;
drop policy if exists "modifier_groups_admin_manage" on public.modifier_groups;
create policy "modifier_groups_select" on public.modifier_groups for select to authenticated
using (exists (
  select 1 from public.products p
  where p.id = modifier_groups.product_id
    and (public.user_is_tenant_admin(p.tenant_id) or public.user_has_venue_access(p.tenant_id, p.venue_id))
));
create policy "modifier_groups_admin_manage" on public.modifier_groups for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "modifiers_tenant_access" on public.modifiers;
drop policy if exists "modifiers_select" on public.modifiers;
drop policy if exists "modifiers_admin_manage" on public.modifiers;
create policy "modifiers_select" on public.modifiers for select to authenticated
using (exists (
  select 1
  from public.modifier_groups mg
  join public.products p on p.id = mg.product_id
  where mg.id = modifiers.group_id
    and (public.user_is_tenant_admin(p.tenant_id) or public.user_has_venue_access(p.tenant_id, p.venue_id))
));
create policy "modifiers_admin_manage" on public.modifiers for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

-- Cajas y ventas: administracion ve todo; solo el usuario asignado escribe en su dispositivo.
drop policy if exists "cash_sessions_select" on public.cash_sessions;
drop policy if exists "cash_sessions_insert" on public.cash_sessions;
drop policy if exists "cash_sessions_update" on public.cash_sessions;
drop policy if exists "cash_sessions_delete" on public.cash_sessions;
create policy "cash_sessions_select" on public.cash_sessions for select to authenticated
using (public.user_can_view_device(tenant_id, venue_id, device_id));
create policy "cash_sessions_insert" on public.cash_sessions for insert to authenticated
with check (
  public.user_has_device_access(tenant_id, venue_id, device_id)
  and opened_by = (select auth.uid())
  and status = 'open'
  and closed_by is null
);
create policy "cash_sessions_update" on public.cash_sessions for update to authenticated
using (public.user_has_device_access(tenant_id, venue_id, device_id))
with check (public.user_has_device_access(tenant_id, venue_id, device_id));

drop policy if exists "tickets_select" on public.tickets;
drop policy if exists "tickets_insert" on public.tickets;
drop policy if exists "tickets_update" on public.tickets;
drop policy if exists "tickets_delete" on public.tickets;
create policy "tickets_select" on public.tickets for select to authenticated
using (public.user_can_view_device(tenant_id, venue_id, device_id));
create policy "tickets_insert" on public.tickets for insert to authenticated
with check (
  public.user_has_device_access(tenant_id, venue_id, device_id)
  and user_id = (select auth.uid())
);
create policy "tickets_update" on public.tickets for update to authenticated
using (public.user_has_device_access(tenant_id, venue_id, device_id))
with check (public.user_has_device_access(tenant_id, venue_id, device_id));
create policy "tickets_delete" on public.tickets for delete to authenticated
using (public.user_has_device_access(tenant_id, venue_id, device_id));

drop policy if exists "sales_select" on public.sales;
drop policy if exists "sales_insert" on public.sales;
drop policy if exists "sales_update" on public.sales;
drop policy if exists "sales_delete" on public.sales;
create policy "sales_select" on public.sales for select to authenticated
using (public.user_can_view_device(tenant_id, venue_id, device_id));
create policy "sales_insert" on public.sales for insert to authenticated
with check (
  public.user_has_device_access(tenant_id, venue_id, device_id)
  and user_id = (select auth.uid())
);
create policy "sales_update" on public.sales for update to authenticated
using (public.user_has_device_access(tenant_id, venue_id, device_id))
with check (public.user_has_device_access(tenant_id, venue_id, device_id));
create policy "sales_delete" on public.sales for delete to authenticated
using (public.user_has_device_access(tenant_id, venue_id, device_id));

drop policy if exists "ticket_lines_tenant_access" on public.ticket_lines;
drop policy if exists "ticket_lines_select" on public.ticket_lines;
drop policy if exists "ticket_lines_write" on public.ticket_lines;
create policy "ticket_lines_select" on public.ticket_lines for select to authenticated
using (exists (
  select 1 from public.tickets t
  where t.id = ticket_lines.ticket_id
    and public.user_can_view_device(t.tenant_id, t.venue_id, t.device_id)
));
create policy "ticket_lines_write" on public.ticket_lines for all to authenticated
using (exists (
  select 1 from public.tickets t
  where t.id = ticket_lines.ticket_id
    and public.user_has_device_access(t.tenant_id, t.venue_id, t.device_id)
))
with check (exists (
  select 1 from public.tickets t
  where t.id = ticket_lines.ticket_id
    and public.user_has_device_access(t.tenant_id, t.venue_id, t.device_id)
));

drop policy if exists "sale_payments_tenant_access" on public.sale_payments;
drop policy if exists "sale_payments_select" on public.sale_payments;
drop policy if exists "sale_payments_write" on public.sale_payments;
create policy "sale_payments_select" on public.sale_payments for select to authenticated
using (exists (
  select 1 from public.sales s
  where s.id = sale_payments.sale_id
    and public.user_can_view_device(s.tenant_id, s.venue_id, s.device_id)
));
create policy "sale_payments_write" on public.sale_payments for all to authenticated
using (exists (
  select 1 from public.sales s
  where s.id = sale_payments.sale_id
    and public.user_has_device_access(s.tenant_id, s.venue_id, s.device_id)
))
with check (exists (
  select 1 from public.sales s
  where s.id = sale_payments.sale_id
    and public.user_has_device_access(s.tenant_id, s.venue_id, s.device_id)
));

-- El log offline contiene payloads de venta; se limita al dispositivo asignado.
create or replace function public.user_can_access_offline_event(
  target_tenant uuid,
  event_kind_value text,
  event_payload jsonb,
  allow_admin boolean default true
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  event_device uuid;
  event_venue uuid;
  related_sale public.sales%rowtype;
  related_session public.cash_sessions%rowtype;
begin
  if allow_admin and public.user_is_tenant_admin(target_tenant) then
    return true;
  end if;

  if event_kind_value = 'sale_created' then
    event_device := (event_payload -> 'ticket' ->> 'deviceId')::uuid;
    event_venue := (event_payload -> 'ticket' ->> 'venueId')::uuid;
  elsif event_kind_value = 'cash_opened' then
    event_device := (event_payload -> 'session' ->> 'deviceId')::uuid;
    event_venue := (event_payload -> 'session' ->> 'venueId')::uuid;
  elsif event_kind_value = 'cash_closed' then
    select * into related_session from public.cash_sessions
    where id = (event_payload ->> 'sessionId')::uuid;
    event_device := related_session.device_id;
    event_venue := related_session.venue_id;
  elsif event_kind_value in ('sale_payment_changed', 'sale_voided') then
    select * into related_sale from public.sales
    where id = (event_payload ->> 'saleId')::uuid;
    event_device := related_sale.device_id;
    event_venue := related_sale.venue_id;
  end if;

  return event_device is not null
    and public.user_has_device_access(target_tenant, event_venue, event_device);
exception when others then
  return false;
end;
$$;

revoke all on function public.user_can_access_offline_event(uuid, text, jsonb, boolean) from public;
grant execute on function public.user_can_access_offline_event(uuid, text, jsonb, boolean) to authenticated;

drop policy if exists "offline_event_log_tenant_access" on public.offline_event_log;
drop policy if exists "offline_event_log_select" on public.offline_event_log;
drop policy if exists "offline_event_log_insert" on public.offline_event_log;
create policy "offline_event_log_select" on public.offline_event_log for select to authenticated
using (public.user_can_access_offline_event(tenant_id, event_kind, payload, true));
create policy "offline_event_log_insert" on public.offline_event_log for insert to authenticated
with check (public.user_can_access_offline_event(tenant_id, event_kind, payload, false));

-- Las imagenes del catalogo solo pueden modificarlas owner/admin.
drop policy if exists "product_images_tenant_select" on storage.objects;
drop policy if exists "product_images_tenant_insert" on storage.objects;
drop policy if exists "product_images_tenant_update" on storage.objects;
drop policy if exists "product_images_tenant_delete" on storage.objects;
create policy "product_images_tenant_select" on storage.objects for select to authenticated
using (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);
create policy "product_images_tenant_insert" on storage.objects for insert to authenticated
with check (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);
create policy "product_images_tenant_update" on storage.objects for update to authenticated
using (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);
create policy "product_images_tenant_delete" on storage.objects for delete to authenticated
using (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);

-- La disponibilidad compartida queda sustituida por products.venue_id.
drop table if exists public.product_venue_settings;
alter table public.products drop column if exists catalog_by_venue;
drop function if exists public.validate_product_venue_setting();

commit;

-- FIN: device-user-access-migration.sql

-- ============================================================================
-- INICIO: superadmin-migration.sql
-- ============================================================================
-- Administracion global de tenants y sus usuarios owner.
-- La cuenta Auth inicial debe crearse antes en Supabase Authentication.

begin;

alter table public.profiles
add column if not exists is_superadmin boolean not null default false;

create index if not exists profiles_superadmin_idx
on public.profiles (id)
where is_superadmin = true;

create or replace function public.user_is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_superadmin = true
  );
$$;

revoke all on function public.user_is_superadmin() from public;
grant execute on function public.user_is_superadmin() to authenticated;

-- Impide que un usuario autenticado modifique su propio indicador global.
-- Los perfiles se crean y actualizan desde la Edge Function con service_role.
drop policy if exists "profiles_self_upsert" on public.profiles;

commit;

-- ACTIVAR LA PRIMERA CUENTA SUPERADMIN
-- 1. Crea el usuario y su contrasena en Authentication > Users.
-- 2. Sustituye el email y ejecuta solamente este bloque:
--
-- insert into public.profiles (id, full_name, is_superadmin)
-- select id, coalesce(raw_user_meta_data ->> 'full_name', email), true
-- from auth.users
-- where lower(email) = lower('superadmin@tu-dominio.com')
-- on conflict (id) do update
-- set full_name = excluded.full_name,
--     is_superadmin = true;

-- FIN: superadmin-migration.sql

-- ============================================================================
-- INICIO: catalog-import-storage-policy-migration.sql
-- ============================================================================
-- Permite que los administradores sobrescriban imagenes durante la importacion
-- ZIP. Supabase Storage requiere SELECT ademas de INSERT y UPDATE para upsert.

drop policy if exists "product_images_tenant_select" on storage.objects;
create policy "product_images_tenant_select"
on storage.objects for select to authenticated
using (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);

-- FIN: catalog-import-storage-policy-migration.sql

-- ============================================================================
-- BOOTSTRAP OPCIONAL: setup-tenant.sql (DESACTIVADO)
-- Para usarlo: crea primero el usuario de Authentication, ajusta sus cuatro
-- variables iniciales y quita el prefijo "-- " de este bloque.
-- ============================================================================
-- -- Bootstrap de un negocio real para poder iniciar sesion en el TPV.
-- -- Ejecutar en Supabase SQL Editor despues de crear el usuario en Authentication.
-- -- Ajusta estos valores si cambian el slug, email o nombre del local.
-- 
-- do $$
-- declare
--   v_tenant_name text := 'Mess Gold';
--   v_tenant_slug text := 'mess_gold';
--   v_user_email text := 'admin@messigualada.com';
--   v_venue_name text := 'Sala principal';
-- 
--   v_tenant_id uuid;
--   v_user_id uuid;
--   v_venue_id uuid;
--   v_category_beer uuid;
--   v_category_cocktail uuid;
--   v_category_gin uuid;
--   v_category_mixer uuid;
--   v_category_rum uuid;
--   v_category_whisky uuid;
--   v_product_id uuid;
-- begin
--   select id
--   into v_user_id
--   from auth.users
--   where lower(email) = lower(v_user_email)
--   limit 1;
-- 
--   if v_user_id is null then
--     raise exception 'No existe un usuario en Supabase Auth con email %', v_user_email;
--   end if;
-- 
--   insert into public.tenants (name, slug)
--   values (v_tenant_name, v_tenant_slug)
--   on conflict (slug) do update
--   set name = excluded.name
--   returning id into v_tenant_id;
-- 
--   insert into public.tenant_memberships (tenant_id, user_id, role, is_active)
--   values (v_tenant_id, v_user_id, 'owner', true)
--   on conflict (tenant_id, user_id) do update
--   set role = excluded.role,
--       is_active = true;
-- 
--   select id
--   into v_venue_id
--   from public.venues
--   where tenant_id = v_tenant_id
--     and name = v_venue_name
--   limit 1;
-- 
--   if v_venue_id is null then
--     insert into public.venues (tenant_id, name, sort_order, is_active)
--     values (v_tenant_id, v_venue_name, 1, true)
--     returning id into v_venue_id;
--   else
--     update public.venues
--     set is_active = true,
--         sort_order = 1
--     where id = v_venue_id;
--   end if;
-- 
--   insert into public.sale_formats (tenant_id, key, label, sort_order, is_active)
--   select v_tenant_id, format_key, format_label, format_sort_order, true
--   from (
--     values
--       ('cubata', 'Cubata', 1),
--       ('copa', 'Copa', 2),
--       ('shot', 'Chupito', 3),
--       ('beer_bottle', 'Botellin cerveza', 4),
--       ('soft_bottle', 'Botellin refresco', 5),
--       ('cocktail', 'Coctel', 6)
--   ) as default_formats(format_key, format_label, format_sort_order)
--   on conflict (tenant_id, key) do update
--   set label = excluded.label,
--       sort_order = excluded.sort_order,
--       is_active = true;
-- 
--   select id into v_category_gin from public.categories where tenant_id = v_tenant_id and name = 'Ginebra' limit 1;
--   if v_category_gin is null then
--     insert into public.categories (tenant_id, name, kind, icon, sort_order)
--     values (v_tenant_id, 'Ginebra', 'alcohol', 'alcohol', 10)
--     returning id into v_category_gin;
--   end if;
-- 
--   select id into v_category_rum from public.categories where tenant_id = v_tenant_id and name = 'Ron' limit 1;
--   if v_category_rum is null then
--     insert into public.categories (tenant_id, name, kind, icon, sort_order)
--     values (v_tenant_id, 'Ron', 'alcohol', 'alcohol', 20)
--     returning id into v_category_rum;
--   end if;
-- 
--   select id into v_category_whisky from public.categories where tenant_id = v_tenant_id and name = 'Whisky' limit 1;
--   if v_category_whisky is null then
--     insert into public.categories (tenant_id, name, kind, icon, sort_order)
--     values (v_tenant_id, 'Whisky', 'alcohol', 'alcohol', 30)
--     returning id into v_category_whisky;
--   end if;
-- 
--   select id into v_category_mixer from public.categories where tenant_id = v_tenant_id and name = 'Mixers y refrescos' limit 1;
--   if v_category_mixer is null then
--     insert into public.categories (tenant_id, name, kind, icon, sort_order)
--     values (v_tenant_id, 'Mixers y refrescos', 'mixer', 'glass', 40)
--     returning id into v_category_mixer;
--   end if;
-- 
--   select id into v_category_beer from public.categories where tenant_id = v_tenant_id and name = 'Cervezas' limit 1;
--   if v_category_beer is null then
--     insert into public.categories (tenant_id, name, kind, icon, sort_order)
--     values (v_tenant_id, 'Cervezas', 'beer_bottle', 'beer', 50)
--     returning id into v_category_beer;
--   end if;
-- 
--   select id into v_category_cocktail from public.categories where tenant_id = v_tenant_id and name = 'Cocteles' limit 1;
--   if v_category_cocktail is null then
--     insert into public.categories (tenant_id, name, kind, icon, sort_order)
--     values (v_tenant_id, 'Cocteles', 'cocktail', 'martini', 60)
--     returning id into v_category_cocktail;
--   end if;
-- 
--   select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Seagrams' limit 1;
--   if v_product_id is null then
--     insert into public.products (tenant_id, venue_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
--     values (v_tenant_id, v_venue_id, v_category_gin, 'Seagrams', 'Ginebra', 'alcohol', array['cubata', 'copa', 'shot'], true, false, 1)
--     returning id into v_product_id;
--   end if;
--   if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Cubata') then
--     insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
--     values (v_tenant_id, v_product_id, 'Cubata', 900, true, 1);
--   end if;
--   if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Copa') then
--     insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
--     values (v_tenant_id, v_product_id, 'Copa', 700, false, 2);
--   end if;
--   if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Chupito') then
--     insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
--     values (v_tenant_id, v_product_id, 'Chupito', 350, false, 3);
--   end if;
-- 
--   select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Barcelo' limit 1;
--   if v_product_id is null then
--     insert into public.products (tenant_id, venue_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
--     values (v_tenant_id, v_venue_id, v_category_rum, 'Barcelo', 'Ron', 'alcohol', array['cubata', 'copa', 'shot'], true, false, 2)
--     returning id into v_product_id;
--   end if;
--   if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Cubata') then
--     insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
--     values (v_tenant_id, v_product_id, 'Cubata', 850, true, 1);
--   end if;
--   if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Copa') then
--     insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
--     values (v_tenant_id, v_product_id, 'Copa', 650, false, 2);
--   end if;
-- 
--   select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Tonica' limit 1;
--   if v_product_id is null then
--     insert into public.products (tenant_id, venue_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
--     values (v_tenant_id, v_venue_id, v_category_mixer, 'Tonica', 'Botellin y mixer', 'mixer', array['soft_bottle'], true, true, 1)
--     returning id into v_product_id;
--   end if;
--   if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Botellin') then
--     insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
--     values (v_tenant_id, v_product_id, 'Botellin', 300, true, 1);
--   end if;
-- 
--   select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Coca-Cola' limit 1;
--   if v_product_id is null then
--     insert into public.products (tenant_id, venue_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
--     values (v_tenant_id, v_venue_id, v_category_mixer, 'Coca-Cola', 'Botellin y mixer', 'mixer', array['soft_bottle'], true, true, 2)
--     returning id into v_product_id;
--   end if;
--   if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Botellin') then
--     insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
--     values (v_tenant_id, v_product_id, 'Botellin', 300, true, 1);
--   end if;
-- 
--   select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Estrella Damm' limit 1;
--   if v_product_id is null then
--     insert into public.products (tenant_id, venue_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
--     values (v_tenant_id, v_venue_id, v_category_beer, 'Estrella Damm', 'Botellin de cerveza', 'beer_bottle', array['beer_bottle'], true, false, 1)
--     returning id into v_product_id;
--   end if;
--   if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Botellin') then
--     insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
--     values (v_tenant_id, v_product_id, 'Botellin', 350, true, 1);
--   end if;
-- 
--   select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Mojito' limit 1;
--   if v_product_id is null then
--     insert into public.products (tenant_id, venue_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
--     values (v_tenant_id, v_venue_id, v_category_cocktail, 'Mojito', 'Coctel preparado', 'cocktail', array['cocktail'], true, false, 1)
--     returning id into v_product_id;
--   end if;
--   if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Coctel') then
--     insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
--     values (v_tenant_id, v_product_id, 'Coctel', 900, true, 1);
--   end if;
-- 
--   raise notice 'Tenant % listo para el usuario %', v_tenant_slug, v_user_email;
-- end $$;

-- Eliminación confirmada de líneas, incluso cuando ya están servidas.
create or replace function public.remove_restaurant_order_line_confirmed(
  p_line_id uuid,
  p_expected_revision integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  line_row public.order_lines%rowtype;
  next_revision integer;
begin
  select o.* into order_row from public.orders o
  join public.order_lines ol on ol.order_id = o.id
  where ol.id = p_line_id for update of o;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Línea de comanda no disponible' using errcode = '42501';
  end if;
  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo'
      using errcode = '40001', detail = jsonb_build_object(
        'expectedRevision', p_expected_revision, 'currentRevision', order_row.revision
      )::text;
  end if;
  select ol.* into line_row from public.order_lines ol
  where ol.id = p_line_id and ol.order_id = order_row.id for update;
  if line_row.id is null then
    raise exception 'Línea de comanda no disponible' using errcode = 'P0002';
  end if;
  perform public.record_restaurant_order_event(order_row.id, 'line_quantity_changed', jsonb_build_object(
    'lineId', line_row.id, 'oldQuantity', line_row.quantity, 'quantity', 0,
    'servedQuantity', line_row.served_quantity, 'removed', true
  ));
  delete from public.order_lines ol where ol.id = line_row.id;
  update public.orders o set revision = o.revision + 1 where o.id = order_row.id
  returning o.revision into next_revision;
  return next_revision;
end;
$$;

revoke all on function public.remove_restaurant_order_line_confirmed(uuid, integer) from public;
grant execute on function public.remove_restaurant_order_line_confirmed(uuid, integer) to authenticated;

-- Cierre seguro de comandas vacías sin generar ticket ni venta.
create or replace function public.cancel_empty_restaurant_order(
  p_order_id uuid,
  p_expected_revision integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  next_revision integer;
begin
  select o.* into order_row from public.orders o where o.id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo'
      using errcode = '40001', detail = jsonb_build_object(
        'expectedRevision', p_expected_revision, 'currentRevision', order_row.revision
      )::text;
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  if exists (select 1 from public.order_lines ol where ol.order_id = order_row.id) then
    raise exception 'La comanda ya contiene productos' using errcode = '23514';
  end if;
  update public.orders o
  set status = 'cancelled', closed_at = now(), revision = o.revision + 1
  where o.id = order_row.id returning o.revision into next_revision;
  update public.order_tables ot set released_at = now()
  where ot.order_id = order_row.id and ot.released_at is null;
  return next_revision;
end;
$$;

revoke all on function public.cancel_empty_restaurant_order(uuid, integer) from public;
grant execute on function public.cancel_empty_restaurant_order(uuid, integer) to authenticated;

-- Divide una ocupacion de mesas en varias comandas cobrables sin duplicar
-- tickets, lineas de cocina ni enlaces activos de mesa.

begin;

create table if not exists public.order_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint order_groups_tenant_venue_unique unique (id, tenant_id, venue_id),
  constraint order_groups_lifecycle_check check (
    (status = 'open' and closed_at is null) or
    (status = 'closed' and closed_at is not null)
  )
);

alter table public.orders add column if not exists order_group_id uuid;
alter table public.orders add column if not exists split_sequence integer not null default 1;

insert into public.order_groups (id, tenant_id, venue_id, cash_session_id, status, opened_at, updated_at, closed_at)
select o.id, o.tenant_id, o.venue_id, o.cash_session_id,
  case when o.status = 'open' then 'open' else 'closed' end,
  o.opened_at, o.updated_at,
  case when o.status = 'open' then null else coalesce(o.closed_at, o.updated_at) end
from public.orders o
where o.order_group_id is null
on conflict (id) do nothing;

update public.orders o set order_group_id = o.id where o.order_group_id is null;

alter table public.orders alter column order_group_id set not null;
alter table public.orders drop constraint if exists orders_order_group_fk;
alter table public.orders add constraint orders_order_group_fk
  foreign key (order_group_id, tenant_id, venue_id)
  references public.order_groups(id, tenant_id, venue_id) on delete restrict;
alter table public.orders drop constraint if exists orders_split_sequence_check;
alter table public.orders add constraint orders_split_sequence_check check (split_sequence >= 1);
create unique index if not exists orders_group_split_sequence_unique
  on public.orders(order_group_id, split_sequence);
create index if not exists orders_open_group_idx
  on public.orders(order_group_id, status) where status = 'open';

alter table public.order_tables add column if not exists order_group_id uuid;
update public.order_tables ot
set order_group_id = o.order_group_id
from public.orders o
where o.id = ot.order_id and ot.order_group_id is null;
alter table public.order_tables alter column order_group_id set not null;
alter table public.order_tables drop constraint if exists order_tables_order_group_fk;
alter table public.order_tables add constraint order_tables_order_group_fk
  foreign key (order_group_id, tenant_id, venue_id)
  references public.order_groups(id, tenant_id, venue_id) on delete restrict;
create index if not exists order_tables_active_group_idx
  on public.order_tables(order_group_id) where released_at is null;

alter table public.order_lines add column if not exists split_from_line_id uuid references public.order_lines(id) on delete set null;
create index if not exists order_lines_split_source_idx on public.order_lines(split_from_line_id)
  where split_from_line_id is not null;

alter table public.order_events drop constraint if exists order_events_event_type_check;
alter table public.order_events add constraint order_events_event_type_check check (event_type in (
  'order_opened', 'order_moved', 'tables_grouped', 'line_added',
  'line_quantity_changed', 'line_partially_served', 'line_fully_served',
  'order_fully_served', 'order_paid', 'order_cancelled',
  'order_split_created', 'line_moved', 'order_split_removed'
));

alter table public.order_groups enable row level security;
drop policy if exists "order_groups_select" on public.order_groups;
create policy "order_groups_select" on public.order_groups for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

grant select on public.order_groups to authenticated;

create or replace function public.audit_restaurant_order_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'orders' then
    if tg_op = 'INSERT' then
      perform public.record_restaurant_order_event(new.id, 'order_opened', jsonb_build_object('guestCount', new.guest_count));
    elsif old.status = 'open' and new.status = 'paid' then
      perform public.record_restaurant_order_event(new.id, 'order_paid');
    elsif old.status = 'open' and new.status = 'cancelled' then
      perform public.record_restaurant_order_event(new.id, 'order_cancelled');
    end if;
    return new;
  end if;

  if tg_table_name = 'order_lines' then
    if tg_op = 'INSERT' then
      if new.split_from_line_id is null then
        perform public.record_restaurant_order_event(new.order_id, 'line_added', jsonb_build_object('lineId', new.id, 'quantity', new.quantity));
      end if;
    else
      if new.quantity is distinct from old.quantity and new.order_id = old.order_id then
        perform public.record_restaurant_order_event(new.order_id, 'line_quantity_changed', jsonb_build_object('lineId', new.id, 'oldQuantity', old.quantity, 'quantity', new.quantity, 'servedQuantity', new.served_quantity));
      end if;
      if new.served_quantity > old.served_quantity and new.order_id = old.order_id then
        perform public.record_restaurant_order_event(
          new.order_id,
          case when new.served_quantity >= new.quantity then 'line_fully_served' else 'line_partially_served' end,
          jsonb_build_object('lineId', new.id, 'unitsMarkedServed', new.served_quantity - old.served_quantity, 'servedQuantity', new.served_quantity, 'quantity', new.quantity)
        );
      end if;
    end if;
    return new;
  end if;

  if tg_table_name = 'order_tables' then
    if tg_op = 'INSERT' and (
      select count(*) from public.order_tables ot
      where ot.order_group_id = new.order_group_id and ot.released_at is null
    ) > 1 then
      perform public.record_restaurant_order_event(new.order_id, 'tables_grouped', jsonb_build_object('tableId', new.table_id));
    elsif tg_op = 'UPDATE' and old.released_at is null and new.released_at is not null
      and exists (select 1 from public.order_groups og where og.id = new.order_group_id and og.status = 'open') then
      perform public.record_restaurant_order_event(new.order_id, 'order_moved', jsonb_build_object('releasedTableId', new.table_id));
    end if;
    return new;
  end if;
  return new;
end;
$$;

create or replace function public.open_restaurant_order(
  p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_table public.restaurant_tables%rowtype;
  new_group_id uuid := gen_random_uuid();
  new_order_id uuid := gen_random_uuid();
  table_count integer;
  locked_count integer;
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
begin
  if coalesce(array_length(p_table_ids, 1), 0) = 0 or p_guest_count < 1 then raise exception 'Seleccion de mesas no valida'; end if;
  select count(distinct value) into table_count from unnest(p_table_ids) as selected(value);
  if table_count <> array_length(p_table_ids, 1) then raise exception 'Hay mesas duplicadas'; end if;
  select rt.* into first_table from public.restaurant_tables rt where rt.id = p_table_ids[1] for update;
  perform 1 from public.restaurant_tables rt where rt.id = any(p_table_ids) order by rt.id for update;
  select count(*) into locked_count from public.restaurant_tables rt where rt.id = any(p_table_ids)
    and rt.tenant_id = first_table.tenant_id and rt.venue_id = first_table.venue_id and rt.is_active
    and (rt.reserved_until is null or rt.reserved_until <= now());
  if first_table.id is null or locked_count <> table_count or exists (
    select 1 from public.order_tables ot where ot.table_id = any(p_table_ids) and ot.released_at is null
  ) then raise exception 'Una de las mesas ya no esta disponible'; end if;
  select cs.* into session_row from public.cash_sessions cs where cs.id = p_cash_session_id for update;
  select d.* into device_row from public.devices d where d.id = p_device_id;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> first_table.tenant_id or session_row.venue_id <> first_table.venue_id
    or device_row.id is null or not device_row.can_take_orders
    or not public.user_has_device_access(session_row.tenant_id, session_row.venue_id, device_row.id) then
    raise exception 'La caja o el dispositivo no son validos' using errcode = '42501';
  end if;
  insert into public.order_groups (id, tenant_id, venue_id, cash_session_id)
  values (new_group_id, first_table.tenant_id, first_table.venue_id, session_row.id);
  insert into public.orders (
    id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id,
    opened_by_device_id, guest_count, order_group_id, split_sequence
  ) values (
    new_order_id, first_table.tenant_id, first_table.venue_id, session_row.id,
    session_row.cash_register_id, auth.uid(), device_row.id, p_guest_count, new_group_id, 1
  );
  insert into public.order_tables (tenant_id, venue_id, order_id, order_group_id, table_id)
  select first_table.tenant_id, first_table.venue_id, new_order_id, new_group_id, value
  from unnest(p_table_ids) as selected(value);
  return new_order_id;
end;
$$;

create or replace function public.group_restaurant_tables(
  p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_table public.restaurant_tables%rowtype;
  anchor_order public.orders%rowtype;
  existing_group_ids uuid[];
  result_order_id uuid;
  table_count integer;
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
  select array_agg(distinct ot.order_group_id) into existing_group_ids
  from public.order_tables ot join public.order_groups og on og.id = ot.order_group_id
  where ot.table_id = any(p_table_ids) and ot.released_at is null and og.status = 'open';
  if coalesce(array_length(existing_group_ids, 1), 0) > 1 then raise exception 'No se pueden unir dos comandas existentes'; end if;
  if coalesce(array_length(existing_group_ids, 1), 0) = 0 then
    result_order_id := public.open_restaurant_order(p_table_ids, p_guest_count, p_cash_session_id, p_device_id);
  else
    select o.* into anchor_order from public.orders o
    where o.order_group_id = existing_group_ids[1] and o.status = 'open'
    order by o.split_sequence limit 1 for update;
    result_order_id := anchor_order.id;
    insert into public.order_tables (tenant_id, venue_id, order_id, order_group_id, table_id)
    select base_table.tenant_id, base_table.venue_id, anchor_order.id, anchor_order.order_group_id, value
    from unnest(p_table_ids) as selected(value)
    where not exists (
      select 1 from public.order_tables active_link
      where active_link.table_id = selected.value and active_link.released_at is null
    )
    on conflict (order_id, table_id) do update set joined_at = now(), released_at = null,
      order_group_id = excluded.order_group_id;
  end if;
  return result_order_id;
end;
$$;

create or replace function public.move_restaurant_order(p_order_id uuid, p_target_table_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare order_row public.orders%rowtype; target_row public.restaurant_tables%rowtype; anchor_id uuid;
begin
  select * into target_row from public.restaurant_tables where id = p_target_table_id for update;
  select * into order_row from public.orders where id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups where id = order_row.order_group_id for update;
  if target_row.id is null or target_row.tenant_id <> order_row.tenant_id or target_row.venue_id <> order_row.venue_id
    or not target_row.is_active or target_row.reserved_until > now()
    or exists (select 1 from public.order_tables where table_id = target_row.id and released_at is null) then
    raise exception 'La mesa destino no esta libre';
  end if;
  select o.id into anchor_id from public.orders o where o.order_group_id = order_row.order_group_id
    and o.status = 'open' order by o.split_sequence limit 1;
  update public.order_tables set released_at = now()
    where order_group_id = order_row.order_group_id and released_at is null;
  insert into public.order_tables (tenant_id, venue_id, order_id, order_group_id, table_id)
  values (order_row.tenant_id, order_row.venue_id, anchor_id, order_row.order_group_id, target_row.id);
end;
$$;

create or replace function public.move_restaurant_order_lines(
  p_source_order_id uuid,
  p_target_order_id uuid,
  p_expected_source_revision integer,
  p_expected_target_revision integer,
  p_moves jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_order public.orders%rowtype;
  target_order public.orders%rowtype;
  line_row public.order_lines%rowtype;
  move_row record;
  target_id uuid := p_target_order_id;
  next_sequence integer;
  move_quantity integer;
  moved_served integer;
  new_line_id uuid;
  source_cancelled boolean := false;
begin
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) = 0 then
    raise exception 'Selecciona al menos una cantidad para mover' using errcode = '22023';
  end if;

  select o.* into source_order from public.orders o where o.id = p_source_order_id;
  if source_order.id is null or source_order.status <> 'open'
    or not public.user_has_venue_access(source_order.tenant_id, source_order.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups og where og.id = source_order.order_group_id and og.status = 'open' for update;
  perform 1 from public.orders o where o.order_group_id = source_order.order_group_id order by o.id for update;
  select o.* into source_order from public.orders o where o.id = p_source_order_id;
  if source_order.status <> 'open' or source_order.revision <> p_expected_source_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;

  if target_id is null then
    select coalesce(max(o.split_sequence), 0) + 1 into next_sequence
    from public.orders o where o.order_group_id = source_order.order_group_id;
    target_id := gen_random_uuid();
    insert into public.orders (
      id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id,
      opened_by_device_id, guest_count, order_group_id, split_sequence
    ) values (
      target_id, source_order.tenant_id, source_order.venue_id, source_order.cash_session_id,
      source_order.cash_register_id, auth.uid(), source_order.opened_by_device_id,
      source_order.guest_count, source_order.order_group_id, next_sequence
    );
    select o.* into target_order from public.orders o where o.id = target_id;
    perform public.record_restaurant_order_event(target_id, 'order_split_created', jsonb_build_object('sourceOrderId', source_order.id));
  else
    select o.* into target_order from public.orders o where o.id = target_id;
    if target_order.id is null or target_order.status <> 'open'
      or target_order.order_group_id <> source_order.order_group_id or target_order.id = source_order.id then
      raise exception 'La comanda destino no es valida' using errcode = '22023';
    end if;
    if p_expected_target_revision is null or target_order.revision <> p_expected_target_revision then
      raise exception 'La comanda destino ha cambiado en otro dispositivo' using errcode = '40001';
    end if;
  end if;

  for move_row in
    select (value ->> 'lineId')::uuid as line_id, sum((value ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_moves) value
    group by (value ->> 'lineId')::uuid
    order by (value ->> 'lineId')::uuid
  loop
    move_quantity := move_row.quantity;
    if move_quantity < 1 then raise exception 'Las cantidades a mover deben ser positivas' using errcode = '22023'; end if;
    select ol.* into line_row from public.order_lines ol where ol.id = move_row.line_id for update;
    if line_row.id is null or line_row.order_id <> source_order.id or move_quantity > line_row.quantity then
      raise exception 'Una linea ya no tiene la cantidad seleccionada' using errcode = '40001';
    end if;
    moved_served := least(line_row.served_quantity, move_quantity);
    if move_quantity = line_row.quantity then
      update public.order_lines ol set order_id = target_id, updated_at = now() where ol.id = line_row.id;
      new_line_id := line_row.id;
    else
      new_line_id := gen_random_uuid();
      insert into public.order_lines (
        id, tenant_id, venue_id, order_id, product_id, variant_id, product_name,
        variant_name, unit_price_cents, quantity, served_quantity, fully_served_at,
        modifiers, mixer_product_id, mixer, note, created_at, updated_at, split_from_line_id
      ) values (
        new_line_id, line_row.tenant_id, line_row.venue_id, target_id, line_row.product_id,
        line_row.variant_id, line_row.product_name, line_row.variant_name, line_row.unit_price_cents,
        move_quantity, moved_served,
        case when moved_served = move_quantity then line_row.fully_served_at else null end,
        line_row.modifiers, line_row.mixer_product_id, line_row.mixer, line_row.note,
        line_row.created_at, now(), line_row.id
      );
      update public.order_lines ol
      set quantity = ol.quantity - move_quantity,
          served_quantity = ol.served_quantity - moved_served,
          fully_served_at = case when ol.served_quantity - moved_served = ol.quantity - move_quantity
            and ol.quantity - move_quantity > 0 then ol.fully_served_at else null end,
          updated_at = now()
      where ol.id = line_row.id;
    end if;
    perform public.record_restaurant_order_event(source_order.id, 'line_moved', jsonb_build_object(
      'lineId', line_row.id, 'targetLineId', new_line_id, 'targetOrderId', target_id,
      'quantity', move_quantity, 'servedQuantity', moved_served
    ));
    perform public.record_restaurant_order_event(target_id, 'line_moved', jsonb_build_object(
      'lineId', new_line_id, 'sourceLineId', line_row.id, 'sourceOrderId', source_order.id,
      'quantity', move_quantity, 'servedQuantity', moved_served
    ));
  end loop;

  update public.orders o set revision = o.revision + 1, updated_at = now()
  where o.id in (source_order.id, target_id);

  if not exists (select 1 from public.order_lines ol where ol.order_id = source_order.id)
    and exists (select 1 from public.orders o where o.order_group_id = source_order.order_group_id and o.status = 'open' and o.id <> source_order.id) then
    update public.orders o set status = 'cancelled', closed_at = now(), updated_at = now()
    where o.id = source_order.id;
    source_cancelled := true;
    perform public.record_restaurant_order_event(source_order.id, 'order_split_removed', jsonb_build_object('targetOrderId', target_id));
  end if;

  return jsonb_build_object(
    'sourceOrderId', source_order.id,
    'targetOrderId', target_id,
    'sourceCancelled', source_cancelled,
    'sourceRevision', (select o.revision from public.orders o where o.id = source_order.id),
    'targetRevision', (select o.revision from public.orders o where o.id = target_id)
  );
end;
$$;

create or replace function public.cancel_empty_restaurant_order(p_order_id uuid, p_expected_revision integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare order_row public.orders%rowtype; next_revision integer; open_siblings integer;
begin
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups where id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  if exists (select 1 from public.order_lines ol where ol.order_id = order_row.id) then
    raise exception 'La comanda ya contiene productos' using errcode = '23514';
  end if;
  update public.orders o set status = 'cancelled', closed_at = now(), revision = o.revision + 1
    where o.id = order_row.id returning o.revision into next_revision;
  select count(*) into open_siblings from public.orders o
    where o.order_group_id = order_row.order_group_id and o.status = 'open';
  if open_siblings = 0 then
    update public.order_groups set status = 'closed', closed_at = now(), updated_at = now()
      where id = order_row.order_group_id;
    update public.order_tables set released_at = now()
      where order_group_id = order_row.order_group_id and released_at is null;
  end if;
  return next_revision;
end;
$$;

create or replace function public.close_order_and_create_sale_v2(
  p_order_id uuid,
  p_payment_method text default null,
  p_received_cents integer default null,
  p_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  subtotal_cents integer;
  total_cents integer;
  discount_result jsonb;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
  remaining_orders integer;
begin
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id and dua.venue_id = order_row.venue_id
    and dua.is_active and d.is_active limit 1;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null or not actor_device.can_take_payments then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;
  select coalesce(sum(ol.quantity * ol.unit_price_cents), 0)::integer into subtotal_cents
  from public.order_lines ol where ol.order_id = order_row.id;
  if subtotal_cents <= 0 then raise exception 'No se puede cobrar una comanda vacia'; end if;
  discount_result := public.resolve_ticket_discount(order_row.tenant_id, order_row.venue_id, subtotal_cents, p_discount);
  total_cents := (discount_result ->> 'totalCents')::integer;
  if total_cents = 0 then
    if p_payment_method is not null then raise exception 'Un ticket a cero no requiere metodo de pago'; end if;
  elsif p_payment_method not in ('cash', 'card') then raise exception 'Metodo de pago no valido'; end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < total_cents then raise exception 'Importe recibido insuficiente'; end if;

  insert into public.tickets (id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, status,
    subtotal_cents, discount_id, discount_name, discount_type, discount_value_type, discount_value,
    discount_amount_cents, total_cents, local_created_at)
  values (ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id, order_row.venue_id,
    actor_device.id, auth.uid(), 'paid', subtotal_cents, nullif(discount_result ->> 'discountId', '')::uuid,
    discount_result ->> 'name', discount_result ->> 'type', discount_result ->> 'calculationType',
    nullif(discount_result ->> 'storedValue', '')::numeric, case when discount_result ->> 'type' is null then null
      else nullif(discount_result ->> 'amountCents', '')::integer end, total_cents, now());
  insert into public.ticket_lines (id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name, quantity, unit_price_cents, line_total_cents, modifiers)
  select gen_random_uuid(), ol.tenant_id, ticket_id, ol.product_id, ol.variant_id, ol.product_name, ol.variant_name,
    ol.quantity, ol.unit_price_cents, ol.quantity * ol.unit_price_cents,
    ol.modifiers || case when ol.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'id', 'mixer:' || ol.mixer_product_id::text, 'groupId', 'mixer', 'name', ol.mixer ->> 'name',
      'priceCents', (ol.mixer ->> 'priceCents')::integer)) end
  from public.order_lines ol where ol.order_id = order_row.id;
  insert into public.sales (id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, total_cents, payment_method, local_created_at)
  values (sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), total_cents, p_payment_method, now());
  if total_cents > 0 then
    insert into public.sale_payments (id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents)
    values (payment_id, order_row.tenant_id, sale_id, p_payment_method, total_cents,
      case when p_payment_method = 'cash' then p_received_cents else null end,
      case when p_payment_method = 'cash' then p_received_cents - total_cents else 0 end);
  end if;
  update public.orders o set status = 'paid', closed_at = now(), updated_at = now() where o.id = order_row.id;
  select count(*) into remaining_orders from public.orders o
    where o.order_group_id = order_row.order_group_id and o.status = 'open';
  if remaining_orders = 0 then
    update public.order_groups set status = 'closed', closed_at = now(), updated_at = now()
      where id = order_row.order_group_id;
    update public.order_tables set released_at = now()
      where order_group_id = order_row.order_group_id and released_at is null;
  end if;
  return jsonb_build_object('orderId', order_row.id, 'ticketId', ticket_id, 'saleId', sale_id,
    'paymentId', case when total_cents > 0 then payment_id else null end, 'totalCents', total_cents,
    'groupClosed', remaining_orders = 0,
    'nextOrderId', (select o.id from public.orders o where o.order_group_id = order_row.order_group_id
      and o.status = 'open' order by o.split_sequence limit 1));
end;
$$;

create or replace function public.close_restaurant_order_checked_v2(
  p_order_id uuid,
  p_payment_method text default null,
  p_received_cents integer default null,
  p_allow_pending boolean default false,
  p_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  pending_units integer;
  payment_result jsonb;
begin
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0)::integer into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units);
  end if;
  payment_result := public.close_order_and_create_sale_v2(p_order_id, p_payment_method, p_received_cents, p_discount);
  return payment_result || jsonb_build_object('requiresConfirmation', false, 'pendingUnits', pending_units);
end;
$$;

-- Compatibilidad con clientes anteriores: delegan en el cierre consciente del grupo.
create or replace function public.close_order_and_create_sale(
  p_order_id uuid,
  p_payment_method text,
  p_received_cents integer default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.close_order_and_create_sale_v2(p_order_id, p_payment_method, p_received_cents, null);
$$;

create or replace function public.close_restaurant_order_checked(
  p_order_id uuid,
  p_payment_method text,
  p_received_cents integer default null,
  p_allow_pending boolean default false
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.close_restaurant_order_checked_v2(
    p_order_id, p_payment_method, p_received_cents, p_allow_pending, null
  );
$$;

revoke all on function public.move_restaurant_order_lines(uuid, uuid, integer, integer, jsonb) from public;
grant execute on function public.move_restaurant_order_lines(uuid, uuid, integer, integer, jsonb) to authenticated;
revoke all on function public.close_restaurant_order_checked_v2(uuid, text, integer, boolean, jsonb) from public;
grant execute on function public.close_restaurant_order_checked_v2(uuid, text, integer, boolean, jsonb) to authenticated;
revoke all on function public.close_order_and_create_sale(uuid, text, integer) from public;
revoke all on function public.close_restaurant_order_checked(uuid, text, integer, boolean) from public;
grant execute on function public.close_order_and_create_sale(uuid, text, integer) to authenticated;
grant execute on function public.close_restaurant_order_checked(uuid, text, integer, boolean) to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.order_groups; exception when duplicate_object then null; end;
end $$;

commit;


-- Cobro persistente de una comanda a partes iguales. Cada parte genera su
-- propio ticket y venta, mientras la ocupacion permanece abierta hasta la ultima.

begin;

alter table public.ticket_lines
  add column if not exists allocated_quantity numeric(18, 9);
alter table public.ticket_lines drop constraint if exists ticket_lines_allocated_quantity_check;
alter table public.ticket_lines add constraint ticket_lines_allocated_quantity_check
  check (allocated_quantity is null or allocated_quantity > 0);

create table if not exists public.restaurant_order_equal_splits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  order_group_id uuid not null,
  order_id uuid not null,
  total_cents integer not null check (total_cents > 0),
  part_count integer not null check (part_count between 2 and 99),
  paid_parts integer not null default 0 check (paid_parts >= 0),
  paid_cents integer not null default 0 check (paid_cents >= 0),
  allow_pending_service boolean not null default false,
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint restaurant_order_equal_splits_order_unique unique (order_id),
  constraint restaurant_order_equal_splits_id_scope_unique unique (id, tenant_id, venue_id),
  constraint restaurant_order_equal_splits_group_fk foreign key (order_group_id, tenant_id, venue_id)
    references public.order_groups(id, tenant_id, venue_id) on delete restrict,
  constraint restaurant_order_equal_splits_order_fk foreign key (order_id, tenant_id, venue_id)
    references public.orders(id, tenant_id, venue_id) on delete restrict,
  constraint restaurant_order_equal_splits_progress_check check (
    paid_parts <= part_count and paid_cents <= total_cents
    and ((status = 'completed' and paid_parts = part_count and paid_cents = total_cents and completed_at is not null)
      or (status <> 'completed' and completed_at is null))
  )
);

create index if not exists restaurant_order_equal_splits_open_group_idx
  on public.restaurant_order_equal_splits(order_group_id) where status = 'open';

create table if not exists public.restaurant_order_equal_split_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  split_id uuid not null,
  part_number integer not null check (part_number > 0),
  amount_cents integer not null check (amount_cents > 0),
  payment_method text not null check (payment_method in ('cash', 'card')),
  received_cents integer,
  change_cents integer not null default 0 check (change_cents >= 0),
  ticket_id uuid not null references public.tickets(id) on delete restrict,
  sale_id uuid not null references public.sales(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint restaurant_order_equal_split_payments_split_fk foreign key (split_id, tenant_id, venue_id)
    references public.restaurant_order_equal_splits(id, tenant_id, venue_id) on delete restrict,
  constraint restaurant_order_equal_split_payment_part_unique unique (split_id, part_number)
);

alter table public.tickets add column if not exists equal_split_id uuid;
alter table public.tickets add column if not exists equal_split_part_number integer;
alter table public.tickets drop constraint if exists tickets_equal_split_fk;
alter table public.tickets add constraint tickets_equal_split_fk
  foreign key (equal_split_id) references public.restaurant_order_equal_splits(id) on delete set null;
alter table public.tickets drop constraint if exists tickets_equal_split_snapshot_check;
alter table public.tickets add constraint tickets_equal_split_snapshot_check check (
  (equal_split_id is null and equal_split_part_number is null)
  or (equal_split_id is not null and equal_split_part_number > 0)
);
create unique index if not exists tickets_equal_split_part_unique
  on public.tickets(equal_split_id, equal_split_part_number) where equal_split_id is not null;

alter table public.order_events drop constraint if exists order_events_event_type_check;
alter table public.order_events add constraint order_events_event_type_check check (event_type in (
  'order_opened', 'order_moved', 'tables_grouped', 'line_added',
  'line_quantity_changed', 'line_partially_served', 'line_fully_served',
  'order_fully_served', 'order_paid', 'order_cancelled',
  'order_split_created', 'line_moved', 'order_split_removed',
  'equal_split_started', 'equal_split_part_paid', 'equal_split_completed'
));

alter table public.restaurant_order_equal_splits enable row level security;
alter table public.restaurant_order_equal_split_payments enable row level security;
drop policy if exists "restaurant_order_equal_splits_select" on public.restaurant_order_equal_splits;
create policy "restaurant_order_equal_splits_select" on public.restaurant_order_equal_splits
for select to authenticated using (
  public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id)
);
drop policy if exists "restaurant_order_equal_split_payments_select" on public.restaurant_order_equal_split_payments;
create policy "restaurant_order_equal_split_payments_select" on public.restaurant_order_equal_split_payments
for select to authenticated using (
  public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id)
);
grant select on public.restaurant_order_equal_splits, public.restaurant_order_equal_split_payments to authenticated;

create or replace function public.restaurant_equal_split_to_json(p_split public.restaurant_order_equal_splits)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_split.id,
    'orderId', p_split.order_id,
    'orderGroupId', p_split.order_group_id,
    'totalCents', p_split.total_cents,
    'partCount', p_split.part_count,
    'paidParts', p_split.paid_parts,
    'paidCents', p_split.paid_cents,
    'remainingParts', p_split.part_count - p_split.paid_parts,
    'remainingCents', p_split.total_cents - p_split.paid_cents,
    'nextPartCents', case when p_split.status = 'open' then
      (p_split.total_cents / p_split.part_count)
      + case when p_split.paid_parts + 1 <= mod(p_split.total_cents, p_split.part_count) then 1 else 0 end
      else 0 end,
    'status', p_split.status,
    'revision', p_split.revision,
    'allowPendingService', p_split.allow_pending_service
  );
$$;

create or replace function public.configure_restaurant_order_equal_split(
  p_order_id uuid,
  p_part_count integer,
  p_expected_order_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  split_row public.restaurant_order_equal_splits%rowtype;
  order_total integer;
begin
  if p_part_count < 2 or p_part_count > 99 then
    raise exception 'El numero de comensales debe estar entre 2 y 99' using errcode = '22023';
  end if;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' or order_row.revision <> p_expected_order_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  select coalesce(sum(ol.quantity * ol.unit_price_cents), 0)::integer into order_total
  from public.order_lines ol where ol.order_id = order_row.id;
  if order_total <= 0 then raise exception 'No se puede dividir una comanda vacia'; end if;
  if p_part_count > order_total then raise exception 'El numero de partes supera los centimos cobrables' using errcode = '22023'; end if;

  select s.* into split_row from public.restaurant_order_equal_splits s
  where s.order_id = order_row.id for update;
  if split_row.id is not null and split_row.status = 'completed' then
    raise exception 'Esta comanda ya se cobro por completo';
  end if;
  if split_row.id is not null and split_row.paid_parts > 0 then
    if split_row.part_count <> p_part_count or split_row.total_cents <> order_total then
      raise exception 'No se puede cambiar el reparto despues del primer cobro' using errcode = '55000';
    end if;
    return public.restaurant_equal_split_to_json(split_row);
  end if;

  insert into public.restaurant_order_equal_splits (
    tenant_id, venue_id, order_group_id, order_id, total_cents, part_count, status
  ) values (
    order_row.tenant_id, order_row.venue_id, order_row.order_group_id, order_row.id,
    order_total, p_part_count, 'open'
  )
  on conflict (order_id) do update set
    total_cents = excluded.total_cents,
    part_count = excluded.part_count,
    paid_parts = 0,
    paid_cents = 0,
    allow_pending_service = false,
    status = 'open',
    revision = public.restaurant_order_equal_splits.revision + 1,
    updated_at = now(),
    completed_at = null
  returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_started', jsonb_build_object(
    'splitId', split_row.id, 'partCount', split_row.part_count, 'totalCents', split_row.total_cents
  ));
  return public.restaurant_equal_split_to_json(split_row);
end;
$$;

create or replace function public.pay_restaurant_order_equal_part(
  p_split_id uuid,
  p_payment_method text,
  p_received_cents integer default null,
  p_allow_pending boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  split_row public.restaurant_order_equal_splits%rowtype;
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  line_row public.order_lines%rowtype;
  part_number integer;
  part_amount integer;
  base_amount integer;
  remainder integer;
  part_start integer;
  part_end integer;
  line_start integer := 0;
  line_end integer;
  allocated_cents integer;
  allocated_quantity numeric;
  pending_units integer;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
  remaining_orders integer;
  next_order_id uuid;
begin
  if p_payment_method not in ('cash', 'card') then raise exception 'Metodo de pago no valido'; end if;
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id;
  if split_row.id is null or split_row.status <> 'open' then raise exception 'Division no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  perform 1 from public.order_groups og where og.id = split_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = split_row.order_group_id order by o.id for update;
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id for update;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  if split_row.status <> 'open' or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Division no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id for update;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0)::integer into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not split_row.allow_pending_service and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units, 'split', public.restaurant_equal_split_to_json(split_row));
  end if;
  if p_allow_pending and not split_row.allow_pending_service then
    update public.restaurant_order_equal_splits set allow_pending_service = true where id = split_row.id
    returning * into split_row;
  end if;

  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d
  join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id
    and dua.venue_id = order_row.venue_id and dua.is_active and d.is_active
    and d.can_take_payments
  order by case when d.id = order_row.opened_by_device_id then 0 else 1 end, d.id limit 1;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;

  base_amount := split_row.total_cents / split_row.part_count;
  remainder := mod(split_row.total_cents, split_row.part_count);
  part_number := split_row.paid_parts + 1;
  part_amount := base_amount + case when part_number <= remainder then 1 else 0 end;
  part_start := (part_number - 1) * base_amount + least(part_number - 1, remainder);
  part_end := part_start + part_amount;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < part_amount then
    raise exception 'Importe recibido insuficiente';
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id,
    status, subtotal_cents, total_cents, local_created_at, equal_split_id, equal_split_part_number
  ) values (
    ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), 'paid', part_amount, part_amount,
    now(), split_row.id, part_number
  );

  for line_row in select ol.* from public.order_lines ol
    where ol.order_id = order_row.id order by ol.created_at, ol.id
  loop
    line_end := line_start + line_row.quantity * line_row.unit_price_cents;
    allocated_cents := greatest(0, least(line_end, part_end) - greatest(line_start, part_start));
    if allocated_cents > 0 or (line_end = line_start and part_number = 1) then
      allocated_quantity := case when line_end = line_start then line_row.quantity::numeric
        else line_row.quantity::numeric * allocated_cents::numeric / (line_end - line_start)::numeric end;
      insert into public.ticket_lines (
        id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
        quantity, allocated_quantity, unit_price_cents, line_total_cents, modifiers
      ) values (
        gen_random_uuid(), line_row.tenant_id, ticket_id, line_row.product_id, line_row.variant_id,
        line_row.product_name, line_row.variant_name, 1, allocated_quantity,
        allocated_cents, allocated_cents,
        line_row.modifiers || case when line_row.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
          'id', 'mixer:' || line_row.mixer_product_id::text, 'groupId', 'mixer',
          'name', line_row.mixer ->> 'name', 'priceCents', (line_row.mixer ->> 'priceCents')::integer
        )) end
      );
    end if;
    line_start := line_end;
  end loop;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id,
    device_id, user_id, total_cents, payment_method, local_created_at
  ) values (
    sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), part_amount, p_payment_method, now()
  );
  insert into public.sale_payments (
    id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents
  ) values (
    payment_id, order_row.tenant_id, sale_id, p_payment_method, part_amount,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - part_amount else 0 end
  );
  insert into public.restaurant_order_equal_split_payments (
    tenant_id, venue_id, split_id, part_number, amount_cents, payment_method,
    received_cents, change_cents, ticket_id, sale_id
  ) values (
    order_row.tenant_id, order_row.venue_id, split_row.id, part_number, part_amount,
    p_payment_method, case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - part_amount else 0 end,
    ticket_id, sale_id
  );

  update public.restaurant_order_equal_splits s set
    paid_parts = s.paid_parts + 1,
    paid_cents = s.paid_cents + part_amount,
    status = case when s.paid_parts + 1 = s.part_count then 'completed' else 'open' end,
    completed_at = case when s.paid_parts + 1 = s.part_count then now() else null end,
    revision = s.revision + 1,
    updated_at = now()
  where s.id = split_row.id returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_part_paid', jsonb_build_object(
    'splitId', split_row.id, 'partNumber', part_number, 'partCount', split_row.part_count,
    'amountCents', part_amount, 'ticketId', ticket_id, 'saleId', sale_id
  ));

  if split_row.status = 'completed' then
    perform set_config('app.equal_split_finalizing', split_row.id::text, true);
    update public.orders o set status = 'paid', closed_at = now(), updated_at = now()
    where o.id = order_row.id;
    select count(*) into remaining_orders from public.orders o
    where o.order_group_id = order_row.order_group_id and o.status = 'open';
    if remaining_orders = 0 then
      update public.order_groups set status = 'closed', closed_at = now(), updated_at = now()
      where id = order_row.order_group_id;
      update public.order_tables set released_at = now()
      where order_group_id = order_row.order_group_id and released_at is null;
    else
      select o.id into next_order_id from public.orders o
      where o.order_group_id = order_row.order_group_id and o.status = 'open'
      order by o.split_sequence limit 1;
    end if;
    perform public.record_restaurant_order_event(order_row.id, 'equal_split_completed', jsonb_build_object('splitId', split_row.id));
  end if;

  return jsonb_build_object(
    'requiresConfirmation', false,
    'pendingUnits', pending_units,
    'split', public.restaurant_equal_split_to_json(split_row),
    'ticketId', ticket_id,
    'saleId', sale_id,
    'paymentId', payment_id,
    'paidAmountCents', part_amount,
    'completed', split_row.status = 'completed',
    'nextOrderId', next_order_id
  );
end;
$$;

create or replace function public.guard_paid_equal_split_order_lines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare guarded_order_id uuid := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
begin
  if not exists (
    select 1 from public.restaurant_order_equal_splits s
    where s.order_id = guarded_order_id and s.status = 'open' and s.paid_parts > 0
  ) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op <> 'UPDATE' or new.order_id is distinct from old.order_id
    or new.product_id is distinct from old.product_id or new.variant_id is distinct from old.variant_id
    or new.product_name is distinct from old.product_name or new.variant_name is distinct from old.variant_name
    or new.unit_price_cents is distinct from old.unit_price_cents or new.quantity is distinct from old.quantity
    or new.modifiers is distinct from old.modifiers or new.mixer_product_id is distinct from old.mixer_product_id
    or new.mixer is distinct from old.mixer or new.note is distinct from old.note then
    raise exception 'No se puede modificar una comanda con partes ya cobradas' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_paid_equal_split_order_lines on public.order_lines;
create trigger guard_paid_equal_split_order_lines
before insert or update or delete on public.order_lines
for each row execute function public.guard_paid_equal_split_order_lines();

create or replace function public.guard_equal_split_order_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare split_row public.restaurant_order_equal_splits%rowtype;
begin
  if old.status = 'open' and new.status in ('paid', 'cancelled') then
    select s.* into split_row from public.restaurant_order_equal_splits s
    where s.order_id = old.id and s.status = 'open' for update;
    if split_row.id is not null and split_row.paid_parts > 0
      and current_setting('app.equal_split_finalizing', true) is distinct from split_row.id::text then
      raise exception 'La comanda tiene un cobro a partes iguales en curso' using errcode = '55000';
    elsif split_row.id is not null and split_row.paid_parts = 0 then
      update public.restaurant_order_equal_splits set status = 'cancelled', revision = revision + 1, updated_at = now()
      where id = split_row.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_equal_split_order_close on public.orders;
create trigger guard_equal_split_order_close
before update of status on public.orders
for each row execute function public.guard_equal_split_order_close();

revoke all on function public.restaurant_equal_split_to_json(public.restaurant_order_equal_splits) from public, anon, authenticated;
revoke all on function public.configure_restaurant_order_equal_split(uuid, integer, integer) from public;
revoke all on function public.pay_restaurant_order_equal_part(uuid, text, integer, boolean) from public;
revoke all on function public.guard_paid_equal_split_order_lines() from public, anon, authenticated;
revoke all on function public.guard_equal_split_order_close() from public, anon, authenticated;
grant execute on function public.configure_restaurant_order_equal_split(uuid, integer, integer) to authenticated;
grant execute on function public.pay_restaurant_order_equal_part(uuid, text, integer, boolean) to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.restaurant_order_equal_splits; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.restaurant_order_equal_split_payments; exception when duplicate_object then null; end;
end $$;

commit;


-- Descuentos independientes por cada cobro a partes iguales.
-- El descuento previo de la comanda queda como valor heredado; los importes
-- fijos se distribuyen entre partes para no multiplicar el descuento.

begin;

alter table public.restaurant_order_equal_splits
  add column if not exists default_discount jsonb;

alter table public.restaurant_order_equal_split_payments
  add column if not exists subtotal_cents integer,
  add column if not exists discount_amount_cents integer not null default 0,
  add column if not exists discount jsonb;

update public.restaurant_order_equal_split_payments
set subtotal_cents = amount_cents
where subtotal_cents is null;

alter table public.restaurant_order_equal_split_payments
  alter column subtotal_cents set not null,
  alter column payment_method drop not null;

alter table public.restaurant_order_equal_split_payments
  drop constraint if exists restaurant_order_equal_split_payments_amount_cents_check;
alter table public.restaurant_order_equal_split_payments
  add constraint restaurant_order_equal_split_payments_amount_cents_check check (amount_cents >= 0);
alter table public.restaurant_order_equal_split_payments
  drop constraint if exists restaurant_order_equal_split_payments_payment_method_check;
alter table public.restaurant_order_equal_split_payments
  add constraint restaurant_order_equal_split_payments_payment_method_check check (
    payment_method is null or payment_method in ('cash', 'card')
  );
alter table public.restaurant_order_equal_split_payments
  drop constraint if exists restaurant_order_equal_split_payments_discount_check;
alter table public.restaurant_order_equal_split_payments
  add constraint restaurant_order_equal_split_payments_discount_check check (
    subtotal_cents > 0
    and discount_amount_cents between 0 and subtotal_cents
    and amount_cents = subtotal_cents - discount_amount_cents
    and ((amount_cents = 0 and payment_method is null) or (amount_cents > 0 and payment_method is not null))
  );

create or replace function public.restaurant_equal_split_to_json(p_split public.restaurant_order_equal_splits)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  next_part_number integer := p_split.paid_parts + 1;
  next_subtotal integer := 0;
  next_discount_amount integer := 0;
  next_discount jsonb := null;
  calculation_type text;
  configured_value numeric;
begin
  if p_split.status = 'open' then
    next_subtotal := (p_split.total_cents / p_split.part_count)
      + case when next_part_number <= mod(p_split.total_cents, p_split.part_count) then 1 else 0 end;
  end if;

  if next_subtotal > 0 and p_split.default_discount is not null then
    calculation_type := p_split.default_discount ->> 'calculationType';
    next_discount_amount := (coalesce((p_split.default_discount ->> 'amountCents')::integer, 0) / p_split.part_count)
      + case when next_part_number <= mod(coalesce((p_split.default_discount ->> 'amountCents')::integer, 0), p_split.part_count) then 1 else 0 end;
    next_discount_amount := least(next_subtotal, next_discount_amount);
    if next_discount_amount = 0 then
      next_discount := null;
    elsif calculation_type = 'percentage' then
      configured_value := (p_split.default_discount ->> 'value')::numeric;
      next_discount := jsonb_build_object(
        'discountId', nullif(p_split.default_discount ->> 'discountId', ''),
        'name', p_split.default_discount ->> 'name',
        'type', p_split.default_discount ->> 'type',
        'calculationType', 'percentage',
        'value', configured_value,
        'color', p_split.default_discount -> 'color'
      );
    elsif calculation_type = 'fixed' then
      if next_discount_amount > 0 then
        next_discount := jsonb_build_object(
          'discountId', nullif(p_split.default_discount ->> 'discountId', ''),
          'name', p_split.default_discount ->> 'name',
          'type', p_split.default_discount ->> 'type',
          'calculationType', 'fixed',
          'value', next_discount_amount,
          'color', p_split.default_discount -> 'color'
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'id', p_split.id,
    'orderId', p_split.order_id,
    'orderGroupId', p_split.order_group_id,
    'totalCents', p_split.total_cents,
    'partCount', p_split.part_count,
    'paidParts', p_split.paid_parts,
    'paidCents', p_split.paid_cents,
    'remainingParts', p_split.part_count - p_split.paid_parts,
    'remainingCents', p_split.total_cents - p_split.paid_cents,
    'nextPartCents', next_subtotal,
    'nextDefaultDiscount', next_discount,
    'nextDefaultDiscountAmountCents', next_discount_amount,
    'nextDefaultTotalCents', next_subtotal - next_discount_amount,
    'status', p_split.status,
    'revision', p_split.revision,
    'allowPendingService', p_split.allow_pending_service
  );
end;
$$;

drop function if exists public.configure_restaurant_order_equal_split(uuid, integer, integer);
create function public.configure_restaurant_order_equal_split(
  p_order_id uuid,
  p_part_count integer,
  p_expected_order_revision integer,
  p_default_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  split_row public.restaurant_order_equal_splits%rowtype;
  order_total integer;
  discount_result jsonb;
  discount_snapshot jsonb;
begin
  if p_part_count < 2 or p_part_count > 99 then
    raise exception 'El numero de comensales debe estar entre 2 y 99' using errcode = '22023';
  end if;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' or order_row.revision <> p_expected_order_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  select coalesce(sum(ol.quantity * ol.unit_price_cents), 0)::integer into order_total
  from public.order_lines ol where ol.order_id = order_row.id;
  if order_total <= 0 then raise exception 'No se puede dividir una comanda vacia'; end if;
  if p_part_count > order_total then raise exception 'El numero de partes supera los centimos cobrables' using errcode = '22023'; end if;

  select s.* into split_row from public.restaurant_order_equal_splits s
  where s.order_id = order_row.id for update;
  if split_row.id is not null and split_row.status = 'completed' then
    raise exception 'Esta comanda ya se cobro por completo';
  end if;
  if split_row.id is not null and split_row.paid_parts > 0 then
    if split_row.part_count <> p_part_count or split_row.total_cents <> order_total then
      raise exception 'No se puede cambiar el reparto despues del primer cobro' using errcode = '55000';
    end if;
    return public.restaurant_equal_split_to_json(split_row);
  end if;

  discount_result := public.resolve_ticket_discount(
    order_row.tenant_id, order_row.venue_id, order_total, p_default_discount
  );
  discount_snapshot := case when discount_result ->> 'type' is null then null
    else discount_result || jsonb_build_object('color', p_default_discount -> 'color') end;

  insert into public.restaurant_order_equal_splits (
    tenant_id, venue_id, order_group_id, order_id, total_cents, part_count,
    default_discount, status
  ) values (
    order_row.tenant_id, order_row.venue_id, order_row.order_group_id, order_row.id,
    order_total, p_part_count, discount_snapshot, 'open'
  )
  on conflict (order_id) do update set
    total_cents = excluded.total_cents,
    part_count = excluded.part_count,
    paid_parts = 0,
    paid_cents = 0,
    default_discount = excluded.default_discount,
    allow_pending_service = false,
    status = 'open',
    revision = public.restaurant_order_equal_splits.revision + 1,
    updated_at = now(),
    completed_at = null
  returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_started', jsonb_build_object(
    'splitId', split_row.id, 'partCount', split_row.part_count, 'totalCents', split_row.total_cents,
    'defaultDiscountAmountCents', coalesce((discount_snapshot ->> 'amountCents')::integer, 0)
  ));
  return public.restaurant_equal_split_to_json(split_row);
end;
$$;

drop function if exists public.pay_restaurant_order_equal_part(uuid, text, integer, boolean);
create function public.pay_restaurant_order_equal_part(
  p_split_id uuid,
  p_payment_method text default null,
  p_received_cents integer default null,
  p_allow_pending boolean default false,
  p_discount jsonb default null,
  p_use_default_discount boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  split_row public.restaurant_order_equal_splits%rowtype;
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  line_row public.order_lines%rowtype;
  part_number integer;
  part_subtotal integer;
  part_total integer;
  discount_amount integer;
  discount_result jsonb;
  base_amount integer;
  remainder integer;
  part_start integer;
  part_end integer;
  line_start integer := 0;
  line_end integer;
  allocated_cents integer;
  allocated_quantity numeric;
  pending_units integer;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
  remaining_orders integer;
  next_order_id uuid;
begin
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id;
  if split_row.id is null or split_row.status <> 'open' then raise exception 'Division no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  perform 1 from public.order_groups og where og.id = split_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = split_row.order_group_id order by o.id for update;
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id for update;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  if split_row.status <> 'open' or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Division no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id for update;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0)::integer into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not split_row.allow_pending_service and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units, 'split', public.restaurant_equal_split_to_json(split_row));
  end if;
  if p_allow_pending and not split_row.allow_pending_service then
    update public.restaurant_order_equal_splits set allow_pending_service = true where id = split_row.id
    returning * into split_row;
  end if;

  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d
  join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id
    and dua.venue_id = order_row.venue_id and dua.is_active and d.is_active
    and d.can_take_payments
  order by case when d.id = order_row.opened_by_device_id then 0 else 1 end, d.id limit 1;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;

  base_amount := split_row.total_cents / split_row.part_count;
  remainder := mod(split_row.total_cents, split_row.part_count);
  part_number := split_row.paid_parts + 1;
  part_subtotal := base_amount + case when part_number <= remainder then 1 else 0 end;
  part_start := (part_number - 1) * base_amount + least(part_number - 1, remainder);
  part_end := part_start + part_subtotal;

  if p_use_default_discount and split_row.default_discount is not null then
    discount_amount := (coalesce((split_row.default_discount ->> 'amountCents')::integer, 0) / split_row.part_count)
      + case when part_number <= mod(coalesce((split_row.default_discount ->> 'amountCents')::integer, 0), split_row.part_count) then 1 else 0 end;
    discount_amount := least(part_subtotal, discount_amount);
    if discount_amount = 0 then
      discount_result := jsonb_build_object('amountCents', 0, 'totalCents', part_subtotal);
    elsif split_row.default_discount ->> 'calculationType' = 'percentage' then
      discount_result := split_row.default_discount || jsonb_build_object(
        'amountCents', discount_amount,
        'totalCents', part_subtotal - discount_amount
      );
    else
      discount_result := split_row.default_discount || jsonb_build_object(
        'value', discount_amount,
        'storedValue', discount_amount::numeric / 100,
        'amountCents', discount_amount,
        'totalCents', part_subtotal - discount_amount
      );
    end if;
  else
    discount_result := public.resolve_ticket_discount(
      order_row.tenant_id, order_row.venue_id, part_subtotal, p_discount
    );
    discount_amount := coalesce((discount_result ->> 'amountCents')::integer, 0);
  end if;
  discount_amount := coalesce(discount_amount, 0);
  part_total := part_subtotal - discount_amount;

  if part_total = 0 then
    if p_payment_method is not null then raise exception 'Un ticket a cero no requiere metodo de pago'; end if;
  elsif p_payment_method not in ('cash', 'card') then
    raise exception 'Metodo de pago no valido';
  end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < part_total then
    raise exception 'Importe recibido insuficiente';
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id,
    status, subtotal_cents, discount_id, discount_name, discount_type,
    discount_value_type, discount_value, discount_amount_cents, total_cents,
    local_created_at, equal_split_id, equal_split_part_number
  ) values (
    ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), 'paid', part_subtotal,
    nullif(discount_result ->> 'discountId', '')::uuid,
    discount_result ->> 'name', discount_result ->> 'type',
    discount_result ->> 'calculationType',
    nullif(discount_result ->> 'storedValue', '')::numeric,
    case when discount_result ->> 'type' is null then null else discount_amount end,
    part_total, now(), split_row.id, part_number
  );

  for line_row in select ol.* from public.order_lines ol
    where ol.order_id = order_row.id order by ol.created_at, ol.id
  loop
    line_end := line_start + line_row.quantity * line_row.unit_price_cents;
    allocated_cents := greatest(0, least(line_end, part_end) - greatest(line_start, part_start));
    if allocated_cents > 0 or (line_end = line_start and part_number = 1) then
      allocated_quantity := case when line_end = line_start then line_row.quantity::numeric
        else line_row.quantity::numeric * allocated_cents::numeric / (line_end - line_start)::numeric end;
      insert into public.ticket_lines (
        id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
        quantity, allocated_quantity, unit_price_cents, line_total_cents, modifiers
      ) values (
        gen_random_uuid(), line_row.tenant_id, ticket_id, line_row.product_id, line_row.variant_id,
        line_row.product_name, line_row.variant_name, 1, allocated_quantity,
        allocated_cents, allocated_cents,
        line_row.modifiers || case when line_row.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
          'id', 'mixer:' || line_row.mixer_product_id::text, 'groupId', 'mixer',
          'name', line_row.mixer ->> 'name', 'priceCents', (line_row.mixer ->> 'priceCents')::integer
        )) end
      );
    end if;
    line_start := line_end;
  end loop;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id,
    device_id, user_id, total_cents, payment_method, local_created_at
  ) values (
    sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), part_total, p_payment_method, now()
  );
  if part_total > 0 then
    insert into public.sale_payments (
      id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents
    ) values (
      payment_id, order_row.tenant_id, sale_id, p_payment_method, part_total,
      case when p_payment_method = 'cash' then p_received_cents else null end,
      case when p_payment_method = 'cash' then p_received_cents - part_total else 0 end
    );
  end if;
  insert into public.restaurant_order_equal_split_payments (
    tenant_id, venue_id, split_id, part_number, subtotal_cents,
    discount_amount_cents, discount, amount_cents, payment_method,
    received_cents, change_cents, ticket_id, sale_id
  ) values (
    order_row.tenant_id, order_row.venue_id, split_row.id, part_number, part_subtotal,
    discount_amount, case when discount_result ->> 'type' is null then null else discount_result end,
    part_total, p_payment_method,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - part_total else 0 end,
    ticket_id, sale_id
  );

  update public.restaurant_order_equal_splits s set
    paid_parts = s.paid_parts + 1,
    paid_cents = s.paid_cents + part_subtotal,
    status = case when s.paid_parts + 1 = s.part_count then 'completed' else 'open' end,
    completed_at = case when s.paid_parts + 1 = s.part_count then now() else null end,
    revision = s.revision + 1,
    updated_at = now()
  where s.id = split_row.id returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_part_paid', jsonb_build_object(
    'splitId', split_row.id, 'partNumber', part_number, 'partCount', split_row.part_count,
    'subtotalCents', part_subtotal, 'discountAmountCents', discount_amount,
    'amountCents', part_total, 'ticketId', ticket_id, 'saleId', sale_id
  ));

  if split_row.status = 'completed' then
    perform set_config('app.equal_split_finalizing', split_row.id::text, true);
    update public.orders o set status = 'paid', closed_at = now(), updated_at = now()
    where o.id = order_row.id;
    select count(*) into remaining_orders from public.orders o
    where o.order_group_id = order_row.order_group_id and o.status = 'open';
    if remaining_orders = 0 then
      update public.order_groups set status = 'closed', closed_at = now(), updated_at = now()
      where id = order_row.order_group_id;
      update public.order_tables set released_at = now()
      where order_group_id = order_row.order_group_id and released_at is null;
    else
      select o.id into next_order_id from public.orders o
      where o.order_group_id = order_row.order_group_id and o.status = 'open'
      order by o.split_sequence limit 1;
    end if;
    perform public.record_restaurant_order_event(order_row.id, 'equal_split_completed', jsonb_build_object('splitId', split_row.id));
  end if;

  return jsonb_build_object(
    'requiresConfirmation', false,
    'pendingUnits', pending_units,
    'split', public.restaurant_equal_split_to_json(split_row),
    'ticketId', ticket_id,
    'saleId', sale_id,
    'paymentId', case when part_total > 0 then payment_id else null end,
    'paidAmountCents', part_total,
    'completed', split_row.status = 'completed',
    'nextOrderId', next_order_id
  );
end;
$$;

revoke all on function public.restaurant_equal_split_to_json(public.restaurant_order_equal_splits) from public, anon, authenticated;
revoke all on function public.configure_restaurant_order_equal_split(uuid, integer, integer, jsonb) from public;
revoke all on function public.pay_restaurant_order_equal_part(uuid, text, integer, boolean, jsonb, boolean) from public;
grant execute on function public.configure_restaurant_order_equal_split(uuid, integer, integer, jsonb) to authenticated;
grant execute on function public.pay_restaurant_order_equal_part(uuid, text, integer, boolean, jsonb, boolean) to authenticated;

commit;


-- FIN DE LA BASE DE DATOS COMPLETA
