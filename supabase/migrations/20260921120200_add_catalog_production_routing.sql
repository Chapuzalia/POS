-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Adds an optional POS-only production routing field while preserving the get_catalog signature and existing collections.
set lock_timeout = '5s';
set statement_timeout = '5min';

create or replace function public.get_catalog(
  p_venue_id uuid,
  p_mode text default 'admin'
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_catalog jsonb;
  v_active_only boolean;
  v_tenant_id uuid;
begin
  v_catalog := public.get_catalog_without_formats(p_venue_id, p_mode);
  v_active_only := p_mode = 'pos';
  select venue.tenant_id into v_tenant_id from public.venues venue where venue.id = p_venue_id;
  return v_catalog || jsonb_build_object(
    'sale_formats', coalesce((select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id) from (select f.id, f.tenant_id, f.venue_id, f.name, f.inventory_consumption_quantity, f.inventory_consumption_unit_id, f.is_active, f.sort_order, f.created_at, f.updated_at from public.catalog_sale_formats f where f.venue_id = p_venue_id and (not v_active_only or f.is_active)) x), '[]'::jsonb),
    'variant_formats', coalesce((select jsonb_agg(jsonb_build_object('variant_id', v.id, 'format_id', f.id) order by v.product_id, v.sort_order, v.id) from public.product_variants v join public.products p on p.id = v.product_id and p.venue_id = p_venue_id join public.catalog_sale_formats f on f.id = v.catalog_sale_format_id and f.venue_id = p_venue_id where v.venue_id = p_venue_id and (not v_active_only or (p.is_active and v.is_active and f.is_active))), '[]'::jsonb),
    'production_routing', case when v_active_only then jsonb_build_object(
      'passes', coalesce((select jsonb_agg(jsonb_build_object('id', pass.id, 'name', pass.name, 'sortOrder', pass.sort_order) order by pass.sort_order, pass.created_at, pass.id) from public.production_passes pass where pass.tenant_id = v_tenant_id and pass.venue_id = p_venue_id and pass.is_active), '[]'::jsonb),
      'defaultPass', (select jsonb_build_object('id', pass.id, 'name', pass.name, 'sortOrder', pass.sort_order) from public.production_passes pass where pass.tenant_id = v_tenant_id and pass.venue_id = p_venue_id and pass.is_active order by pass.sort_order, pass.created_at, pass.id limit 1),
      'productRoutes', coalesce((select jsonb_agg(jsonb_build_object('productId', route.product_id, 'passId', route.pass_id) order by route.product_id) from public.production_product_pass_routes route join public.production_passes pass on pass.id = route.pass_id and pass.tenant_id = route.tenant_id and pass.venue_id = route.venue_id and pass.is_active where route.tenant_id = v_tenant_id and route.venue_id = p_venue_id), '[]'::jsonb),
      'categoryRoutes', coalesce((select jsonb_agg(jsonb_build_object('categoryId', route.category_id, 'passId', route.pass_id) order by route.category_id) from public.production_category_pass_routes route join public.production_passes pass on pass.id = route.pass_id and pass.tenant_id = route.tenant_id and pass.venue_id = route.venue_id and pass.is_active where route.tenant_id = v_tenant_id and route.venue_id = p_venue_id), '[]'::jsonb),
      'loadedAt', now()
    ) else null end
  );
end;
$$;

notify pgrst, 'reload schema';
