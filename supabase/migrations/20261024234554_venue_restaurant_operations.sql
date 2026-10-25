-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Keep legacy signatures and historical cash references; share venue layouts and bind new restaurant payments to the authenticated checkout. New RPCs are authenticated-only.

-- Apply during the agreed maintenance window with every cash session closed.
create function pg_temp.require_closed_restaurant_sessions() returns void
language plpgsql as $$
begin
  lock table public.cash_sessions in share row exclusive mode;
  if exists (select 1 from public.cash_sessions where status = 'open') then
    raise exception 'Cierra todas las cajas antes de independizar las mesas del local' using errcode = '55000';
  end if;
end;
$$;
select pg_temp.require_closed_restaurant_sessions();

-- cash_session_id on orders/groups/temporary tables remains creation provenance.
-- It no longer owns their visibility, lifetime, layout or payment destination.
create table public.venue_table_layouts (
  venue_id uuid primary key references public.venues(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  tables jsonb not null default '{}'::jsonb check (jsonb_typeof(tables) = 'object'),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create index venue_table_layouts_tenant_idx on public.venue_table_layouts(tenant_id, venue_id);
create index venue_table_layouts_updated_by_idx on public.venue_table_layouts(updated_by);
alter table public.venue_table_layouts enable row level security;
create policy venue_table_layouts_select on public.venue_table_layouts for select to authenticated
using (public.user_has_venue_access(tenant_id, venue_id));
grant select on public.venue_table_layouts to authenticated;
alter publication supabase_realtime add table public.venue_table_layouts;

create function public.get_venue_table_layout(p_venue_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare venue_row public.venues%rowtype; layout_row public.venue_table_layouts%rowtype;
begin
  select * into venue_row from public.venues where id = p_venue_id;
  if auth.uid() is null or venue_row.id is null
    or not public.user_has_venue_access(venue_row.tenant_id, venue_row.id) then
    raise exception 'Local no disponible' using errcode = '42501';
  end if;
  insert into public.venue_table_layouts(venue_id, tenant_id, tables, updated_by)
  select venue_row.id, venue_row.tenant_id, coalesce(jsonb_object_agg(rt.id::text,
    jsonb_build_object('positionX', rt.position_x, 'positionY', rt.position_y, 'groupId', null)), '{}'::jsonb), auth.uid()
  from public.restaurant_tables rt where rt.tenant_id = venue_row.tenant_id and rt.venue_id = venue_row.id and rt.is_active
  on conflict (venue_id) do nothing;
  select * into layout_row from public.venue_table_layouts where venue_id = venue_row.id;
  return jsonb_build_object('venueId', layout_row.venue_id, 'revision', layout_row.revision,
    'updatedAt', layout_row.updated_at, 'tables', layout_row.tables);
end;
$$;

-- CRM additions/deletions and activation changes invalidate the same shared
-- revision. Remove dead layout members and dissolve singleton compositions.
create function public.sync_venue_table_layout_members() returns trigger
language plpgsql security definer set search_path = '' as $$
declare target_venue uuid; target_id uuid; entry jsonb;
begin
  if tg_op = 'DELETE' then target_venue := old.venue_id; target_id := old.id;
  else target_venue := new.venue_id; target_id := new.id; end if;
  if tg_op <> 'DELETE' and new.is_active then
    entry := jsonb_build_object(target_id::text,jsonb_build_object('positionX',new.position_x,'positionY',new.position_y,'groupId',null));
  else entry := '{}'::jsonb; end if;
  update public.venue_table_layouts l set tables = (
    select coalesce(jsonb_object_agg(item.key,case when item.group_id is not null and item.members < 2
      then jsonb_set(item.value,'{groupId}','null'::jsonb) else item.value end),'{}'::jsonb)
    from (select e.key,e.value,nullif(e.value ->> 'groupId','') group_id,
      count(*) over(partition by nullif(e.value ->> 'groupId','')) members
      from jsonb_each((l.tables - target_id::text) || entry) e) item
  ), revision = revision + 1, updated_by = auth.uid(), updated_at = now()
  where l.venue_id = target_venue;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger sync_venue_table_layout_members after insert or delete or update of is_active on public.restaurant_tables
for each row execute function public.sync_venue_table_layout_members();

-- Reservations survive network failures and are never stolen on a timeout:
-- money may already have entered Cashlogy. Retry the same operation to recover.
create table public.restaurant_checkout_claims (
  operation_id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  venue_id uuid not null references public.venues(id),
  order_group_id uuid not null references public.order_groups(id),
  order_id uuid not null references public.orders(id),
  cash_session_id uuid not null references public.cash_sessions(id),
  device_id uuid not null references public.devices(id),
  user_id uuid not null references auth.users(id),
  action text not null check (action in ('close', 'equal_part', 'selected_items')),
  params jsonb not null,
  active boolean not null default true,
  charging boolean not null default false,
  cancelled boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index restaurant_checkout_active_group_idx on public.restaurant_checkout_claims(order_group_id) where active;
create index restaurant_checkout_session_idx on public.restaurant_checkout_claims(cash_session_id) where active;
create index restaurant_checkout_scope_idx on public.restaurant_checkout_claims(tenant_id, venue_id);
create index restaurant_checkout_order_idx on public.restaurant_checkout_claims(order_id);
create index restaurant_checkout_device_idx on public.restaurant_checkout_claims(device_id);
create index restaurant_checkout_user_idx on public.restaurant_checkout_claims(user_id);
alter table public.restaurant_checkout_claims enable row level security;
create policy restaurant_checkout_claims_select on public.restaurant_checkout_claims for select to authenticated
using (public.user_has_venue_access(tenant_id, venue_id));
grant select on public.restaurant_checkout_claims to authenticated;

-- A single fiscal ticket represents one sale in one checkout. Separate-ticket
-- shares and selected-item payments may each be settled in different checkouts.
alter table public.restaurant_order_equal_splits
  add column settlement_cash_session_id uuid references public.cash_sessions(id);
create index restaurant_equal_split_settlement_idx on public.restaurant_order_equal_splits(settlement_cash_session_id)
where status = 'open' and single_ticket;

create function public.prepare_restaurant_checkout(
  p_operation_id uuid, p_tenant_id uuid, p_venue_id uuid, p_device_id uuid, p_action text, p_params jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  order_row public.orders%rowtype; device_row public.devices%rowtype; session_row public.cash_sessions%rowtype;
  split_row public.restaurant_order_equal_splits%rowtype; prior public.restaurant_checkout_claims%rowtype;
  order_id uuid; session_id uuid;
  economic_params jsonb := p_params - array['allowPending','receivedCents','cashlogyRequestId','cashlogyTransactionId','paymentOperationId'];
begin
  if auth.uid() is null or p_operation_id is null or p_action is null
    or p_action not in ('close','equal_part','selected_items') or jsonb_typeof(p_params) is distinct from 'object'
    or public.user_has_device_access(p_tenant_id, p_venue_id, p_device_id) is not true then
    raise exception 'PAYMENT_OPERATION_FORBIDDEN' using errcode = '42501';
  end if;
  select * into device_row from public.devices where id = p_device_id;
  if device_row.is_active is not true or device_row.can_take_payments is not true
    or (device_row.tenant_id, device_row.venue_id) is distinct from (p_tenant_id, p_venue_id) then
    raise exception 'El dispositivo no puede cobrar en este local' using errcode = '42501';
  end if;
  session_id := coalesce(nullif(p_params ->> 'cashSessionId','')::uuid, device_row.active_cash_session_id);
  select * into prior from public.restaurant_checkout_claims where operation_id = p_operation_id;
  if prior.operation_id is not null then
    if (prior.tenant_id,prior.venue_id,prior.device_id,prior.user_id,prior.cash_session_id,prior.action,prior.params)
      is distinct from (p_tenant_id,p_venue_id,p_device_id,auth.uid(),session_id,p_action,economic_params) then
      raise exception 'PAYMENT_OPERATION_CONFLICT' using errcode = '23505';
    end if;
    if prior.cancelled then raise exception 'Este intento de cobro se canceló. Inicia un cobro nuevo.' using errcode = '55000'; end if;
    -- Completed operations remain replayable after closing their cash session.
    if not prior.active then return; end if;
    order_id := prior.order_id;
  elsif p_action = 'equal_part' then
    select s.order_id into order_id from public.restaurant_order_equal_splits s
    where s.id = (p_params ->> 'splitId')::uuid and s.tenant_id = p_tenant_id and s.venue_id = p_venue_id;
  else order_id := (p_params ->> 'orderId')::uuid;
  end if;
  select * into order_row from public.orders where id = order_id and tenant_id = p_tenant_id and venue_id = p_venue_id;
  if order_row.id is null then raise exception 'PAYMENT_ORDER_FORBIDDEN' using errcode = '42501'; end if;
  -- Match the economic routines: group -> orders -> checkout session.
  perform 1 from public.order_groups where id = order_row.order_group_id for update;
  perform 1 from public.orders where order_group_id = order_row.order_group_id order by id for update;
  select * into order_row from public.orders where id = order_id;
  if order_row.status <> 'open' then raise exception 'La comanda ya no está abierta' using errcode = '55000'; end if;
  if exists(select 1 from public.restaurant_checkout_claims where order_group_id = order_row.order_group_id
    and active and operation_id <> p_operation_id) then
    raise exception 'Esta cuenta tiene un cobro en curso en otro terminal. Finalízalo o recupéralo allí.' using errcode = '55000';
  end if;
  if prior.operation_id is null and p_params ? 'expectedRevision'
    and order_row.revision is distinct from (p_params ->> 'expectedRevision')::integer then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  if p_action = 'equal_part' then
    select * into split_row from public.restaurant_order_equal_splits where id = (p_params ->> 'splitId')::uuid for update;
    if split_row.status <> 'open' or (prior.operation_id is null and p_params ? 'expectedPaidParts'
      and split_row.paid_parts is distinct from (p_params ->> 'expectedPaidParts')::integer) then
      raise exception 'El reparto ha cambiado en otro dispositivo' using errcode = '40001';
    end if;
    if split_row.single_ticket and split_row.paid_parts > 0
      and split_row.settlement_cash_session_id is distinct from session_id then
      raise exception 'Completa este reparto con ticket único en la caja que recibió el primer pago' using errcode = '55000';
    end if;
  end if;
  select * into session_row from public.cash_sessions where id = session_id for update;
  if session_row.id is null or session_row.status <> 'open'
    or (session_row.tenant_id,session_row.venue_id) is distinct from (p_tenant_id,p_venue_id)
    or device_row.active_cash_session_id is distinct from session_row.id then
    raise exception 'Selecciona una caja abierta de este local para cobrar' using errcode = '42501';
  end if;
  insert into public.restaurant_checkout_claims(operation_id,tenant_id,venue_id,order_group_id,order_id,cash_session_id,device_id,user_id,action,params)
  values(p_operation_id,p_tenant_id,p_venue_id,order_row.order_group_id,order_row.id,session_row.id,p_device_id,auth.uid(),p_action,economic_params)
  on conflict (operation_id) do nothing;
  perform set_config('app.restaurant_checkout_session',session_row.id::text,true);
  perform set_config('app.restaurant_checkout_device',p_device_id::text,true);
  perform set_config('app.restaurant_checkout_operation',p_operation_id::text,true);
end;
$$;

create function public.start_restaurant_checkout(p_operation_id uuid, p_device_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.restaurant_checkout_claims where operation_id = p_operation_id and not active
    and device_id = p_device_id and user_id = auth.uid() and public.user_has_device_access(tenant_id,venue_id,device_id)) then return; end if;
  update public.restaurant_checkout_claims set charging = true where operation_id = p_operation_id and active
    and device_id = p_device_id and user_id = auth.uid()
    and public.user_has_device_access(tenant_id,venue_id,device_id);
  if not found then raise exception 'Cobro no disponible' using errcode = '42501'; end if;
end;
$$;

create function public.release_restaurant_checkout(p_operation_id uuid, p_device_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.restaurant_checkout_claims where operation_id = p_operation_id) then return true; end if;
  if exists(select 1 from public.restaurant_checkout_claims where operation_id = p_operation_id and cancelled
    and device_id = p_device_id and user_id = auth.uid() and public.user_has_device_access(tenant_id,venue_id,device_id)) then return true; end if;
  -- Only preflight failures can release a reservation. An uncertain hardware
  -- collection stays reserved until the original durable operation is recovered.
  delete from public.restaurant_checkout_claims where operation_id = p_operation_id and active and not charging
    and device_id = p_device_id and user_id = auth.uid()
    and public.user_has_device_access(tenant_id,venue_id,device_id);
  return found;
end;
$$;

-- Explicit hardware cancellation is different from a timeout: the terminal calls
-- this only after the agent confirmed cancellation/absence. Failed requests keep
-- both the local journal and server reservation for the next recovery attempt.
create function public.cancel_restaurant_checkout(p_operation_id uuid,p_device_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare claim_row public.restaurant_checkout_claims%rowtype;
begin
  select * into claim_row from public.restaurant_checkout_claims where operation_id = p_operation_id;
  if claim_row.operation_id is null then return; end if;
  if claim_row.device_id is distinct from p_device_id or claim_row.user_id is distinct from auth.uid()
    or public.user_has_device_access(claim_row.tenant_id,claim_row.venue_id,p_device_id) is not true then
    raise exception 'Cobro no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups where id = claim_row.order_group_id for update;
  update public.restaurant_checkout_claims set active = false,cancelled = true
  where operation_id = p_operation_id and active;
end;
$$;

create function public.restaurant_checkout_session(p_tenant_id uuid, p_venue_id uuid)
returns public.cash_sessions language plpgsql security definer set search_path = '' as $$
declare session_row public.cash_sessions%rowtype;
begin
  select cs.* into session_row from public.cash_sessions cs join public.restaurant_checkout_claims c on c.cash_session_id = cs.id
  where c.operation_id = nullif(current_setting('app.restaurant_checkout_operation',true),'')::uuid
    and c.active and c.user_id = auth.uid() and c.tenant_id = p_tenant_id and c.venue_id = p_venue_id
    and cs.status = 'open' and cs.tenant_id = p_tenant_id and cs.venue_id = p_venue_id for update of cs;
  if session_row.id is null then raise exception 'Prepara el cobro desde una caja abierta' using errcode = '42501'; end if;
  return session_row;
end;
$$;

create function public.guard_restaurant_checkout_edit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare group_id uuid;
begin
  if tg_table_name = 'orders' then
    if tg_op = 'DELETE' then group_id := old.order_group_id; else group_id := new.order_group_id; end if;
  elsif tg_table_name = 'order_tables' then
    if tg_op = 'DELETE' then group_id := old.order_group_id; else group_id := new.order_group_id; end if;
  else
    select order_group_id into group_id from public.orders where id = case when tg_op = 'DELETE' then old.order_id else new.order_id end;
  end if;
  if exists(select 1 from public.restaurant_checkout_claims where order_group_id = group_id and active
    and operation_id is distinct from nullif(current_setting('app.restaurant_checkout_operation',true),'')::uuid) then
    raise exception 'Esta cuenta tiene un cobro en curso. Finalízalo antes de modificarla.' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger guard_restaurant_checkout_orders before insert or update or delete on public.orders
for each row execute function public.guard_restaurant_checkout_edit();
create trigger guard_restaurant_checkout_lines before insert or update or delete on public.order_lines
for each row execute function public.guard_restaurant_checkout_edit();
create trigger guard_restaurant_checkout_tables before insert or update or delete on public.order_tables
for each row execute function public.guard_restaurant_checkout_edit();

create or replace function public.block_cash_close_with_open_restaurant_orders() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'open' and new.status <> 'open' and exists (
    select 1 from public.restaurant_checkout_claims where cash_session_id = old.id and active
  ) then raise exception 'Finaliza o recupera los cobros en curso antes de cerrar caja' using errcode = '55000'; end if;
  return new;
end;
$$;

create or replace function public.guard_pending_equal_split_cash_session() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'open' and new.status <> 'open' and exists (
    select 1 from public.restaurant_order_equal_splits where settlement_cash_session_id = old.id
    and single_ticket and status = 'open' and paid_parts > 0
  ) then raise exception 'Completa los repartos parcialmente cobrados antes de cerrar caja' using errcode = '55000'; end if;
  return new;
end;
$$;

create or replace function public.deactivate_closed_session_virtual_tables() returns trigger
language plpgsql security definer set search_path = '' as $$
begin return new; end;
$$;

create or replace function public.validate_order_table_virtual_session() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.restaurant_tables t join public.orders o on o.id = new.order_id
    where t.id = new.table_id and t.tenant_id = o.tenant_id and t.venue_id = o.venue_id
      and new.tenant_id = o.tenant_id and new.venue_id = o.venue_id) then
    raise exception 'La mesa y la comanda deben pertenecer al mismo local' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.carry_forward_and_close_cash_session(p_cash_session_id uuid,p_device_id uuid,p_payload jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  select public.close_cash_register_session(p_cash_session_id,p_device_id,p_payload);
$$;
create or replace function public.open_cash_register_session_with_carryovers(p_cash_register_id uuid,p_opening_float_cents integer,p_device_id uuid)
returns uuid language sql security definer set search_path = '' as $$
  select public.open_cash_register_session(p_cash_register_id,p_opening_float_cents,p_device_id);
$$;

-- Previously suspended, wholly unpaid accounts resume as venue accounts.
update public.orders set status = 'open', revision = revision + 1 where status = 'carried_forward';

revoke all on function public.get_venue_table_layout(uuid) from public, anon;
grant execute on function public.get_venue_table_layout(uuid) to authenticated;
revoke all on function public.prepare_restaurant_checkout(uuid,uuid,uuid,uuid,text,jsonb) from public, anon;
grant execute on function public.prepare_restaurant_checkout(uuid,uuid,uuid,uuid,text,jsonb) to authenticated;
revoke all on function public.start_restaurant_checkout(uuid,uuid) from public, anon;
grant execute on function public.start_restaurant_checkout(uuid,uuid) to authenticated;
revoke all on function public.release_restaurant_checkout(uuid,uuid) from public, anon;
grant execute on function public.release_restaurant_checkout(uuid,uuid) to authenticated;
revoke all on function public.cancel_restaurant_checkout(uuid,uuid) from public, anon;
grant execute on function public.cancel_restaurant_checkout(uuid,uuid) to authenticated;
revoke all on function public.restaurant_checkout_session(uuid,uuid) from public, anon, authenticated;

-- The following definitions retain the existing pricing, source-line snapshots,
-- discounts, fiscal chain and idempotency logic, replacing only session ownership.
-- BEGIN VENUE ROUTINES

create or replace function public.capture_ticket_line_catalog_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  line_payload jsonb;
  snapshot_payload jsonb;
  ticket_session uuid;
  ticket_venue uuid;
  source_found boolean := false;
begin
  select t.cash_session_id, t.venue_id into ticket_session, ticket_venue
  from public.tickets t where t.id = new.ticket_id and t.tenant_id = new.tenant_id;

  -- New restaurant payments already identify the exact historical source.
  -- An empty snapshot on that source must not be replaced by another order's.
  if new.source_order_line_id is not null then
    select l.catalog_snapshot into snapshot_payload
    from public.order_lines l join public.orders o on o.id = l.order_id
    where l.id = new.source_order_line_id
      and l.tenant_id = new.tenant_id and o.tenant_id = new.tenant_id
      and l.venue_id = ticket_venue and o.venue_id = ticket_venue
      and l.product_id is not distinct from new.product_id
      and l.variant_id is not distinct from new.variant_id
      and l.unit_price_cents = new.unit_price_cents;
    source_found := found;
  end if;

  if not source_found then
    -- These scalar keys are maintained for old and new offline clients by DB.
    select line into line_payload from public.offline_event_log e
    cross join lateral jsonb_array_elements(e.payload -> 'lines') line
    where e.tenant_id = new.tenant_id and e.event_kind = 'sale_created'
      and e.sale_cash_session_id = ticket_session::text
      and e.sale_ticket_id = new.ticket_id::text and line ->> 'id' = new.id::text
    order by e.created_at desc limit 1;
    snapshot_payload := line_payload -> 'catalogSnapshot';

    -- Compatibility for restaurant clients without source_order_line_id.
    if snapshot_payload is null then
      select (array_agg(l.catalog_snapshot order by l.updated_at desc))[1] into snapshot_payload
      from public.order_lines l join public.orders o on o.id = l.order_id
      where l.tenant_id = new.tenant_id and o.tenant_id = new.tenant_id
        and l.venue_id = ticket_venue and o.venue_id = ticket_venue
          and l.product_id is not distinct from new.product_id
        and l.variant_id is not distinct from new.variant_id
        and l.unit_price_cents = new.unit_price_cents
        and l.catalog_snapshot <> '{}'::jsonb having count(*) = 1;
    end if;
  end if;

  if snapshot_payload is not null then
    new.category_id_snapshot := nullif(snapshot_payload ->> 'categoryId', '')::uuid;
    new.category_name_snapshot := nullif(snapshot_payload ->> 'categoryName', '');
    new.catalog_tab_id_snapshot := nullif(snapshot_payload ->> 'catalogTabId', '')::uuid;
    new.catalog_tab_name_snapshot := nullif(snapshot_payload ->> 'catalogTabName', '');
  end if;
  new.base_price_cents := coalesce(nullif(line_payload ->> 'basePriceCents', '')::integer, new.unit_price_cents);
  new.component_delta_cents := coalesce(nullif(line_payload ->> 'componentDeltaCents', '')::integer, 0);
  new.modifier_delta_cents := coalesce(nullif(line_payload ->> 'modifierDeltaCents', '')::integer, 0);
  new.gross_before_discount_cents := coalesce(nullif(line_payload ->> 'grossBeforeDiscountCents', '')::integer, new.unit_price_cents);
  return new;
exception when others then
  perform public.record_sale_auxiliary_failure(new.tenant_id, (select venue_id from public.tickets where id = new.ticket_id and tenant_id = new.tenant_id), new.id, 'catalog_snapshot', sqlstate);
  new.category_id_snapshot := null;
  new.category_name_snapshot := null;
  new.catalog_tab_id_snapshot := null;
  new.catalog_tab_name_snapshot := null;
  new.base_price_cents := new.unit_price_cents;
  new.component_delta_cents := 0;
  new.modifier_delta_cents := 0;
  new.gross_before_discount_cents := new.unit_price_cents;
  return new;
end;
$$;

create or replace function public.close_cash_register_session(p_cash_session_id uuid, p_device_id uuid, p_payload jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  venue_row public.venues%rowtype;
  register_name text;
  opened_by_name text;
  closed_by_name text;
  closed_time timestamptz := now();
  sales_total integer := 0;
  sales_count integer := 0;
  cash_payments_total integer := 0;
  card_payments_total integer := 0;
  invitation_payments_total integer := 0;
  other_payments_total integer := 0;
  cash_entries_total integer := 0;
  cash_exits_total integer := 0;
  card_cashback_total integer := 0;
  stacker_collections_total integer := 0;
  expected_cash_total integer := 0;
  expected_card_total integer := 0;
  counted_cash_total integer := 0;
  counted_card_total integer := 0;
  counted_invitation_total integer := 0;
  counted_other_total integer := 0;
  final_cash_fund_total integer := 0;
  payments_json jsonb := '[]'::jsonb;
  snapshot jsonb;
begin
  if auth.uid() is null then
    raise exception 'Autenticacion requerida' using errcode = '42501';
  end if;

  select cs.* into session_row
  from public.cash_sessions cs
  where cs.id = p_cash_session_id
  for update;
  select d.* into device_row from public.devices d where d.id = p_device_id;

  if session_row.id is null or session_row.status <> 'open' then
    raise exception 'Caja no disponible';
  end if;
  if device_row.id is null
    or not device_row.is_active
    or device_row.tenant_id <> session_row.tenant_id
    or device_row.venue_id <> session_row.venue_id
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id)
    or not device_row.can_close_cash_session then
    raise exception 'El dispositivo no puede cerrar esta caja' using errcode = '42501';
  end if;


  final_cash_fund_total := coalesce((p_payload ->> 'finalCashFundCents')::integer, 0);
  counted_cash_total := coalesce((p_payload ->> 'countedCashCents')::integer, 0);
  counted_card_total := coalesce((p_payload ->> 'countedCardCents')::integer, 0);
  counted_invitation_total := coalesce((p_payload ->> 'countedInvitationCents')::integer, 0);
  counted_other_total := coalesce((p_payload ->> 'countedOtherCents')::integer, 0);
  if final_cash_fund_total < 0 then
    raise exception 'Fondo final no valido';
  end if;

  select v.* into venue_row from public.venues v where v.id = session_row.venue_id;
  select cr.name into register_name from public.cash_registers cr where cr.id = session_row.cash_register_id;
  select coalesce(p.full_name, 'Usuario') into opened_by_name from public.profiles p where p.id = session_row.opened_by;
  select coalesce(p.full_name, 'Usuario') into closed_by_name from public.profiles p where p.id = auth.uid();

  select coalesce(sum(s.total_cents), 0)::integer, count(*)::integer
    into sales_total, sales_count
  from public.sales s
  join public.tickets t on t.id = s.ticket_id
  where s.cash_session_id = session_row.id
    and t.status = 'paid';

  select
    coalesce(sum(sp.amount_cents) filter (where sp.method = 'cash'), 0)::integer,
    coalesce(sum(sp.amount_cents) filter (where sp.method = 'card'), 0)::integer,
    coalesce(sum(sp.amount_cents) filter (where sp.method = 'invitation'), 0)::integer,
    coalesce(sum(sp.amount_cents) filter (where sp.method not in ('cash', 'card', 'invitation')), 0)::integer
  into cash_payments_total, card_payments_total, invitation_payments_total, other_payments_total
  from public.sale_payments sp
  join public.sales s on s.id = sp.sale_id
  join public.tickets t on t.id = s.ticket_id
  where s.cash_session_id = session_row.id
    and t.status = 'paid';

  select coalesce(jsonb_agg(jsonb_build_object(
    'code', grouped.method,
    'label', case grouped.method
      when 'cash' then 'Efectivo'
      when 'card' then 'Tarjeta'
      when 'invitation' then 'Invitacion'
      when 'other' then 'Otros'
      else grouped.method
    end,
    'amountCents', grouped.amount_cents
  ) order by case grouped.method when 'cash' then 1 when 'card' then 2 when 'invitation' then 7 else 8 end), '[]'::jsonb)
  into payments_json
  from (
    select sp.method, sum(sp.amount_cents)::integer as amount_cents
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
    join public.tickets t on t.id = s.ticket_id
    where s.cash_session_id = session_row.id
      and t.status = 'paid'
    group by sp.method
  ) grouped;

  select
    coalesce(sum(cm.amount_cents) filter (
      where cm.category = 'cash_in'
        or (cm.direction = 'entry' and (cm.category is null or cm.category not in ('cash_in', 'cash_out', 'card_cashback')))
    ), 0)::integer,
    coalesce(sum(cm.amount_cents) filter (
      where cm.category = 'cash_out'
        or (cm.direction = 'exit' and (cm.category is null or cm.category not in ('cash_in', 'cash_out', 'card_cashback')))
    ), 0)::integer,
    coalesce(sum(cm.amount_cents) filter (where cm.category = 'card_cashback'), 0)::integer
  into cash_entries_total, cash_exits_total, card_cashback_total
  from public.cash_movements cm
  where cm.cash_session_id = session_row.id;

  select coalesce(sum(sc.amount_cents), 0)::integer
  into stacker_collections_total
  from public.cash_session_stacker_collections sc
  where sc.cash_session_id = session_row.id;

  expected_cash_total := session_row.opening_float_cents
    + cash_payments_total
    + cash_entries_total
    - cash_exits_total
    - card_cashback_total
    - stacker_collections_total;
  expected_card_total := card_payments_total + card_cashback_total;

  snapshot := jsonb_build_object(
    'reportTitle', 'Informe ' || upper(substr(session_row.id::text, 1, 8)),
    'companyName', venue_row.name,
    'registerName', coalesce(register_name, 'Caja'),
    'shiftLabel', upper(substr(session_row.id::text, 1, 8)),
    'openedAt', session_row.opened_at,
    'closedAt', closed_time,
    'timezone', coalesce(venue_row.timezone, 'Europe/Madrid'),
    'currency', coalesce(venue_row.currency_code, 'EUR'),
    'locale', 'es-ES',
    'openedBy', coalesce(opened_by_name, 'Usuario'),
    'closedBy', coalesce(closed_by_name, 'Usuario'),
    'summary', jsonb_build_object(
      'totalSalesCents', sales_total,
      'salesCount', sales_count,
      'averageSaleCents', case when sales_count = 0 then 0 else round(sales_total::numeric / sales_count)::integer end
    ),
    'payments', payments_json,
    'cashMovements', jsonb_build_object(
      'cashEntriesCents', cash_entries_total,
      'cashExitsCents', cash_exits_total,
      'cardCashbackCents', card_cashback_total,
      'stackerCollectionsCents', stacker_collections_total
    ),
    'cashFund', jsonb_build_object(
      'openingCashFundCents', session_row.opening_float_cents,
      'finalCashFundCents', final_cash_fund_total
    ),
    'expectedAndCounted', jsonb_build_object(
      'expectedCashCents', expected_cash_total,
      'countedCashCents', counted_cash_total,
      'expectedCardCents', expected_card_total,
      'countedCardCents', counted_card_total
    ),
    'differences', jsonb_build_object(
      'cashDifferenceCents', counted_cash_total - expected_cash_total,
      'cardDifferenceCents', counted_card_total - expected_card_total
    )
  );

  update public.cash_sessions as cs set
    status = 'closed',
    closed_at = closed_time,
    closed_by = auth.uid(),
    closed_by_device_id = device_row.id,
    expected_cash_cents = expected_cash_total,
    expected_card_cents = expected_card_total,
    expected_invitation_cents = invitation_payments_total,
    expected_other_cents = other_payments_total,
    counted_cash_cents = counted_cash_total,
    counted_card_cents = counted_card_total,
    counted_invitation_cents = counted_invitation_total,
    counted_other_cents = counted_other_total,
    discrepancy_cents = (counted_cash_total - expected_cash_total)
      + (counted_card_total - expected_card_total)
      + (counted_invitation_total - invitation_payments_total)
      + (counted_other_total - other_payments_total),
    final_cash_fund_cents = final_cash_fund_total,
    notes = nullif(btrim(p_payload ->> 'notes'), ''),
    print_snapshot = snapshot
  where cs.id = session_row.id;

  return jsonb_build_object('id', session_row.id, 'printSnapshot', snapshot);
end;
$$;

create or replace function public.validate_compact_joined_table_layout(p_tables jsonb)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  group_key text;
  member_count integer;
  reached_count integer;
begin
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then
    raise exception 'Distribución de mesas no válida';
  end if;

  if exists (
    with entries as (
      select item.key as table_id,
        nullif(item.value ->> 'groupId', '') as group_id,
        coalesce(rt.area_id, rt.venue_id) as layout_area_id,
        (item.value ->> 'positionX')::numeric as x,
        (item.value ->> 'positionY')::numeric as y,
        rt.width::numeric as width,
        rt.height::numeric as height
      from jsonb_each(p_tables) item
      join public.restaurant_tables rt on rt.id = item.key::uuid
    )
    select 1
    from entries a
    join entries b on a.table_id < b.table_id
    where a.layout_area_id = b.layout_area_id
      and (a.group_id is not null or b.group_id is not null)
      and least(a.x + a.width, b.x + b.width) - greatest(a.x, b.x) > 0.08
      and least(a.y + a.height, b.y + b.height) - greatest(a.y, b.y) > 0.08
  ) then
    raise exception 'Las mesas juntadas no pueden solaparse con otras mesas';
  end if;

  if exists (
    select 1
    from jsonb_each(p_tables) item
    join public.restaurant_tables rt on rt.id = item.key::uuid
    where nullif(item.value ->> 'groupId', '') is not null
    group by item.value ->> 'groupId'
    having count(distinct coalesce(rt.area_id, rt.venue_id)) > 1
  ) then
    raise exception 'No se pueden juntar mesas de zonas distintas';
  end if;

  for group_key in
    select distinct nullif(item.value ->> 'groupId', '')
    from jsonb_each(p_tables) item
    where nullif(item.value ->> 'groupId', '') is not null
  loop
    with recursive members as (
      select item.key as table_id,
        (item.value ->> 'positionX')::numeric as x,
        (item.value ->> 'positionY')::numeric as y,
        rt.width::numeric as width,
        rt.height::numeric as height
      from jsonb_each(p_tables) item
      join public.restaurant_tables rt on rt.id = item.key::uuid
      where item.value ->> 'groupId' = group_key
    ), connected(table_id) as (
      select min(m.table_id) from members m
      union
      select candidate.table_id
      from connected reached
      join members current_member on current_member.table_id = reached.table_id
      join members candidate on candidate.table_id <> current_member.table_id
      where (
        (
          (abs((current_member.x + current_member.width) - candidate.x) <= 0.30
            or abs((candidate.x + candidate.width) - current_member.x) <= 0.30)
          and least(current_member.y + current_member.height, candidate.y + candidate.height)
            - greatest(current_member.y, candidate.y) > 0.20
        ) or (
          (abs((current_member.y + current_member.height) - candidate.y) <= 0.30
            or abs((candidate.y + candidate.height) - current_member.y) <= 0.30)
          and least(current_member.x + current_member.width, candidate.x + candidate.width)
            - greatest(current_member.x, candidate.x) > 0.20
        )
      )
    )
    select (select count(*) from members), (select count(distinct connected.table_id) from connected)
    into member_count, reached_count;

    if member_count < 2 or reached_count <> member_count then
      raise exception 'Las mesas juntadas deben permanecer físicamente pegadas';
    end if;
  end loop;
end;
$$;

create or replace function public.save_venue_table_layout(
  p_venue_id uuid,
  p_expected_revision bigint,
  p_tables jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  session_row public.venues%rowtype;
  layout_row public.venue_table_layouts%rowtype;
  active_count integer;
  supplied_count integer;
begin
  select cs.* into session_row
  from public.venues cs
  where cs.id = p_venue_id
  for update;

  if auth.uid() is null or session_row.id is null
    or not public.user_has_venue_access(session_row.tenant_id, session_row.id) then
    raise exception 'Local no disponible' using errcode = '42501';
  end if;

  perform public.get_venue_table_layout(p_venue_id);
  select l.* into layout_row
  from public.venue_table_layouts l
  where l.venue_id = p_venue_id
  for update;

  if layout_row.revision is distinct from p_expected_revision then
    raise exception 'La distribución ha cambiado en otro dispositivo'
      using errcode = '40001', detail = jsonb_build_object('currentRevision', layout_row.revision)::text;
  end if;
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then
    raise exception 'Distribución no válida';
  end if;

  select count(*) into active_count
  from public.restaurant_tables rt
  where rt.tenant_id = session_row.tenant_id
    and rt.venue_id = session_row.id
    and rt.is_active;

  select count(*) into supplied_count from jsonb_object_keys(p_tables);
  if supplied_count <> active_count or exists (
    select 1
    from jsonb_object_keys(p_tables) supplied(table_id)
    where not exists (
      select 1
      from public.restaurant_tables rt
      where rt.id = supplied.table_id::uuid
        and rt.tenant_id = session_row.tenant_id
        and rt.venue_id = session_row.id
        and rt.is_active

    )
  ) then
    raise exception 'La distribución no contiene exactamente las mesas activas de este local';
  end if;

  if exists (
    select 1
    from jsonb_each(p_tables) item(table_id, value)
    join public.restaurant_tables rt on rt.id = item.table_id::uuid
    where jsonb_typeof(item.value) is distinct from 'object'
      or jsonb_typeof(item.value -> 'positionX') is distinct from 'number'
      or jsonb_typeof(item.value -> 'positionY') is distinct from 'number'
      or (item.value ->> 'positionX')::numeric < 0
      or (item.value ->> 'positionY')::numeric < 0
      or (item.value ->> 'positionX')::numeric > 100 - rt.width
      or (item.value ->> 'positionY')::numeric > 100 - rt.height
  ) then
    raise exception 'Una mesa tiene una posición no válida';
  end if;

  if exists (
    select 1
    from (
      select item.value ->> 'groupId' group_id, count(*) member_count
      from jsonb_each(p_tables) item(table_id, value)
      where nullif(item.value ->> 'groupId', '') is not null
      group by item.value ->> 'groupId'
    ) groups
    where groups.member_count < 2
  ) then
    raise exception 'Los grupos deben contener al menos dos mesas';
  end if;

  if exists (
    select 1
    from jsonb_each(p_tables) item(table_id, value)
    join public.order_tables ot on ot.table_id = item.table_id::uuid and ot.released_at is null
    join public.orders o on o.id = ot.order_id and o.status = 'open'
    where nullif(item.value ->> 'groupId', '') is not null
    group by item.value ->> 'groupId'
    having count(distinct o.id) > 1
  ) then
    raise exception 'No se pueden agrupar mesas con comandas distintas';
  end if;

  perform public.validate_compact_joined_table_layout(p_tables);

  update public.venue_table_layouts l
  set tables = p_tables,
      revision = l.revision + 1,
      updated_by = auth.uid(),
      updated_at = now()
  where l.venue_id = p_venue_id
  returning l.* into layout_row;

  return jsonb_build_object(
    'venueId', layout_row.venue_id,
    'revision', layout_row.revision,
    'updatedAt', layout_row.updated_at,
    'tables', layout_row.tables
  );
end;
$$;

create or replace function public.get_cash_session_table_layout(p_cash_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare session_row public.cash_sessions%rowtype;
begin
  select * into session_row from public.cash_sessions where id = p_cash_session_id;
  if session_row.id is null or auth.uid() is null or not public.user_has_venue_access(session_row.tenant_id,session_row.venue_id) then
    raise exception 'Local no disponible' using errcode = '42501';
  end if;
  return public.get_venue_table_layout(session_row.venue_id) || jsonb_build_object('cashSessionId',session_row.id);
end;
$$;
create or replace function public.save_cash_session_table_layout(p_cash_session_id uuid,p_expected_revision bigint,p_tables jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare session_row public.cash_sessions%rowtype;
begin
  select * into session_row from public.cash_sessions where id = p_cash_session_id;
  if session_row.id is null or auth.uid() is null or not public.user_has_venue_access(session_row.tenant_id,session_row.venue_id) then
    raise exception 'Local no disponible' using errcode = '42501';
  end if;
  return public.save_venue_table_layout(session_row.venue_id,p_expected_revision,p_tables) || jsonb_build_object('cashSessionId',session_row.id);
end;
$$;

create or replace function public.pos_restaurant_map(p_tenant_id uuid, p_venue_id uuid, p_cash_session_id uuid default null, p_include_production boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_timezone text; v_layout jsonb; v_from timestamptz; v_to timestamptz; v_result jsonb; v_assist boolean; v_config jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  select timezone into v_timezone from public.venues where tenant_id=p_tenant_id and id=p_venue_id;
  if v_timezone is null then raise exception 'VENUE_NOT_AVAILABLE' using errcode='42501'; end if;
  v_layout := public.get_venue_table_layout(p_venue_id);
  v_assist := public.tickit_assist_enabled(p_tenant_id,p_venue_id);
  select jsonb_build_object('tenantEnabled',public.tenant_addon_enabled(p_tenant_id,'tickit_assist'),'venueEnabled',coalesce(tickit_assist_enabled,false),'sensitivity',coalesce(tickit_assist_sensitivity,'normal')) into v_config from public.venues where tenant_id=p_tenant_id and id=p_venue_id;
  v_from := (now() at time zone v_timezone)::date::timestamp at time zone v_timezone;
  v_to := ((now() at time zone v_timezone)::date + 1)::timestamp at time zone v_timezone;
  with areas as (select id, tenant_id, venue_id, name, sort_order, is_active, canvas_width, canvas_height, map_elements, created_at, updated_at from public.dining_areas where tenant_id=p_tenant_id and venue_id=p_venue_id and is_active order by sort_order),
  tables as (select id, tenant_id, venue_id, area_id, cash_session_id, name, capacity, shape, position_x, position_y, width, height, is_active, sort_order, reserved_until, reservation_note, created_at, updated_at from public.restaurant_tables where tenant_id=p_tenant_id and venue_id=p_venue_id and is_active order by sort_order),
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

create or replace function public.create_virtual_restaurant_table(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_area_id uuid,
  p_name text,
  p_capacity integer,
  p_shape text default 'square'
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  virtual_count integer;
  new_table_id uuid := gen_random_uuid();
  next_x numeric(8,3);
  next_y numeric(8,3);
begin
  select cs.* into session_row
  from public.cash_sessions cs
  where cs.id = p_cash_session_id
;

  select d.* into device_row
  from public.devices d
  where d.id = p_device_id;

  if session_row.id is null or session_row.status <> 'open'
    or device_row.id is null or not device_row.can_take_orders
    or not public.user_has_device_access(session_row.tenant_id, session_row.venue_id, device_row.id) then
    raise exception 'La caja o el dispositivo no son válidos' using errcode = '42501';
  end if;

  if p_area_id is not null and not exists (
    select 1
    from public.dining_areas da
    where da.id = p_area_id
      and da.tenant_id = session_row.tenant_id
      and da.venue_id = session_row.venue_id
      and da.is_active
  ) then
    raise exception 'La zona seleccionada no está disponible' using errcode = '23514';
  end if;

  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 80 then
    raise exception 'Indica un nombre de mesa válido' using errcode = '22023';
  end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 99 then
    raise exception 'La capacidad debe estar entre 1 y 99' using errcode = '22023';
  end if;
  if p_shape not in ('square', 'rectangle', 'round') then
    raise exception 'La forma de mesa no es válida' using errcode = '22023';
  end if;

  perform public.get_cash_session_table_layout(session_row.id);

  select count(*) into virtual_count
  from public.restaurant_tables rt
  where rt.tenant_id = session_row.tenant_id and rt.venue_id = session_row.venue_id and rt.cash_session_id is not null and rt.is_active
    and rt.area_id is not distinct from p_area_id;

  next_x := 4 + (virtual_count % 6) * 15;
  next_y := 4 + ((virtual_count / 6) % 5) * 17;

  insert into public.restaurant_tables (
    id, tenant_id, venue_id, area_id, cash_session_id, name, capacity, shape,
    position_x, position_y, width, height, sort_order
  ) values (
    new_table_id, session_row.tenant_id, session_row.venue_id, p_area_id, session_row.id,
    btrim(p_name), p_capacity, p_shape, next_x, next_y, 12, 12, virtual_count
  );

  update public.venue_table_layouts l
  set tables = l.tables || jsonb_build_object(
        new_table_id::text,
        jsonb_build_object('positionX', next_x, 'positionY', next_y, 'groupId', null)
      ),
      revision = l.revision + 1,
      updated_by = auth.uid(),
      updated_at = now()
  where l.venue_id = session_row.venue_id;

  return new_table_id;
end;
$$;

create or replace function public.delete_session_virtual_restaurant_table(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_table_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  selected_table public.restaurant_tables%rowtype;
  active_group_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_table_id::text, 0));

  select session.* into session_row
  from public.cash_sessions session
  where session.id = p_cash_session_id
;

  select device.* into device_row
  from public.devices device
  where device.id = p_device_id;

  if session_row.id is null
    or session_row.status <> 'open'
    or device_row.id is null
    or not device_row.can_take_orders
    or not public.user_has_device_access(session_row.tenant_id, session_row.venue_id, device_row.id)
  then
    raise exception 'VIRTUAL_TABLE_DELETE_FORBIDDEN' using errcode = '42501';
  end if;

  select tables.* into selected_table
  from public.restaurant_tables tables
  where tables.id = p_table_id
  for update;

  if selected_table.id is null then return false; end if;
  if selected_table.cash_session_id is null
    or selected_table.tenant_id is distinct from session_row.tenant_id
    or selected_table.venue_id is distinct from session_row.venue_id
  then
    raise exception 'VIRTUAL_TABLE_SESSION_MISMATCH' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.reservation_tables assignment
    join public.reservations reservation on reservation.id = assignment.reservation_id
    where assignment.table_id = selected_table.id
      and (
        reservation.status in ('arrived', 'seated')
        or (reservation.status = 'confirmed' and reservation.ends_at > now())
      )
  ) then
    raise exception 'VIRTUAL_TABLE_HAS_ACTIVE_RESERVATION' using errcode = '55000';
  end if;

  select assignment.order_group_id into active_group_id
  from public.order_tables assignment
  where assignment.table_id = selected_table.id
    and assignment.released_at is null
  order by assignment.joined_at desc
  limit 1;

  if active_group_id is not null then
    perform 1 from public.order_groups groups
    where groups.id = active_group_id
    for update;
    perform 1 from public.orders orders
    where orders.order_group_id = active_group_id
    order by orders.id
    for update;
    perform 1 from public.order_tables assignment
    where assignment.order_group_id = active_group_id
      and assignment.released_at is null
    order by assignment.joined_at, assignment.table_id
    for update;

    if (
      select count(*)
      from public.order_tables assignment
      where assignment.order_group_id = active_group_id
        and assignment.released_at is null
    ) > 1 then
      raise exception 'VIRTUAL_TABLE_JOINED' using errcode = '55000';
    end if;

    if exists (
      select 1 from public.orders orders
      where orders.order_group_id = active_group_id
        and orders.status = 'paid'
    ) or exists (
      select 1 from public.restaurant_order_equal_splits split
      where split.order_group_id = active_group_id
        and split.paid_parts > 0
    ) then
      raise exception 'VIRTUAL_TABLE_HAS_PAYMENTS' using errcode = '55000';
    end if;

    update public.orders orders
    set status = 'cancelled',
        closed_at = now(),
        updated_at = now(),
        revision = orders.revision + 1
    where orders.order_group_id = active_group_id
      and orders.status = 'open';

    update public.order_groups groups
    set status = 'closed',
        closed_at = now(),
        updated_at = now()
    where groups.id = active_group_id
      and groups.status = 'open';

    update public.order_tables assignment
    set released_at = now()
    where assignment.order_group_id = active_group_id
      and assignment.released_at is null;
  end if;

  -- Remove the table from the session layout and dissolve a layout group that
  -- would otherwise be left with a single member.
  update public.venue_table_layouts layout
  set tables = (
        select coalesce(jsonb_object_agg(item.key,
          case
            when item.group_id is not null and item.group_members < 2
              then jsonb_set(item.value, '{groupId}', 'null'::jsonb, true)
            else item.value
          end
        ), '{}'::jsonb)
        from (
          select entry.key,
                 entry.value,
                 nullif(entry.value ->> 'groupId', '') group_id,
                 count(*) over (partition by nullif(entry.value ->> 'groupId', '')) group_members
          from jsonb_each(layout.tables - selected_table.id::text) entry
        ) item
      ),
      revision = layout.revision + 1,
      updated_by = auth.uid(),
      updated_at = now()
  where layout.venue_id = session_row.venue_id;

  delete from public.restaurant_tables tables
  where tables.id = selected_table.id;
  return found;
end;
$$;

create or replace function public.cleanup_virtual_room_restaurant_table(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_table_id uuid,
  p_close_as_paid boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  selected_table public.restaurant_tables%rowtype;
  active_group_id uuid;
  cleanup_table_ids uuid[];
  cleanup_table_keys text[];
  deleted_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_table_id::text, 0));

  select session.* into session_row
  from public.cash_sessions session
  where session.id = p_cash_session_id
;

  select device.* into device_row
  from public.devices device
  where device.id = p_device_id;

  if session_row.id is null
    or session_row.status <> 'open'
    or device_row.id is null
    or not device_row.can_take_orders
    or not public.user_has_device_access(session_row.tenant_id, session_row.venue_id, device_row.id)
  then
    raise exception 'VIRTUAL_TABLE_CLEANUP_FORBIDDEN' using errcode = '42501';
  end if;

  select tables.* into selected_table
  from public.restaurant_tables tables
  where tables.id = p_table_id
  for update;

  if selected_table.id is null then return false; end if;
  if selected_table.cash_session_id is null
    or selected_table.tenant_id is distinct from session_row.tenant_id
    or selected_table.venue_id is distinct from session_row.venue_id
  then
    raise exception 'VIRTUAL_TABLE_CLEANUP_SESSION_MISMATCH' using errcode = '55000';
  end if;

  -- This is the important distinction: a session table with a physical area
  -- is temporary but reusable, whereas an unplaced table belongs to Virtual.
  if selected_table.area_id is not null then return false; end if;

  select assignment.order_group_id into active_group_id
  from public.order_tables assignment
  where assignment.table_id = selected_table.id
    and assignment.released_at is null
  order by assignment.joined_at desc
  limit 1;

  cleanup_table_ids := array[selected_table.id];

  if active_group_id is not null then
    perform 1 from public.order_groups groups
    where groups.id = active_group_id
    for update;
    perform 1 from public.orders orders
    where orders.order_group_id = active_group_id
    order by orders.id
    for update;
    perform 1 from public.order_lines lines
    join public.orders orders on orders.id = lines.order_id
    where orders.order_group_id = active_group_id
    order by lines.id
    for update of lines;
    perform 1 from public.order_tables assignment
    where assignment.order_group_id = active_group_id
      and assignment.released_at is null
    order by assignment.joined_at, assignment.table_id
    for update;

    -- The table is still occupied while any order in the joined group has
    -- items. This also prevents deleting a table when only one split is empty.
    if exists (
      select 1
      from public.order_lines lines
      join public.orders orders on orders.id = lines.order_id
      where orders.order_group_id = active_group_id
    ) then
      return false;
    end if;

    select coalesce(array_agg(distinct tables.id), array[selected_table.id])
    into cleanup_table_ids
    from public.order_tables assignment
    join public.restaurant_tables tables on tables.id = assignment.table_id
    where assignment.order_group_id = active_group_id
      and assignment.released_at is null
      and tables.cash_session_id is not null and tables.venue_id = session_row.venue_id
      and tables.area_id is null;
  end if;

  if exists (
    select 1
    from public.reservation_tables assignment
    join public.reservations reservation on reservation.id = assignment.reservation_id
    where assignment.table_id = any(cleanup_table_ids)
      and (
        reservation.status in ('arrived', 'seated')
        or (reservation.status = 'confirmed' and reservation.ends_at > now())
      )
  ) then
    return false;
  end if;

  if active_group_id is not null then
    update public.restaurant_order_equal_splits split
    set status = 'cancelled',
        updated_at = now(),
        revision = split.revision + 1
    where split.order_group_id = active_group_id
      and split.status = 'open';

    update public.orders orders
    set status = case when p_close_as_paid then 'paid' else 'cancelled' end,
        closed_at = now(),
        updated_at = now(),
        revision = orders.revision + 1
    where orders.order_group_id = active_group_id
      and orders.status = 'open';

    update public.order_groups groups
    set status = 'closed',
        closed_at = now(),
        updated_at = now()
    where groups.id = active_group_id
      and groups.status = 'open';

    update public.order_tables assignment
    set released_at = now()
    where assignment.order_group_id = active_group_id
      and assignment.released_at is null;
  end if;

  select coalesce(array_agg(table_id::text), '{}'::text[])
  into cleanup_table_keys
  from unnest(cleanup_table_ids) table_id;

  update public.venue_table_layouts layout
  set tables = (
        select coalesce(jsonb_object_agg(item.key,
          case
            when item.group_id is not null and item.group_members < 2
              then jsonb_set(item.value, '{groupId}', 'null'::jsonb, true)
            else item.value
          end
        ), '{}'::jsonb)
        from (
          select entry.key,
                 entry.value,
                 nullif(entry.value ->> 'groupId', '') group_id,
                 count(*) over (partition by nullif(entry.value ->> 'groupId', '')) group_members
          from jsonb_each(layout.tables - cleanup_table_keys) entry
        ) item
      ),
      revision = layout.revision + 1,
      updated_by = auth.uid(),
      updated_at = now()
  where layout.venue_id = session_row.venue_id;

  delete from public.restaurant_tables tables
  where tables.id = any(cleanup_table_ids)
    and tables.cash_session_id is not null and tables.venue_id = session_row.venue_id
    and tables.area_id is null
    and not exists (
      select 1 from public.order_tables assignment
      where assignment.table_id = tables.id
        and assignment.released_at is null
    );
  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

create or replace function public.close_order_and_create_sale_v2(p_order_id uuid, p_payment_method text DEFAULT NULL::text, p_received_cents integer DEFAULT NULL::integer, p_discount jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  subtotal_cents integer;
  total_cents integer;
  discount_result jsonb;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
  remaining_orders integer;
begin
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  select * into session_row from public.restaurant_checkout_session(order_row.tenant_id,order_row.venue_id);
  select d.* into actor_device from public.devices d where d.id = nullif(current_setting('app.restaurant_checkout_device',true),'')::uuid;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null or not actor_device.can_take_payments then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;
  select coalesce(sum(ol.quantity * ol.unit_price_cents), 0)::integer into subtotal_cents
  from public.order_lines ol where ol.order_id = order_row.id;
  if subtotal_cents <= 0 then raise exception 'No se puede cobrar una comanda vacia'; end if;
  discount_result := public.resolve_ticket_discount(order_row.tenant_id, order_row.venue_id, subtotal_cents, p_discount);
  total_cents := (discount_result ->> 'totalCents')::integer;
  if total_cents = 0 then
    if p_payment_method is not null then raise exception 'Un ticket a cero no requiere metodo de pago'; end if;
  elsif p_payment_method not in ('cash', 'card') then raise exception 'Metodo de pago no valido'; end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < total_cents then raise exception 'Importe recibido insuficiente'; end if;

  insert into public.tickets (id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, status,
    subtotal_cents, discount_id, discount_name, discount_type, discount_value_type, discount_value,
    discount_amount_cents, total_cents, local_created_at)
  values (ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id, order_row.venue_id,
    actor_device.id, auth.uid(), 'paid', subtotal_cents, nullif(discount_result ->> 'discountId', '')::uuid,
    discount_result ->> 'name', discount_result ->> 'type', discount_result ->> 'calculationType',
    nullif(discount_result ->> 'storedValue', '')::numeric, case when discount_result ->> 'type' is null then null
      else nullif(discount_result ->> 'amountCents', '')::integer end, total_cents, now());
  insert into public.ticket_lines (id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name, quantity, source_order_line_id, unit_price_cents, line_total_cents, modifiers)
  select gen_random_uuid(), ol.tenant_id, ticket_id, ol.product_id, ol.variant_id, ol.product_name, ol.variant_name,
    ol.quantity, ol.id, ol.unit_price_cents, ol.quantity * ol.unit_price_cents,
    ol.modifiers || case when ol.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'id', 'mixer:' || ol.mixer_product_id::text, 'groupId', 'mixer', 'name', ol.mixer ->> 'name',
      'priceCents', (ol.mixer ->> 'priceCents')::integer)) end
  from public.order_lines ol where ol.order_id = order_row.id;
  insert into public.sales (id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, total_cents, payment_method, local_created_at)
  values (sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), total_cents, p_payment_method, now());
  if total_cents > 0 then
    insert into public.sale_payments (id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents)
    values (payment_id, order_row.tenant_id, sale_id, p_payment_method, total_cents,
      case when p_payment_method = 'cash' then p_received_cents else null end,
      case when p_payment_method = 'cash' then p_received_cents - total_cents else 0 end);
  end if;
  update public.orders o set status = 'paid', closed_at = now(), updated_at = now() where o.id = order_row.id;
  select count(*) into remaining_orders from public.orders o
    where o.order_group_id = order_row.order_group_id and o.status = 'open';
  if remaining_orders = 0 then
    update public.order_groups set status = 'closed', closed_at = now(), updated_at = now()
      where id = order_row.order_group_id;
    update public.order_tables set released_at = now()
      where order_group_id = order_row.order_group_id and released_at is null;
  end if;
  return jsonb_build_object('orderId', order_row.id, 'ticketId', ticket_id, 'saleId', sale_id,
    'paymentId', case when total_cents > 0 then payment_id else null end, 'totalCents', total_cents,
    'groupClosed', remaining_orders = 0,
    'nextOrderId', (select o.id from public.orders o where o.order_group_id = order_row.order_group_id
      and o.status = 'open' order by o.split_sequence limit 1));
end;
$$;

create or replace function public.pay_restaurant_order_items(p_order_id uuid, p_expected_revision integer, p_items jsonb, p_payment_method text DEFAULT NULL::text, p_received_cents integer DEFAULT NULL::integer, p_allow_pending boolean DEFAULT false, p_discount jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  subtotal_cents integer;
  total_cents integer;
  pending_units numeric(18,3);
  requested_lines integer;
  matched_lines integer;
  next_revision integer;
  discount_result jsonb;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Selecciona al menos un producto' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce((item ->> 'quantity')::numeric, 0) <= 0
      or nullif(item ->> 'lineId', '') is null
  ) then
    raise exception 'La seleccion contiene cantidades no validas' using errcode = '22023';
  end if;

  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;

  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id for update;

  if exists (
    select 1 from public.restaurant_order_equal_splits s
    where s.order_id = order_row.id and s.status = 'open' and s.paid_parts > 0
  ) then
    raise exception 'Esta comanda ya se esta cobrando a partes iguales' using errcode = '23514';
  end if;

  with selected as (
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::numeric(18,3))::numeric(18,3) quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  select count(*)::integer,
    count(ol.id)::integer,
    coalesce(sum(case when ol.id is null then 0 else round(selected.quantity * ol.unit_price_cents)::integer end), 0)::integer,
    coalesce(sum(case when ol.id is null then 0 else greatest(selected.quantity - least(ol.served_quantity, selected.quantity), 0) end), 0)::integer
  into requested_lines, matched_lines, subtotal_cents, pending_units
  from selected left join public.order_lines ol
    on ol.id = selected.line_id and ol.order_id = order_row.id
  where ol.id is null or selected.quantity <= ol.quantity;

  if matched_lines <> requested_lines or exists (
    with selected as (
      select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::numeric(18,3))::numeric(18,3) quantity
      from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
    )
    select 1 from selected join public.order_lines ol on ol.id = selected.line_id
    where ol.order_id <> order_row.id or selected.quantity > ol.quantity
  ) then
    raise exception 'La seleccion ya no coincide con la comanda' using errcode = '40001';
  end if;
  if subtotal_cents <= 0 then raise exception 'No se puede cobrar una seleccion vacia'; end if;
  if pending_units > 0 and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units);
  end if;

  select * into session_row from public.restaurant_checkout_session(order_row.tenant_id,order_row.venue_id);
  select d.* into actor_device from public.devices d where d.id = nullif(current_setting('app.restaurant_checkout_device',true),'')::uuid;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;

  discount_result := public.resolve_ticket_discount(order_row.tenant_id, order_row.venue_id, subtotal_cents, p_discount);
  total_cents := (discount_result ->> 'totalCents')::integer;
  if total_cents = 0 then
    if p_payment_method is not null then raise exception 'Un ticket a cero no requiere metodo de pago'; end if;
  elsif p_payment_method not in ('cash', 'card') then
    raise exception 'Metodo de pago no valido';
  end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < total_cents then
    raise exception 'Importe recibido insuficiente';
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id,
    status, subtotal_cents, discount_id, discount_name, discount_type,
    discount_value_type, discount_value, discount_amount_cents, total_cents, local_created_at
  ) values (
    ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), 'paid', subtotal_cents,
    nullif(discount_result ->> 'discountId', '')::uuid,
    discount_result ->> 'name', discount_result ->> 'type', discount_result ->> 'calculationType',
    nullif(discount_result ->> 'storedValue', '')::numeric,
    case when discount_result ->> 'type' is null then null else nullif(discount_result ->> 'amountCents', '')::integer end,
    total_cents, now()
  );

  with selected as (
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::numeric(18,3))::numeric(18,3) quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  insert into public.ticket_lines (
    id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
    quantity, source_order_line_id, unit_price_cents, line_total_cents, modifiers
  )
  select gen_random_uuid(), ol.tenant_id, ticket_id, ol.product_id, ol.variant_id,
    ol.product_name, ol.variant_name, selected.quantity, ol.id, ol.unit_price_cents,
    round(selected.quantity * ol.unit_price_cents)::integer,
    ol.modifiers || case when ol.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'id', 'mixer:' || ol.mixer_product_id::text, 'groupId', 'mixer', 'name', ol.mixer ->> 'name',
      'priceCents', (ol.mixer ->> 'priceCents')::integer
    )) end
  from selected join public.order_lines ol on ol.id = selected.line_id;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id,
    device_id, user_id, total_cents, payment_method, local_created_at
  ) values (
    sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), total_cents, p_payment_method, now()
  );
  if total_cents > 0 then
    insert into public.sale_payments (
      id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents
    ) values (
      payment_id, order_row.tenant_id, sale_id, p_payment_method, total_cents,
      case when p_payment_method = 'cash' then p_received_cents else null end,
      case when p_payment_method = 'cash' then p_received_cents - total_cents else 0 end
    );
  end if;

  with selected as (
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::numeric(18,3))::numeric(18,3) quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  delete from public.order_lines ol using selected
  where ol.id = selected.line_id and selected.quantity = ol.quantity;

  with selected as (
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::numeric(18,3))::numeric(18,3) quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  update public.order_lines ol set
    quantity = ol.quantity - selected.quantity,
    served_quantity = greatest(0, ol.served_quantity - least(ol.served_quantity, selected.quantity)),
    fully_served_at = case
      when ol.quantity - selected.quantity > 0
        and greatest(0, ol.served_quantity - least(ol.served_quantity, selected.quantity)) = ol.quantity - selected.quantity
      then coalesce(ol.fully_served_at, now()) else null end,
    updated_at = now()
  from selected
  where ol.id = selected.line_id and selected.quantity < ol.quantity;
  update public.restaurant_order_equal_splits
    set status = 'cancelled', updated_at = now(), revision = revision + 1
    where order_id = order_row.id and status = 'open' and paid_parts = 0;
  update public.orders o set revision = o.revision + 1, updated_at = now()
    where o.id = order_row.id returning o.revision into next_revision;

  return jsonb_build_object(
    'requiresConfirmation', false,
    'pendingUnits', pending_units,
    'orderId', order_row.id,
    'revision', next_revision,
    'ticketId', ticket_id,
    'saleId', sale_id,
    'paymentId', case when total_cents > 0 then payment_id else null end,
    'subtotalCents', subtotal_cents,
    'totalCents', total_cents
  );
end;
$$;

create or replace function public.pay_restaurant_order_equal_part(p_split_id uuid, p_payment_method text DEFAULT NULL::text, p_received_cents integer DEFAULT NULL::integer, p_allow_pending boolean DEFAULT false, p_discount jsonb DEFAULT NULL::jsonb, p_use_default_discount boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  split_row public.restaurant_order_equal_splits%rowtype;
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  line_row public.order_lines%rowtype;
  part_number integer;
  part_subtotal integer;
  part_total integer;
  discount_amount integer;
  discount_result jsonb;
  base_amount integer;
  remainder integer;
  part_start integer;
  part_end integer;
  line_start numeric(18,3) := 0;
  line_end numeric(18,3);
  allocated_cents integer;
  allocated_quantity numeric;
  pending_units numeric(18,3);
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
  remaining_orders integer;
  next_order_id uuid;
begin
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id;
  if split_row.id is null or split_row.status <> 'open' then raise exception 'Division no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  perform 1 from public.order_groups og where og.id = split_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = split_row.order_group_id order by o.id for update;
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id for update;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  if split_row.status <> 'open' or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Division no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id for update;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0)::integer into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not split_row.allow_pending_service and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units, 'split', public.restaurant_equal_split_to_json(split_row));
  end if;
  if p_allow_pending and not split_row.allow_pending_service then
    update public.restaurant_order_equal_splits set allow_pending_service = true where id = split_row.id
    returning * into split_row;
  end if;

  select * into session_row from public.restaurant_checkout_session(order_row.tenant_id,order_row.venue_id);
  select d.* into actor_device from public.devices d where d.id = nullif(current_setting('app.restaurant_checkout_device',true),'')::uuid;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;

  base_amount := split_row.total_cents / split_row.part_count;
  remainder := mod(split_row.total_cents, split_row.part_count);
  part_number := split_row.paid_parts + 1;
  part_subtotal := base_amount + case when part_number <= remainder then 1 else 0 end;
  part_start := (part_number - 1) * base_amount + least(part_number - 1, remainder);
  part_end := part_start + part_subtotal;

  if p_use_default_discount and split_row.default_discount is not null then
    discount_amount := (coalesce((split_row.default_discount ->> 'amountCents')::integer, 0) / split_row.part_count)
      + case when part_number <= mod(coalesce((split_row.default_discount ->> 'amountCents')::integer, 0), split_row.part_count) then 1 else 0 end;
    discount_amount := least(part_subtotal, discount_amount);
    if discount_amount = 0 then
      discount_result := jsonb_build_object('amountCents', 0, 'totalCents', part_subtotal);
    elsif split_row.default_discount ->> 'calculationType' = 'percentage' then
      discount_result := split_row.default_discount || jsonb_build_object(
        'amountCents', discount_amount,
        'totalCents', part_subtotal - discount_amount
      );
    else
      discount_result := split_row.default_discount || jsonb_build_object(
        'value', discount_amount,
        'storedValue', discount_amount::numeric / 100,
        'amountCents', discount_amount,
        'totalCents', part_subtotal - discount_amount
      );
    end if;
  else
    discount_result := public.resolve_ticket_discount(
      order_row.tenant_id, order_row.venue_id, part_subtotal, p_discount
    );
    discount_amount := coalesce((discount_result ->> 'amountCents')::integer, 0);
  end if;
  discount_amount := coalesce(discount_amount, 0);
  part_total := part_subtotal - discount_amount;

  if part_total = 0 then
    if p_payment_method is not null then raise exception 'Un ticket a cero no requiere metodo de pago'; end if;
  elsif p_payment_method not in ('cash', 'card') then
    raise exception 'Metodo de pago no valido';
  end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < part_total then
    raise exception 'Importe recibido insuficiente';
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id,
    status, subtotal_cents, discount_id, discount_name, discount_type,
    discount_value_type, discount_value, discount_amount_cents, total_cents,
    local_created_at, equal_split_id, equal_split_part_number
  ) values (
    ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), 'paid', part_subtotal,
    nullif(discount_result ->> 'discountId', '')::uuid,
    discount_result ->> 'name', discount_result ->> 'type',
    discount_result ->> 'calculationType',
    nullif(discount_result ->> 'storedValue', '')::numeric,
    case when discount_result ->> 'type' is null then null else discount_amount end,
    part_total, now(), split_row.id, part_number
  );

  for line_row in select ol.* from public.order_lines ol
    where ol.order_id = order_row.id order by ol.created_at, ol.id
  loop
    line_end := line_start + line_row.quantity * line_row.unit_price_cents;
    allocated_cents := round(greatest(0, least(line_end, part_end) - greatest(line_start, part_start)))::integer;
    if allocated_cents > 0 or (line_end = line_start and part_number = 1) then
      allocated_quantity := case when line_end = line_start then line_row.quantity::numeric
        else line_row.quantity::numeric * allocated_cents::numeric / (line_end - line_start)::numeric end;
      insert into public.ticket_lines (
        id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
        quantity, allocated_quantity, source_order_line_id, unit_price_cents, line_total_cents, modifiers
      ) values (
        gen_random_uuid(), line_row.tenant_id, ticket_id, line_row.product_id, line_row.variant_id,
        line_row.product_name, line_row.variant_name, 1, allocated_quantity, line_row.id,
        allocated_cents, allocated_cents,
        line_row.modifiers || case when line_row.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
          'id', 'mixer:' || line_row.mixer_product_id::text, 'groupId', 'mixer',
          'name', line_row.mixer ->> 'name', 'priceCents', (line_row.mixer ->> 'priceCents')::integer
        )) end
      );
    end if;
    line_start := line_end;
  end loop;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id,
    device_id, user_id, total_cents, payment_method, local_created_at
  ) values (
    sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), part_total, p_payment_method, now()
  );
  if part_total > 0 then
    insert into public.sale_payments (
      id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents
    ) values (
      payment_id, order_row.tenant_id, sale_id, p_payment_method, part_total,
      case when p_payment_method = 'cash' then p_received_cents else null end,
      case when p_payment_method = 'cash' then p_received_cents - part_total else 0 end
    );
  end if;
  insert into public.restaurant_order_equal_split_payments (
    tenant_id, venue_id, split_id, part_number, subtotal_cents,
    discount_amount_cents, discount, amount_cents, payment_method,
    received_cents, change_cents, ticket_id, sale_id
  ) values (
    order_row.tenant_id, order_row.venue_id, split_row.id, part_number, part_subtotal,
    discount_amount, case when discount_result ->> 'type' is null then null else discount_result end,
    part_total, p_payment_method,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - part_total else 0 end,
    ticket_id, sale_id
  );

  update public.restaurant_order_equal_splits s set
    paid_parts = s.paid_parts + 1,
    paid_cents = s.paid_cents + part_subtotal,
    status = case when s.paid_parts + 1 = s.part_count then 'completed' else 'open' end,
    completed_at = case when s.paid_parts + 1 = s.part_count then now() else null end,
    revision = s.revision + 1,
    updated_at = now()
  where s.id = split_row.id returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_part_paid', jsonb_build_object(
    'splitId', split_row.id, 'partNumber', part_number, 'partCount', split_row.part_count,
    'subtotalCents', part_subtotal, 'discountAmountCents', discount_amount,
    'amountCents', part_total, 'ticketId', ticket_id, 'saleId', sale_id
  ));

  if split_row.status = 'completed' then
    perform set_config('app.equal_split_finalizing', split_row.id::text, true);
    update public.orders o set status = 'paid', closed_at = now(), updated_at = now()
    where o.id = order_row.id;
    select count(*) into remaining_orders from public.orders o
    where o.order_group_id = order_row.order_group_id and o.status = 'open';
    if remaining_orders = 0 then
      update public.order_groups set status = 'closed', closed_at = now(), updated_at = now()
      where id = order_row.order_group_id;
      update public.order_tables set released_at = now()
      where order_group_id = order_row.order_group_id and released_at is null;
    else
      select o.id into next_order_id from public.orders o
      where o.order_group_id = order_row.order_group_id and o.status = 'open'
      order by o.split_sequence limit 1;
    end if;
    perform public.record_restaurant_order_event(order_row.id, 'equal_split_completed', jsonb_build_object('splitId', split_row.id));
  end if;

  return jsonb_build_object(
    'requiresConfirmation', false,
    'pendingUnits', pending_units,
    'split', public.restaurant_equal_split_to_json(split_row),
    'ticketId', ticket_id,
    'saleId', sale_id,
    'paymentId', case when part_total > 0 then payment_id else null end,
    'paidAmountCents', part_total,
    'completed', split_row.status = 'completed',
    'nextOrderId', next_order_id
  );
end;
$$;

create or replace function public.pay_restaurant_equal_split_single(p_params jsonb) returns jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  p_split_id uuid := (p_params ->> 'splitId')::uuid;
  p_payment_method text := p_params ->> 'method';
  p_received_cents integer := (p_params ->> 'receivedCents')::integer;
  p_allow_pending boolean := coalesce((p_params ->> 'allowPending')::boolean, false);
  p_discount jsonb := p_params -> 'discount';
  p_use_default_discount boolean := coalesce((p_params ->> 'useDefaultDiscount')::boolean, true);
  v_device uuid := (p_params ->> 'deviceId')::uuid;
  v_subtotal integer;
  v_total integer;
  v_discount integer;
  v_method text;
  split_row public.restaurant_order_equal_splits%rowtype;
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  line_row public.order_lines%rowtype;
  part_number integer;
  part_subtotal integer;
  part_total integer;
  discount_amount integer;
  discount_result jsonb;
  base_amount integer;
  remainder integer;
  pending_units numeric(18,3);
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
  remaining_orders integer;
  next_order_id uuid;
begin
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id;
  if split_row.id is null or split_row.status <> 'open' then raise exception 'Division no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  perform 1 from public.order_groups og where og.id = split_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = split_row.order_group_id order by o.id for update;
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id for update;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  if split_row.single_ticket is not true or auth.uid() is null
    or split_row.paid_parts is distinct from (p_params ->> 'expectedPaidParts')::integer then
    raise exception 'El reparto ha cambiado. Actualiza antes de cobrar.' using errcode = '40001';
  end if;
  if split_row.status <> 'open' or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Division no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id for update;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0) into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not split_row.allow_pending_service and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units, 'split', public.restaurant_equal_split_single_snapshot(split_row));
  end if;
  if p_allow_pending and not split_row.allow_pending_service then
    update public.restaurant_order_equal_splits set allow_pending_service = true where id = split_row.id
    returning * into split_row;
  end if;

  select * into session_row from public.restaurant_checkout_session(order_row.tenant_id,order_row.venue_id);
  select d.* into actor_device from public.devices d where d.id = nullif(current_setting('app.restaurant_checkout_device',true),'')::uuid;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;

  if split_row.paid_parts = 0 then
    update public.restaurant_order_equal_splits set settlement_cash_session_id = session_row.id where id = split_row.id;
  elsif split_row.settlement_cash_session_id is distinct from session_row.id then
    raise exception 'Completa este reparto con ticket único en la caja que recibió el primer pago' using errcode = '55000';
  end if;
  base_amount := split_row.total_cents / split_row.part_count;
  remainder := mod(split_row.total_cents, split_row.part_count);
  part_number := split_row.paid_parts + 1;
  part_subtotal := base_amount + case when part_number <= remainder then 1 else 0 end;

  if p_use_default_discount and split_row.default_discount is not null then
    discount_amount := (coalesce((split_row.default_discount ->> 'amountCents')::integer, 0) / split_row.part_count)
      + case when part_number <= mod(coalesce((split_row.default_discount ->> 'amountCents')::integer, 0), split_row.part_count) then 1 else 0 end;
    discount_amount := least(part_subtotal, discount_amount);
    if discount_amount = 0 then
      discount_result := jsonb_build_object('amountCents', 0, 'totalCents', part_subtotal);
    elsif split_row.default_discount ->> 'calculationType' = 'percentage' then
      discount_result := split_row.default_discount || jsonb_build_object(
        'amountCents', discount_amount,
        'totalCents', part_subtotal - discount_amount
      );
    else
      discount_result := split_row.default_discount || jsonb_build_object(
        'value', discount_amount,
        'storedValue', discount_amount::numeric / 100,
        'amountCents', discount_amount,
        'totalCents', part_subtotal - discount_amount
      );
    end if;
  else
    discount_result := public.resolve_ticket_discount(
      order_row.tenant_id, order_row.venue_id, part_subtotal, p_discount
    );
    discount_amount := coalesce((discount_result ->> 'amountCents')::integer, 0);
  end if;
  discount_amount := coalesce(discount_amount, 0);
  part_total := part_subtotal - discount_amount;

  if part_total = 0 then
    if p_payment_method is not null then raise exception 'Un ticket a cero no requiere metodo de pago'; end if;
  elsif p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Metodo de pago no valido';
  end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < part_total then
    raise exception 'Importe recibido insuficiente';
  end if;

  insert into public.restaurant_equal_split_tenders (
    id, tenant_id, venue_id, split_id, part_number, subtotal_cents, discount_amount_cents,
    discount, amount_cents, method, received_cents, change_cents, device_id, user_id,
    cashlogy_request_id, cashlogy_transaction_id
  ) values (
    payment_id, order_row.tenant_id, order_row.venue_id, split_row.id, part_number,
    part_subtotal, discount_amount, case when discount_result ->> 'type' is null then null else discount_result end,
    part_total, p_payment_method,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - part_total else 0 end,
    actor_device.id, auth.uid(), nullif(p_params ->> 'cashlogyRequestId',''), nullif(p_params ->> 'cashlogyTransactionId','')
  );
  ticket_id := null;
  sale_id := null;
  if part_number = split_row.part_count then
    ticket_id := gen_random_uuid(); sale_id := gen_random_uuid();
    select sum(subtotal_cents), sum(amount_cents), sum(discount_amount_cents),
      case when count(distinct method) = 1 then min(method) else null end
    into v_subtotal, v_total, v_discount, v_method
    from public.restaurant_equal_split_tenders where split_id = split_row.id;
    if v_subtotal is distinct from split_row.total_cents then
      raise exception 'El importe del reparto no coincide con la comanda' using errcode = '22023';
    end if;
    insert into public.tickets (
      id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id,
      status, subtotal_cents, discount_name, discount_type, discount_value_type,
      discount_value, discount_amount_cents, total_cents, local_created_at, equal_split_id
    ) values (
      ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id,
      order_row.venue_id, actor_device.id, auth.uid(), 'paid', v_subtotal,
      case when v_discount > 0 then 'Descuentos por comensal' else null end,
      case when v_discount > 0 then 'manual' else null end,
      case when v_discount > 0 then 'fixed' else null end,
      case when v_discount > 0 then v_discount::numeric / 100 else null end,
      case when v_discount > 0 then v_discount else null end, v_total, now(), split_row.id
    );
    for line_row in select ol.* from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id loop
      insert into public.ticket_lines (
        id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
        quantity, unit_price_cents, line_total_cents, modifiers, source_order_line_id
      ) values (
        gen_random_uuid(), line_row.tenant_id, ticket_id, line_row.product_id, line_row.variant_id,
        line_row.product_name, line_row.variant_name, line_row.quantity, line_row.unit_price_cents,
        round(line_row.quantity * line_row.unit_price_cents)::integer,
        line_row.modifiers || case when line_row.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
          'id','mixer:' || line_row.mixer_product_id::text,'groupId','mixer',
          'name',line_row.mixer ->> 'name','priceCents',(line_row.mixer ->> 'priceCents')::integer)) end, line_row.id
      );
    end loop;
    insert into public.sales (
      id,tenant_id,ticket_id,cash_session_id,cash_register_id,venue_id,device_id,user_id,total_cents,payment_method,local_created_at
    ) values (sale_id,order_row.tenant_id,ticket_id,session_row.id,session_row.cash_register_id,
      order_row.venue_id,actor_device.id,auth.uid(),v_total,v_method,now());
    insert into public.sale_payments (
      id,tenant_id,sale_id,method,amount_cents,received_cents,change_cents,cashlogy_request_id,cashlogy_transaction_id,created_at,equal_split_part_number
    ) select t.id,t.tenant_id,sale_id,t.method,t.amount_cents,t.received_cents,t.change_cents,t.cashlogy_request_id,t.cashlogy_transaction_id,t.created_at,t.part_number
      from public.restaurant_equal_split_tenders t where t.split_id = split_row.id and t.amount_cents > 0 order by t.part_number;
  end if;

  update public.restaurant_order_equal_splits s set
    paid_parts = s.paid_parts + 1,
    paid_cents = s.paid_cents + part_subtotal,
    status = case when s.paid_parts + 1 = s.part_count then 'completed' else 'open' end,
    completed_at = case when s.paid_parts + 1 = s.part_count then now() else null end,
    revision = s.revision + 1,
    updated_at = now()
  where s.id = split_row.id returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_part_paid', jsonb_build_object(
    'splitId', split_row.id, 'partNumber', part_number, 'partCount', split_row.part_count,
    'subtotalCents', part_subtotal, 'discountAmountCents', discount_amount,
    'amountCents', part_total, 'ticketId', ticket_id, 'saleId', sale_id
  ));

  if split_row.status = 'completed' then
    perform set_config('app.equal_split_finalizing', split_row.id::text, true);
    update public.orders o set status = 'paid', closed_at = now(), updated_at = now()
    where o.id = order_row.id;
    select count(*) into remaining_orders from public.orders o
    where o.order_group_id = order_row.order_group_id and o.status = 'open';
    if remaining_orders = 0 then
      update public.order_groups set status = 'closed', closed_at = now(), updated_at = now()
      where id = order_row.order_group_id;
      update public.order_tables set released_at = now()
      where order_group_id = order_row.order_group_id and released_at is null;
    else
      select o.id into next_order_id from public.orders o
      where o.order_group_id = order_row.order_group_id and o.status = 'open'
      order by o.split_sequence limit 1;
    end if;
    perform public.record_restaurant_order_event(order_row.id, 'equal_split_completed', jsonb_build_object('splitId', split_row.id));
  end if;

  return jsonb_build_object(
    'requiresConfirmation', false,
    'pendingUnits', pending_units,
    'split', public.restaurant_equal_split_single_snapshot(split_row),
    'ticketId', ticket_id,
    'saleId', sale_id,
    'paymentId', case when part_total > 0 then payment_id else null end,
    'paidAmountCents', part_total,
    'totalCents', v_total,
    'singleTicket', true,
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'tenantId',t.tenant_id,'saleId',sale_id,'partNumber',t.part_number,'method',t.method,'amountCents',t.amount_cents,'receivedCents',t.received_cents,'changeCents',t.change_cents,'cashlogyRequestId',t.cashlogy_request_id,'cashlogyTransactionId',t.cashlogy_transaction_id) order by t.part_number),'[]'::jsonb) from public.restaurant_equal_split_tenders t where t.split_id = split_row.id and t.amount_cents > 0),
    'completed', split_row.status = 'completed',
    'nextOrderId', next_order_id
  );
end;
$$;

create or replace function public.pay_restaurant_idempotent(p_operation_id uuid, p_tenant_id uuid, p_venue_id uuid, p_device_id uuid, p_action text, p_params jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare prior public.restaurant_payment_operations%rowtype; answer jsonb; order_id uuid;
begin
  if auth.uid() is null or p_operation_id is null or p_action is null or p_action not in ('close','equal_part','selected_items')
    or jsonb_typeof(p_params) is distinct from 'object'
    or public.user_has_device_access(p_tenant_id, p_venue_id, p_device_id) is not true then
    raise exception 'PAYMENT_OPERATION_FORBIDDEN' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('restaurant-payment:' || p_operation_id::text, 0));
  select * into prior from public.restaurant_payment_operations where operation_id = p_operation_id;
  if prior.operation_id is not null then
    -- Confirmation of pending production is needed before first commit only.
    -- It cannot change the identity of an already committed economic operation.
    if (prior.tenant_id, prior.venue_id, prior.device_id, prior.user_id, prior.action, prior.params - 'allowPending')
      is distinct from (p_tenant_id, p_venue_id, p_device_id, auth.uid(), p_action, p_params - 'allowPending') then
      raise exception 'PAYMENT_OPERATION_CONFLICT' using errcode = '23505';
    end if;
    return prior.result;
  end if;
  if p_action = 'equal_part' then
    select s.order_id into order_id from public.restaurant_order_equal_splits s
      where s.id = (p_params ->> 'splitId')::uuid and s.tenant_id = p_tenant_id and s.venue_id = p_venue_id;
  else order_id := (p_params ->> 'orderId')::uuid;
  end if;
  if not exists(select 1 from public.orders o where o.id = order_id and o.tenant_id = p_tenant_id and o.venue_id = p_venue_id) then
    raise exception 'PAYMENT_ORDER_FORBIDDEN' using errcode = '42501';
  end if;
  perform public.prepare_restaurant_checkout(p_operation_id,p_tenant_id,p_venue_id,p_device_id,p_action,p_params);
  if p_action = 'close' then
    if nullif(p_params ->> 'cashlogyRequestId','') is not null then
      answer := public.close_restaurant_order_cashlogy(order_id, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId', nullif(p_params ->> 'customerId','')::uuid);
    elsif nullif(p_params ->> 'customerId','') is not null then
      answer := public.close_restaurant_order_with_invoice(order_id, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'customerId')::uuid);
    else
      answer := public.close_restaurant_order_checked_v2(order_id, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  elsif p_action = 'equal_part' then
    if nullif(p_params ->> 'cashlogyRequestId','') is not null then
      answer := public.pay_restaurant_order_equal_part_cashlogy((p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'useDefaultDiscount')::boolean,
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      answer := public.pay_restaurant_order_equal_part((p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'useDefaultDiscount')::boolean);
    end if;
  else
    if nullif(p_params ->> 'cashlogyRequestId','') is not null then
      answer := public.pay_restaurant_order_items_cashlogy(order_id, (p_params ->> 'expectedRevision')::integer, p_params -> 'moves',
        p_params ->> 'method', (p_params ->> 'receivedCents')::integer, (p_params ->> 'allowPending')::boolean,
        p_params -> 'discount', p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      answer := public.pay_restaurant_order_items(order_id, (p_params ->> 'expectedRevision')::integer, p_params -> 'moves',
        p_params ->> 'method', (p_params ->> 'receivedCents')::integer, (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  end if;
  if coalesce((answer ->> 'requiresConfirmation')::boolean, false) then return answer; end if;
  insert into public.restaurant_payment_operations(operation_id,tenant_id,venue_id,device_id,user_id,action,params,result)
  values(p_operation_id,p_tenant_id,p_venue_id,p_device_id,auth.uid(),p_action,p_params,answer);
  update public.restaurant_checkout_claims set active = false where operation_id = p_operation_id;
  return answer;
end;
$$;

create or replace function public.pay_restaurant_equal_split_single_idempotent(p_operation_id uuid, p_tenant_id uuid, p_venue_id uuid, p_device_id uuid, p_action text, p_params jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare prior public.restaurant_payment_operations%rowtype; answer jsonb; order_id uuid;
begin
  if auth.uid() is null or p_operation_id is null or p_action is null or p_action not in ('close','equal_part','selected_items')
    or jsonb_typeof(p_params) is distinct from 'object'
    or public.user_has_device_access(p_tenant_id, p_venue_id, p_device_id) is not true then
    raise exception 'PAYMENT_OPERATION_FORBIDDEN' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('restaurant-payment:' || p_operation_id::text, 0));
  select * into prior from public.restaurant_payment_operations where operation_id = p_operation_id;
  if prior.operation_id is not null then
    -- Confirmation of pending production is needed before first commit only.
    -- It cannot change the identity of an already committed economic operation.
    if (prior.tenant_id, prior.venue_id, prior.device_id, prior.user_id, prior.action, prior.params - 'allowPending')
      is distinct from (p_tenant_id, p_venue_id, p_device_id, auth.uid(), p_action, p_params - 'allowPending') then
      raise exception 'PAYMENT_OPERATION_CONFLICT' using errcode = '23505';
    end if;
    return prior.result;
  end if;
  if p_action = 'equal_part' then
    select s.order_id into order_id from public.restaurant_order_equal_splits s
      where s.id = (p_params ->> 'splitId')::uuid and s.tenant_id = p_tenant_id and s.venue_id = p_venue_id;
  else order_id := (p_params ->> 'orderId')::uuid;
  end if;
  if not exists(select 1 from public.orders o where o.id = order_id and o.tenant_id = p_tenant_id and o.venue_id = p_venue_id) then
    raise exception 'PAYMENT_ORDER_FORBIDDEN' using errcode = '42501';
  end if;
  perform public.prepare_restaurant_checkout(p_operation_id,p_tenant_id,p_venue_id,p_device_id,p_action,p_params);
  if p_action = 'close' then
    if nullif(p_params ->> 'cashlogyRequestId','') is not null then
      answer := public.close_restaurant_order_cashlogy(order_id, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId', nullif(p_params ->> 'customerId','')::uuid);
    elsif nullif(p_params ->> 'customerId','') is not null then
      answer := public.close_restaurant_order_with_invoice(order_id, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'customerId')::uuid);
    else
      answer := public.close_restaurant_order_checked_v2(order_id, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  elsif p_action = 'equal_part' then
    if coalesce((p_params ->> 'singleTicket')::boolean,false) then
      answer := public.pay_restaurant_equal_split_single(p_params || jsonb_build_object('deviceId',p_device_id));
    elsif nullif(p_params ->> 'cashlogyRequestId','') is not null then
      answer := public.pay_restaurant_order_equal_part_cashlogy((p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'useDefaultDiscount')::boolean,
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      answer := public.pay_restaurant_order_equal_part((p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount', (p_params ->> 'useDefaultDiscount')::boolean);
    end if;
  else
    if nullif(p_params ->> 'cashlogyRequestId','') is not null then
      answer := public.pay_restaurant_order_items_cashlogy(order_id, (p_params ->> 'expectedRevision')::integer, p_params -> 'moves',
        p_params ->> 'method', (p_params ->> 'receivedCents')::integer, (p_params ->> 'allowPending')::boolean,
        p_params -> 'discount', p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      answer := public.pay_restaurant_order_items(order_id, (p_params ->> 'expectedRevision')::integer, p_params -> 'moves',
        p_params ->> 'method', (p_params ->> 'receivedCents')::integer, (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  end if;
  if coalesce((answer ->> 'requiresConfirmation')::boolean, false) then return answer; end if;
  insert into public.restaurant_payment_operations(operation_id,tenant_id,venue_id,device_id,user_id,action,params,result)
  values(p_operation_id,p_tenant_id,p_venue_id,p_device_id,auth.uid(),p_action,p_params,answer);
  update public.restaurant_checkout_claims set active = false where operation_id = p_operation_id;
  return answer;
end;
$$;

create or replace function public.pay_restaurant_local_fiscal(
  p_action text, p_params jsonb, p_record jsonb, p_invoice jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_installation public.fiscal_sif_installations%rowtype;
  v_subject public.fiscal_subjects%rowtype;
  v_prior public.fiscal_local_records%rowtype;
  v_existing public.fiscal_local_records%rowtype;
  v_series public.fiscal_local_series%rowtype;
  v_canonical jsonb := p_record -> 'canonicalRecord' -> 'RegistroAlta';
  v_type text := v_canonical ->> 'TipoFactura';
  v_idempotency uuid := (p_record ->> 'idempotencyKey')::uuid;
  v_position bigint := (p_record ->> 'chainPosition')::bigint;
  v_previous_hash text := p_record -> 'previous' ->> 'hash';
  v_hash text := p_record ->> 'hash';
  v_number bigint := (p_invoice ->> 'number')::bigint;
  v_series_name text := p_invoice ->> 'series';
  v_issued_at timestamptz := (p_invoice ->> 'issuedAt')::timestamptz;
  v_exercise integer := public.fiscal_series_exercise(v_series_name);
  v_timezone text;
  v_expected_series text;
  v_kind text;
  v_result jsonb;
  v_ticket uuid;
  v_sale uuid;
  v_payment uuid;
  v_total bigint;
  v_customer uuid := nullif(p_params ->> 'customerId', '')::uuid;
begin
  if auth.uid() is null or p_action not in ('close', 'equal_part', 'selected_items')
    or jsonb_typeof(p_params) <> 'object' or jsonb_typeof(p_record) <> 'object'
    or jsonb_typeof(p_invoice) <> 'object' or jsonb_typeof(v_canonical) <> 'object' then
    raise exception 'LOCAL_FISCAL_BAD_REQUEST' using errcode = '22023';
  end if;
  select * into v_existing from public.fiscal_local_records r
    where r.tenant_id = (p_record ->> 'tenantId')::uuid and r.idempotency_key = v_idempotency;
  if v_existing.id is not null then
    if v_existing.record_envelope is distinct from p_record
      or v_existing.invoice_snapshot is distinct from p_invoice
      or v_existing.rpc_result is null then
      raise exception 'LOCAL_FISCAL_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return v_existing.rpc_result;
  end if;
  select * into v_installation from public.fiscal_sif_installations i
    where i.id = (p_record ->> 'installationId')::uuid for update;
  if v_installation.id is null or (v_installation.retired_at is not null and ((p_record ->> 'generatedAt') is null or (p_record ->> 'generatedAt')::timestamptz >= v_installation.retired_at)) or v_installation.mode <> 'production'
    or (v_installation.tenant_id::text, v_installation.venue_id::text,
        v_installation.cash_register_id::text, v_installation.device_id::text)
      is distinct from (p_record ->> 'tenantId', p_record ->> 'venueId',
        p_record ->> 'cashRegisterId', p_record ->> 'deviceId')
    or not public.user_has_device_access(v_installation.tenant_id, v_installation.venue_id, v_installation.device_id) then
    raise exception 'LOCAL_FISCAL_INSTALLATION_FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_subject from public.fiscal_subjects s
    where s.id = v_installation.fiscal_subject_id and s.tenant_id = v_installation.tenant_id;
  select coalesce(v.timezone, 'Europe/Madrid') into v_timezone from public.venues v
    where v.id = v_installation.venue_id and v.tenant_id = v_installation.tenant_id;
  if v_subject.id is null or v_timezone is null
    or p_record ->> 'fiscalSubjectId' <> v_subject.id::text
    or p_record ->> 'issuerNif' <> v_subject.nif
    or p_record ->> 'environment' <> 'production'
    or p_record ->> 'generatedAt' <> p_invoice ->> 'issuedAt'
    or p_record ->> 'canonicalSchema' <> 'aeat-registro-v1'
    or p_record ->> 'invoiceId' <> p_invoice ->> 'invoiceId'
    or coalesce((p_record -> 'lease' ->> 'fencingToken')::bigint, 0) < 1
    or v_hash !~ '^[0-9A-F]{64}$'
    or v_canonical ->> 'Huella' <> v_hash
    or v_canonical -> 'IDFactura' ->> 'IDEmisorFactura' <> v_subject.nif
    or v_canonical -> 'IDFactura' ->> 'NumSerieFactura' <> v_series_name || '/' || v_number::text
    or v_canonical -> 'IDFactura' ->> 'FechaExpedicionFactura'
      <> to_char(v_issued_at at time zone v_timezone, 'DD-MM-YYYY')
    or v_canonical ->> 'FechaHoraHusoGenRegistro' <> p_record ->> 'generatedAt'
    or (v_canonical ->> 'ImporteTotal')::numeric * 100 <> (p_invoice ->> 'totalCents')::numeric then
    raise exception 'LOCAL_FISCAL_RECORD_MISMATCH' using errcode = '22023';
  end if;
  v_kind := case when v_type = 'F1' then 'complete' when v_type = 'F2' then 'simplified' else null end;
  v_expected_series := public.fiscal_installation_series_prefix(v_installation) || '-' || v_exercise::text || '-'
    || case when v_type = 'F1' then 'F' else 'S' end;
  if v_kind is null or v_number < 1 or v_series_name <> v_expected_series
    or v_exercise <> extract(year from v_issued_at at time zone v_timezone)::integer then
    raise exception 'LOCAL_FISCAL_SERIES_MISMATCH' using errcode = '22023';
  end if;
  if (v_type = 'F1' and (v_customer is null
      or p_params -> 'customerSnapshot' ->> 'taxId'
        <> v_canonical -> 'Destinatarios' -> 'IDDestinatario' -> 0 ->> 'NIF'
      or not exists (select 1 from public.customers c where c.id = v_customer and c.tenant_id = v_installation.tenant_id)))
    or (v_type = 'F2' and v_customer is not null) then
    raise exception 'LOCAL_FISCAL_RECIPIENT_MISMATCH' using errcode = '22023';
  end if;
  if exists (select 1 from public.fiscal_integration_settings s
    where s.tenant_id = v_installation.tenant_id and s.enabled) then
    raise exception 'LOCAL_FISCAL_LEGACY_PROVIDER_ENABLED' using errcode = '55000';
  end if;
  select * into v_prior from public.fiscal_local_records r
    where r.tenant_id = v_installation.tenant_id and r.fiscal_subject_id = v_subject.id
      and r.installation_id = v_installation.id
    order by r.chain_position desc limit 1;
  if v_position <> coalesce(v_prior.chain_position, 0) + 1
    or (v_prior.id is null and v_previous_hash is not null)
    or (v_prior.id is null and v_canonical -> 'Encadenamiento' ->> 'PrimerRegistro' is distinct from 'S')
    or (v_prior.id is not null and v_previous_hash is distinct from v_prior.hash)
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'issuerNif') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'IDEmisorFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'IDEmisorFacturaAnulada'))
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'seriesAndNumber') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'NumSerieFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'NumSerieFacturaAnulada'))
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'issueDate') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'FechaExpedicionFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'FechaExpedicionFacturaAnulada'))
    or (v_prior.id is not null and v_canonical -> 'Encadenamiento' -> 'RegistroAnterior' is distinct from
      jsonb_build_object('IDEmisorFactura', p_record -> 'previous' ->> 'issuerNif',
        'NumSerieFactura', p_record -> 'previous' ->> 'seriesAndNumber',
        'FechaExpedicionFactura', p_record -> 'previous' ->> 'issueDate', 'Huella', v_previous_hash)) then
    raise exception 'LOCAL_FISCAL_CHAIN_CONFLICT' using errcode = '23505';
  end if;
  insert into public.fiscal_local_series (
    tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,device_id,
    document_kind,exercise,series
  ) values (v_installation.tenant_id,v_subject.id,v_installation.id,v_installation.venue_id,
    v_installation.cash_register_id,v_installation.device_id,v_kind,v_exercise,v_series_name)
  on conflict (tenant_id,fiscal_subject_id,series) do nothing;
  select * into v_series from public.fiscal_local_series s
    where s.tenant_id = v_installation.tenant_id and s.fiscal_subject_id = v_subject.id
      and s.series = v_series_name for update;
  if v_series.id is null or v_series.installation_id <> v_installation.id
    or v_series.document_kind <> v_kind or v_series.last_number + 1 <> v_number then
    raise exception 'LOCAL_FISCAL_NUMBER_CONFLICT' using errcode = '23505';
  end if;

  perform public.prepare_restaurant_checkout((p_params ->> 'paymentOperationId')::uuid,
    v_installation.tenant_id,v_installation.venue_id,v_installation.device_id,p_action,p_params);
  perform set_config('app.local_fiscal_sale', 'yes', true);
  if p_action = 'close' then
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.close_restaurant_order_cashlogy(
        (p_params ->> 'orderId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId', null);
    else
      v_result := public.close_restaurant_order_checked_v2(
        (p_params ->> 'orderId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  elsif p_action = 'equal_part' then
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.pay_restaurant_order_equal_part_cashlogy(
        (p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        (p_params ->> 'useDefaultDiscount')::boolean,
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      v_result := public.pay_restaurant_order_equal_part(
        (p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        (p_params ->> 'useDefaultDiscount')::boolean);
    end if;
  else
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.pay_restaurant_order_items_cashlogy(
        (p_params ->> 'orderId')::uuid, (p_params ->> 'expectedRevision')::integer,
        p_params -> 'moves', p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      v_result := public.pay_restaurant_order_items(
        (p_params ->> 'orderId')::uuid, (p_params ->> 'expectedRevision')::integer,
        p_params -> 'moves', p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  end if;
  if coalesce((v_result ->> 'requiresConfirmation')::boolean, false) then return v_result; end if;
  v_ticket := (v_result ->> 'ticketId')::uuid;
  v_sale := (v_result ->> 'saleId')::uuid;
  v_payment := nullif(v_result ->> 'paymentId', '')::uuid;
  v_total := (coalesce(v_result ->> 'totalCents', v_result ->> 'paidAmountCents'))::bigint;
  -- Legacy restaurant RPCs choose the first assigned device for the cashier.
  -- Bind the new paid document to the authenticated checkout installation.
  update public.tickets t set device_id = v_installation.device_id
    where t.id = v_ticket and t.tenant_id = v_installation.tenant_id
      and t.venue_id = v_installation.venue_id and t.cash_register_id = v_installation.cash_register_id;
  update public.sales s set device_id = v_installation.device_id
    where s.id = v_sale and s.tenant_id = v_installation.tenant_id
      and s.venue_id = v_installation.venue_id and s.cash_register_id = v_installation.cash_register_id;
  if v_ticket is null or v_sale is null or v_total is null
    or v_total <> (p_invoice ->> 'totalCents')::bigint
    or not exists (select 1 from public.sales s where s.id = v_sale and s.ticket_id = v_ticket
      and s.tenant_id = v_installation.tenant_id and s.venue_id = v_installation.venue_id
      and s.cash_register_id = v_installation.cash_register_id and s.device_id = v_installation.device_id) then
    raise exception 'LOCAL_FISCAL_RESTAURANT_SALE_MISMATCH' using errcode = '22023';
  end if;
  if v_type = 'F1' then
    update public.tickets t set is_invoice = true, customer_id = v_customer,
      customer_snapshot = p_params -> 'customerSnapshot', invoice_series = v_series_name,
      invoice_number = v_number::text, invoice_issued_at = v_issued_at
    where t.id = v_ticket and t.tenant_id = v_installation.tenant_id and t.status = 'paid';
    if not found then raise exception 'LOCAL_FISCAL_TICKET_NOT_STORED' using errcode = '55000'; end if;
  end if;
  insert into public.fiscal_local_records (
    id,tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,
    invoice_id,ticket_id,sale_id,record_kind,chain_position,previous_hash,hash,
    canonical_schema,canonical_record,record_envelope,invoice_snapshot,
    generated_at,idempotency_key,rpc_result
  ) values (v_idempotency,v_installation.tenant_id,v_subject.id,v_installation.id,v_installation.venue_id,
    v_installation.cash_register_id,(p_record ->> 'invoiceId')::uuid,v_ticket,v_sale,'alta',v_position,
    v_previous_hash,v_hash,'aeat-registro-v1',p_record -> 'canonicalRecord',p_record,p_invoice,
    (p_record ->> 'generatedAt')::timestamptz,v_idempotency,v_result);
  update public.fiscal_local_series set last_number = v_number where id = v_series.id;
  update public.restaurant_checkout_claims set active = false where operation_id = (p_params ->> 'paymentOperationId')::uuid;
  return v_result;
end;
$$;

create or replace function public.pay_restaurant_equal_split_single_fiscal(
  p_action text, p_params jsonb, p_record jsonb, p_invoice jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_installation public.fiscal_sif_installations%rowtype;
  v_subject public.fiscal_subjects%rowtype;
  v_prior public.fiscal_local_records%rowtype;
  v_existing public.fiscal_local_records%rowtype;
  v_series public.fiscal_local_series%rowtype;
  v_canonical jsonb := p_record -> 'canonicalRecord' -> 'RegistroAlta';
  v_type text := v_canonical ->> 'TipoFactura';
  v_idempotency uuid := (p_record ->> 'idempotencyKey')::uuid;
  v_position bigint := (p_record ->> 'chainPosition')::bigint;
  v_previous_hash text := p_record -> 'previous' ->> 'hash';
  v_hash text := p_record ->> 'hash';
  v_number bigint := (p_invoice ->> 'number')::bigint;
  v_series_name text := p_invoice ->> 'series';
  v_issued_at timestamptz := (p_invoice ->> 'issuedAt')::timestamptz;
  v_exercise integer := public.fiscal_series_exercise(v_series_name);
  v_timezone text;
  v_expected_series text;
  v_kind text;
  v_result jsonb;
  v_ticket uuid;
  v_sale uuid;
  v_payment uuid;
  v_total bigint;
  v_customer uuid := nullif(p_params ->> 'customerId', '')::uuid;
begin
  if auth.uid() is null or p_action not in ('close', 'equal_part', 'selected_items')
    or jsonb_typeof(p_params) <> 'object' or jsonb_typeof(p_record) <> 'object'
    or jsonb_typeof(p_invoice) <> 'object' or jsonb_typeof(v_canonical) <> 'object' then
    raise exception 'LOCAL_FISCAL_BAD_REQUEST' using errcode = '22023';
  end if;
  select * into v_existing from public.fiscal_local_records r
    where r.tenant_id = (p_record ->> 'tenantId')::uuid and r.idempotency_key = v_idempotency;
  if v_existing.id is not null then
    if v_existing.record_envelope is distinct from p_record
      or v_existing.invoice_snapshot is distinct from p_invoice
      or v_existing.rpc_result is null then
      raise exception 'LOCAL_FISCAL_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return v_existing.rpc_result;
  end if;
  select * into v_installation from public.fiscal_sif_installations i
    where i.id = (p_record ->> 'installationId')::uuid for update;
  if v_installation.id is null or (v_installation.retired_at is not null and ((p_record ->> 'generatedAt') is null or (p_record ->> 'generatedAt')::timestamptz >= v_installation.retired_at)) or v_installation.mode <> 'production'
    or (v_installation.tenant_id::text, v_installation.venue_id::text,
        v_installation.cash_register_id::text, v_installation.device_id::text)
      is distinct from (p_record ->> 'tenantId', p_record ->> 'venueId',
        p_record ->> 'cashRegisterId', p_record ->> 'deviceId')
    or not public.user_has_device_access(v_installation.tenant_id, v_installation.venue_id, v_installation.device_id) then
    raise exception 'LOCAL_FISCAL_INSTALLATION_FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_subject from public.fiscal_subjects s
    where s.id = v_installation.fiscal_subject_id and s.tenant_id = v_installation.tenant_id;
  select coalesce(v.timezone, 'Europe/Madrid') into v_timezone from public.venues v
    where v.id = v_installation.venue_id and v.tenant_id = v_installation.tenant_id;
  if v_subject.id is null or v_timezone is null
    or p_record ->> 'fiscalSubjectId' <> v_subject.id::text
    or p_record ->> 'issuerNif' <> v_subject.nif
    or p_record ->> 'environment' <> 'production'
    or p_record ->> 'generatedAt' <> p_invoice ->> 'issuedAt'
    or p_record ->> 'canonicalSchema' <> 'aeat-registro-v1'
    or p_record ->> 'invoiceId' <> p_invoice ->> 'invoiceId'
    or coalesce((p_record -> 'lease' ->> 'fencingToken')::bigint, 0) < 1
    or v_hash !~ '^[0-9A-F]{64}$'
    or v_canonical ->> 'Huella' <> v_hash
    or v_canonical -> 'IDFactura' ->> 'IDEmisorFactura' <> v_subject.nif
    or v_canonical -> 'IDFactura' ->> 'NumSerieFactura' <> v_series_name || '/' || v_number::text
    or v_canonical -> 'IDFactura' ->> 'FechaExpedicionFactura'
      <> to_char(v_issued_at at time zone v_timezone, 'DD-MM-YYYY')
    or v_canonical ->> 'FechaHoraHusoGenRegistro' <> p_record ->> 'generatedAt'
    or (v_canonical ->> 'ImporteTotal')::numeric * 100 <> (p_invoice ->> 'totalCents')::numeric then
    raise exception 'LOCAL_FISCAL_RECORD_MISMATCH' using errcode = '22023';
  end if;
  v_kind := case when v_type = 'F1' then 'complete' when v_type = 'F2' then 'simplified' else null end;
  v_expected_series := public.fiscal_installation_series_prefix(v_installation) || '-'
    || v_exercise::text || '-'
    || case when v_type = 'F1' then 'F' else 'S' end;
  if v_kind is null or v_number < 1 or v_series_name <> v_expected_series
    or v_exercise <> extract(year from v_issued_at at time zone v_timezone)::integer then
    raise exception 'LOCAL_FISCAL_SERIES_MISMATCH' using errcode = '22023';
  end if;
  if (v_type = 'F1' and (v_customer is null
      or p_params -> 'customerSnapshot' ->> 'taxId'
        <> v_canonical -> 'Destinatarios' -> 'IDDestinatario' -> 0 ->> 'NIF'
      or not exists (select 1 from public.customers c where c.id = v_customer and c.tenant_id = v_installation.tenant_id)))
    or (v_type = 'F2' and v_customer is not null) then
    raise exception 'LOCAL_FISCAL_RECIPIENT_MISMATCH' using errcode = '22023';
  end if;
  if exists (select 1 from public.fiscal_integration_settings s
    where s.tenant_id = v_installation.tenant_id and s.enabled) then
    raise exception 'LOCAL_FISCAL_LEGACY_PROVIDER_ENABLED' using errcode = '55000';
  end if;
  select * into v_prior from public.fiscal_local_records r
    where r.tenant_id = v_installation.tenant_id and r.fiscal_subject_id = v_subject.id
      and r.installation_id = v_installation.id
    order by r.chain_position desc limit 1;
  if v_position <> coalesce(v_prior.chain_position, 0) + 1
    or (v_prior.id is null and v_previous_hash is not null)
    or (v_prior.id is null and v_canonical -> 'Encadenamiento' ->> 'PrimerRegistro' is distinct from 'S')
    or (v_prior.id is not null and v_previous_hash is distinct from v_prior.hash)
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'issuerNif') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'IDEmisorFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'IDEmisorFacturaAnulada'))
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'seriesAndNumber') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'NumSerieFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'NumSerieFacturaAnulada'))
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'issueDate') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'FechaExpedicionFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'FechaExpedicionFacturaAnulada'))
    or (v_prior.id is not null and v_canonical -> 'Encadenamiento' -> 'RegistroAnterior' is distinct from
      jsonb_build_object('IDEmisorFactura', p_record -> 'previous' ->> 'issuerNif',
        'NumSerieFactura', p_record -> 'previous' ->> 'seriesAndNumber',
        'FechaExpedicionFactura', p_record -> 'previous' ->> 'issueDate', 'Huella', v_previous_hash)) then
    raise exception 'LOCAL_FISCAL_CHAIN_CONFLICT' using errcode = '23505';
  end if;
  insert into public.fiscal_local_series (
    tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,device_id,
    document_kind,exercise,series
  ) values (v_installation.tenant_id,v_subject.id,v_installation.id,v_installation.venue_id,
    v_installation.cash_register_id,v_installation.device_id,v_kind,v_exercise,v_series_name)
  on conflict (tenant_id,fiscal_subject_id,series) do nothing;
  select * into v_series from public.fiscal_local_series s
    where s.tenant_id = v_installation.tenant_id and s.fiscal_subject_id = v_subject.id
      and s.series = v_series_name for update;
  if v_series.id is null or v_series.installation_id <> v_installation.id
    or v_series.document_kind <> v_kind or v_series.last_number + 1 <> v_number then
    raise exception 'LOCAL_FISCAL_NUMBER_CONFLICT' using errcode = '23505';
  end if;

  perform public.prepare_restaurant_checkout((p_params ->> 'paymentOperationId')::uuid,
    v_installation.tenant_id,v_installation.venue_id,v_installation.device_id,p_action,p_params);
  perform set_config('app.local_fiscal_sale', 'yes', true);
  if p_action = 'close' then
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.close_restaurant_order_cashlogy(
        (p_params ->> 'orderId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId', null);
    else
      v_result := public.close_restaurant_order_checked_v2(
        (p_params ->> 'orderId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  elsif p_action = 'equal_part' then
    if coalesce((p_params ->> 'singleTicket')::boolean,false) then
      v_result := public.pay_restaurant_equal_split_single(p_params || jsonb_build_object('deviceId',v_installation.device_id));
    elsif nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.pay_restaurant_order_equal_part_cashlogy(
        (p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        (p_params ->> 'useDefaultDiscount')::boolean,
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      v_result := public.pay_restaurant_order_equal_part(
        (p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        (p_params ->> 'useDefaultDiscount')::boolean);
    end if;
  else
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.pay_restaurant_order_items_cashlogy(
        (p_params ->> 'orderId')::uuid, (p_params ->> 'expectedRevision')::integer,
        p_params -> 'moves', p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      v_result := public.pay_restaurant_order_items(
        (p_params ->> 'orderId')::uuid, (p_params ->> 'expectedRevision')::integer,
        p_params -> 'moves', p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  end if;
  if coalesce((v_result ->> 'requiresConfirmation')::boolean, false) then return v_result; end if;
  v_ticket := (v_result ->> 'ticketId')::uuid;
  v_sale := (v_result ->> 'saleId')::uuid;
  v_payment := nullif(v_result ->> 'paymentId', '')::uuid;
  v_total := (coalesce(v_result ->> 'totalCents', v_result ->> 'paidAmountCents'))::bigint;
  -- Legacy restaurant RPCs choose the first assigned device for the cashier.
  -- Bind the new paid document to the authenticated checkout installation.
  update public.tickets t set device_id = v_installation.device_id
    where t.id = v_ticket and t.tenant_id = v_installation.tenant_id
      and t.venue_id = v_installation.venue_id and t.cash_register_id = v_installation.cash_register_id;
  update public.sales s set device_id = v_installation.device_id
    where s.id = v_sale and s.tenant_id = v_installation.tenant_id
      and s.venue_id = v_installation.venue_id and s.cash_register_id = v_installation.cash_register_id;
  if v_ticket is null or v_sale is null or v_total is null
    or v_total <> (p_invoice ->> 'totalCents')::bigint
    or not exists (select 1 from public.sales s where s.id = v_sale and s.ticket_id = v_ticket
      and s.tenant_id = v_installation.tenant_id and s.venue_id = v_installation.venue_id
      and s.cash_register_id = v_installation.cash_register_id and s.device_id = v_installation.device_id) then
    raise exception 'LOCAL_FISCAL_RESTAURANT_SALE_MISMATCH' using errcode = '22023';
  end if;
  if v_type = 'F1' then
    update public.tickets t set is_invoice = true, customer_id = v_customer,
      customer_snapshot = p_params -> 'customerSnapshot', invoice_series = v_series_name,
      invoice_number = v_number::text, invoice_issued_at = v_issued_at
    where t.id = v_ticket and t.tenant_id = v_installation.tenant_id and t.status = 'paid';
    if not found then raise exception 'LOCAL_FISCAL_TICKET_NOT_STORED' using errcode = '55000'; end if;
  end if;
  insert into public.fiscal_local_records (
    id,tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,
    invoice_id,ticket_id,sale_id,record_kind,chain_position,previous_hash,hash,
    canonical_schema,canonical_record,record_envelope,invoice_snapshot,
    generated_at,idempotency_key,rpc_result
  ) values (v_idempotency,v_installation.tenant_id,v_subject.id,v_installation.id,v_installation.venue_id,
    v_installation.cash_register_id,(p_record ->> 'invoiceId')::uuid,v_ticket,v_sale,'alta',v_position,
    v_previous_hash,v_hash,'aeat-registro-v1',p_record -> 'canonicalRecord',p_record,p_invoice,
    (p_record ->> 'generatedAt')::timestamptz,v_idempotency,v_result);
  update public.fiscal_local_series set last_number = v_number where id = v_series.id;
  update public.restaurant_checkout_claims set active = false where operation_id = (p_params ->> 'paymentOperationId')::uuid;
  return v_result;
end;
$$;

revoke all on function public.save_venue_table_layout(uuid,bigint,jsonb) from public, anon;
grant execute on function public.save_venue_table_layout(uuid,bigint,jsonb) to authenticated;
notify pgrst, 'reload schema';
