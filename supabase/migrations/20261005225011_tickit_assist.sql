-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserve signatures, existing read payloads, invoker RLS and grants. Tenant config accepts a version marker while retaining Assist for N-1 clients. New RPCs remove only PUBLIC/anon execution and grant authenticated execution.

insert into public.platform_features(key,name,description,is_core,is_active,enabled_by_default,sort_order)
values('tickit_assist','Tickit Assist','Asistencia operativa orientativa durante el servicio',false,true,false,210)
on conflict(key) do nothing;

alter table public.venues add column tickit_assist_enabled boolean default false;
alter table public.venues add column tickit_assist_sensitivity text default 'normal';
alter table public.venues add constraint venues_assist_sensitivity_check check(tickit_assist_sensitivity in ('low','normal','high')) not valid;

create function public.tickit_assist_access(p_tenant_id uuid,p_venue_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(
    select 1 from public.venues v join public.tenants t on t.id=v.tenant_id
    where v.id=p_venue_id and v.tenant_id=p_tenant_id and v.is_active and t.is_active
    and (public.user_has_venue_access(p_tenant_id,p_venue_id) or exists(
      select 1 from public.tenant_memberships m where m.tenant_id=p_tenant_id and m.user_id=auth.uid() and m.is_active
      and (m.role='owner' or (m.role='manager' and exists(select 1 from public.manager_venue_assignments a where a.tenant_id=p_tenant_id and a.venue_id=p_venue_id and a.manager_user_id=auth.uid())))
    ))
  );
$$;
create function public.tickit_assist_enabled(p_tenant_id uuid,p_venue_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.tickit_assist_access(p_tenant_id,p_venue_id)
    and public.tenant_addon_enabled(p_tenant_id,'tickit_assist')
    and exists(select 1 from public.venues where tenant_id=p_tenant_id and id=p_venue_id and tickit_assist_enabled is true);
$$;

-- Guard direct REST writes as well as the dedicated configuration RPC.
create function public.guard_tickit_assist_venue_config() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if TG_OP='INSERT' then
    if new.tickit_assist_enabled is true then raise exception 'ASSIST_CONFIG_REQUIRES_EXISTING_VENUE' using errcode='42501'; end if;
    return new;
  end if;
  if new.tickit_assist_enabled is distinct from old.tickit_assist_enabled or new.tickit_assist_sensitivity is distinct from old.tickit_assist_sensitivity then
    if not public.user_is_tenant_admin(old.tenant_id) or not public.tickit_assist_access(old.tenant_id,old.id)
      or not public.tenant_addon_enabled(old.tenant_id,'tickit_assist')
      or new.tenant_id is distinct from old.tenant_id or new.id is distinct from old.id then
      raise exception 'ASSIST_CONFIG_FORBIDDEN' using errcode='42501';
    end if;
  end if;
  return new;
end; $$;
create trigger guard_tickit_assist_venue_config before insert or update on public.venues for each row execute function public.guard_tickit_assist_venue_config();

create function public.set_tickit_assist_venue(p_venue_id uuid,p_enabled boolean,p_sensitivity text)
returns void language plpgsql security definer set search_path='' as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.venues where id=p_venue_id for update;
  if not public.user_is_tenant_admin(v_tenant) or not public.tickit_assist_access(v_tenant,p_venue_id)
    or not public.tenant_addon_enabled(v_tenant,'tickit_assist') then raise exception 'ASSIST_CONFIG_FORBIDDEN' using errcode='42501'; end if;
  if p_enabled is null or p_sensitivity is null or p_sensitivity not in ('low','normal','high') then raise exception 'ASSIST_CONFIG_INVALID' using errcode='22023'; end if;
  update public.venues set tickit_assist_enabled=p_enabled,tickit_assist_sensitivity=p_sensitivity where id=p_venue_id and tenant_id=v_tenant;
end; $$;

create table public.tickit_assist_situations(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,venue_id uuid not null,
  situation_key text not null check(length(situation_key)<=160), kind text not null check(kind in ('unattended_table','kitchen_delay','kitchen_overload','floor_imbalance')),
  entity_id text not null check(length(entity_id)<=80), severity text not null check(severity in ('INFO','ATTENTION','ACTION')),
  started_at timestamptz not null, ended_at timestamptz, expires_at timestamptz not null,
  metrics jsonb not null check(jsonb_typeof(metrics)='object' and pg_column_size(metrics)<4096),
  foreign key(venue_id,tenant_id) references public.venues(id,tenant_id)
);
create unique index tickit_assist_active_key on public.tickit_assist_situations(tenant_id,venue_id,situation_key) where ended_at is null;
create index tickit_assist_service_history on public.tickit_assist_situations(tenant_id,venue_id,started_at desc);
create index tickit_assist_episode_lookup on public.tickit_assist_situations(tenant_id,venue_id,situation_key,started_at);
create table public.tickit_assist_feedback(
  situation_id uuid not null references public.tickit_assist_situations(id), user_id uuid not null references auth.users(id),
  tenant_id uuid not null, venue_id uuid not null, feedback text not null check(feedback in ('understood','not_a_problem')),
  created_at timestamptz not null default now(), primary key(situation_id,user_id),
  foreign key(venue_id,tenant_id) references public.venues(id,tenant_id)
);
create index tickit_assist_feedback_scope on public.tickit_assist_feedback(tenant_id,venue_id,created_at desc);
alter table public.tickit_assist_situations enable row level security;
alter table public.tickit_assist_feedback enable row level security;
create policy assist_situations_read on public.tickit_assist_situations for select to authenticated using(public.tickit_assist_enabled(tenant_id,venue_id));
create policy assist_feedback_read on public.tickit_assist_feedback for select to authenticated using(public.tickit_assist_enabled(tenant_id,venue_id));
-- No direct write policy: writes require the bounded, activation-gated RPC below.
grant select on public.tickit_assist_situations,public.tickit_assist_feedback to authenticated;

create function public.record_tickit_assist_events(p_tenant_id uuid,p_venue_id uuid,p_events jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare e jsonb; v_id uuid; v_started timestamptz; v_ended timestamptz;
begin
  -- Serialize configuration and event writes. A remote disable wins before the next write.
  perform 1 from public.tenants where id=p_tenant_id for share;
  perform 1 from public.venues where id=p_venue_id and tenant_id=p_tenant_id for share;
  if not public.tickit_assist_enabled(p_tenant_id,p_venue_id) then raise exception 'ASSIST_DISABLED' using errcode='42501'; end if;
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>64 or pg_column_size(p_events)>262144 then raise exception 'ASSIST_EVENTS_INVALID' using errcode='22023'; end if;
  for e in select value from jsonb_array_elements(p_events) loop
    if e->>'state' not in ('active','resolved') or e->>'state' is null or e->>'key' is null
      or e->>'key' <> (e->>'kind') || ':' || (e->>'entityId') then raise exception 'ASSIST_EVENT_INVALID' using errcode='22023'; end if;
    v_started := (e->>'startedAt')::timestamptz;
    v_ended := (e->>'endedAt')::timestamptz;
    if v_started is null or v_started>now()+interval '5 minutes' or v_started<now()-interval '24 hours'
      or (e->>'state'='resolved' and (v_ended is null or v_ended<v_started or v_ended>now()+interval '5 minutes')) then continue; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||p_venue_id::text||(e->>'key'),0));
    -- Expire orphaned episodes lazily, with no scheduled history scan.
    update public.tickit_assist_situations set ended_at=expires_at where tenant_id=p_tenant_id and venue_id=p_venue_id and situation_key=e->>'key' and ended_at is null and expires_at<now();
    select id into v_id from public.tickit_assist_situations where tenant_id=p_tenant_id and venue_id=p_venue_id and situation_key=e->>'key' and ended_at is null;
    if v_id is null then
      -- A retried offline episode already persisted should not become a new alert.
      select id into v_id from public.tickit_assist_situations where tenant_id=p_tenant_id and venue_id=p_venue_id and situation_key=e->>'key' and started_at=v_started limit 1;
    end if;
    if v_id is null then
      insert into public.tickit_assist_situations(tenant_id,venue_id,situation_key,kind,entity_id,severity,started_at,ended_at,expires_at,metrics)
      values(p_tenant_id,p_venue_id,e->>'key',e->>'kind',e->>'entityId',e->>'severity',v_started,v_ended,v_started+interval '24 hours',e->'metrics') returning id into v_id;
    else
      update public.tickit_assist_situations set severity=e->>'severity',metrics=e->'metrics',ended_at=case when e->>'state'='resolved' and v_ended>=started_at then v_ended else ended_at end where id=v_id;
    end if;
    if e->>'feedback' is not null then
      insert into public.tickit_assist_feedback(situation_id,user_id,tenant_id,venue_id,feedback) values(v_id,auth.uid(),p_tenant_id,p_venue_id,e->>'feedback')
      on conflict(situation_id,user_id) do update set feedback=excluded.feedback;
    end if;
  end loop;
end; $$;

revoke all on function public.tickit_assist_access(uuid,uuid),public.tickit_assist_enabled(uuid,uuid),public.set_tickit_assist_venue(uuid,boolean,text),public.record_tickit_assist_events(uuid,uuid,jsonb) from public,anon;
grant execute on function public.tickit_assist_access(uuid,uuid),public.tickit_assist_enabled(uuid,uuid),public.set_tickit_assist_venue(uuid,boolean,text),public.record_tickit_assist_events(uuid,uuid,jsonb) to authenticated;

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
    where feature_key not in ('multi_device', '__addon_catalog_v2', '__assist_catalog_v1')
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
    where feature_key is null or feature_key not in ('analytics_advanced', 'restaurant', 'reservations', 'production', 'inventory', 'costing', 'purchases', 'document_ai', 'promotions', 'cashlogy', 'discounts', 'inventory_recipes', 'supplier_documents', 'supplier_document_scanning', 'multi_device', '__addon_catalog_v2', '__assist_catalog_v1', 'tickit_assist')
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


create or replace function public.pos_restaurant_map(p_tenant_id uuid, p_venue_id uuid, p_cash_session_id uuid default null, p_include_production boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_timezone text; v_layout jsonb; v_from timestamptz; v_to timestamptz; v_result jsonb; v_assist boolean; v_config jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  select timezone into v_timezone from public.venues where tenant_id=p_tenant_id and id=p_venue_id;
  if v_timezone is null then raise exception 'VENUE_NOT_AVAILABLE' using errcode='42501'; end if;
  if p_cash_session_id is not null then
    if not exists(select 1 from public.cash_sessions where id=p_cash_session_id and tenant_id=p_tenant_id and venue_id=p_venue_id and status='open') then
      raise exception 'SESSION_NOT_AVAILABLE' using errcode='42501';
    end if;
    v_layout := public.get_cash_session_table_layout(p_cash_session_id);
  end if;
  v_assist := public.tickit_assist_enabled(p_tenant_id,p_venue_id);
  select jsonb_build_object('tenantEnabled',public.tenant_addon_enabled(p_tenant_id,'tickit_assist'),'venueEnabled',coalesce(tickit_assist_enabled,false),'sensitivity',coalesce(tickit_assist_sensitivity,'normal')) into v_config from public.venues where tenant_id=p_tenant_id and id=p_venue_id;
  v_from := (now() at time zone v_timezone)::date::timestamp at time zone v_timezone;
  v_to := ((now() at time zone v_timezone)::date + 1)::timestamp at time zone v_timezone;
  with areas as (select id, tenant_id, venue_id, name, sort_order, is_active, canvas_width, canvas_height, map_elements, created_at, updated_at from public.dining_areas where tenant_id=p_tenant_id and venue_id=p_venue_id and is_active order by sort_order),
  tables as (select id, tenant_id, venue_id, area_id, cash_session_id, name, capacity, shape, position_x, position_y, width, height, is_active, sort_order, reserved_until, reservation_note, created_at, updated_at from public.restaurant_tables where tenant_id=p_tenant_id and venue_id=p_venue_id and is_active and (cash_session_id is null or cash_session_id=p_cash_session_id) order by sort_order),
  orders as materialized (select id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id, opened_by_device_id, guest_count, status, revision, order_group_id, split_sequence, draft_discount, opened_at, updated_at, closed_at from public.orders where tenant_id=p_tenant_id and venue_id=p_venue_id and status='open' union all select id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id, opened_by_device_id, guest_count, status, revision, order_group_id, split_sequence, draft_discount, opened_at, updated_at, closed_at from public.orders where tenant_id=p_tenant_id and venue_id=p_venue_id and status='carried_forward'),
  lines as materialized (select id, tenant_id, venue_id, order_id, product_id, variant_id, product_name, variant_name, unit_price_cents, quantity, served_quantity, fully_served_at, modifiers, components, catalog_snapshot, mixer_product_id, mixer, note, created_at, updated_at from public.order_lines where tenant_id=p_tenant_id and venue_id=p_venue_id and order_id in (select id from orders))
  select jsonb_build_object(
    'areas',coalesce((select jsonb_agg(to_jsonb(a)) from areas a),'[]'::jsonb),
    'tables',coalesce((select jsonb_agg(to_jsonb(t)) from tables t),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(to_jsonb(o)) from orders o),'[]'::jsonb),
    'lines',coalesce((select jsonb_agg(to_jsonb(l)) from lines l),'[]'::jsonb),
    'links',coalesce((select jsonb_agg(jsonb_build_object('order_id',order_id,'order_group_id',order_group_id,'table_id',table_id,'joined_at',joined_at,'released_at',released_at)) from public.order_tables where tenant_id=p_tenant_id and venue_id=p_venue_id and released_at is null),'[]'::jsonb),
    'splits',coalesce((select jsonb_agg(jsonb_build_object('order_group_id',order_group_id,'paid_cents',paid_cents)) from public.restaurant_order_equal_splits where tenant_id=p_tenant_id and venue_id=p_venue_id and status='open'),'[]'::jsonb),
    'reservations',coalesce((select jsonb_agg(jsonb_build_object('table_id',rt.table_id,'reservations',jsonb_build_object('id',r.id,'customer_name',r.customer_name,'customer_phone',r.customer_phone,'party_size',r.party_size,'starts_at',r.starts_at,'ends_at',r.ends_at,'status',r.status))) from public.reservation_tables rt join public.reservations r on r.id=rt.reservation_id and r.tenant_id=rt.tenant_id and r.venue_id=rt.venue_id where rt.tenant_id=p_tenant_id and rt.venue_id=p_venue_id and r.status in ('confirmed','arrived','seated') and r.starts_at>=v_from and r.starts_at<v_to and r.ends_at>now()),'[]'::jsonb),
    'allocations',coalesce((select jsonb_agg(jsonb_build_object('current_order_line_id',current_order_line_id,'ready_quantity',ready_quantity) || case when v_assist then jsonb_build_object('quantity',quantity,'cancelled_quantity',cancelled_quantity,'created_at',(select b.created_at from public.production_batches b where b.id=production_line_allocations.batch_id),'updated_at',updated_at) else '{}'::jsonb end) from public.production_line_allocations where p_include_production and tenant_id=p_tenant_id and venue_id=p_venue_id and current_order_line_id in (select id from lines)),'[]'::jsonb),
    'assistConfiguration',v_config, 'observedAt',now(), 'layout',v_layout
  ) into v_result;
  return v_result;
end; $$;
