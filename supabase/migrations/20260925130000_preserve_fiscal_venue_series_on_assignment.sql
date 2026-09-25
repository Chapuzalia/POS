-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

create or replace function public.superadmin_update_fiscal_entity_venues(
  p_tenant_id uuid,
  p_fiscal_entity_id uuid,
  p_venue_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected_count integer;
  v_distinct_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'FISCAL_ENTITY_VENUE_SERVICE_ONLY' using errcode = '42501';
  end if;

  select count(*), count(distinct value)
    into v_expected_count, v_distinct_count
  from unnest(coalesce(p_venue_ids, '{}'::uuid[])) as values(value);

  if v_expected_count = 0 or v_expected_count <> v_distinct_count then
    raise exception 'FISCAL_ENTITY_VENUE_IDS_INVALID' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.fiscal_entities
    where tenant_id = p_tenant_id and id = p_fiscal_entity_id
  ) then
    raise exception 'FISCAL_ENTITY_NOT_FOUND' using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(p_venue_ids) as requested(venue_id)
    left join public.venues v on v.id = requested.venue_id and v.tenant_id = p_tenant_id
    where v.id is null
  ) then
    raise exception 'FISCAL_ENTITY_VENUE_TENANT_MISMATCH' using errcode = '22023';
  end if;

  perform 1
  from public.fiscal_entity_venues
  where tenant_id = p_tenant_id
    and (fiscal_entity_id = p_fiscal_entity_id or venue_id = any(p_venue_ids))
  for update;

  if exists (
    select 1
    from public.fiscal_entity_venues
    where tenant_id = p_tenant_id
      and venue_id = any(p_venue_ids)
      and fiscal_entity_id <> p_fiscal_entity_id
  ) then
    raise exception 'FISCAL_ENTITY_VENUE_ALREADY_ASSIGNED' using errcode = '23505';
  end if;

  delete from public.fiscal_entity_venues
  where tenant_id = p_tenant_id
    and fiscal_entity_id = p_fiscal_entity_id
    and venue_id <> all(p_venue_ids);

  insert into public.fiscal_entity_venues (tenant_id, fiscal_entity_id, venue_id)
  select p_tenant_id, p_fiscal_entity_id, requested.venue_id
  from unnest(p_venue_ids) as requested(venue_id)
  where not exists (
    select 1
    from public.fiscal_entity_venues existing
    where existing.tenant_id = p_tenant_id
      and existing.fiscal_entity_id = p_fiscal_entity_id
      and existing.venue_id = requested.venue_id
  );
end;
$$;

revoke all on function public.superadmin_update_fiscal_entity_venues(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.superadmin_update_fiscal_entity_venues(uuid, uuid, uuid[]) to service_role;
