-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- policy replacement preserves active tenant and venue membership checks.
drop policy if exists print_templates_venue_read on public.print_templates;
create policy print_templates_venue_read on public.print_templates
for select to authenticated
using (
  exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = print_templates.tenant_id
      and tm.user_id = (select auth.uid())
      and tm.role in ('owner', 'manager')
      and tm.is_active = true
  )
  or public.user_has_venue_access(print_templates.tenant_id, print_templates.venue_id)
);

drop policy if exists print_templates_admin_insert on public.print_templates;
create policy print_templates_admin_insert on public.print_templates
for insert to authenticated
with check (
  exists (
    select 1
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id and t.is_active = true
    join public.venues v on v.id = print_templates.venue_id
      and v.tenant_id = print_templates.tenant_id
      and v.is_active = true
    where tm.tenant_id = print_templates.tenant_id
      and tm.user_id = (select auth.uid())
      and tm.role in ('owner', 'manager')
      and tm.is_active = true
  )
);

drop policy if exists print_templates_admin_update on public.print_templates;
create policy print_templates_admin_update on public.print_templates
for update to authenticated
using (
  exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = print_templates.tenant_id
      and tm.user_id = (select auth.uid())
      and tm.role in ('owner', 'manager')
      and tm.is_active = true
  )
)
with check (
  exists (
    select 1
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id and t.is_active = true
    join public.venues v on v.id = print_templates.venue_id
      and v.tenant_id = print_templates.tenant_id
      and v.is_active = true
    where tm.tenant_id = print_templates.tenant_id
      and tm.user_id = (select auth.uid())
      and tm.role in ('owner', 'manager')
      and tm.is_active = true
  )
);

drop policy if exists print_templates_admin_delete on public.print_templates;
create policy print_templates_admin_delete on public.print_templates
for delete to authenticated
using (
  exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = print_templates.tenant_id
      and tm.user_id = (select auth.uid())
      and tm.role in ('owner', 'manager')
      and tm.is_active = true
  )
);
