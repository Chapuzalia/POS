-- Destructive removal of the tenant admin role.
-- This intentionally deletes matching memberships and has no guards or rollback.

delete from public.tenant_memberships
where role = 'admin';

alter table public.tenant_memberships
drop constraint tenant_memberships_role_check;

alter table public.tenant_memberships
add constraint tenant_memberships_role_check
check (role = any (array['owner'::text, 'manager'::text, 'cashier'::text]));

create or replace function public.user_is_tenant_admin(target_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.role = 'owner'
      and tm.is_active = true
  );
$$;

alter policy memberships_admin_all on public.tenant_memberships
rename to memberships_owner_all;

alter policy memberships_owner_all on public.tenant_memberships
using (public.user_has_tenant_role(tenant_id, array['owner'::text]))
with check (public.user_has_tenant_role(tenant_id, array['owner'::text]));

alter policy catalog_placements_admin_manage on public.catalog_placements rename to catalog_placements_owner_manage;
alter policy catalog_sale_formats_admin_manage on public.catalog_sale_formats rename to catalog_sale_formats_owner_manage;
alter policy catalog_tabs_admin_manage on public.catalog_tabs rename to catalog_tabs_owner_manage;
alter policy categories_admin_manage on public.categories rename to categories_owner_manage;
alter policy device_assignments_admin_manage on public.device_user_assignments rename to device_assignments_owner_manage;
alter policy devices_admin_manage on public.devices rename to devices_owner_manage;
alter policy dining_areas_admin_manage on public.dining_areas rename to dining_areas_owner_manage;
alter policy discounts_admin_manage on public.discounts rename to discounts_owner_manage;
alter policy modifier_groups_admin_manage on public.modifier_groups rename to modifier_groups_owner_manage;
alter policy modifiers_admin_manage on public.modifiers rename to modifiers_owner_manage;
alter policy product_variants_admin_manage on public.product_variants rename to product_variants_owner_manage;
alter policy products_admin_manage on public.products rename to products_owner_manage;
alter policy restaurant_tables_admin_manage on public.restaurant_tables rename to restaurant_tables_owner_manage;
alter policy selection_groups_admin_manage on public.selection_groups rename to selection_groups_owner_manage;
alter policy venues_admin_manage on public.venues rename to venues_owner_manage;
