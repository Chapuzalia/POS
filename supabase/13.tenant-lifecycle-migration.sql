begin;

alter table public.tenants
  add column if not exists is_active boolean not null default true;

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
    join public.tenants t on t.id = tm.tenant_id
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.is_active = true
      and t.is_active = true
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
    join public.tenants t on t.id = tm.tenant_id
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.role = any(allowed_roles)
      and tm.is_active = true
      and t.is_active = true
  );
$$;

commit;
