-- Allow active managers to use the CRM data policies while owner-only actions
-- remain protected by their explicit role checks.

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
      and tm.role = any (array['owner'::text, 'manager'::text])
      and tm.is_active = true
  );
$$;
