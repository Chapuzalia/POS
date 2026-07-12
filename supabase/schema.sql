-- Club POS / TPV discotecas
-- Ejecutar en Supabase SQL Editor con un rol con permisos de administración.

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
create policy "profiles_self_upsert"
on public.profiles for all
using (id = auth.uid())
with check (id = auth.uid());

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
-- El bucket es publico para descarga por URL, pero no se concede SELECT sobre
-- storage.objects porque ese permiso tambien permitiria listar sus archivos.

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

-- Datos de ejemplo para una discoteca. Ajusta el slug y añade un usuario a tenant_memberships.
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
select tenant_id, key, label, sort_order, true
from public.tenants
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
  ('44444444-4444-4444-4444-444444444441', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333331', 'Seagrams', 'Ginebra', 'alcohol', array['cubata', 'copa', 'shot'], true, false, 1),
  ('44444444-4444-4444-4444-444444444442', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333332', 'Barcelo', 'Ron', 'alcohol', array['cubata', 'copa', 'shot'], true, false, 1),
  ('44444444-4444-4444-4444-444444444443', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'Tonica', 'Botellin y mixer', 'mixer', array['soft_bottle'], true, true, 1),
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333334', 'Estrella Damm', 'Botellin de cerveza', 'beer_bottle', array['beer_bottle'], true, false, 1),
  ('44444444-4444-4444-4444-444444444445', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333335', 'Mojito', 'Coctel preparado', 'cocktail', array['cocktail'], true, false, 1)
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
