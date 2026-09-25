-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Adds an authenticated admin RPC that atomically reorders existing passes without changing the established first-active-pass fallback contract.

create or replace function public.set_default_production_pass(p_venue_id uuid, p_pass_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_pass_name text;
begin
  if auth.uid() is null then
    raise exception 'Autenticación requerida' using errcode = '42501';
  end if;

  select venue.tenant_id
  into v_tenant_id
  from public.venues venue
  where venue.id = p_venue_id;

  if v_tenant_id is null or not public.user_is_tenant_admin(v_tenant_id) then
    raise exception 'Local no disponible' using errcode = '42501';
  end if;

  perform 1
  from public.production_passes pass
  where pass.tenant_id = v_tenant_id and pass.venue_id = p_venue_id
  order by pass.id
  for update;

  select pass.name
  into v_pass_name
  from public.production_passes pass
  where pass.id = p_pass_id
    and pass.tenant_id = v_tenant_id
    and pass.venue_id = p_venue_id
    and pass.is_active;

  if v_pass_name is null then
    raise exception 'Pase no disponible' using errcode = '42501';
  end if;

  with ranked as (
    select pass.id,
      row_number() over (
        order by case when pass.id = p_pass_id then 0 else 1 end,
          pass.sort_order,
          pass.created_at,
          pass.id
      ) - 1 as sort_order
    from public.production_passes pass
    where pass.tenant_id = v_tenant_id and pass.venue_id = p_venue_id
  )
  update public.production_passes pass
  set sort_order = ranked.sort_order,
      updated_at = now()
  from ranked
  where pass.id = ranked.id;

  return jsonb_build_object('passId', p_pass_id, 'passName', v_pass_name);
end;
$$;

revoke all on function public.set_default_production_pass(uuid, uuid) from public, anon;
grant execute on function public.set_default_production_pass(uuid, uuid) to authenticated;
