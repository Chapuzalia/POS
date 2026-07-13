-- Bloque 2: sincronizacion robusta y seguimiento de productos servidos.
-- Baseline: complete-database.sql + restaurant-tables-block1-migration.sql.

begin;

alter table public.order_lines
add column if not exists served_quantity integer not null default 0;

alter table public.order_lines
add column if not exists fully_served_at timestamptz;

alter table public.order_lines drop constraint if exists order_lines_served_quantity_check;
alter table public.order_lines add constraint order_lines_served_quantity_check
check (served_quantity >= 0 and served_quantity <= quantity);

create index if not exists order_lines_pending_order_idx
on public.order_lines (order_id)
where served_quantity < quantity;

create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  device_id uuid references public.devices(id) on delete set null,
  event_type text not null check (event_type in (
    'order_opened', 'order_moved', 'tables_grouped', 'line_added',
    'line_quantity_changed', 'line_partially_served', 'line_fully_served',
    'order_fully_served', 'order_paid', 'order_cancelled'
  )),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists order_events_order_created_idx
on public.order_events (order_id, created_at desc);
create index if not exists order_events_venue_created_idx
on public.order_events (tenant_id, venue_id, created_at desc);

alter table public.order_events enable row level security;
drop policy if exists "order_events_select" on public.order_events;
create policy "order_events_select" on public.order_events for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

create or replace function public.record_restaurant_order_event(
  p_order_id uuid,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  actor_device_id uuid;
begin
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null then return; end if;

  select dua.device_id into actor_device_id
  from public.device_user_assignments dua
  where dua.tenant_id = order_row.tenant_id
    and dua.venue_id = order_row.venue_id
    and dua.user_id = auth.uid()
    and dua.is_active
  limit 1;

  insert into public.order_events (
    tenant_id, venue_id, order_id, user_id, device_id, event_type, payload
  ) values (
    order_row.tenant_id, order_row.venue_id, order_row.id, auth.uid(),
    actor_device_id, p_event_type, coalesce(p_payload, '{}'::jsonb)
  );
end;
$$;

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
      perform public.record_restaurant_order_event(new.order_id, 'line_added', jsonb_build_object('lineId', new.id, 'quantity', new.quantity));
    else
      if new.quantity is distinct from old.quantity then
        perform public.record_restaurant_order_event(new.order_id, 'line_quantity_changed', jsonb_build_object('lineId', new.id, 'oldQuantity', old.quantity, 'quantity', new.quantity, 'servedQuantity', new.served_quantity));
      end if;
      if new.served_quantity > old.served_quantity then
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
      where ot.order_id = new.order_id and ot.released_at is null
    ) > 1 then
      perform public.record_restaurant_order_event(new.order_id, 'tables_grouped', jsonb_build_object('tableId', new.table_id));
    elsif tg_op = 'UPDATE' and old.released_at is null and new.released_at is not null
      and exists (select 1 from public.orders o where o.id = new.order_id and o.status = 'open') then
      perform public.record_restaurant_order_event(new.order_id, 'order_moved', jsonb_build_object('releasedTableId', new.table_id));
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists audit_restaurant_orders on public.orders;
create trigger audit_restaurant_orders after insert or update on public.orders
for each row execute function public.audit_restaurant_order_change();
drop trigger if exists audit_restaurant_order_lines on public.order_lines;
create trigger audit_restaurant_order_lines after insert or update on public.order_lines
for each row execute function public.audit_restaurant_order_change();
drop trigger if exists audit_restaurant_order_tables on public.order_tables;
create trigger audit_restaurant_order_tables after insert or update on public.order_tables
for each row execute function public.audit_restaurant_order_change();

create or replace function public.mark_order_line_units_served(
  p_order_line_id uuid,
  p_units integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  line_row public.order_lines%rowtype;
  order_row public.orders%rowtype;
  next_served integer;
begin
  if p_units < 1 then raise exception 'La cantidad a servir debe ser positiva'; end if;
  select ol.* into line_row from public.order_lines ol where ol.id = p_order_line_id;
  if line_row.id is null then raise exception 'Linea no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = line_row.order_id for update;
  select ol.* into line_row from public.order_lines ol where ol.id = p_order_line_id for update;
  if line_row.id is null or order_row.status <> 'open' or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  next_served := line_row.served_quantity + p_units;
  if next_served > line_row.quantity then raise exception 'No quedan tantas unidades pendientes'; end if;
  update public.order_lines as ol
  set served_quantity = next_served,
      fully_served_at = case when next_served = ol.quantity then now() else null end
  where ol.id = line_row.id;
  update public.orders as o set revision = o.revision + 1 where o.id = order_row.id;
  return jsonb_build_object('lineId', line_row.id, 'servedQuantity', next_served, 'quantity', line_row.quantity);
end;
$$;

create or replace function public.mark_order_line_fully_served(p_order_line_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  line_row public.order_lines%rowtype;
  order_row public.orders%rowtype;
begin
  select ol.* into line_row from public.order_lines ol where ol.id = p_order_line_id;
  if line_row.id is null then raise exception 'Linea no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = line_row.order_id for update;
  select ol.* into line_row from public.order_lines ol where ol.id = p_order_line_id for update;
  if line_row.id is null or order_row.status <> 'open' or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  if line_row.served_quantity < line_row.quantity then
    update public.order_lines as ol
    set served_quantity = ol.quantity, fully_served_at = now()
    where ol.id = line_row.id;
    update public.orders as o set revision = o.revision + 1 where o.id = order_row.id;
  end if;
  return jsonb_build_object('lineId', line_row.id, 'servedQuantity', line_row.quantity, 'quantity', line_row.quantity);
end;
$$;

create or replace function public.mark_order_fully_served(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  pending_units integer;
begin
  select o.* into order_row from public.orders o where o.id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0)::integer into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 then
    update public.order_lines as ol
    set served_quantity = ol.quantity, fully_served_at = now()
    where ol.order_id = order_row.id and ol.served_quantity < ol.quantity;
    update public.orders as o set revision = o.revision + 1 where o.id = order_row.id;
    perform public.record_restaurant_order_event(order_row.id, 'order_fully_served', jsonb_build_object('unitsMarkedServed', pending_units));
  end if;
  return pending_units;
end;
$$;

create or replace function public.set_restaurant_order_line_quantity(p_line_id uuid, p_quantity integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  line_row public.order_lines%rowtype;
  order_row public.orders%rowtype;
begin
  if p_quantity < 1 then raise exception 'Cantidad no valida'; end if;
  select ol.* into line_row from public.order_lines ol where ol.id = p_line_id;
  if line_row.id is null then raise exception 'Linea no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = line_row.order_id for update;
  select ol.* into line_row from public.order_lines ol where ol.id = p_line_id for update;
  if line_row.id is null or order_row.status <> 'open' or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Linea no disponible' using errcode = '42501';
  end if;
  if p_quantity < line_row.served_quantity then
    raise exception 'No puedes reducir la cantidad por debajo de las unidades servidas';
  end if;
  update public.order_lines as ol
  set quantity = p_quantity,
      fully_served_at = case when p_quantity = ol.served_quantity then coalesce(ol.fully_served_at, now()) else null end
  where ol.id = line_row.id;
  update public.orders as o set revision = o.revision + 1 where o.id = order_row.id;
end;
$$;

create or replace function public.remove_restaurant_order_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  line_row public.order_lines%rowtype;
  order_row public.orders%rowtype;
begin
  select ol.* into line_row from public.order_lines ol where ol.id = p_line_id;
  if line_row.id is null then raise exception 'Linea no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = line_row.order_id for update;
  select ol.* into line_row from public.order_lines ol where ol.id = p_line_id for update;
  if line_row.id is null or order_row.status <> 'open' or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Linea no disponible' using errcode = '42501';
  end if;
  if line_row.served_quantity > 0 then
    raise exception 'No se puede eliminar una linea con productos ya servidos';
  end if;
  delete from public.order_lines as ol where ol.id = line_row.id;
  update public.orders as o set revision = o.revision + 1 where o.id = order_row.id;
end;
$$;

create or replace function public.save_restaurant_order_lines(
  p_order_id uuid,
  p_expected_revision integer,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  existing_line public.order_lines%rowtype;
  line_item jsonb;
  line_id uuid;
  generated_line_id uuid;
  product_value uuid;
  variant_value uuid;
  modifier_ids uuid[];
  quantity_value integer;
  note_value text;
  signature_value text;
  signatures text[] := '{}'::text[];
  retained_ids uuid[] := '{}'::uuid[];
  next_revision integer;
  result_lines jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 500 then
    raise exception 'El borrador de comanda no es valido';
  end if;

  select o.* into order_row from public.orders o where o.id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo'
      using errcode = '40001',
      detail = jsonb_build_object('expectedRevision', p_expected_revision, 'currentRevision', order_row.revision)::text;
  end if;

  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;

  for line_item in select item.value from jsonb_array_elements(p_lines) as item(value)
  loop
    line_id := (line_item ->> 'id')::uuid;
    quantity_value := (line_item ->> 'quantity')::integer;
    note_value := nullif(trim(line_item ->> 'note'), '');
    if quantity_value < 1 or quantity_value > 9999 then raise exception 'Cantidad de linea no valida'; end if;
    if line_id = any(retained_ids) then raise exception 'El borrador contiene IDs de linea duplicados'; end if;

    select ol.* into existing_line
    from public.order_lines ol
    where ol.id = line_id and ol.order_id = order_row.id;

    if existing_line.id is not null then
      if quantity_value < existing_line.served_quantity then
        raise exception 'No puedes reducir la cantidad por debajo de las unidades servidas';
      end if;
      update public.order_lines as ol
      set quantity = quantity_value,
          note = note_value,
          fully_served_at = case
            when quantity_value = ol.served_quantity then coalesce(ol.fully_served_at, now())
            else null
          end
      where ol.id = existing_line.id;
      retained_ids := array_append(retained_ids, existing_line.id);
      continue;
    end if;

    if nullif(line_item ->> 'productId', '') is null or nullif(line_item ->> 'variantId', '') is null then
      raise exception 'No se puede crear una linea sin producto y variante';
    end if;
    product_value := (line_item ->> 'productId')::uuid;
    variant_value := (line_item ->> 'variantId')::uuid;
    select coalesce(array_agg(selected.value::uuid order by selected.value), '{}'::uuid[])
    into modifier_ids
    from jsonb_array_elements_text(coalesce(line_item -> 'modifierIds', '[]'::jsonb)) as selected(value);
    signature_value := concat_ws('|', product_value::text, variant_value::text, array_to_string(modifier_ids, ','), coalesce(note_value, ''));
    if signature_value = any(signatures) then raise exception 'El borrador contiene lineas duplicadas'; end if;
    signatures := array_append(signatures, signature_value);

    generated_line_id := public.add_restaurant_order_line(
      order_row.id, product_value, variant_value, modifier_ids, quantity_value, note_value
    );
    update public.order_lines as ol set id = line_id where ol.id = generated_line_id;
    update public.order_events as oe
    set payload = jsonb_set(oe.payload, '{lineId}', to_jsonb(line_id::text))
    where oe.order_id = order_row.id
      and oe.event_type = 'line_added'
      and oe.payload ->> 'lineId' = generated_line_id::text;
    retained_ids := array_append(retained_ids, line_id);
  end loop;

  if exists (
    select 1 from public.order_lines ol
    where ol.order_id = order_row.id
      and not (ol.id = any(retained_ids))
      and ol.served_quantity > 0
  ) then
    raise exception 'No se puede eliminar una linea con productos ya servidos';
  end if;
  delete from public.order_lines as ol
  where ol.order_id = order_row.id
    and not (ol.id = any(retained_ids));

  update public.orders as o
  set revision = o.revision + 1
  where o.id = order_row.id
  returning o.revision into next_revision;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ol.id, 'tenantId', ol.tenant_id, 'venueId', ol.venue_id,
    'orderId', ol.order_id, 'productId', ol.product_id, 'variantId', ol.variant_id,
    'productName', ol.product_name, 'variantName', ol.variant_name,
    'unitPriceCents', ol.unit_price_cents, 'quantity', ol.quantity,
    'servedQuantity', ol.served_quantity, 'fullyServedAt', ol.fully_served_at,
    'modifiers', ol.modifiers, 'note', ol.note,
    'createdAt', ol.created_at, 'updatedAt', ol.updated_at
  ) order by ol.created_at), '[]'::jsonb)
  into result_lines
  from public.order_lines ol where ol.order_id = order_row.id;

  return jsonb_build_object('revision', next_revision, 'lines', result_lines);
end;
$$;

create or replace function public.close_restaurant_order_checked(
  p_order_id uuid,
  p_payment_method text,
  p_received_cents integer default null,
  p_allow_pending boolean default false
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
  select o.* into order_row from public.orders o where o.id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0)::integer into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units);
  end if;
  payment_result := public.close_order_and_create_sale(p_order_id, p_payment_method, p_received_cents);
  return payment_result || jsonb_build_object('requiresConfirmation', false, 'pendingUnits', pending_units);
end;
$$;

create or replace function public.block_cash_close_with_open_restaurant_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'open' and new.status <> 'open' and exists (
    select 1 from public.orders o
    where o.cash_session_id = old.id and o.status = 'open'
  ) then
    raise exception 'No se puede cerrar la caja mientras existan comandas abiertas';
  end if;
  return new;
end;
$$;

drop trigger if exists block_cash_close_with_open_restaurant_orders on public.cash_sessions;
create trigger block_cash_close_with_open_restaurant_orders
before update of status on public.cash_sessions
for each row execute function public.block_cash_close_with_open_restaurant_orders();

revoke all on function public.record_restaurant_order_event(uuid, text, jsonb) from public;
revoke all on function public.audit_restaurant_order_change() from public;
revoke all on function public.block_cash_close_with_open_restaurant_orders() from public;
revoke all on function public.close_restaurant_order_checked(uuid, text, integer, boolean) from public;
revoke all on function public.mark_order_line_units_served(uuid, integer) from public;
revoke all on function public.mark_order_line_fully_served(uuid) from public;
revoke all on function public.mark_order_fully_served(uuid) from public;
revoke all on function public.set_restaurant_order_line_quantity(uuid, integer) from public;
revoke all on function public.remove_restaurant_order_line(uuid) from public;
revoke all on function public.save_restaurant_order_lines(uuid, integer, jsonb) from public;
grant execute on function public.mark_order_line_units_served(uuid, integer) to authenticated;
grant execute on function public.mark_order_line_fully_served(uuid) to authenticated;
grant execute on function public.mark_order_fully_served(uuid) to authenticated;
grant execute on function public.set_restaurant_order_line_quantity(uuid, integer) to authenticated;
grant execute on function public.remove_restaurant_order_line(uuid) to authenticated;
grant execute on function public.save_restaurant_order_lines(uuid, integer, jsonb) to authenticated;
grant execute on function public.close_restaurant_order_checked(uuid, text, integer, boolean) to authenticated;
grant select on public.order_events to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.order_events; exception when duplicate_object then null; end;
end $$;

commit;
