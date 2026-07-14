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
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.is_active = true
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
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.role = any(allowed_roles)
      and tm.is_active = true
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

-- FIN DE LA BASE DE DATOS COMPLETA
