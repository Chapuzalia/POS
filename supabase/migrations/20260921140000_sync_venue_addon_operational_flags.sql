-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserve the existing venue addon RPC signature while synchronizing legacy operational flags required by venue capability checks; remove only default PUBLIC/anon execution and retain authenticated/service_role execution.
set lock_timeout = '5s';
set statement_timeout = '5min';

create or replace function public.set_venue_addon_enabled(p_venue_id uuid, p_addon_key text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  tenant_id uuid;
begin
  select venue.tenant_id into tenant_id
  from public.venues venue
  where venue.id = p_venue_id
    and venue.is_active
  for update;

  if tenant_id is null or not public.user_is_tenant_admin(tenant_id) then
    raise exception 'VENUE_ADDON_FORBIDDEN' using errcode = '42501';
  end if;
  if p_addon_key not in ('analytics_advanced', 'restaurant', 'reservations', 'production', 'inventory', 'costing', 'purchases', 'document_ai', 'promotions', 'cashlogy') then
    raise exception 'VENUE_ADDON_INVALID' using errcode = '22023';
  end if;
  if p_enabled and not public.tenant_addon_enabled(tenant_id, p_addon_key) then
    raise exception 'VENUE_ADDON_NOT_CONTRACTED' using errcode = '42501';
  end if;

  if p_enabled and p_addon_key in ('restaurant', 'reservations') then
    update public.venues
    set tables_enabled = true, updated_at = now()
    where id = p_venue_id;
  elsif p_enabled and p_addon_key = 'production' then
    update public.venues
    set tables_enabled = true, production_enabled = true, updated_at = now()
    where id = p_venue_id;
  elsif not p_enabled and p_addon_key = 'restaurant' then
    update public.venues
    set tables_enabled = false, production_enabled = false, updated_at = now()
    where id = p_venue_id;
  elsif p_enabled and p_addon_key = 'production' then
    update public.venues
    set production_enabled = true, updated_at = now()
    where id = p_venue_id;
  elsif not p_enabled and p_addon_key = 'production' then
    update public.venues
    set production_enabled = false, updated_at = now()
    where id = p_venue_id;
  elsif p_enabled and p_addon_key in ('inventory', 'costing', 'document_ai') then
    update public.venues
    set inventory_enabled = true, updated_at = now()
    where id = p_venue_id;
  elsif not p_enabled and p_addon_key = 'inventory' then
    update public.venues
    set inventory_enabled = false, updated_at = now()
    where id = p_venue_id;
  end if;

  if not p_enabled and p_addon_key = 'restaurant' then
    delete from public.venue_addon_assignments where venue_id = p_venue_id and addon_key in ('restaurant', 'reservations', 'production');
  elsif not p_enabled and p_addon_key = 'inventory' then
    delete from public.venue_addon_assignments where venue_id = p_venue_id and addon_key in ('inventory', 'costing', 'document_ai');
  elsif not p_enabled and p_addon_key = 'purchases' then
    delete from public.venue_addon_assignments where venue_id = p_venue_id and addon_key in ('purchases', 'document_ai');
  elsif p_enabled and p_addon_key = 'reservations' then
    insert into public.venue_addon_assignments values (tenant_id, p_venue_id, 'restaurant', true, now(), now()) on conflict (venue_id, addon_key) do update set is_enabled = true, updated_at = now();
  elsif p_enabled and p_addon_key = 'production' then
    insert into public.venue_addon_assignments values (tenant_id, p_venue_id, 'restaurant', true, now(), now()) on conflict (venue_id, addon_key) do update set is_enabled = true, updated_at = now();
  elsif p_enabled and p_addon_key = 'costing' then
    insert into public.venue_addon_assignments values (tenant_id, p_venue_id, 'inventory', true, now(), now()) on conflict (venue_id, addon_key) do update set is_enabled = true, updated_at = now();
  elsif p_enabled and p_addon_key = 'document_ai' then
    insert into public.venue_addon_assignments (tenant_id, venue_id, addon_key) values (tenant_id, p_venue_id, 'purchases'), (tenant_id, p_venue_id, 'inventory') on conflict (venue_id, addon_key) do update set is_enabled = true, updated_at = now();
  end if;
  insert into public.venue_addon_assignments (tenant_id, venue_id, addon_key, is_enabled, updated_at) values (tenant_id, p_venue_id, p_addon_key, p_enabled, now()) on conflict (venue_id, addon_key) do update set is_enabled = excluded.is_enabled, updated_at = now();
end;
$$;

revoke all on function public.set_venue_addon_enabled(uuid, text, boolean) from public, anon;
grant execute on function public.set_venue_addon_enabled(uuid, text, boolean) to authenticated, service_role;
