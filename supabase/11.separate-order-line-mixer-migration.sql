begin;

alter table public.order_lines
  add column if not exists mixer_product_id uuid references public.products(id) on delete set null,
  add column if not exists mixer jsonb;

alter table public.order_lines drop constraint if exists order_lines_mixer_object;
alter table public.order_lines add constraint order_lines_mixer_object
  check (mixer is null or jsonb_typeof(mixer) = 'object');

-- Compatibilidad para datos historicos que hubieran llegado a persistirse como mixer:<uuid>.
with legacy as (
  select distinct on (ol.id)
    ol.id as line_id,
    p.id as mixer_product_id,
    jsonb_build_object(
      'productId', p.id,
      'name', coalesce(element.value ->> 'name', p.name),
      'priceCents', p.mixer_supplement_cents
    ) as mixer
  from public.order_lines ol
  cross join lateral jsonb_array_elements(ol.modifiers) element(value)
  join public.products p
    on p.id::text = substring(element.value ->> 'id' from 7)
   and p.tenant_id = ol.tenant_id
   and p.venue_id = ol.venue_id
  where element.value ->> 'id' ~* '^mixer:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  order by ol.id
)
update public.order_lines ol
set mixer_product_id = legacy.mixer_product_id,
    mixer = legacy.mixer,
    modifiers = coalesce((
      select jsonb_agg(element.value)
      from jsonb_array_elements(ol.modifiers) element(value)
      where coalesce(element.value ->> 'groupId', '') <> 'mixer'
        and coalesce(element.value ->> 'id', '') not like 'mixer:%'
    ), '[]'::jsonb)
from legacy
where ol.id = legacy.line_id
  and ol.mixer_product_id is null;

create or replace function public.add_restaurant_order_line_with_mixer(
  p_order_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_modifier_ids uuid[] default '{}'::uuid[],
  p_quantity integer default 1,
  p_note text default null,
  p_mixer_product_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  product_row public.products%rowtype;
  variant_row public.product_variants%rowtype;
  mixer_row public.products%rowtype;
  modifiers_json jsonb := '[]'::jsonb;
  mixer_json jsonb := null;
  modifier_total integer := 0;
  mixer_total integer := 0;
  modifier_count integer := 0;
  new_line_id uuid := gen_random_uuid();
begin
  if p_quantity < 1 then raise exception 'Cantidad no valida'; end if;
  select o.* into order_row from public.orders o where o.id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  select p.* into product_row from public.products p
  where p.id = p_product_id and p.tenant_id = order_row.tenant_id
    and p.venue_id = order_row.venue_id and p.is_active;
  select pv.* into variant_row from public.product_variants pv
  where pv.id = p_variant_id and pv.tenant_id = order_row.tenant_id and pv.product_id = p_product_id;
  if product_row.id is null or variant_row.id is null then raise exception 'Producto o variante no validos'; end if;

  if p_mixer_product_id is not null then
    select p.* into mixer_row from public.products p
    where p.id = p_mixer_product_id and p.tenant_id = order_row.tenant_id
      and p.venue_id = order_row.venue_id and p.is_active and p.can_use_as_mixer;
    if mixer_row.id is null then raise exception 'Mixer no valido'; end if;
    mixer_total := mixer_row.mixer_supplement_cents;
    mixer_json := jsonb_build_object('productId', mixer_row.id, 'name', mixer_row.name, 'priceCents', mixer_total);
  end if;

  if coalesce(array_length(p_modifier_ids, 1), 0) > 0 then
    if (select count(distinct selected.value) from unnest(p_modifier_ids) as selected(value)) <> array_length(p_modifier_ids, 1) then
      raise exception 'Hay modificadores duplicados';
    end if;
    select count(*), coalesce(sum(m.price_cents), 0),
      coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'groupId', m.group_id, 'name', m.name, 'priceCents', m.price_cents) order by m.sort_order), '[]'::jsonb)
    into modifier_count, modifier_total, modifiers_json
    from public.modifiers m
    join public.modifier_groups mg on mg.id = m.group_id
    where m.id = any(p_modifier_ids) and m.tenant_id = order_row.tenant_id and mg.product_id = p_product_id;
    if modifier_count <> array_length(p_modifier_ids, 1) then raise exception 'Modificadores no validos'; end if;
  end if;

  if exists (
    select 1 from public.modifier_groups mg
    where mg.product_id = p_product_id and mg.tenant_id = order_row.tenant_id
      and ((select count(*) from unnest(coalesce(p_modifier_ids, '{}'::uuid[])) selected(selected_id)
        join public.modifiers sm on sm.id = selected.selected_id where sm.group_id = mg.id) < mg.min_select
      or (select count(*) from unnest(coalesce(p_modifier_ids, '{}'::uuid[])) selected(selected_id)
        join public.modifiers sm on sm.id = selected.selected_id where sm.group_id = mg.id) > mg.max_select)
  ) then raise exception 'La seleccion de modificadores no cumple los limites del producto'; end if;

  insert into public.order_lines (
    id, tenant_id, venue_id, order_id, product_id, variant_id, product_name, variant_name,
    unit_price_cents, quantity, modifiers, mixer_product_id, mixer, note
  ) values (
    new_line_id, order_row.tenant_id, order_row.venue_id, order_row.id, product_row.id, variant_row.id,
    product_row.name, variant_row.name, variant_row.price_cents + modifier_total + mixer_total,
    p_quantity, modifiers_json, mixer_row.id, mixer_json, nullif(trim(p_note), '')
  );
  return new_line_id;
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
  mixer_product_value uuid;
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
      using errcode = '40001', detail = jsonb_build_object('expectedRevision', p_expected_revision, 'currentRevision', order_row.revision)::text;
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;

  for line_item in select item.value from jsonb_array_elements(p_lines) item(value)
  loop
    line_id := (line_item ->> 'id')::uuid;
    quantity_value := (line_item ->> 'quantity')::integer;
    note_value := nullif(trim(line_item ->> 'note'), '');
    mixer_product_value := nullif(line_item ->> 'mixerProductId', '')::uuid;
    if quantity_value < 1 or quantity_value > 9999 then raise exception 'Cantidad de linea no valida'; end if;
    if line_id = any(retained_ids) then raise exception 'El borrador contiene IDs de linea duplicados'; end if;

    select ol.* into existing_line from public.order_lines ol where ol.id = line_id and ol.order_id = order_row.id;
    if existing_line.id is not null then
      if quantity_value < existing_line.served_quantity then raise exception 'No puedes reducir la cantidad por debajo de las unidades servidas'; end if;
      if existing_line.served_quantity > 0 then
        if mixer_product_value is distinct from existing_line.mixer_product_id then
          raise exception 'No se puede cambiar el mixer de una linea ya servida';
        end if;
        update public.order_lines ol set quantity = quantity_value, note = note_value,
          fully_served_at = case when quantity_value = ol.served_quantity then coalesce(ol.fully_served_at, now()) else null end
        where ol.id = existing_line.id;
      else
        if nullif(line_item ->> 'productId', '') is null or nullif(line_item ->> 'variantId', '') is null then
          raise exception 'No se puede actualizar una linea sin producto y variante';
        end if;
        product_value := (line_item ->> 'productId')::uuid;
        variant_value := (line_item ->> 'variantId')::uuid;
        select coalesce(array_agg(selected.value::uuid order by selected.value), '{}'::uuid[])
        into modifier_ids from jsonb_array_elements_text(coalesce(line_item -> 'modifierIds', '[]'::jsonb)) selected(value);
        generated_line_id := public.add_restaurant_order_line_with_mixer(
          order_row.id, product_value, variant_value, modifier_ids, quantity_value, note_value, mixer_product_value
        );
        update public.order_lines target set
          product_id = source.product_id, variant_id = source.variant_id,
          product_name = source.product_name, variant_name = source.variant_name,
          unit_price_cents = source.unit_price_cents, quantity = source.quantity,
          modifiers = source.modifiers, mixer_product_id = source.mixer_product_id,
          mixer = source.mixer, note = source.note, fully_served_at = null
        from public.order_lines source
        where target.id = existing_line.id and source.id = generated_line_id;
        delete from public.order_lines ol where ol.id = generated_line_id;
      end if;
      retained_ids := array_append(retained_ids, existing_line.id);
      continue;
    end if;

    if nullif(line_item ->> 'productId', '') is null or nullif(line_item ->> 'variantId', '') is null then
      raise exception 'No se puede crear una linea sin producto y variante';
    end if;
    product_value := (line_item ->> 'productId')::uuid;
    variant_value := (line_item ->> 'variantId')::uuid;
    select coalesce(array_agg(selected.value::uuid order by selected.value), '{}'::uuid[])
    into modifier_ids from jsonb_array_elements_text(coalesce(line_item -> 'modifierIds', '[]'::jsonb)) selected(value);
    signature_value := concat_ws('|', product_value::text, variant_value::text, array_to_string(modifier_ids, ','), coalesce(mixer_product_value::text, ''), coalesce(note_value, ''));
    if signature_value = any(signatures) then raise exception 'El borrador contiene lineas duplicadas'; end if;
    signatures := array_append(signatures, signature_value);

    generated_line_id := public.add_restaurant_order_line_with_mixer(
      order_row.id, product_value, variant_value, modifier_ids, quantity_value, note_value, mixer_product_value
    );
    update public.order_lines ol set id = line_id where ol.id = generated_line_id;
    update public.order_events oe set payload = jsonb_set(oe.payload, '{lineId}', to_jsonb(line_id::text))
    where oe.order_id = order_row.id and oe.event_type = 'line_added' and oe.payload ->> 'lineId' = generated_line_id::text;
    retained_ids := array_append(retained_ids, line_id);
  end loop;

  if exists (select 1 from public.order_lines ol where ol.order_id = order_row.id
    and not (ol.id = any(retained_ids)) and ol.served_quantity > 0) then
    raise exception 'No se puede eliminar una linea con productos ya servidos';
  end if;
  delete from public.order_lines ol where ol.order_id = order_row.id and not (ol.id = any(retained_ids));
  update public.orders o set revision = o.revision + 1 where o.id = order_row.id returning o.revision into next_revision;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ol.id, 'tenantId', ol.tenant_id, 'venueId', ol.venue_id, 'orderId', ol.order_id,
    'productId', ol.product_id, 'variantId', ol.variant_id, 'productName', ol.product_name,
    'variantName', ol.variant_name, 'unitPriceCents', ol.unit_price_cents, 'quantity', ol.quantity,
    'servedQuantity', ol.served_quantity, 'fullyServedAt', ol.fully_served_at,
    'modifiers', ol.modifiers, 'mixerProductId', ol.mixer_product_id, 'mixer', ol.mixer,
    'note', ol.note, 'createdAt', ol.created_at, 'updatedAt', ol.updated_at
  ) order by ol.created_at), '[]'::jsonb)
  into result_lines from public.order_lines ol where ol.order_id = order_row.id;
  return jsonb_build_object('revision', next_revision, 'lines', result_lines);
end;
$$;

create or replace function public.close_order_and_create_sale(
  p_order_id uuid,
  p_payment_method text,
  p_received_cents integer default null
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
  total_cents integer;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
begin
  if p_payment_method not in ('cash', 'card', 'invitation', 'other') then raise exception 'Metodo de pago no valido'; end if;
  select o.* into order_row from public.orders o where o.id = p_order_id for update;
  if order_row.id is null or order_row.status <> 'open' then raise exception 'La comanda ya no esta abierta'; end if;
  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id and dua.venue_id = order_row.venue_id and dua.is_active limit 1;
  if session_row.status <> 'open' or actor_device.id is null or not actor_device.can_take_payments then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;
  select coalesce(sum(ol.quantity * ol.unit_price_cents), 0)::integer into total_cents from public.order_lines ol where ol.order_id = order_row.id;
  if total_cents <= 0 then raise exception 'No se puede cobrar una comanda vacia'; end if;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < total_cents then raise exception 'Importe recibido insuficiente'; end if;

  insert into public.tickets (id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, status, subtotal_cents, total_cents, local_created_at)
  values (ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id, order_row.venue_id, actor_device.id, auth.uid(), 'paid', total_cents, total_cents, now());
  insert into public.ticket_lines (id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name, quantity, unit_price_cents, line_total_cents, modifiers)
  select gen_random_uuid(), ol.tenant_id, ticket_id, ol.product_id, ol.variant_id, ol.product_name, ol.variant_name,
    ol.quantity, ol.unit_price_cents, ol.quantity * ol.unit_price_cents,
    ol.modifiers || case when ol.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'id', 'mixer:' || ol.mixer_product_id::text, 'groupId', 'mixer',
      'name', ol.mixer ->> 'name', 'priceCents', (ol.mixer ->> 'priceCents')::integer
    )) end
  from public.order_lines ol where ol.order_id = order_row.id;
  insert into public.sales (id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, total_cents, payment_method, local_created_at)
  values (sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id, order_row.venue_id, actor_device.id, auth.uid(), total_cents, p_payment_method, now());
  insert into public.sale_payments (id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents)
  values (payment_id, order_row.tenant_id, sale_id, p_payment_method, total_cents,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - total_cents else 0 end);
  update public.orders o set status = 'paid', closed_at = now() where o.id = order_row.id;
  update public.order_tables ot set released_at = now() where ot.order_id = order_row.id and ot.released_at is null;
  return jsonb_build_object('orderId', order_row.id, 'ticketId', ticket_id, 'saleId', sale_id, 'paymentId', payment_id, 'totalCents', total_cents);
end;
$$;

revoke all on function public.add_restaurant_order_line_with_mixer(uuid, uuid, uuid, uuid[], integer, text, uuid) from public;
grant execute on function public.add_restaurant_order_line_with_mixer(uuid, uuid, uuid, uuid[], integer, text, uuid) to authenticated;

commit;
