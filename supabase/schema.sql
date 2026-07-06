-- Club POS / TPV discotecas
-- Ejecutar en Supabase SQL Editor con un rol con permisos de administración.

create extension if not exists pgcrypto;

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
  kind text not null check (kind in ('beer', 'mixed', 'shot', 'other')),
  icon text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete restrict,
  name text not null,
  description text,
  kind text not null check (kind in ('beer', 'mixed', 'shot', 'other')),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create index if not exists tenant_memberships_user_idx on public.tenant_memberships (user_id);
create index if not exists venues_tenant_idx on public.venues (tenant_id);
create index if not exists devices_tenant_idx on public.devices (tenant_id, venue_id);
create index if not exists categories_tenant_idx on public.categories (tenant_id, sort_order);
create index if not exists products_tenant_idx on public.products (tenant_id, category_id, sort_order);
create index if not exists product_variants_product_idx on public.product_variants (product_id, sort_order);
create index if not exists modifier_groups_product_idx on public.modifier_groups (product_id, sort_order);
create index if not exists modifiers_group_idx on public.modifiers (group_id, sort_order);
create index if not exists cash_sessions_tenant_idx on public.cash_sessions (tenant_id, opened_at desc);
create index if not exists tickets_tenant_idx on public.tickets (tenant_id, created_at desc);
create index if not exists sales_tenant_idx on public.sales (tenant_id, created_at desc);

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
create policy "cash_sessions_tenant_access"
on public.cash_sessions for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "tickets_tenant_access" on public.tickets;
create policy "tickets_tenant_access"
on public.tickets for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "ticket_lines_tenant_access" on public.ticket_lines;
create policy "ticket_lines_tenant_access"
on public.ticket_lines for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop policy if exists "sales_tenant_access" on public.sales;
create policy "sales_tenant_access"
on public.sales for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

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
  ('33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', 'Cerveza', 'beer', 'beer', 1),
  ('33333333-3333-3333-3333-333333333332', '11111111-1111-1111-1111-111111111111', 'Copas', 'mixed', 'martini', 2),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Chupitos', 'shot', 'shot', 3),
  ('33333333-3333-3333-3333-333333333334', '11111111-1111-1111-1111-111111111111', 'Sin alcohol', 'other', 'glass', 4)
on conflict do nothing;

insert into public.products (id, tenant_id, category_id, name, description, kind, sort_order)
values
  ('44444444-4444-4444-4444-444444444441', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333331', 'Caña', 'Cerveza de barril', 'beer', 1),
  ('44444444-4444-4444-4444-444444444442', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333332', 'Gin Tonic', 'Copa premium configurable', 'mixed', 1),
  ('44444444-4444-4444-4444-444444444443', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'Tequila', 'Chupito clásico', 'shot', 1),
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333334', 'Agua', 'Botella fría', 'other', 1)
on conflict do nothing;

insert into public.product_variants (id, tenant_id, product_id, name, price_cents, is_default, sort_order)
values
  ('55555555-5555-5555-5555-555555555551', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444441', 'Vaso', 300, true, 1),
  ('55555555-5555-5555-5555-555555555552', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444442', 'Normal', 800, true, 1),
  ('55555555-5555-5555-5555-555555555553', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444442', 'Premium', 1100, false, 2),
  ('55555555-5555-5555-5555-555555555554', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444443', 'Chupito', 350, true, 1),
  ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'Botella', 250, true, 1)
on conflict do nothing;

insert into public.modifier_groups (id, tenant_id, product_id, name, min_select, max_select, sort_order)
values ('66666666-6666-6666-6666-666666666661', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444442', 'Tónica', 1, 1, 1)
on conflict do nothing;

insert into public.modifiers (id, tenant_id, group_id, name, price_cents, sort_order)
values
  ('77777777-7777-7777-7777-777777777771', '11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666661', 'Schweppes', 0, 1),
  ('77777777-7777-7777-7777-777777777772', '11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666661', 'Fever-Tree', 150, 2)
on conflict do nothing;

-- Vincula un usuario ya creado en Supabase Auth:
-- insert into public.tenant_memberships (tenant_id, user_id, role)
-- values ('11111111-1111-1111-1111-111111111111', '<AUTH_USER_UUID>', 'owner')
-- on conflict (tenant_id, user_id) do update set role = excluded.role, is_active = true;
