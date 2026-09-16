-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- policy replacement preserves the table and tenant/venue scope.
drop policy if exists print_templates_admin_insert on public.print_templates;
create policy print_templates_admin_insert on public.print_templates
for insert to authenticated
with check (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

drop policy if exists print_templates_admin_update on public.print_templates;
create policy print_templates_admin_update on public.print_templates
for update to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
)
with check (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

drop policy if exists print_templates_admin_delete on public.print_templates;
create policy print_templates_admin_delete on public.print_templates
for delete to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);
