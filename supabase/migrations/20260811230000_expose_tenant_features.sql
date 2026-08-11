create or replace function public.get_current_tenant_features(p_tenant_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(assignment.feature_key order by feature.sort_order), array[]::text[])
  from public.tenant_feature_assignments assignment
  join public.platform_features feature on feature.key = assignment.feature_key
  where assignment.tenant_id = p_tenant_id
    and feature.is_core = false
    and feature.is_active = true
    and exists (
      select 1
      from public.tenant_memberships membership
      join public.tenants tenant on tenant.id = membership.tenant_id
      where membership.tenant_id = p_tenant_id
        and membership.user_id = auth.uid()
        and membership.is_active = true
        and tenant.is_active = true
    );
$$;

revoke all on function public.get_current_tenant_features(uuid) from public, anon;
grant execute on function public.get_current_tenant_features(uuid) to authenticated, service_role;

comment on function public.get_current_tenant_features(uuid) is
  'Returns the active optional features for an authenticated member of the requested tenant.';
