create or replace function public.user_can_manage_print_template(
  target_tenant uuid,
  target_venue uuid
)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id
    join public.venues v on v.id = target_venue and v.tenant_id = target_tenant
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.role = any (array['owner'::text, 'manager'::text])
      and tm.is_active = true
      and t.is_active = true
      and v.is_active = true
  );
$$;

drop policy if exists print_templates_venue_read on public.print_templates;
create policy print_templates_venue_read on public.print_templates
for select to authenticated
using (
  public.user_can_manage_print_template(tenant_id, venue_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

drop policy if exists print_templates_admin_insert on public.print_templates;
create policy print_templates_admin_insert on public.print_templates
for insert to authenticated
with check (
  public.user_can_manage_print_template(tenant_id, venue_id)
);

drop policy if exists print_templates_admin_update on public.print_templates;
create policy print_templates_admin_update on public.print_templates
using (
  public.user_can_manage_print_template(tenant_id, venue_id)
)
with check (
  public.user_can_manage_print_template(tenant_id, venue_id)
);

drop policy if exists print_templates_admin_delete on public.print_templates;
create policy print_templates_admin_delete on public.print_templates
for delete to authenticated
using (
  public.user_can_manage_print_template(tenant_id, venue_id)
);

grant execute on function public.user_can_manage_print_template(uuid, uuid) to authenticated, service_role;
