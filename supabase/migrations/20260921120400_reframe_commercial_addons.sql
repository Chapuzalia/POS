-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

insert into public.platform_features (key, name, description, is_core, is_active, enabled_by_default, sort_order)
values
  ('analytics_advanced', 'Analítica avanzada', 'Comparativas, actividad, distribuciones e informes agregados avanzados.', false, true, false, 100),
  ('restaurant', 'Restaurante', 'Mesas, zonas, comandas, división de cuenta, pretickets y carryovers.', false, true, false, 110),
  ('reservations', 'Reservas', 'Reservas, disponibilidad y asignación de mesas. Requiere Restaurante.', false, true, false, 120),
  ('production', 'Producción & KDS', 'Destinos, routing, impresión de producción, KDS y dispatches. Requiere Restaurante.', false, true, false, 130),
  ('inventory', 'Inventario', 'Stock, artículos, almacenes, unidades, rutas, objetivos y ajustes.', false, true, false, 140),
  ('costing', 'Escandallos & Costes', 'Recetas, ingredientes, elaboraciones y cálculo de costes. Requiere Inventario.', false, true, false, 150),
  ('purchases', 'Compras & Proveedores', 'Proveedores, documentos, archivo e histórico de precios.', false, true, false, 160),
  ('document_ai', 'Escaneo inteligente', 'OCR, extracción de líneas e identificación y actualización desde documentos. Requiere Compras e Inventario.', false, true, false, 170),
  ('promotions', 'Promociones avanzadas', 'Reglas, autoaplicación, horarios, targets, PIN y redondeos.', false, true, false, 180),
  ('cashlogy', 'Cashlogy', 'Configuración y operativa de la integración Cashlogy.', false, true, false, 190)
on conflict (key) do update
set name = excluded.name, description = excluded.description, is_core = false, is_active = true,
    enabled_by_default = false, sort_order = excluded.sort_order, updated_at = now();

-- Preserve every commercial entitlement already granted before the rename.
insert into public.tenant_feature_assignments (tenant_id, feature_key)
select assignment.tenant_id,
  case assignment.feature_key
    when 'discounts' then 'promotions'
    when 'inventory_recipes' then 'costing'
    when 'supplier_documents' then 'purchases'
    when 'supplier_document_scanning' then 'document_ai'
  end
from public.tenant_feature_assignments assignment
where assignment.feature_key in ('discounts', 'inventory_recipes', 'supplier_documents', 'supplier_document_scanning')
on conflict (tenant_id, feature_key) do nothing;

-- Materialize prerequisite assignments so old clients and direct database checks remain compatible.
insert into public.tenant_feature_assignments (tenant_id, feature_key)
select assignment.tenant_id, dependency.feature_key
from public.tenant_feature_assignments assignment
cross join lateral (
  select 'restaurant'::text as feature_key where assignment.feature_key in ('reservations', 'production')
  union all select 'inventory'::text where assignment.feature_key in ('costing', 'document_ai')
  union all select 'purchases'::text where assignment.feature_key = 'document_ai'
) dependency
on conflict (tenant_id, feature_key) do nothing;

update public.platform_features
set is_active = false, enabled_by_default = false, updated_at = now()
where key in ('discounts', 'multi_device', 'inventory_recipes', 'supplier_documents', 'supplier_document_scanning');

create or replace function public.tenant_addon_enabled(p_tenant_id uuid, p_addon_key text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
    from public.tenant_feature_assignments assignment
    join public.platform_features feature on feature.key = assignment.feature_key and feature.is_active
    where assignment.tenant_id = p_tenant_id and assignment.feature_key = p_addon_key
  );
$$;

create or replace function public.inventory_recipes_feature_enabled(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select public.tenant_addon_enabled(p_tenant_id, 'inventory')
     and public.tenant_addon_enabled(p_tenant_id, 'costing');
$$;

create or replace function public.supplier_documents_feature_enabled(p_tenant_id uuid, p_scanning boolean default false)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select public.tenant_addon_enabled(p_tenant_id, 'purchases')
     and (
       not p_scanning
       or (
         public.tenant_addon_enabled(p_tenant_id, 'inventory')
         and public.tenant_addon_enabled(p_tenant_id, 'document_ai')
       )
     );
$$;

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
set search_path to ''
as $$
declare
  current_devices integer;
  current_venues integer;
  requested text[] := array(
    select distinct feature_key
    from unnest(coalesce(p_feature_keys, array[]::text[])) requested(feature_key)
    where feature_key in ('analytics_advanced', 'restaurant', 'reservations', 'production', 'inventory', 'costing', 'purchases', 'document_ai', 'promotions', 'cashlogy')
  );
begin
  perform 1 from public.tenants where tenants.id = p_tenant_id for update;
  if not found then raise exception 'Negocio no encontrado' using errcode = 'P0002'; end if;

  select count(*) into current_venues from public.venues where venues.tenant_id = p_tenant_id;
  select count(*) into current_devices from public.devices where devices.tenant_id = p_tenant_id and devices.is_active = true;
  if p_max_venues < current_venues or p_max_devices < current_devices then
    raise exception 'Los límites no pueden ser inferiores al uso actual del negocio' using errcode = 'P0001';
  end if;
  if cardinality(requested) <> cardinality(array(select distinct feature_key from unnest(coalesce(p_feature_keys, array[]::text[])) feature_key)) then
    raise exception 'La selección contiene addons no válidos' using errcode = '22023';
  end if;

  if 'reservations' = any(requested) or 'production' = any(requested) then requested := array_append(requested, 'restaurant'); end if;
  if 'costing' = any(requested) then requested := array_append(requested, 'inventory'); end if;
  if 'document_ai' = any(requested) then requested := array_append(requested, 'purchases'); requested := array_append(requested, 'inventory'); end if;
  requested := array(select distinct feature_key from unnest(requested) feature_key);

  update public.tenants set name = p_name, slug = p_slug, max_venues = p_max_venues, max_devices = p_max_devices, updated_at = now()
  where tenants.id = p_tenant_id;
  delete from public.tenant_feature_assignments where tenant_feature_assignments.tenant_id = p_tenant_id;
  insert into public.tenant_feature_assignments (tenant_id, feature_key)
  select p_tenant_id, feature_key from unnest(requested) feature_key;

  return query select tenants.id, tenants.name, tenants.slug from public.tenants where tenants.id = p_tenant_id;
end;
$$;

revoke all on function public.tenant_addon_enabled(uuid, text) from public, anon, authenticated;
grant execute on function public.tenant_addon_enabled(uuid, text) to authenticated, service_role;
comment on function public.tenant_addon_enabled(uuid, text) is 'Checks an active commercial addon assignment; capabilities are resolved by their prerequisite addons.';
