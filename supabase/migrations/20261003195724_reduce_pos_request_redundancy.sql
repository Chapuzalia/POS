-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New invoker read RPCs are authenticated-only; existing endpoints and RLS remain intact.

create function public.pos_restaurant_map(p_tenant_id uuid, p_venue_id uuid, p_cash_session_id uuid default null, p_include_production boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_timezone text; v_layout jsonb; v_from timestamptz; v_to timestamptz; v_result jsonb;
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
  v_from := (now() at time zone v_timezone)::date::timestamp at time zone v_timezone;
  v_to := ((now() at time zone v_timezone)::date + 1)::timestamp at time zone v_timezone;
  with areas as (select id, tenant_id, venue_id, name, sort_order, is_active, canvas_width, canvas_height, map_elements, created_at, updated_at from public.dining_areas where tenant_id=p_tenant_id and venue_id=p_venue_id and is_active order by sort_order),
  tables as (select id, tenant_id, venue_id, area_id, cash_session_id, name, capacity, shape, position_x, position_y, width, height, is_active, sort_order, reserved_until, reservation_note, created_at, updated_at from public.restaurant_tables where tenant_id=p_tenant_id and venue_id=p_venue_id and is_active and (cash_session_id is null or cash_session_id=p_cash_session_id) order by sort_order),
  orders as materialized (select id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id, opened_by_device_id, guest_count, status, revision, order_group_id, split_sequence, draft_discount, opened_at, updated_at, closed_at from public.orders where tenant_id=p_tenant_id and venue_id=p_venue_id and status in ('open','carried_forward')),
  lines as materialized (select id, tenant_id, venue_id, order_id, product_id, variant_id, product_name, variant_name, unit_price_cents, quantity, served_quantity, fully_served_at, modifiers, components, catalog_snapshot, mixer_product_id, mixer, note, created_at, updated_at from public.order_lines where tenant_id=p_tenant_id and venue_id=p_venue_id and order_id in (select id from orders))
  select jsonb_build_object(
    'areas',coalesce((select jsonb_agg(to_jsonb(a)) from areas a),'[]'::jsonb),
    'tables',coalesce((select jsonb_agg(to_jsonb(t)) from tables t),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(to_jsonb(o)) from orders o),'[]'::jsonb),
    'lines',coalesce((select jsonb_agg(to_jsonb(l)) from lines l),'[]'::jsonb),
    'links',coalesce((select jsonb_agg(jsonb_build_object('order_id',order_id,'order_group_id',order_group_id,'table_id',table_id,'joined_at',joined_at,'released_at',released_at)) from public.order_tables where tenant_id=p_tenant_id and venue_id=p_venue_id and released_at is null),'[]'::jsonb),
    'splits',coalesce((select jsonb_agg(jsonb_build_object('order_group_id',order_group_id,'paid_cents',paid_cents)) from public.restaurant_order_equal_splits where tenant_id=p_tenant_id and venue_id=p_venue_id and status='open'),'[]'::jsonb),
    'reservations',coalesce((select jsonb_agg(jsonb_build_object('table_id',rt.table_id,'reservations',jsonb_build_object('id',r.id,'customer_name',r.customer_name,'customer_phone',r.customer_phone,'party_size',r.party_size,'starts_at',r.starts_at,'ends_at',r.ends_at,'status',r.status))) from public.reservation_tables rt join public.reservations r on r.id=rt.reservation_id and r.tenant_id=rt.tenant_id and r.venue_id=rt.venue_id where rt.tenant_id=p_tenant_id and rt.venue_id=p_venue_id and r.status in ('confirmed','arrived','seated') and r.starts_at>=v_from and r.starts_at<v_to and r.ends_at>now()),'[]'::jsonb),
    'allocations',coalesce((select jsonb_agg(jsonb_build_object('current_order_line_id',current_order_line_id,'ready_quantity',ready_quantity)) from public.production_line_allocations where p_include_production and tenant_id=p_tenant_id and venue_id=p_venue_id and current_order_line_id in (select id from lines)),'[]'::jsonb),
    'layout',v_layout
  ) into v_result;
  return v_result;
end; $$;

create function public.pos_restaurant_order(p_tenant_id uuid,p_venue_id uuid,p_order_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  with selected as (select id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id, opened_by_device_id, guest_count, status, revision, order_group_id, split_sequence, draft_discount, opened_at, updated_at, closed_at from public.orders where tenant_id=p_tenant_id and venue_id=p_venue_id and id=p_order_id and auth.uid() is not null),
  links as (select table_id from public.order_tables where tenant_id=p_tenant_id and venue_id=p_venue_id and order_group_id=(select order_group_id from selected) and released_at is null),
  lines as (select id, tenant_id, venue_id, order_id, product_id, variant_id, product_name, variant_name, unit_price_cents, quantity, served_quantity, fully_served_at, modifiers, components, catalog_snapshot, mixer_product_id, mixer, note, created_at, updated_at from public.order_lines where tenant_id=p_tenant_id and venue_id=p_venue_id and order_id=(select id from selected) order by created_at),
  tables as (select id, tenant_id, venue_id, area_id, cash_session_id, name, capacity, shape, position_x, position_y, width, height, is_active, sort_order, reserved_until, reservation_note, created_at, updated_at from public.restaurant_tables where tenant_id=p_tenant_id and venue_id=p_venue_id and id in (select table_id from links))
  select jsonb_build_object('order',to_jsonb(o),'lines',coalesce((select jsonb_agg(to_jsonb(l)) from lines l),'[]'::jsonb),'tables',coalesce((select jsonb_agg(to_jsonb(t)) from tables t),'[]'::jsonb),'registerName',(select name from public.cash_registers where id=o.cash_register_id and tenant_id=p_tenant_id and venue_id=p_venue_id)) from selected o;
$$;

create function public.pos_fiscal_preparation(p_tenant_id uuid,p_venue_id uuid,p_register_id uuid,p_device_id uuid,p_installation_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('installation',to_jsonb(i),'subject',jsonb_build_object('id',s.id,'tenant_id',s.tenant_id,'legal_name',s.legal_name,'nif',s.nif),'settings',to_jsonb(c),
    'head',(select to_jsonb(r) from public.fiscal_local_records r where r.tenant_id=i.tenant_id and r.fiscal_subject_id=i.fiscal_subject_id and r.installation_id=i.id order by r.chain_position desc limit 1))
  from public.fiscal_sif_installations i join public.fiscal_subjects s on s.id=i.fiscal_subject_id and s.tenant_id=i.tenant_id
  join public.fiscal_pos_bridge_settings c on c.tenant_id=i.tenant_id
  where auth.uid() is not null and i.id=p_installation_id and i.tenant_id=p_tenant_id and i.venue_id=p_venue_id and i.cash_register_id=p_register_id and i.device_id=p_device_id and i.retired_at is null;
$$;

revoke all on function public.pos_restaurant_map(uuid,uuid,uuid,boolean), public.pos_restaurant_order(uuid,uuid,uuid), public.pos_fiscal_preparation(uuid,uuid,uuid,uuid,uuid) from public, anon;
grant execute on function public.pos_restaurant_map(uuid,uuid,uuid,boolean), public.pos_restaurant_order(uuid,uuid,uuid), public.pos_fiscal_preparation(uuid,uuid,uuid,uuid,uuid) to authenticated;
