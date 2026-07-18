-- Divide una ocupacion de mesas en varias comandas cobrables sin duplicar
-- tickets, lineas de cocina ni enlaces activos de mesa.

begin;

create table if not exists public.order_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint order_groups_tenant_venue_unique unique (id, tenant_id, venue_id),
  constraint order_groups_lifecycle_check check (
    (status = 'open' and closed_at is null) or
    (status = 'closed' and closed_at is not null)
  )
);

alter table public.orders add column if not exists order_group_id uuid;
alter table public.orders add column if not exists split_sequence integer not null default 1;

insert into public.order_groups (id, tenant_id, venue_id, cash_session_id, status, opened_at, updated_at, closed_at)
select o.id, o.tenant_id, o.venue_id, o.cash_session_id,
  case when o.status = 'open' then 'open' else 'closed' end,
  o.opened_at, o.updated_at,
  case when o.status = 'open' then null else coalesce(o.closed_at, o.updated_at) end
from public.orders o
where o.order_group_id is null
on conflict (id) do nothing;

update public.orders o set order_group_id = o.id where o.order_group_id is null;

alter table public.orders alter column order_group_id set not null;
alter table public.orders drop constraint if exists orders_order_group_fk;
alter table public.orders add constraint orders_order_group_fk
  foreign key (order_group_id, tenant_id, venue_id)
  references public.order_groups(id, tenant_id, venue_id) on delete restrict;
alter table public.orders drop constraint if exists orders_split_sequence_check;
alter table public.orders add constraint orders_split_sequence_check check (split_sequence >= 1);
create unique index if not exists orders_group_split_sequence_unique
  on public.orders(order_group_id, split_sequence);
create index if not exists orders_open_group_idx
  on public.orders(order_group_id, status) where status = 'open';

alter table public.order_tables add column if not exists order_group_id uuid;
update public.order_tables ot
set order_group_id = o.order_group_id
from public.orders o
where o.id = ot.order_id and ot.order_group_id is null;
alter table public.order_tables alter column order_group_id set not null;
alter table public.order_tables drop constraint if exists order_tables_order_group_fk;
alter table public.order_tables add constraint order_tables_order_group_fk
  foreign key (order_group_id, tenant_id, venue_id)
  references public.order_groups(id, tenant_id, venue_id) on delete restrict;
create index if not exists order_tables_active_group_idx
  on public.order_tables(order_group_id) where released_at is null;

alter table public.order_lines add column if not exists split_from_line_id uuid references public.order_lines(id) on delete set null;
create index if not exists order_lines_split_source_idx on public.order_lines(split_from_line_id)
  where split_from_line_id is not null;

alter table public.order_events drop constraint if exists order_events_event_type_check;
alter table public.order_events add constraint order_events_event_type_check check (event_type in (
  'order_opened', 'order_moved', 'tables_grouped', 'line_added',
  'line_quantity_changed', 'line_partially_served', 'line_fully_served',
  'order_fully_served', 'order_paid', 'order_cancelled',
  'order_split_created', 'line_moved', 'order_split_removed'
));

alter table public.order_groups enable row level security;
drop policy if exists "order_groups_select" on public.order_groups;
create policy "order_groups_select" on public.order_groups for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

grant select on public.order_groups to authenticated;

create or replace function public.audit_restaurant_order_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'orders' then
    if tg_op = 'INSERT' then
      perform public.record_restaurant_order_event(new.id, 'order_opened', jsonb_build_object('guestCount', new.guest_count));
    elsif old.status = 'open' and new.status = 'paid' then
      perform public.record_restaurant_order_event(new.id, 'order_paid');
    elsif old.status = 'open' and new.status = 'cancelled' then
      perform public.record_restaurant_order_event(new.id, 'order_cancelled');
    end if;
    return new;
  end if;

  if tg_table_name = 'order_lines' then
    if tg_op = 'INSERT' then
      if new.split_from_line_id is null then
        perform public.record_restaurant_order_event(new.order_id, 'line_added', jsonb_build_object('lineId', new.id, 'quantity', new.quantity));
      end if;
    else
      if new.quantity is distinct from old.quantity and new.order_id = old.order_id then
        perform public.record_restaurant_order_event(new.order_id, 'line_quantity_changed', jsonb_build_object('lineId', new.id, 'oldQuantity', old.quantity, 'quantity', new.quantity, 'servedQuantity', new.served_quantity));
      end if;
      if new.served_quantity > old.served_quantity and new.order_id = old.order_id then
        perform public.record_restaurant_order_event(
          new.order_id,
          case when new.served_quantity >= new.quantity then 'line_fully_served' else 'line_partially_served' end,
          jsonb_build_object('lineId', new.id, 'unitsMarkedServed', new.served_quantity - old.served_quantity, 'servedQuantity', new.served_quantity, 'quantity', new.quantity)
        );
      end if;
    end if;
    return new;
  end if;

  if tg_table_name = 'order_tables' then
    if tg_op = 'INSERT' and (
      select count(*) from public.order_tables ot
      where ot.order_group_id = new.order_group_id and ot.released_at is null
    ) > 1 then
      perform public.record_restaurant_order_event(new.order_id, 'tables_grouped', jsonb_build_object('tableId', new.table_id));
    elsif tg_op = 'UPDATE' and old.released_at is null and new.released_at is not null
      and exists (select 1 from public.order_groups og where og.id = new.order_group_id and og.status = 'open') then
      perform public.record_restaurant_order_event(new.order_id, 'order_moved', jsonb_build_object('releasedTableId', new.table_id));
    end if;
    return new;
  end if;
  return new;
end;
$$;

create or replace function public.open_restaurant_order(
  p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_table public.restaurant_tables%rowtype;
  new_group_id uuid := gen_random_uuid();
  new_order_id uuid := gen_random_uuid();
  table_count integer;
  locked_count integer;
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
begin
  if coalesce(array_length(p_table_ids, 1), 0) = 0 or p_guest_count < 1 then raise exception 'Seleccion de mesas no valida'; end if;
  select count(distinct value) into table_count from unnest(p_table_ids) as selected(value);
  if table_count <> array_length(p_table_ids, 1) then raise exception 'Hay mesas duplicadas'; end if;
  select rt.* into first_table from public.restaurant_tables rt where rt.id = p_table_ids[1] for update;
  perform 1 from public.restaurant_tables rt where rt.id = any(p_table_ids) order by rt.id for update;
  select count(*) into locked_count from public.restaurant_tables rt where rt.id = any(p_table_ids)
    and rt.tenant_id = first_table.tenant_id and rt.venue_id = first_table.venue_id and rt.is_active
    and (rt.reserved_until is null or rt.reserved_until <= now());
  if first_table.id is null or locked_count <> table_count or exists (
    select 1 from public.order_tables ot where ot.table_id = any(p_table_ids) and ot.released_at is null
  ) then raise exception 'Una de las mesas ya no esta disponible'; end if;
  select cs.* into session_row from public.cash_sessions cs where cs.id = p_cash_session_id for update;
  select d.* into device_row from public.devices d where d.id = p_device_id;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> first_table.tenant_id or session_row.venue_id <> first_table.venue_id
    or device_row.id is null or not device_row.can_take_orders
    or not public.user_has_device_access(session_row.tenant_id, session_row.venue_id, device_row.id) then
    raise exception 'La caja o el dispositivo no son validos' using errcode = '42501';
  end if;
  insert into public.order_groups (id, tenant_id, venue_id, cash_session_id)
  values (new_group_id, first_table.tenant_id, first_table.venue_id, session_row.id);
  insert into public.orders (
    id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id,
    opened_by_device_id, guest_count, order_group_id, split_sequence
  ) values (
    new_order_id, first_table.tenant_id, first_table.venue_id, session_row.id,
    session_row.cash_register_id, auth.uid(), device_row.id, p_guest_count, new_group_id, 1
  );
  insert into public.order_tables (tenant_id, venue_id, order_id, order_group_id, table_id)
  select first_table.tenant_id, first_table.venue_id, new_order_id, new_group_id, value
  from unnest(p_table_ids) as selected(value);
  return new_order_id;
end;
$$;

create or replace function public.group_restaurant_tables(
  p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_table public.restaurant_tables%rowtype;
  anchor_order public.orders%rowtype;
  existing_group_ids uuid[];
  result_order_id uuid;
  table_count integer;
begin
  if coalesce(array_length(p_table_ids, 1), 0) < 2 then raise exception 'Selecciona al menos dos mesas'; end if;
  select count(distinct value) into table_count from unnest(p_table_ids) as selected(value);
  if table_count <> array_length(p_table_ids, 1) then raise exception 'Hay mesas duplicadas'; end if;
  perform 1 from public.restaurant_tables where id = any(p_table_ids) order by id for update;
  select * into base_table from public.restaurant_tables where id = p_table_ids[1];
  if base_table.id is null or not public.user_has_venue_access(base_table.tenant_id, base_table.venue_id) then
    raise exception 'Mesas no disponibles' using errcode = '42501';
  end if;
  if (select count(*) from public.restaurant_tables rt where rt.id = any(p_table_ids)
      and rt.tenant_id = base_table.tenant_id and rt.venue_id = base_table.venue_id and rt.is_active
      and (rt.reserved_until is null or rt.reserved_until <= now())) <> table_count then
    raise exception 'Todas las mesas deben estar activas, no reservadas y en el mismo local';
  end if;
  select array_agg(distinct ot.order_group_id) into existing_group_ids
  from public.order_tables ot join public.order_groups og on og.id = ot.order_group_id
  where ot.table_id = any(p_table_ids) and ot.released_at is null and og.status = 'open';
  if coalesce(array_length(existing_group_ids, 1), 0) > 1 then raise exception 'No se pueden unir dos comandas existentes'; end if;
  if coalesce(array_length(existing_group_ids, 1), 0) = 0 then
    result_order_id := public.open_restaurant_order(p_table_ids, p_guest_count, p_cash_session_id, p_device_id);
  else
    select o.* into anchor_order from public.orders o
    where o.order_group_id = existing_group_ids[1] and o.status = 'open'
    order by o.split_sequence limit 1 for update;
    result_order_id := anchor_order.id;
    insert into public.order_tables (tenant_id, venue_id, order_id, order_group_id, table_id)
    select base_table.tenant_id, base_table.venue_id, anchor_order.id, anchor_order.order_group_id, value
    from unnest(p_table_ids) as selected(value)
    where not exists (
      select 1 from public.order_tables active_link
      where active_link.table_id = selected.value and active_link.released_at is null
    )
    on conflict (order_id, table_id) do update set joined_at = now(), released_at = null,
      order_group_id = excluded.order_group_id;
  end if;
  return result_order_id;
end;
$$;

create or replace function public.move_restaurant_order(p_order_id uuid, p_target_table_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare order_row public.orders%rowtype; target_row public.restaurant_tables%rowtype; anchor_id uuid;
begin
  select * into target_row from public.restaurant_tables where id = p_target_table_id for update;
  select * into order_row from public.orders where id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups where id = order_row.order_group_id for update;
  if target_row.id is null or target_row.tenant_id <> order_row.tenant_id or target_row.venue_id <> order_row.venue_id
    or not target_row.is_active or target_row.reserved_until > now()
    or exists (select 1 from public.order_tables where table_id = target_row.id and released_at is null) then
    raise exception 'La mesa destino no esta libre';
  end if;
  select o.id into anchor_id from public.orders o where o.order_group_id = order_row.order_group_id
    and o.status = 'open' order by o.split_sequence limit 1;
  update public.order_tables set released_at = now()
    where order_group_id = order_row.order_group_id and released_at is null;
  insert into public.order_tables (tenant_id, venue_id, order_id, order_group_id, table_id)
  values (order_row.tenant_id, order_row.venue_id, anchor_id, order_row.order_group_id, target_row.id);
end;
$$;

create or replace function public.move_restaurant_order_lines(
  p_source_order_id uuid,
  p_target_order_id uuid,
  p_expected_source_revision integer,
  p_expected_target_revision integer,
  p_moves jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_order public.orders%rowtype;
  target_order public.orders%rowtype;
  line_row public.order_lines%rowtype;
  move_row record;
  target_id uuid := p_target_order_id;
  next_sequence integer;
  move_quantity integer;
  moved_served integer;
  new_line_id uuid;
  source_cancelled boolean := false;
begin
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) = 0 then
    raise exception 'Selecciona al menos una cantidad para mover' using errcode = '22023';
  end if;

  select o.* into source_order from public.orders o where o.id = p_source_order_id;
  if source_order.id is null or source_order.status <> 'open'
    or not public.user_has_venue_access(source_order.tenant_id, source_order.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups og where og.id = source_order.order_group_id and og.status = 'open' for update;
  perform 1 from public.orders o where o.order_group_id = source_order.order_group_id order by o.id for update;
  select o.* into source_order from public.orders o where o.id = p_source_order_id;
  if source_order.status <> 'open' or source_order.revision <> p_expected_source_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;

  if target_id is null then
    select coalesce(max(o.split_sequence), 0) + 1 into next_sequence
    from public.orders o where o.order_group_id = source_order.order_group_id;
    target_id := gen_random_uuid();
    insert into public.orders (
      id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id,
      opened_by_device_id, guest_count, order_group_id, split_sequence
    ) values (
      target_id, source_order.tenant_id, source_order.venue_id, source_order.cash_session_id,
      source_order.cash_register_id, auth.uid(), source_order.opened_by_device_id,
      source_order.guest_count, source_order.order_group_id, next_sequence
    );
    select o.* into target_order from public.orders o where o.id = target_id;
    perform public.record_restaurant_order_event(target_id, 'order_split_created', jsonb_build_object('sourceOrderId', source_order.id));
  else
    select o.* into target_order from public.orders o where o.id = target_id;
    if target_order.id is null or target_order.status <> 'open'
      or target_order.order_group_id <> source_order.order_group_id or target_order.id = source_order.id then
      raise exception 'La comanda destino no es valida' using errcode = '22023';
    end if;
    if p_expected_target_revision is null or target_order.revision <> p_expected_target_revision then
      raise exception 'La comanda destino ha cambiado en otro dispositivo' using errcode = '40001';
    end if;
  end if;

  for move_row in
    select (value ->> 'lineId')::uuid as line_id, sum((value ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_moves) value
    group by (value ->> 'lineId')::uuid
    order by (value ->> 'lineId')::uuid
  loop
    move_quantity := move_row.quantity;
    if move_quantity < 1 then raise exception 'Las cantidades a mover deben ser positivas' using errcode = '22023'; end if;
    select ol.* into line_row from public.order_lines ol where ol.id = move_row.line_id for update;
    if line_row.id is null or line_row.order_id <> source_order.id or move_quantity > line_row.quantity then
      raise exception 'Una linea ya no tiene la cantidad seleccionada' using errcode = '40001';
    end if;
    moved_served := least(line_row.served_quantity, move_quantity);
    if move_quantity = line_row.quantity then
      update public.order_lines ol set order_id = target_id, updated_at = now() where ol.id = line_row.id;
      new_line_id := line_row.id;
    else
      new_line_id := gen_random_uuid();
      insert into public.order_lines (
        id, tenant_id, venue_id, order_id, product_id, variant_id, product_name,
        variant_name, unit_price_cents, quantity, served_quantity, fully_served_at,
        modifiers, mixer_product_id, mixer, note, created_at, updated_at, split_from_line_id
      ) values (
        new_line_id, line_row.tenant_id, line_row.venue_id, target_id, line_row.product_id,
        line_row.variant_id, line_row.product_name, line_row.variant_name, line_row.unit_price_cents,
        move_quantity, moved_served,
        case when moved_served = move_quantity then line_row.fully_served_at else null end,
        line_row.modifiers, line_row.mixer_product_id, line_row.mixer, line_row.note,
        line_row.created_at, now(), line_row.id
      );
      update public.order_lines ol
      set quantity = ol.quantity - move_quantity,
          served_quantity = ol.served_quantity - moved_served,
          fully_served_at = case when ol.served_quantity - moved_served = ol.quantity - move_quantity
            and ol.quantity - move_quantity > 0 then ol.fully_served_at else null end,
          updated_at = now()
      where ol.id = line_row.id;
    end if;
    perform public.record_restaurant_order_event(source_order.id, 'line_moved', jsonb_build_object(
      'lineId', line_row.id, 'targetLineId', new_line_id, 'targetOrderId', target_id,
      'quantity', move_quantity, 'servedQuantity', moved_served
    ));
    perform public.record_restaurant_order_event(target_id, 'line_moved', jsonb_build_object(
      'lineId', new_line_id, 'sourceLineId', line_row.id, 'sourceOrderId', source_order.id,
      'quantity', move_quantity, 'servedQuantity', moved_served
    ));
  end loop;

  update public.orders o set revision = o.revision + 1, updated_at = now()
  where o.id in (source_order.id, target_id);

  if not exists (select 1 from public.order_lines ol where ol.order_id = source_order.id)
    and exists (select 1 from public.orders o where o.order_group_id = source_order.order_group_id and o.status = 'open' and o.id <> source_order.id) then
    update public.orders o set status = 'cancelled', closed_at = now(), updated_at = now()
    where o.id = source_order.id;
    source_cancelled := true;
    perform public.record_restaurant_order_event(source_order.id, 'order_split_removed', jsonb_build_object('targetOrderId', target_id));
  end if;

  return jsonb_build_object(
    'sourceOrderId', source_order.id,
    'targetOrderId', target_id,
    'sourceCancelled', source_cancelled,
    'sourceRevision', (select o.revision from public.orders o where o.id = source_order.id),
    'targetRevision', (select o.revision from public.orders o where o.id = target_id)
  );
end;
$$;

create or replace function public.cancel_empty_restaurant_order(p_order_id uuid, p_expected_revision integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare order_row public.orders%rowtype; next_revision integer; open_siblings integer;
begin
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups where id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  if exists (select 1 from public.order_lines ol where ol.order_id = order_row.id) then
    raise exception 'La comanda ya contiene productos' using errcode = '23514';
  end if;
  update public.orders o set status = 'cancelled', closed_at = now(), revision = o.revision + 1
    where o.id = order_row.id returning o.revision into next_revision;
  select count(*) into open_siblings from public.orders o
    where o.order_group_id = order_row.order_group_id and o.status = 'open';
  if open_siblings = 0 then
    update public.order_groups set status = 'closed', closed_at = now(), updated_at = now()
      where id = order_row.order_group_id;
    update public.order_tables set released_at = now()
      where order_group_id = order_row.order_group_id and released_at is null;
  end if;
  return next_revision;
end;
$$;

create or replace function public.close_order_and_create_sale_v2(
  p_order_id uuid,
  p_payment_method text default null,
  p_received_cents integer default null,
  p_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id and dua.venue_id = order_row.venue_id
    and dua.is_active and d.is_active limit 1;
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
  insert into public.ticket_lines (id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name, quantity, unit_price_cents, line_total_cents, modifiers)
  select gen_random_uuid(), ol.tenant_id, ticket_id, ol.product_id, ol.variant_id, ol.product_name, ol.variant_name,
    ol.quantity, ol.unit_price_cents, ol.quantity * ol.unit_price_cents,
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

create or replace function public.close_restaurant_order_checked_v2(
  p_order_id uuid,
  p_payment_method text default null,
  p_received_cents integer default null,
  p_allow_pending boolean default false,
  p_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  pending_units integer;
  payment_result jsonb;
begin
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0)::integer into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units);
  end if;
  payment_result := public.close_order_and_create_sale_v2(p_order_id, p_payment_method, p_received_cents, p_discount);
  return payment_result || jsonb_build_object('requiresConfirmation', false, 'pendingUnits', pending_units);
end;
$$;

-- Compatibilidad con clientes anteriores: delegan en el cierre consciente del grupo.
create or replace function public.close_order_and_create_sale(
  p_order_id uuid,
  p_payment_method text,
  p_received_cents integer default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.close_order_and_create_sale_v2(p_order_id, p_payment_method, p_received_cents, null);
$$;

create or replace function public.close_restaurant_order_checked(
  p_order_id uuid,
  p_payment_method text,
  p_received_cents integer default null,
  p_allow_pending boolean default false
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.close_restaurant_order_checked_v2(
    p_order_id, p_payment_method, p_received_cents, p_allow_pending, null
  );
$$;

revoke all on function public.move_restaurant_order_lines(uuid, uuid, integer, integer, jsonb) from public;
grant execute on function public.move_restaurant_order_lines(uuid, uuid, integer, integer, jsonb) to authenticated;
revoke all on function public.close_restaurant_order_checked_v2(uuid, text, integer, boolean, jsonb) from public;
grant execute on function public.close_restaurant_order_checked_v2(uuid, text, integer, boolean, jsonb) to authenticated;
revoke all on function public.close_order_and_create_sale(uuid, text, integer) from public;
revoke all on function public.close_restaurant_order_checked(uuid, text, integer, boolean) from public;
grant execute on function public.close_order_and_create_sale(uuid, text, integer) to authenticated;
grant execute on function public.close_restaurant_order_checked(uuid, text, integer, boolean) to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.order_groups; exception when duplicate_object then null; end;
end $$;

commit;
