-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- policy replacement preserves the table and tenant scope.
drop policy if exists print_templates_admin_insert on public.print_templates;
create policy print_templates_admin_insert on public.print_templates
for insert to authenticated
with check (
  public.user_has_tenant_role(tenant_id, array['owner'::text, 'manager'::text])
);

drop policy if exists print_templates_admin_update on public.print_templates;
create policy print_templates_admin_update on public.print_templates
for update to authenticated
using (
  public.user_has_tenant_role(tenant_id, array['owner'::text, 'manager'::text])
)
with check (
  public.user_has_tenant_role(tenant_id, array['owner'::text, 'manager'::text])
);

drop policy if exists print_templates_admin_delete on public.print_templates;
create policy print_templates_admin_delete on public.print_templates
for delete to authenticated
using (
  public.user_has_tenant_role(tenant_id, array['owner'::text, 'manager'::text])
);
