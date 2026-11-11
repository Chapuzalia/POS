-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE, CREATE OR REPLACE ROUTINE
-- migration-safety-reason: New connector RPCs restrict default execution. The commercial config replacement only adds the new optional addon and preserves it for older clients.

insert into public.platform_features(key,name,description,is_core,is_active,enabled_by_default,sort_order)
values('tickit_personal','Tickit Personal','Trabajadores, PIN y permisos del POS gestionados desde Tickit Personal.',false,true,false,210);
insert into public.billing_products(key,kind,name,description,scope,feature_key,sort_order)
values('tickit_personal','addon','Tickit Personal','Integración de trabajadores y permisos operativos.','tenant','tickit_personal',210);
-- Prices are published through the existing Superadmin Stripe catalog; no invented tariff.

create schema if not exists tickit_private;
create table tickit_private.personal_connections (
  tenant_id uuid primary key references public.tenants(id),
  connection_id uuid not null unique,
  organization_id uuid not null,
  secret text not null check(secret ~ '^[a-f0-9]{64}$'),
  venue_mappings jsonb not null check(jsonb_typeof(venue_mappings)='object'),
  enabled boolean not null default true,
  linked boolean not null default false
);
create table tickit_private.personal_staff (
  tenant_id uuid not null references public.tenants(id),
  connection_id uuid not null,
  employee_id uuid not null,
  version bigint not null check(version>0),
  snapshot jsonb not null,
  primary key(tenant_id,connection_id,employee_id)
);
alter table tickit_private.personal_connections enable row level security;
alter table tickit_private.personal_staff enable row level security;

create function public.tickit_personal_configure(p_tenant_id uuid,p_config jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare mapping record; c tickit_private.personal_connections;
begin
  if auth.uid() is null or not exists(select 1 from public.tenant_memberships where tenant_id=p_tenant_id and user_id=auth.uid() and role='owner' and is_active) then
    raise exception 'PERSONAL_FORBIDDEN' using errcode='42501';
  end if;
  if not public.tenant_addon_enabled(p_tenant_id,'tickit_personal') then raise exception 'PERSONAL_NOT_CONTRACTED' using errcode='42501'; end if;
  if p_config is null then
    select * into c from tickit_private.personal_connections where tenant_id=p_tenant_id;
    return jsonb_build_object('enabled',coalesce(c.enabled,false),'linked',coalesce(c.linked,false),'connectionId',c.connection_id,'organizationId',c.organization_id,'venueMappings',coalesce(c.venue_mappings,'{}'));
  end if;
  if p_config->>'enabled'='false' then
    update tickit_private.personal_connections set enabled=false,linked=false where tenant_id=p_tenant_id;
    return jsonb_build_object('enabled',false);
  end if;
  if coalesce(p_config->>'secret','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_config->'venueMappings') is distinct from 'object' or p_config->'venueMappings'='{}' then raise exception 'PERSONAL_INVALID_CONFIG' using errcode='22023'; end if;
  for mapping in select key,value from jsonb_each_text(p_config->'venueMappings') loop
    perform mapping.key::uuid;
    if not exists(select 1 from public.venues where id=mapping.value::uuid and tenant_id=p_tenant_id and is_active) then raise exception 'PERSONAL_FOREIGN_VENUE' using errcode='42501'; end if;
  end loop;
  if (select count(*)<>count(distinct value) from jsonb_each_text(p_config->'venueMappings')) then raise exception 'PERSONAL_DUPLICATE_VENUE' using errcode='22023'; end if;
  insert into tickit_private.personal_connections(tenant_id,connection_id,organization_id,secret,venue_mappings)
  values(p_tenant_id,(p_config->>'connectionId')::uuid,(p_config->>'organizationId')::uuid,p_config->>'secret',p_config->'venueMappings')
  on conflict(tenant_id) do update set connection_id=excluded.connection_id,organization_id=excluded.organization_id,secret=excluded.secret,venue_mappings=excluded.venue_mappings,enabled=true,linked=false;
  return jsonb_build_object('enabled',true,'linked',false);
end $$;

create function public.tickit_personal_credentials(p_connection_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('secret',secret) from tickit_private.personal_connections
  where connection_id=p_connection_id and enabled and public.tenant_addon_enabled(tenant_id,'tickit_personal');
$$;

create function public.tickit_personal_ingest(p_connection_id uuid,p_kind text,p_event jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c tickit_private.personal_connections; previous tickit_private.personal_staff; s jsonb;
begin
  select * into c from tickit_private.personal_connections where connection_id=p_connection_id and enabled for update;
  if not found or not public.tenant_addon_enabled(c.tenant_id,'tickit_personal')
    or p_event->>'organization_id' is distinct from c.organization_id::text or p_event->>'contract_version' is distinct from '1' then raise exception 'PERSONAL_FORBIDDEN' using errcode='42501'; end if;
  if p_kind='link' then
    if p_event->>'external_organization_id' is distinct from c.tenant_id::text or p_event->>'connection_id' is distinct from c.connection_id::text then raise exception 'PERSONAL_FORBIDDEN' using errcode='42501'; end if;
    update tickit_private.personal_connections set linked=true where tenant_id=c.tenant_id;
    return to_jsonb(c.tenant_id::text);
  end if;
  if p_kind<>'event' or not c.linked or p_event->>'target_organization_id' is distinct from c.tenant_id::text then raise exception 'PERSONAL_FORBIDDEN' using errcode='42501'; end if;
  s:=p_event->'payload';
  select * into previous from tickit_private.personal_staff where tenant_id=c.tenant_id and connection_id=c.connection_id and employee_id=(s->>'employee_id')::uuid;
  if found and previous.version=(s->>'version')::bigint and previous.snapshot<>s then raise exception 'PERSONAL_VERSION_CONFLICT' using errcode='22023'; end if;
  insert into tickit_private.personal_staff(tenant_id,connection_id,employee_id,version,snapshot)
  values(c.tenant_id,c.connection_id,(s->>'employee_id')::uuid,(s->>'version')::bigint,s)
  on conflict(tenant_id,connection_id,employee_id) do update set version=excluded.version,snapshot=excluded.snapshot
  where personal_staff.version<excluded.version;
  return jsonb_build_object('event_id',p_event->>'event_id');
end $$;

create function public.tickit_personal_device_state(p_tenant_id uuid,p_venue_id uuid,p_device_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c tickit_private.personal_connections; staff jsonb; personal_venues text[];
begin
  if auth.uid() is null or not exists(
    select 1 from public.device_user_assignments a join public.devices d on d.id=a.device_id and d.tenant_id=a.tenant_id and d.venue_id=a.venue_id
    join public.tenant_memberships m on m.tenant_id=a.tenant_id and m.user_id=a.user_id and m.is_active
    where a.tenant_id=p_tenant_id and a.venue_id=p_venue_id and a.device_id=p_device_id and a.user_id=auth.uid() and a.is_active and d.is_active
  ) then raise exception 'PERSONAL_DEVICE_FORBIDDEN' using errcode='42501'; end if;
  select * into c from tickit_private.personal_connections where tenant_id=p_tenant_id and enabled and linked and public.tenant_addon_enabled(tenant_id,'tickit_personal');
  select array_agg(key) into personal_venues from jsonb_each_text(coalesce(c.venue_mappings,'{}')) where value=p_venue_id::text;
  if c.tenant_id is null or personal_venues is null then return '{"enabled":false,"connectionId":null,"staff":[]}'; end if;
  select coalesce(jsonb_agg(s.snapshot || jsonb_build_object('venue_ids',jsonb_build_array(p_venue_id),
    'policies',jsonb_build_object(p_venue_id::text,(select coalesce(jsonb_object_agg(rule.key,rule.value),'{}') from jsonb_each(s.snapshot->'policies') venue cross join lateral jsonb_each(venue.value) rule where venue.key=any(personal_venues))))),'[]') into staff
  from tickit_private.personal_staff s where s.tenant_id=p_tenant_id and s.connection_id=c.connection_id
    and (s.snapshot->'venue_ids') ?| personal_venues;
  return jsonb_build_object('enabled',true,'connectionId',c.connection_id,'staff',staff);
end $$;

revoke all on function public.tickit_personal_configure(uuid,jsonb),public.tickit_personal_device_state(uuid,uuid,uuid) from public,anon;
grant execute on function public.tickit_personal_configure(uuid,jsonb),public.tickit_personal_device_state(uuid,uuid,uuid) to authenticated;
revoke all on function public.tickit_personal_credentials(uuid),public.tickit_personal_ingest(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.tickit_personal_credentials(uuid),public.tickit_personal_ingest(uuid,text,jsonb) to service_role;


create or replace function public.update_platform_tenant_config(
  p_tenant_id uuid,
  p_name text,
  p_slug text,
  p_max_venues integer,
  p_max_devices integer,
  p_feature_keys text[]
)
returns table (id uuid, name text, slug text)
language plpgsql
security definer
set search_path to ''
as $$
declare
  current_devices integer;
  current_venues integer;
  had_multi_device boolean;
  legacy_request boolean := not ('__addon_catalog_v2' = any(coalesce(p_feature_keys, array[]::text[])));
  requested text[] := array(
    select distinct case feature_key
      when 'discounts' then 'promotions'
      when 'inventory_recipes' then 'costing'
      when 'supplier_documents' then 'purchases'
      when 'supplier_document_scanning' then 'document_ai'
      else feature_key
    end
    from unnest(coalesce(p_feature_keys, array[]::text[])) input(feature_key)
    where feature_key not in ('multi_device', '__addon_catalog_v2', '__assist_catalog_v1', '__personal_catalog_v1')
  );
begin
  perform 1 from public.tenants where tenants.id = p_tenant_id for update;
  if not found then raise exception 'Negocio no encontrado' using errcode = 'P0002'; end if;

  select count(*) into current_venues from public.venues where venues.tenant_id = p_tenant_id;
  select count(*) into current_devices from public.devices where devices.tenant_id = p_tenant_id and devices.is_active = true;
  if p_max_venues < current_venues or p_max_devices < current_devices then
    raise exception 'Los límites no pueden ser inferiores al uso actual del negocio' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_feature_keys, array[]::text[])) input(feature_key)
    where feature_key is null or feature_key not in ('analytics_advanced', 'restaurant', 'reservations', 'production', 'inventory', 'costing', 'purchases', 'document_ai', 'promotions', 'cashlogy', 'discounts', 'inventory_recipes', 'supplier_documents', 'supplier_document_scanning', 'multi_device', '__addon_catalog_v2', '__assist_catalog_v1', '__personal_catalog_v1', 'tickit_assist', 'tickit_personal')
  ) then
    raise exception 'La selección contiene addons no válidos' using errcode = '22023';
  end if;

  if 'reservations' = any(requested) or 'production' = any(requested) then requested := array_append(requested, 'restaurant'); end if;
  if 'costing' = any(requested) then requested := array_append(requested, 'inventory'); end if;
  if 'document_ai' = any(requested) then requested := array_append(requested, 'purchases'); requested := array_append(requested, 'inventory'); end if;
  requested := array(select distinct feature_key from unnest(requested) feature_key);

  -- A legacy client cannot display the new-only addons, so retain those entitlements.
  if legacy_request then
    requested := array(
      select distinct feature_key from unnest(requested) feature_key
      union
      select assignment.feature_key from public.tenant_feature_assignments assignment
      where assignment.tenant_id = p_tenant_id and assignment.feature_key in ('analytics_advanced', 'cashlogy')
    );
  end if;

  if not ('__assist_catalog_v1' = any(coalesce(p_feature_keys,array[]::text[]))) then
    requested := array(select distinct key from (select unnest(requested) as key union select feature_key from public.tenant_feature_assignments where tenant_id=p_tenant_id and feature_key='tickit_assist') preserved);
  end if;
  if not ('__personal_catalog_v1' = any(coalesce(p_feature_keys,array[]::text[]))) then
    requested := array(select distinct key from (select unnest(requested) as key union select feature_key from public.tenant_feature_assignments where tenant_id=p_tenant_id and feature_key='tickit_personal') preserved);
  end if;
  update public.tenants set name = p_name, slug = p_slug, max_venues = p_max_venues, max_devices = p_max_devices, updated_at = now()
  where tenants.id = p_tenant_id;
  select exists (
    select 1 from public.tenant_feature_assignments assignment
    where assignment.tenant_id = p_tenant_id and assignment.feature_key = 'multi_device'
  ) into had_multi_device;
  delete from public.tenant_feature_assignments where tenant_feature_assignments.tenant_id = p_tenant_id;
  insert into public.tenant_feature_assignments (tenant_id, feature_key)
  select p_tenant_id, feature_key from (
    select feature_key from unnest(requested) feature_key
    union
    select case feature_key
      when 'promotions' then 'discounts'
      when 'costing' then 'inventory_recipes'
      when 'purchases' then 'supplier_documents'
      when 'document_ai' then 'supplier_document_scanning'
    end from unnest(requested) feature_key
    where feature_key in ('promotions', 'costing', 'purchases', 'document_ai')
    union
    select 'multi_device' where
      (legacy_request and 'multi_device' = any(coalesce(p_feature_keys, array[]::text[])))
      or (not legacy_request and had_multi_device)
  ) assignments;

  return query select tenants.id, tenants.name, tenants.slug from public.tenants where tenants.id = p_tenant_id;
end;
$$;
