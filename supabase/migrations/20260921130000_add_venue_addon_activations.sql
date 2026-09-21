-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: All four RPCs are newly created; only their default PUBLIC/anon execute access is removed, with authenticated and service_role execute granted below.
set lock_timeout = '5s';
set statement_timeout = '5min';

create table if not exists public.venue_addon_assignments (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null,
  addon_key text not null references public.platform_features(key) on delete restrict,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (venue_id, addon_key),
  foreign key (venue_id, tenant_id) references public.venues(id, tenant_id) on delete cascade,
  constraint venue_addon_assignments_key_check check (addon_key in ('analytics_advanced', 'restaurant', 'reservations', 'production', 'inventory', 'costing', 'purchases', 'document_ai', 'promotions', 'cashlogy'))
);

create index if not exists venue_addon_assignments_tenant_idx
  on public.venue_addon_assignments(tenant_id, venue_id);

alter table public.venue_addon_assignments enable row level security;

create or replace function public.venue_addon_enabled(p_tenant_id uuid, p_venue_id uuid, p_addon_key text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select public.tenant_addon_enabled(p_tenant_id, p_addon_key)
    and coalesce((select assignment.is_enabled
      from public.venue_addon_assignments assignment
      where assignment.tenant_id = p_tenant_id
        and assignment.venue_id = p_venue_id
        and assignment.addon_key = p_addon_key), true);
$$;

create or replace function public.venue_capability_enabled(p_tenant_id uuid, p_venue_id uuid, p_capability_key text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  enabled boolean;
begin
  case p_capability_key
    when 'analytics_basic', 'manual_discounts' then return true;
    when 'analytics_advanced' then return public.venue_addon_enabled(p_tenant_id, p_venue_id, 'analytics_advanced');
    when 'restaurant' then return public.venue_addon_enabled(p_tenant_id, p_venue_id, 'restaurant') and coalesce((select tables_enabled from public.venues where id = p_venue_id and tenant_id = p_tenant_id), false);
    when 'reservations' then return public.venue_capability_enabled(p_tenant_id, p_venue_id, 'restaurant') and public.venue_addon_enabled(p_tenant_id, p_venue_id, 'reservations');
    when 'production' then return public.venue_capability_enabled(p_tenant_id, p_venue_id, 'restaurant') and public.venue_addon_enabled(p_tenant_id, p_venue_id, 'production') and coalesce((select production_enabled from public.venues where id = p_venue_id and tenant_id = p_tenant_id), false);
    when 'inventory' then return public.venue_addon_enabled(p_tenant_id, p_venue_id, 'inventory') and coalesce((select inventory_enabled from public.venues where id = p_venue_id and tenant_id = p_tenant_id), false);
    when 'costing' then return public.venue_capability_enabled(p_tenant_id, p_venue_id, 'inventory') and public.venue_addon_enabled(p_tenant_id, p_venue_id, 'costing');
    when 'purchases' then return public.venue_addon_enabled(p_tenant_id, p_venue_id, 'purchases');
    when 'purchase_analytics' then return public.venue_capability_enabled(p_tenant_id, p_venue_id, 'purchases') and public.venue_addon_enabled(p_tenant_id, p_venue_id, 'analytics_advanced');
    when 'replenishment' then return public.venue_capability_enabled(p_tenant_id, p_venue_id, 'purchases') and public.venue_capability_enabled(p_tenant_id, p_venue_id, 'inventory');
    when 'document_ai' then return public.venue_capability_enabled(p_tenant_id, p_venue_id, 'purchases') and public.venue_capability_enabled(p_tenant_id, p_venue_id, 'inventory') and public.venue_addon_enabled(p_tenant_id, p_venue_id, 'document_ai');
    when 'profitability' then return public.venue_capability_enabled(p_tenant_id, p_venue_id, 'analytics_advanced') and public.venue_capability_enabled(p_tenant_id, p_venue_id, 'costing');
    when 'promotions', 'cashlogy' then return public.venue_addon_enabled(p_tenant_id, p_venue_id, p_capability_key);
    else return false;
  end case;
end;
$$;

create or replace function public.list_current_tenant_venue_addons(p_tenant_id uuid)
returns table (venue_id uuid, addon_key text, is_enabled boolean)
language sql
stable
security definer
set search_path to ''
as $$
  select assignment.venue_id, feature.key,
    coalesce(assignment.is_enabled, true)
  from public.venues venue
  cross join public.platform_features feature
  left join public.venue_addon_assignments assignment
    on assignment.tenant_id = p_tenant_id
   and assignment.venue_id = venue.id
   and assignment.addon_key = feature.key
  where venue.tenant_id = p_tenant_id
    and venue.is_active
    and feature.is_core = false
    and feature.is_active
    and public.tenant_addon_enabled(p_tenant_id, feature.key)
    and feature.key in ('analytics_advanced', 'restaurant', 'reservations', 'production', 'inventory', 'costing', 'purchases', 'document_ai', 'promotions', 'cashlogy');
$$;

create or replace function public.set_venue_addon_enabled(p_venue_id uuid, p_addon_key text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  tenant_id uuid;
  prerequisite text;
begin
  select venue.tenant_id into tenant_id from public.venues venue where venue.id = p_venue_id and venue.is_active for update;
  if tenant_id is null or not public.user_is_tenant_admin(tenant_id) then raise exception 'VENUE_ADDON_FORBIDDEN' using errcode = '42501'; end if;
  if p_addon_key not in ('analytics_advanced', 'restaurant', 'reservations', 'production', 'inventory', 'costing', 'purchases', 'document_ai', 'promotions', 'cashlogy') then raise exception 'VENUE_ADDON_INVALID' using errcode = '22023'; end if;
  if p_enabled and not public.tenant_addon_enabled(tenant_id, p_addon_key) then raise exception 'VENUE_ADDON_NOT_CONTRACTED' using errcode = '42501'; end if;
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

revoke all on function public.venue_addon_enabled(uuid, uuid, text), public.venue_capability_enabled(uuid, uuid, text), public.list_current_tenant_venue_addons(uuid), public.set_venue_addon_enabled(uuid, text, boolean) from public, anon;
grant execute on function public.venue_addon_enabled(uuid, uuid, text), public.venue_capability_enabled(uuid, uuid, text), public.list_current_tenant_venue_addons(uuid), public.set_venue_addon_enabled(uuid, text, boolean) to authenticated, service_role;
