create table if not exists public.platform_features (
  key text primary key,
  name text not null,
  description text not null,
  is_core boolean not null default false,
  is_active boolean not null default true,
  enabled_by_default boolean not null default false,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_features_key_check check (key ~ '^[a-z][a-z0-9_]*$')
);

create table if not exists public.tenant_feature_assignments (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  feature_key text not null references public.platform_features(key) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (tenant_id, feature_key)
);

create index if not exists tenant_feature_assignments_feature_key_idx
  on public.tenant_feature_assignments(feature_key);

alter table public.platform_features enable row level security;
alter table public.tenant_feature_assignments enable row level security;

revoke all on table public.platform_features from anon, authenticated;
revoke all on table public.tenant_feature_assignments from anon, authenticated;
grant select on table public.platform_features to service_role;
grant select, insert, update, delete on table public.tenant_feature_assignments to service_role;

insert into public.platform_features (key, name, description, is_core, enabled_by_default, sort_order)
values
  ('quick_sale', 'Venta rápida', 'Creación y cobro de tickets.', true, false, 10),
  ('catalog', 'Catálogo de venta', 'Productos, categorías, formatos, variantes y modificadores.', true, false, 20),
  ('basic_cash', 'Gestión básica de caja', 'Apertura, cierre y arqueo de caja.', true, false, 30),
  ('ticket_history', 'Histórico de tickets', 'Consulta, reimpresión y anulación de tickets.', true, false, 40),
  ('advanced_cash', 'Gestión avanzada de caja', 'Movimientos, auditoría y apertura manual del cajón.', true, false, 50),
  ('local_printing', 'Impresión y hardware', 'Impresoras, cajón y agente local.', true, false, 60),
  ('offline_mode', 'Funcionamiento offline', 'Venta, cola y recuperación sin conexión.', true, false, 70),
  ('verifacti', 'Fiscalidad avanzada / VeriFacti', 'Emisión, QR y anulación fiscal.', true, false, 80),
  ('personalization', 'Personalización del TPV', 'Temas y preferencias de interfaz.', true, false, 90),
  ('discounts', 'Descuentos', 'Descuentos manuales, promociones y PIN.', false, true, 100),
  ('restaurant', 'Restaurante y división de cuenta', 'Mesas, comandas, pagos parciales y división de cuenta.', false, true, 110),
  ('reservations', 'Reservas', 'Reservas, disponibilidad y asignación de mesas.', false, true, 120),
  ('inventory', 'Inventario', 'Stock, almacenes y consumos por formato.', false, true, 130),
  ('multi_device', 'Operación multidispositivo', 'Dispositivos principales, satélites y sincronización.', false, true, 140)
on conflict (key) do update
set name = excluded.name,
    description = excluded.description,
    is_core = excluded.is_core,
    enabled_by_default = excluded.enabled_by_default,
    sort_order = excluded.sort_order,
    updated_at = now();

-- Preserve current behaviour: every existing business receives every optional feature.
insert into public.tenant_feature_assignments (tenant_id, feature_key)
select tenant.id, feature.key
from public.tenants tenant
cross join public.platform_features feature
where feature.is_core = false
  and feature.is_active = true
on conflict (tenant_id, feature_key) do nothing;

create or replace function public.assign_default_tenant_features()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tenant_feature_assignments (tenant_id, feature_key)
  select new.id, feature.key
  from public.platform_features feature
  where feature.is_core = false
    and feature.is_active = true
    and feature.enabled_by_default = true
  on conflict (tenant_id, feature_key) do nothing;
  return new;
end;
$$;

drop trigger if exists assign_default_tenant_features_after_insert on public.tenants;
create trigger assign_default_tenant_features_after_insert
after insert on public.tenants
for each row execute function public.assign_default_tenant_features();

create or replace function public.update_platform_tenant_config(
  p_tenant_id uuid,
  p_name text,
  p_slug text,
  p_max_venues integer,
  p_max_devices integer,
  p_feature_keys text[]
)
returns table (id uuid, name text, slug text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_devices integer;
  current_venues integer;
begin
  perform 1 from public.tenants where tenants.id = p_tenant_id for update;
  if not found then
    raise exception 'Negocio no encontrado' using errcode = 'P0002';
  end if;

  select count(*) into current_venues
  from public.venues
  where venues.tenant_id = p_tenant_id;

  select count(*) into current_devices
  from public.devices
  where devices.tenant_id = p_tenant_id
    and devices.is_active = true;

  if p_max_venues < current_venues or p_max_devices < current_devices then
    raise exception 'Los límites no pueden ser inferiores al uso actual del negocio' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_feature_keys, array[]::text[])) requested(feature_key)
    left join public.platform_features feature
      on feature.key = requested.feature_key
      and feature.is_core = false
      and feature.is_active = true
    where feature.key is null
  ) then
    raise exception 'La selección contiene features no válidas' using errcode = '22023';
  end if;

  update public.tenants
  set name = p_name,
      slug = p_slug,
      max_venues = p_max_venues,
      max_devices = p_max_devices,
      updated_at = now()
  where tenants.id = p_tenant_id;

  delete from public.tenant_feature_assignments
  where tenant_feature_assignments.tenant_id = p_tenant_id;

  insert into public.tenant_feature_assignments (tenant_id, feature_key)
  select p_tenant_id, requested.feature_key
  from (
    select distinct feature_key
    from unnest(coalesce(p_feature_keys, array[]::text[])) feature_key
  ) requested;

  return query
  select tenants.id, tenants.name, tenants.slug
  from public.tenants
  where tenants.id = p_tenant_id;
end;
$$;

revoke all on function public.assign_default_tenant_features() from public, anon, authenticated;
revoke all on function public.update_platform_tenant_config(uuid, text, text, integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.update_platform_tenant_config(uuid, text, text, integer, integer, text[]) to service_role;

comment on table public.platform_features is 'Catalog of core and optional platform capabilities.';
comment on table public.tenant_feature_assignments is 'Optional features enabled for each tenant.';
