create or replace function public.save_print_template(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_type text,
  p_definition jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not exists (
    select 1
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id and t.is_active = true
    join public.venues v on v.id = p_venue_id
      and v.tenant_id = p_tenant_id
      and v.is_active = true
    where tm.tenant_id = p_tenant_id
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'manager')
      and tm.is_active = true
  ) then
    raise exception 'PRINT_TEMPLATE_FORBIDDEN' using errcode = '42501';
  end if;

  if p_type is null or p_type !~ '^[a-z][a-z0-9_]{1,79}$'
    or p_definition is null
    or p_definition ->> 'version' <> '1'
    or jsonb_typeof(p_definition -> 'blocks') <> 'array' then
    raise exception 'PRINT_TEMPLATE_INVALID' using errcode = '22023';
  end if;

  insert into public.print_templates (
    tenant_id, venue_id, type, name, definition, is_active, updated_at
  ) values (
    p_tenant_id, p_venue_id, p_type, p_type, p_definition, true, now()
  )
  on conflict (tenant_id, venue_id, type) do update set
    name = excluded.name,
    definition = excluded.definition,
    is_active = true,
    updated_at = now();
end;
$$;

revoke all on function public.save_print_template(uuid, uuid, text, jsonb)
from public, anon;
grant execute on function public.save_print_template(uuid, uuid, text, jsonb)
to authenticated, service_role;
