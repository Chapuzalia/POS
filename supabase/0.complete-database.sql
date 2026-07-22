-- CLUB POS - CONSOLIDATED FINAL DATABASE
-- Direct post-Phase-4 schema. No transitional catalogue objects are created.
-- Execute once in Supabase SQL Editor with an administrative role.



-- Dumped from database version 17.10
-- Dumped by pg_dump version 17.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: audit_catalog_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_catalog_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.catalog_audit_log(tenant_id, venue_id, table_name, row_id, action, actor_id, before_data, after_data)
  values ((v_row->>'tenant_id')::uuid, nullif(v_row->>'venue_id','')::uuid, tg_table_name, nullif(v_row->>'id','')::uuid, tg_op, auth.uid(), case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end, case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end; $$;


--
-- Name: audit_restaurant_order_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_restaurant_order_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: block_cash_close_with_open_restaurant_orders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.block_cash_close_with_open_restaurant_orders() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: calculate_tax_from_gross(integer, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_tax_from_gross(p_gross_cents integer, p_tax_rate numeric) RETURNS TABLE(taxable_base_cents integer, tax_amount_cents integer)
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO ''
    AS $$
begin
  if p_gross_cents < 0 then
    raise exception 'El total final no puede ser negativo';
  end if;
  if p_tax_rate < 0 or p_tax_rate > 100 then
    raise exception 'El tipo de IVA debe estar entre 0 y 100';
  end if;

  taxable_base_cents := round(
    p_gross_cents::numeric * 100 / (100 + p_tax_rate)
  )::integer;
  tax_amount_cents := p_gross_cents - taxable_base_cents;
  return next;
end;
$$;


--
-- Name: cancel_empty_restaurant_order(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_empty_restaurant_order(p_order_id uuid, p_expected_revision integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: canonical_catalog_modifiers(uuid, uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonical_catalog_modifiers(p_venue_id uuid, p_product_id uuid, p_variant_id uuid, p_submitted jsonb) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'groupId', g.id, 'name', m.name, 'priceCents', m.supplement_cents
  ) order by a.sort_order, g.sort_order, m.sort_order, m.id), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_submitted, '[]'::jsonb)) submitted
  join public.modifiers m on m.id = nullif(submitted ->> 'id', '')::uuid
    and m.venue_id = p_venue_id and m.is_active
  join public.modifier_groups g on g.id = m.group_id and g.venue_id = p_venue_id and g.is_active
  join public.product_modifier_group_assignments a on a.group_id = g.id
    and a.product_id = p_product_id and a.venue_id = p_venue_id and a.is_active
    and (a.applies_to_all_variants or exists (
      select 1 from public.product_modifier_group_assignment_variants av
      where av.assignment_id = a.id and av.variant_id = p_variant_id
    ));
$$;


--
-- Name: capture_ticket_line_catalog_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.capture_ticket_line_catalog_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare line_payload jsonb; snapshot_payload jsonb;
begin
  select line into line_payload from public.offline_event_log e
  cross join lateral jsonb_array_elements(e.payload->'lines') line
  where e.tenant_id=new.tenant_id and e.payload->'ticket'->>'id'=new.ticket_id::text and line->>'id'=new.id::text
  order by e.created_at desc limit 1;
  snapshot_payload:=line_payload->'catalogSnapshot';
  if snapshot_payload is null then
    select (array_agg(l.catalog_snapshot order by l.updated_at desc))[1] into snapshot_payload
    from public.order_lines l join public.orders o on o.id=l.order_id join public.tickets t on t.id=new.ticket_id
    where l.tenant_id=new.tenant_id and o.cash_session_id=t.cash_session_id and o.venue_id=t.venue_id
      and l.product_id is not distinct from new.product_id and l.variant_id is not distinct from new.variant_id
      and l.unit_price_cents=new.unit_price_cents and l.catalog_snapshot<>'{}'::jsonb having count(*)=1;
  end if;
  if snapshot_payload is not null then
    new.category_id_snapshot:=nullif(snapshot_payload->>'categoryId','')::uuid;
    new.category_name_snapshot:=nullif(snapshot_payload->>'categoryName','');
    new.catalog_tab_id_snapshot:=nullif(snapshot_payload->>'catalogTabId','')::uuid;
    new.catalog_tab_name_snapshot:=nullif(snapshot_payload->>'catalogTabName','');
  end if;
  new.base_price_cents:=coalesce(nullif(line_payload->>'basePriceCents','')::integer,new.unit_price_cents);
  new.component_delta_cents:=coalesce(nullif(line_payload->>'componentDeltaCents','')::integer,0);
  new.modifier_delta_cents:=coalesce(nullif(line_payload->>'modifierDeltaCents','')::integer,0);
  new.gross_before_discount_cents:=coalesce(nullif(line_payload->>'grossBeforeDiscountCents','')::integer,new.unit_price_cents);
  return new;
end $$;


--
-- Name: capture_ticket_line_components(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.capture_ticket_line_components() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare components_payload jsonb;
begin
  select line -> 'components' into components_payload from public.offline_event_log e
  cross join lateral jsonb_array_elements(e.payload -> 'lines') line
  where e.tenant_id = new.tenant_id and e.payload -> 'ticket' ->> 'id' = new.ticket_id::text and line ->> 'id' = new.id::text
  order by e.created_at desc limit 1;
  if components_payload is null then
    -- Restaurant payment RPCs predate components and do not expose source_order_line_id.
    -- Copy only when the source is unambiguous; verification reports anything left unresolved.
    select (array_agg(ol.components order by ol.updated_at desc))[1] into components_payload
    from public.order_lines ol join public.orders o on o.id = ol.order_id
    join public.tickets t on t.id = new.ticket_id
    where ol.tenant_id = new.tenant_id and o.cash_session_id = t.cash_session_id and o.venue_id = t.venue_id
      and ol.product_id is not distinct from new.product_id and ol.variant_id is not distinct from new.variant_id
      and ol.product_name = new.product_name and ol.variant_name = new.variant_name
      and ol.unit_price_cents = new.unit_price_cents and jsonb_array_length(ol.components) > 0
    having count(*) = 1;
  end if;
  if jsonb_typeof(components_payload) = 'array' then
    insert into public.ticket_line_components (tenant_id, ticket_line_id, component_type, selection_group_id, selection_group_name_snapshot, product_id, variant_id, product_name_snapshot, variant_name_snapshot, quantity, price_delta_cents, sort_order, metadata)
    select new.tenant_id, new.id, c.type, nullif(c."selectionGroupId", '')::uuid, coalesce(c."selectionGroupName", ''),
      nullif(c."productId", '')::uuid, nullif(c."variantId", '')::uuid, c."productName", coalesce(c."variantName", ''),
      greatest(c.quantity, 1), greatest(c."priceDeltaCents", 0), c."sortOrder",
      coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object('modifiers', coalesce(c.modifiers, '[]'::jsonb))
    from jsonb_to_recordset(components_payload) c(type text, "selectionGroupId" text, "selectionGroupName" text, "productId" text, "variantId" text, "productName" text, "variantName" text, quantity integer, "priceDeltaCents" integer, "sortOrder" integer, modifiers jsonb, metadata jsonb);
  end if;
  return new;
end;
$$;


--
-- Name: catalog_command(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.catalog_command(p_venue_id uuid, p_command text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_tenant_id uuid;
  v_id uuid;
  v_product_id uuid;
  v_group_id uuid;
  v_variant_id uuid;
  v_item jsonb;
  v_table text;
  v_path text;
  v_orphaned_paths text[] := '{}';
  v_default_count integer;
  v_default_assigned boolean := false;
begin
  select v.tenant_id into v_tenant_id from public.venues v where v.id = p_venue_id for update;
  if v_tenant_id is null then raise exception 'CATALOG_VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant_id) then
    raise exception 'CATALOG_COMMAND_FORBIDDEN';
  end if;

  if p_command = 'create_product' then
    if jsonb_typeof(p_payload -> 'variants') <> 'array' or jsonb_array_length(p_payload -> 'variants') = 0 then
      raise exception 'CATALOG_PRODUCT_REQUIRES_VARIANT';
    end if;
    select count(*) into v_default_count from jsonb_array_elements(p_payload -> 'variants') x
      where coalesce((x ->> 'active')::boolean, true) and coalesce((x ->> 'isDefault')::boolean, false);
    if v_default_count > 1 then raise exception 'INVALID_ACTIVE_DEFAULT_VARIANT_COUNT'; end if;
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.products(id, tenant_id, venue_id, name, description, product_type, tax_rate, is_active, sort_order)
    values (v_id, v_tenant_id, p_venue_id, trim(p_payload ->> 'name'), nullif(p_payload ->> 'description', ''),
      p_payload ->> 'type', nullif(p_payload ->> 'vatRate', '')::numeric,
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer);
    for v_item in select value from jsonb_array_elements(p_payload -> 'variants') loop
      if v_default_count = 0 and not v_default_assigned and coalesce((v_item ->> 'active')::boolean, true) then
        v_item := jsonb_set(v_item, '{isDefault}', 'true'::jsonb);
        v_default_assigned := true;
      end if;
      v_variant_id := coalesce(nullif(v_item ->> 'id', '')::uuid, gen_random_uuid());
      insert into public.product_variants(id, tenant_id, venue_id, product_id, name, price_cents, sku,
        is_default, is_active, sort_order)
      values (v_variant_id, v_tenant_id, p_venue_id, v_id, trim(v_item ->> 'name'),
        (v_item ->> 'priceCents')::integer, nullif(v_item ->> 'sku', ''),
        coalesce((v_item ->> 'isDefault')::boolean, false),
        coalesce((v_item ->> 'active')::boolean, true), (v_item ->> 'sortOrder')::integer);
    end loop;

  elsif p_command = 'update_product' then
    v_id := (p_payload ->> 'id')::uuid;
    if p_payload ? 'active' and not (p_payload ->> 'active')::boolean then
      update public.product_selection_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
      update public.product_modifier_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
    end if;
    update public.products p set
      name = case when p_payload ? 'name' then trim(p_payload ->> 'name') else p.name end,
      description = case when p_payload ? 'description' then nullif(p_payload ->> 'description', '') else p.description end,
      product_type = case when p_payload ? 'type' then p_payload ->> 'type' else p.product_type end,
      tax_rate = case when p_payload ? 'vatRate' then nullif(p_payload ->> 'vatRate', '')::numeric else p.tax_rate end,
      is_active = case when p_payload ? 'active' then (p_payload ->> 'active')::boolean else p.is_active end,
      sort_order = case when p_payload ? 'sortOrder' then (p_payload ->> 'sortOrder')::integer else p.sort_order end
    where p.id = v_id and p.venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;

  elsif p_command = 'set_product_active' then
    v_id := (p_payload ->> 'id')::uuid;
    if not (p_payload ->> 'active')::boolean then
      update public.product_selection_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
      update public.product_modifier_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
    end if;
    update public.products set is_active = (p_payload ->> 'active')::boolean where id = v_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;

  elsif p_command = 'delete_product' then
    v_id := (p_payload ->> 'id')::uuid;
    select i.storage_path into v_path from public.product_images i where i.product_id = v_id and i.venue_id = p_venue_id;
    delete from public.products where id = v_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;
    if v_path is not null and not exists (select 1 from public.product_images where storage_path = v_path) then
      v_orphaned_paths := array_append(v_orphaned_paths, v_path);
    end if;

  elsif p_command in ('create_variant', 'update_variant') then
    v_product_id := (p_payload ->> 'productId')::uuid;
    if not exists (select 1 from public.products where id = v_product_id and venue_id = p_venue_id) then
      raise exception 'CATALOG_PRODUCT_NOT_FOUND';
    end if;
    v_id := case when p_command = 'update_variant' then (p_payload ->> 'id')::uuid
      else coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid()) end;
    if coalesce((p_payload ->> 'isDefault')::boolean, false) then
      update public.product_variants set is_default = false where product_id = v_product_id and venue_id = p_venue_id;
    end if;
    if p_command = 'create_variant' then
      insert into public.product_variants(id, tenant_id, venue_id, product_id, name, price_cents, sku,
        is_default, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, v_product_id, trim(p_payload ->> 'name'),
        (p_payload ->> 'priceCents')::integer, nullif(p_payload ->> 'sku', ''),
        coalesce((p_payload ->> 'isDefault')::boolean, false), coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer);
    else
      update public.product_variants v set
        name = case when p_payload ? 'name' then trim(p_payload ->> 'name') else v.name end,
        price_cents = case when p_payload ? 'priceCents' then (p_payload ->> 'priceCents')::integer else v.price_cents end,
        sku = case when p_payload ? 'sku' then nullif(p_payload ->> 'sku', '') else v.sku end,
        is_default = case when p_payload ? 'isDefault' then (p_payload ->> 'isDefault')::boolean else v.is_default end,
        is_active = case when p_payload ? 'active' then (p_payload ->> 'active')::boolean else v.is_active end,
        sort_order = case when p_payload ? 'sortOrder' then (p_payload ->> 'sortOrder')::integer else v.sort_order end
      where v.id = v_id and v.product_id = v_product_id and v.venue_id = p_venue_id;
      if not found then raise exception 'CATALOG_VARIANT_NOT_FOUND'; end if;
    end if;

  elsif p_command = 'set_default_variant' then
    v_product_id := (p_payload ->> 'productId')::uuid;
    v_variant_id := (p_payload ->> 'variantId')::uuid;
    if not exists (select 1 from public.product_variants where id = v_variant_id and product_id = v_product_id and venue_id = p_venue_id and is_active) then
      raise exception 'CATALOG_VARIANT_PRODUCT_MISMATCH';
    end if;
    update public.product_variants set is_default = (id = v_variant_id)
      where product_id = v_product_id and venue_id = p_venue_id;

  elsif p_command = 'delete_variant' then
    v_product_id := (p_payload ->> 'productId')::uuid;
    v_id := (p_payload ->> 'id')::uuid;
    if exists (select 1 from public.product_variants where id = v_id and product_id = v_product_id and venue_id = p_venue_id and is_active and is_default) then
      raise exception 'CATALOG_DEFAULT_VARIANT_REQUIRES_REPLACEMENT';
    end if;
    delete from public.product_variants where id = v_id and product_id = v_product_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_VARIANT_NOT_FOUND'; end if;

  elsif p_command in ('create_placement', 'update_placement') then
    v_id := case when p_command = 'update_placement' then (p_payload ->> 'id')::uuid
      else coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid()) end;
    if p_command = 'create_placement' then
      insert into public.catalog_placements(id, tenant_id, venue_id, product_id, tab_id, category_id, variant_id,
        is_featured, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, (p_payload ->> 'productId')::uuid, (p_payload ->> 'tabId')::uuid,
        nullif(p_payload ->> 'categoryId', '')::uuid, nullif(p_payload ->> 'pinnedVariantId', '')::uuid,
        coalesce((p_payload ->> 'featured')::boolean, false), coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer);
    else
      update public.catalog_placements cp set
        product_id = case when p_payload ? 'productId' then (p_payload ->> 'productId')::uuid else cp.product_id end,
        tab_id = case when p_payload ? 'tabId' then (p_payload ->> 'tabId')::uuid else cp.tab_id end,
        category_id = case when p_payload ? 'categoryId' then nullif(p_payload ->> 'categoryId', '')::uuid else cp.category_id end,
        variant_id = case when p_payload ? 'pinnedVariantId' then nullif(p_payload ->> 'pinnedVariantId', '')::uuid else cp.variant_id end,
        is_featured = case when p_payload ? 'featured' then (p_payload ->> 'featured')::boolean else cp.is_featured end,
        is_active = case when p_payload ? 'active' then (p_payload ->> 'active')::boolean else cp.is_active end,
        sort_order = case when p_payload ? 'sortOrder' then (p_payload ->> 'sortOrder')::integer else cp.sort_order end
      where cp.id = v_id and cp.venue_id = p_venue_id;
      if not found then raise exception 'CATALOG_PLACEMENT_INVALID'; end if;
    end if;

  elsif p_command = 'delete_placement' then
    delete from public.catalog_placements where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PLACEMENT_INVALID'; end if;

  elsif p_command = 'save_tab' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.catalog_tabs(id, tenant_id, venue_id, key, label, icon, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, p_payload ->> 'key', trim(p_payload ->> 'label'), nullif(p_payload ->> 'icon', ''),
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set key = excluded.key, label = excluded.label, icon = excluded.icon,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where catalog_tabs.venue_id = p_venue_id;

  elsif p_command = 'delete_tab' then
    delete from public.catalog_tabs where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PLACEMENT_INVALID'; end if;

  elsif p_command = 'save_category' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.categories(id, tenant_id, venue_id, name, icon, unused, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, trim(p_payload ->> 'name'), nullif(p_payload ->> 'icon', ''),
      coalesce((p_payload ->> 'unused')::boolean, false), coalesce((p_payload ->> 'active')::boolean, true),
      (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set name = excluded.name, icon = excluded.icon, unused = excluded.unused,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where categories.venue_id = p_venue_id;

  elsif p_command = 'delete_category' then
    delete from public.categories where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_selection_group' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.selection_groups(id, tenant_id, venue_id, kind, name, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, p_payload ->> 'type', trim(p_payload ->> 'name'),
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set kind = excluded.kind, name = excluded.name,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where selection_groups.venue_id = p_venue_id;

  elsif p_command = 'delete_selection_group' then
    delete from public.selection_groups where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_selection_option' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.selection_group_options(id, tenant_id, venue_id, group_id, product_id, variant_id,
      supplement_cents, default_quantity, max_quantity, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, (p_payload ->> 'groupId')::uuid, (p_payload ->> 'productId')::uuid,
      nullif(p_payload ->> 'variantId', '')::uuid, (p_payload ->> 'supplementCents')::integer,
      (p_payload ->> 'defaultQuantity')::integer, nullif(p_payload ->> 'maxQuantity', '')::integer,
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set group_id = excluded.group_id, product_id = excluded.product_id,
      variant_id = excluded.variant_id, supplement_cents = excluded.supplement_cents,
      default_quantity = excluded.default_quantity, max_quantity = excluded.max_quantity,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where selection_group_options.venue_id = p_venue_id;

  elsif p_command = 'delete_selection_option' then
    delete from public.selection_group_options where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_modifier_group' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.modifier_groups(id, tenant_id, venue_id, name, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, trim(p_payload ->> 'name'),
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set name = excluded.name,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where modifier_groups.venue_id = p_venue_id;

  elsif p_command = 'delete_modifier_group' then
    delete from public.modifier_groups where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_modifier' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.modifiers(id, tenant_id, venue_id, group_id, name, supplement_cents,
      is_default, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, (p_payload ->> 'groupId')::uuid, trim(p_payload ->> 'name'),
      (p_payload ->> 'supplementCents')::integer, coalesce((p_payload ->> 'isDefault')::boolean, false),
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set group_id = excluded.group_id, name = excluded.name,
      supplement_cents = excluded.supplement_cents, is_default = excluded.is_default,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where modifiers.venue_id = p_venue_id;

  elsif p_command = 'delete_modifier' then
    delete from public.modifiers where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_assignment' then
    v_product_id := (p_payload ->> 'productId')::uuid;
    v_group_id := (p_payload ->> 'groupId')::uuid;
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    if p_payload ->> 'domain' = 'selection' then
      insert into public.product_selection_group_assignments(id, tenant_id, venue_id, product_id, group_id,
        display_name, min_selection, max_selection, applies_to_all_variants, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, v_product_id, v_group_id, nullif(p_payload ->> 'displayName', ''),
        (p_payload ->> 'minSelection')::integer, (p_payload ->> 'maxSelection')::integer,
        (p_payload ->> 'appliesToAllVariants')::boolean, coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer)
      on conflict (product_id, group_id) do update set display_name = excluded.display_name,
        min_selection = excluded.min_selection, max_selection = excluded.max_selection,
        applies_to_all_variants = excluded.applies_to_all_variants, is_active = excluded.is_active,
        sort_order = excluded.sort_order returning id into v_id;
      delete from public.product_selection_group_assignment_variants where assignment_id = v_id;
      if not (p_payload ->> 'appliesToAllVariants')::boolean then
        for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'variantIds', '[]'::jsonb)) loop
          insert into public.product_selection_group_assignment_variants(tenant_id, venue_id, assignment_id, product_id, variant_id)
          values(v_tenant_id, p_venue_id, v_id, v_product_id, (v_item #>> '{}')::uuid);
        end loop;
      end if;
    elsif p_payload ->> 'domain' = 'modifier' then
      insert into public.product_modifier_group_assignments(id, tenant_id, venue_id, product_id, group_id,
        display_name, min_selection, max_selection, applies_to_all_variants, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, v_product_id, v_group_id, nullif(p_payload ->> 'displayName', ''),
        (p_payload ->> 'minSelection')::integer, (p_payload ->> 'maxSelection')::integer,
        (p_payload ->> 'appliesToAllVariants')::boolean, coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer)
      on conflict (product_id, group_id) do update set display_name = excluded.display_name,
        min_selection = excluded.min_selection, max_selection = excluded.max_selection,
        applies_to_all_variants = excluded.applies_to_all_variants, is_active = excluded.is_active,
        sort_order = excluded.sort_order returning id into v_id;
      delete from public.product_modifier_group_assignment_variants where assignment_id = v_id;
      if not (p_payload ->> 'appliesToAllVariants')::boolean then
        for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'variantIds', '[]'::jsonb)) loop
          insert into public.product_modifier_group_assignment_variants(tenant_id, venue_id, assignment_id, product_id, variant_id)
          values(v_tenant_id, p_venue_id, v_id, v_product_id, (v_item #>> '{}')::uuid);
        end loop;
      end if;
    else raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'delete_assignment' then
    if p_payload ->> 'domain' = 'selection' then
      delete from public.product_selection_group_assignments where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    elsif p_payload ->> 'domain' = 'modifier' then
      delete from public.product_modifier_group_assignments where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    else raise exception 'CATALOG_GROUP_INVALID'; end if;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'reorder' then
    v_table := case p_payload ->> 'entity'
      when 'products' then 'products' when 'variants' then 'product_variants'
      when 'placements' then 'catalog_placements' when 'tabs' then 'catalog_tabs'
      when 'categories' then 'categories' when 'tab_categories' then 'catalog_tab_categories'
      when 'selection_groups' then 'selection_groups' when 'selection_options' then 'selection_group_options'
      when 'selection_assignments' then 'product_selection_group_assignments'
      when 'modifier_groups' then 'modifier_groups' when 'modifiers' then 'modifiers'
      when 'modifier_assignments' then 'product_modifier_group_assignments' else null end;
    if v_table is null then raise exception 'CATALOG_INVALID_REORDER_ENTITY'; end if;
    for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) order by value ->> 'id' loop
      execute format('update public.%I set sort_order = $1 where id = $2 and venue_id = $3', v_table)
        using (v_item ->> 'sortOrder')::integer, (v_item ->> 'id')::uuid, p_venue_id;
      if not found then raise exception 'CATALOG_REORDER_ENTITY_NOT_FOUND'; end if;
    end loop;
  else
    raise exception 'CATALOG_UNKNOWN_COMMAND %', p_command;
  end if;

  set constraints all immediate;
  return jsonb_build_object('result', 'SUCCESS', 'id', v_id, 'orphanedImagePaths', to_jsonb(v_orphaned_paths));
end;
$_$;


--
-- Name: FUNCTION catalog_command(p_venue_id uuid, p_command text, p_payload jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.catalog_command(p_venue_id uuid, p_command text, p_payload jsonb) IS 'Definitive catalogue command boundary.';


--
-- Name: catalog_command_batch(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.catalog_command_batch(p_venue_id uuid, p_commands jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_command jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_commands) <> 'array' or jsonb_array_length(p_commands) = 0 then
    raise exception 'CATALOG_EMPTY_COMMAND_BATCH';
  end if;
  if jsonb_array_length(p_commands) > 5000 then
    raise exception 'CATALOG_COMMAND_BATCH_TOO_LARGE';
  end if;
  perform 1 from public.venues where id = p_venue_id for update;
  if not found then raise exception 'CATALOG_SCOPE_MISMATCH'; end if;
  for v_command in select value from jsonb_array_elements(p_commands) loop
    if coalesce(v_command ->> 'command', '') = '' then
      raise exception 'CATALOG_INVALID_BATCH_COMMAND';
    end if;
    if v_command ->> 'command' = 'save_tab_category' then
      v_results := v_results || jsonb_build_array(public.catalog_tab_category_command(
        p_venue_id, 'save', coalesce(v_command -> 'payload', '{}'::jsonb)
      ));
    else
      v_results := v_results || jsonb_build_array(public.catalog_command(
        p_venue_id,
        v_command ->> 'command',
        coalesce(v_command -> 'payload', '{}'::jsonb)
      ));
    end if;
  end loop;
  return jsonb_build_object('result', 'SUCCESS', 'results', v_results);
end;
$$;


--
-- Name: FUNCTION catalog_command_batch(p_venue_id uuid, p_commands jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.catalog_command_batch(p_venue_id uuid, p_commands jsonb) IS 'Executes CRM catalog mutations atomically using the definitive command service.';


--
-- Name: catalog_export_ref(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.catalog_export_ref(p_prefix text, p_id uuid) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO ''
    AS $$
  select p_prefix || '_' || replace(p_id::text, '-', '_')
$$;


--
-- Name: catalog_image_command(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.catalog_image_command(p_venue_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_tenant_id uuid;
  v_product_id uuid := (p_payload ->> 'productId')::uuid;
  v_id uuid;
  v_previous_path text;
  v_orphaned_paths text[] := '{}';
begin
  select tenant_id into v_tenant_id from public.venues where id = p_venue_id for update;
  if v_tenant_id is null then raise exception 'CATALOG_SCOPE_MISMATCH'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant_id) then
    raise exception 'CATALOG_COMMAND_FORBIDDEN';
  end if;
  if not exists (
    select 1 from public.products where id = v_product_id and venue_id = p_venue_id
  ) then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;

  select storage_path into v_previous_path
  from public.product_images
  where product_id = v_product_id and venue_id = p_venue_id
  for update;

  if p_action = 'save' then
    if p_payload ->> 'mimeType' not in ('image/webp', 'image/jpeg', 'image/png', 'image/avif') then
      raise exception 'CATALOG_IMAGE_TYPE_INVALID';
    end if;
    if (p_payload ->> 'sizeBytes')::bigint <= 0 or (p_payload ->> 'sizeBytes')::bigint > 1048576 then
      raise exception 'CATALOG_IMAGE_SIZE_INVALID';
    end if;
    if p_payload ->> 'sha256' !~ '^[a-f0-9]{64}$' then
      raise exception 'CATALOG_IMAGE_HASH_INVALID';
    end if;
    if (p_payload ->> 'storagePath') not like (v_tenant_id::text || '/' || p_venue_id::text || '/products/%') then
      raise exception 'CATALOG_IMAGE_PATH_INVALID';
    end if;
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.product_images(
      id, tenant_id, venue_id, product_id, storage_path, mime_type, size_bytes, sha256
    ) values (
      v_id, v_tenant_id, p_venue_id, v_product_id,
      p_payload ->> 'storagePath', p_payload ->> 'mimeType',
      (p_payload ->> 'sizeBytes')::bigint, p_payload ->> 'sha256'
    )
    on conflict (product_id) do update set
      storage_path = excluded.storage_path,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      sha256 = excluded.sha256
    where product_images.venue_id = p_venue_id
    returning id into v_id;
  elsif p_action = 'delete' then
    delete from public.product_images
    where product_id = v_product_id and venue_id = p_venue_id
    returning id into v_id;
    if not found then raise exception 'CATALOG_IMAGE_NOT_FOUND'; end if;
  else
    raise exception 'CATALOG_UNKNOWN_IMAGE_COMMAND';
  end if;

  if v_previous_path is not null
    and v_previous_path is distinct from p_payload ->> 'storagePath'
    and not exists (select 1 from public.product_images where storage_path = v_previous_path)
  then
    v_orphaned_paths := array_append(v_orphaned_paths, v_previous_path);
  end if;
  return jsonb_build_object(
    'result', 'SUCCESS', 'id', v_id,
    'orphanedImagePaths', to_jsonb(v_orphaned_paths)
  );
end;
$_$;


--
-- Name: FUNCTION catalog_image_command(p_venue_id uuid, p_action text, p_payload jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.catalog_image_command(p_venue_id uuid, p_action text, p_payload jsonb) IS 'Registers or removes product image metadata and returns only unreferenced storage paths.';


--
-- Name: catalog_tab_category_command(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.catalog_tab_category_command(p_venue_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_tenant_id uuid;
  v_id uuid;
begin
  select tenant_id into v_tenant_id from public.venues where id = p_venue_id for update;
  if v_tenant_id is null then raise exception 'CATALOG_SCOPE_MISMATCH'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant_id) then
    raise exception 'CATALOG_COMMAND_FORBIDDEN';
  end if;
  if p_action = 'save' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.catalog_tab_categories(
      id, tenant_id, venue_id, tab_id, category_id, is_active, sort_order
    ) values (
      v_id, v_tenant_id, p_venue_id,
      (p_payload ->> 'tabId')::uuid,
      (p_payload ->> 'categoryId')::uuid,
      coalesce((p_payload ->> 'active')::boolean, true),
      (p_payload ->> 'sortOrder')::integer
    )
    on conflict (tab_id, category_id) do update set
      is_active = excluded.is_active,
      sort_order = excluded.sort_order
    where catalog_tab_categories.venue_id = p_venue_id
    returning id into v_id;
  elsif p_action = 'delete' then
    v_id := (p_payload ->> 'id')::uuid;
    if exists (
      select 1 from public.catalog_placements
      where venue_id = p_venue_id
        and tab_id = (select tab_id from public.catalog_tab_categories where id = v_id)
        and category_id = (select category_id from public.catalog_tab_categories where id = v_id)
    ) then
      raise exception 'CATALOG_TAB_CATEGORY_IN_USE';
    end if;
    delete from public.catalog_tab_categories where id = v_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;
  else
    raise exception 'CATALOG_UNKNOWN_TAB_CATEGORY_COMMAND';
  end if;
  return jsonb_build_object('result', 'SUCCESS', 'id', v_id);
end;
$$;


--
-- Name: check_user_login(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_user_login(p_client_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.user_login_leases
    where user_id = auth.uid()
      and auth_session_id = (auth.jwt() ->> 'session_id')
      and client_id = p_client_id
      and expires_at > now()
  );
$$;


--
-- Name: claim_user_login(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_user_login(p_client_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
  claimed boolean := false;
begin
  if current_user_id is null or current_session_id is null or p_client_id is null then
    return false;
  end if;

  insert into public.user_login_leases (
    user_id, auth_session_id, client_id, heartbeat_at, expires_at
  ) values (
    current_user_id, current_session_id, p_client_id, now(), now() + interval '30 minutes'
  )
  on conflict (user_id) do update set
    auth_session_id = excluded.auth_session_id,
    client_id = excluded.client_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at
  where (
    public.user_login_leases.auth_session_id = excluded.auth_session_id
    and public.user_login_leases.client_id = excluded.client_id
  ) or public.user_login_leases.expires_at <= now()
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;


--
-- Name: clear_closed_cash_session_table_layout(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clear_closed_cash_session_table_layout() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if old.status = 'open' and new.status <> 'open' then delete from public.cash_session_table_layouts where cash_session_id = new.id; end if;
  return new;
end;
$$;


--
-- Name: close_cash_register_session(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_cash_register_session(p_cash_session_id uuid, p_device_id uuid, p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  if exists (
    select 1 from public.orders o
    where o.cash_session_id = session_row.id and o.status = 'open'
  ) then
    raise exception 'No se puede cerrar la caja mientras existan comandas abiertas';
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

  expected_cash_total := session_row.opening_float_cents
    + cash_payments_total
    + cash_entries_total
    - cash_exits_total
    - card_cashback_total;
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
      'cardCashbackCents', card_cashback_total
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


--
-- Name: close_order_and_create_sale(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_order_and_create_sale(p_order_id uuid, p_payment_method text, p_received_cents integer DEFAULT NULL::integer) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select public.close_order_and_create_sale_v2(p_order_id, p_payment_method, p_received_cents, null);
$$;


--
-- Name: close_order_and_create_sale_v2(uuid, text, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_order_and_create_sale_v2(p_order_id uuid, p_payment_method text DEFAULT NULL::text, p_received_cents integer DEFAULT NULL::integer, p_discount jsonb DEFAULT NULL::jsonb) RETURNS jsonb
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


--
-- Name: close_restaurant_order_checked(uuid, text, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_restaurant_order_checked(p_order_id uuid, p_payment_method text, p_received_cents integer DEFAULT NULL::integer, p_allow_pending boolean DEFAULT false) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select public.close_restaurant_order_checked_v2(
    p_order_id, p_payment_method, p_received_cents, p_allow_pending, null
  );
$$;


--
-- Name: close_restaurant_order_checked_v2(uuid, text, integer, boolean, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_restaurant_order_checked_v2(p_order_id uuid, p_payment_method text DEFAULT NULL::text, p_received_cents integer DEFAULT NULL::integer, p_allow_pending boolean DEFAULT false, p_discount jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: configure_restaurant_order_equal_split(uuid, integer, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.configure_restaurant_order_equal_split(p_order_id uuid, p_part_count integer, p_expected_order_revision integer, p_default_discount jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  order_row public.orders%rowtype;
  split_row public.restaurant_order_equal_splits%rowtype;
  order_total integer;
  discount_result jsonb;
  discount_snapshot jsonb;
begin
  if p_part_count < 2 or p_part_count > 99 then
    raise exception 'El numero de comensales debe estar entre 2 y 99' using errcode = '22023';
  end if;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' or order_row.revision <> p_expected_order_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  select coalesce(sum(ol.quantity * ol.unit_price_cents), 0)::integer into order_total
  from public.order_lines ol where ol.order_id = order_row.id;
  if order_total <= 0 then raise exception 'No se puede dividir una comanda vacia'; end if;
  if p_part_count > order_total then raise exception 'El numero de partes supera los centimos cobrables' using errcode = '22023'; end if;

  select s.* into split_row from public.restaurant_order_equal_splits s
  where s.order_id = order_row.id for update;
  if split_row.id is not null and split_row.status = 'completed' then
    raise exception 'Esta comanda ya se cobro por completo';
  end if;
  if split_row.id is not null and split_row.paid_parts > 0 then
    if split_row.part_count <> p_part_count or split_row.total_cents <> order_total then
      raise exception 'No se puede cambiar el reparto despues del primer cobro' using errcode = '55000';
    end if;
    return public.restaurant_equal_split_to_json(split_row);
  end if;

  discount_result := public.resolve_ticket_discount(
    order_row.tenant_id, order_row.venue_id, order_total, p_default_discount
  );
  discount_snapshot := case when discount_result ->> 'type' is null then null
    else discount_result || jsonb_build_object('color', p_default_discount -> 'color') end;

  insert into public.restaurant_order_equal_splits (
    tenant_id, venue_id, order_group_id, order_id, total_cents, part_count,
    default_discount, status
  ) values (
    order_row.tenant_id, order_row.venue_id, order_row.order_group_id, order_row.id,
    order_total, p_part_count, discount_snapshot, 'open'
  )
  on conflict (order_id) do update set
    total_cents = excluded.total_cents,
    part_count = excluded.part_count,
    paid_parts = 0,
    paid_cents = 0,
    default_discount = excluded.default_discount,
    allow_pending_service = false,
    status = 'open',
    revision = public.restaurant_order_equal_splits.revision + 1,
    updated_at = now(),
    completed_at = null
  returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_started', jsonb_build_object(
    'splitId', split_row.id, 'partCount', split_row.part_count, 'totalCents', split_row.total_cents,
    'defaultDiscountAmountCents', coalesce((discount_snapshot ->> 'amountCents')::integer, 0)
  ));
  return public.restaurant_equal_split_to_json(split_row);
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cash_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    cash_session_id uuid NOT NULL,
    created_by uuid NOT NULL,
    direction text NOT NULL,
    amount_cents integer NOT NULL,
    category text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id uuid,
    CONSTRAINT cash_movements_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT cash_movements_direction_check CHECK ((direction = ANY (ARRAY['entry'::text, 'exit'::text])))
);


--
-- Name: create_cash_movement(uuid, uuid, text, integer, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_cash_movement(p_cash_session_id uuid, p_device_id uuid, p_movement_type text, p_amount_cents integer, p_notes text, p_request_id uuid) RETURNS public.cash_movements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  movement_row public.cash_movements%rowtype;
  member_role text;
  movement_direction text;
begin
  if auth.uid() is null then
    raise exception 'Autenticacion requerida' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'El importe debe ser mayor que cero';
  end if;
  if p_movement_type is null or p_movement_type not in ('cash_in', 'cash_out', 'card_cashback') then
    raise exception 'Tipo de movimiento no valido';
  end if;
  if p_notes is null or btrim(p_notes) = '' then
    raise exception 'El motivo es obligatorio';
  end if;
  if p_request_id is null then
    raise exception 'El identificador de la peticion es obligatorio';
  end if;

  select cs.* into session_row
  from public.cash_sessions cs
  where cs.id = p_cash_session_id
  for update;

  if session_row.id is null then
    raise exception 'Caja no disponible';
  end if;
  if session_row.status <> 'open' then
    raise exception 'No se puede registrar un movimiento en una caja cerrada' using errcode = '55000';
  end if;

  select d.* into device_row
  from public.devices d
  where d.id = p_device_id;

  select tm.role into member_role
  from public.tenant_memberships tm
  where tm.tenant_id = session_row.tenant_id
    and tm.user_id = auth.uid()
    and tm.is_active
  limit 1;

  if device_row.id is null
    or not device_row.is_active
    or device_row.tenant_id <> session_row.tenant_id
    or device_row.venue_id <> session_row.venue_id then
    raise exception 'El dispositivo o el local no estan disponibles para este usuario' using errcode = '42501';
  end if;
  if coalesce(member_role, '') not in ('manager', 'admin', 'owner')
    and (not public.user_has_device_access(session_row.tenant_id, session_row.venue_id, device_row.id)
      or not public.user_has_venue_access(session_row.tenant_id, session_row.venue_id)) then
    raise exception 'El usuario no tiene acceso al dispositivo o al local' using errcode = '42501';
  end if;

  if not coalesce(device_row.can_manage_cash, false)
    and coalesce(member_role, '') not in ('manager', 'admin', 'owner') then
    raise exception 'No tienes permiso para gestionar movimientos de caja' using errcode = '42501';
  end if;

  movement_direction := case p_movement_type
    when 'cash_in' then 'entry'
    else 'exit'
  end;

  insert into public.cash_movements (
    tenant_id,
    venue_id,
    cash_session_id,
    created_by,
    direction,
    amount_cents,
    category,
    notes,
    request_id
  ) values (
    session_row.tenant_id,
    session_row.venue_id,
    session_row.id,
    auth.uid(),
    movement_direction,
    p_amount_cents,
    p_movement_type,
    btrim(p_notes),
    p_request_id
  )
  on conflict (cash_session_id, request_id) where request_id is not null
  do nothing
  returning * into movement_row;

  if movement_row.id is null then
    select cm.* into movement_row
    from public.cash_movements cm
    where cm.cash_session_id = session_row.id
      and cm.request_id = p_request_id;
  end if;

  return movement_row;
end;
$$;


--
-- Name: enforce_tenant_plan_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_tenant_plan_limit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_usage integer;
  resource_limit integer;
  resource_label text;
begin
  if tg_table_name = 'venues' then
    select max_venues into resource_limit
    from public.tenants
    where id = new.tenant_id
    for update;

    select count(*) into current_usage
    from public.venues
    where tenant_id = new.tenant_id;
    resource_label := 'locales';
  elsif tg_table_name = 'devices' then
    select max_devices into resource_limit
    from public.tenants
    where id = new.tenant_id
    for update;

    select count(*) into current_usage
    from public.devices
    where tenant_id = new.tenant_id;
    resource_label := 'dispositivos';
  elsif tg_table_name = 'tenant_memberships' then
    if new.role <> 'cashier' then
      return new;
    end if;

    select max_devices into resource_limit
    from public.tenants
    where id = new.tenant_id
    for update;

    select count(*) into current_usage
    from public.tenant_memberships
    where tenant_id = new.tenant_id
      and role = 'cashier';
    resource_label := 'usuarios';
  else
    return new;
  end if;

  if resource_limit is null then
    raise exception 'El negocio no existe.' using errcode = 'P0001';
  end if;

  if current_usage >= resource_limit then
    raise exception 'Has alcanzado el límite de % de tu plan (%).', resource_label, resource_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;


--
-- Name: export_catalog(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.export_catalog(p_venue_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_venue public.venues%rowtype; v_tenant public.tenants%rowtype; v_catalog jsonb;
begin
  select * into v_venue from public.venues where id=p_venue_id;
  if not found then raise exception 'VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_venue.tenant_id) then raise exception 'CATALOG_EXPORT_FORBIDDEN'; end if;
  select * into v_tenant from public.tenants where id=v_venue.tenant_id;
  v_catalog := jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('category',c.id),'name',c.name,'icon',c.icon,'sortOrder',c.sort_order,'isActive',c.is_active,'unused',c.unused,'trace','{}'::jsonb,'source','{}'::jsonb) order by c.sort_order,c.name,c.id) from public.categories c where c.venue_id=p_venue_id),'[]'::jsonb),
    'tabs', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('tab',t.id),'key',t.key,'label',t.label,'icon',t.icon,'sortOrder',t.sort_order,'isActive',t.is_active,'trace','{}'::jsonb) order by t.sort_order,t.label,t.id) from public.catalog_tabs t where t.venue_id=p_venue_id),'[]'::jsonb),
    'tabCategories', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('tab_category',x.id),'tabRef',public.catalog_export_ref('tab',x.tab_id),'categoryRef',public.catalog_export_ref('category',x.category_id),'sortOrder',x.sort_order,'isActive',x.is_active,'source','{}'::jsonb) order by x.sort_order,x.id) from public.catalog_tab_categories x where x.venue_id=p_venue_id),'[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('product',p.id),'type',p.product_type,'name',p.name,'description',p.description,'imageRef',case when pi.id is null then null else public.catalog_export_ref('image',pi.id) end,'taxRate',p.tax_rate,'sortOrder',p.sort_order,'isActive',p.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by p.sort_order,p.name,p.id) from public.products p left join public.product_images pi on pi.product_id=p.id where p.venue_id=p_venue_id),'[]'::jsonb),
    'variants', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('variant',v.id),'productRef',public.catalog_export_ref('product',v.product_id),'name',v.name,'priceCents',v.price_cents,'sku',v.sku,'isDefault',v.is_default,'sortOrder',v.sort_order,'isActive',v.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by v.product_id,v.sort_order,v.name,v.id) from public.product_variants v where v.venue_id=p_venue_id),'[]'::jsonb),
    'placements', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('placement',x.id),'productRef',public.catalog_export_ref('product',x.product_id),'tabRef',public.catalog_export_ref('tab',x.tab_id),'categoryRef',case when x.category_id is null then null else public.catalog_export_ref('category',x.category_id) end,'variantRef',case when x.variant_id is null then null else public.catalog_export_ref('variant',x.variant_id) end,'featured',x.is_featured,'sortOrder',x.sort_order,'isActive',x.is_active,'trace','{}'::jsonb) order by x.tab_id,x.category_id nulls first,x.sort_order,x.id) from public.catalog_placements x where x.venue_id=p_venue_id),'[]'::jsonb),
    'selectionGroups', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('selection_group',g.id),'name',g.name,'type',g.kind,'sortOrder',g.sort_order,'isActive',g.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by g.sort_order,g.name,g.id) from public.selection_groups g where g.venue_id=p_venue_id),'[]'::jsonb),
    'selectionGroupOptions', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('selection_option',o.id),'groupRef',public.catalog_export_ref('selection_group',o.group_id),'productRef',public.catalog_export_ref('product',o.product_id),'variantRef',case when o.variant_id is null then null else public.catalog_export_ref('variant',o.variant_id) end,'supplementCents',o.supplement_cents,'defaultQuantity',o.default_quantity,'maxQuantity',o.max_quantity,'sortOrder',o.sort_order,'isActive',o.is_active,'trace','{}'::jsonb) order by o.group_id,o.sort_order,o.id) from public.selection_group_options o where o.venue_id=p_venue_id),'[]'::jsonb),
    'selectionAssignments', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('selection_assignment',a.id),'productRef',public.catalog_export_ref('product',a.product_id),'groupRef',public.catalog_export_ref('selection_group',a.group_id),'variantRefs',coalesce((select jsonb_agg(public.catalog_export_ref('variant',av.variant_id) order by av.variant_id) from public.product_selection_group_assignment_variants av where av.assignment_id=a.id),'[]'::jsonb),'minSelection',a.min_selection,'maxSelection',a.max_selection,'sortOrder',a.sort_order,'isActive',a.is_active,'displayName',a.display_name,'trace','{}'::jsonb) order by a.product_id,a.sort_order,a.id) from public.product_selection_group_assignments a where a.venue_id=p_venue_id),'[]'::jsonb),
    'modifierGroups', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('modifier_group',g.id),'name',g.name,'sortOrder',g.sort_order,'isActive',g.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by g.sort_order,g.name,g.id) from public.modifier_groups g where g.venue_id=p_venue_id),'[]'::jsonb),
    'modifiers', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('modifier',m.id),'groupRef',public.catalog_export_ref('modifier_group',m.group_id),'name',m.name,'supplementCents',m.supplement_cents,'isDefault',m.is_default,'sortOrder',m.sort_order,'isActive',m.is_active,'trace','{}'::jsonb) order by m.group_id,m.sort_order,m.id) from public.modifiers m where m.venue_id=p_venue_id),'[]'::jsonb),
    'modifierAssignments', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('modifier_assignment',a.id),'productRef',public.catalog_export_ref('product',a.product_id),'groupRef',public.catalog_export_ref('modifier_group',a.group_id),'variantRefs',coalesce((select jsonb_agg(public.catalog_export_ref('variant',av.variant_id) order by av.variant_id) from public.product_modifier_group_assignment_variants av where av.assignment_id=a.id),'[]'::jsonb),'minSelection',a.min_selection,'maxSelection',a.max_selection,'sortOrder',a.sort_order,'isActive',a.is_active,'displayName',a.display_name,'trace','{}'::jsonb) order by a.product_id,a.sort_order,a.id) from public.product_modifier_group_assignments a where a.venue_id=p_venue_id),'[]'::jsonb),
    'images', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('image',i.id),'productRef',public.catalog_export_ref('product',i.product_id),'file','images/'||public.catalog_export_ref('image',i.id)||case i.mime_type when 'image/jpeg' then '.jpg' when 'image/png' then '.png' when 'image/gif' then '.gif' when 'image/avif' then '.avif' else '.webp' end,'mimeType',i.mime_type,'sizeBytes',i.size_bytes,'sha256',i.sha256,'missing',false,'trace','{}'::jsonb,'source',jsonb_build_object('storagePath',i.storage_path)) order by i.product_id,i.id) from public.product_images i where i.venue_id=p_venue_id),'[]'::jsonb)
  );
  return jsonb_build_object('format','club-pos-catalog-export','schemaVersion',3,'metadata',jsonb_build_object('exportedAt',to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'origin',jsonb_build_object('tenant',jsonb_build_object('name',v_tenant.name),'venue',jsonb_build_object('name',v_venue.name)),'fiscal',jsonb_build_object('defaultTaxRate',v_venue.default_tax_rate,'currencyCode',v_venue.currency_code,'timezone',v_venue.timezone),'counts',(select jsonb_object_agg(key,jsonb_array_length(value)) from jsonb_each(v_catalog))),'catalog',v_catalog);
end; $$;


--
-- Name: force_claim_user_login(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.force_claim_user_login(p_client_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
begin
  if current_user_id is null or current_session_id is null or p_client_id is null then
    return false;
  end if;

  insert into public.user_login_leases (
    user_id, auth_session_id, client_id, heartbeat_at, expires_at
  ) values (
    current_user_id, current_session_id, p_client_id, now(), now() + interval '30 minutes'
  )
  on conflict (user_id) do update set
    auth_session_id = excluded.auth_session_id,
    client_id = excluded.client_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at;

  return true;
end;
$$;


--
-- Name: get_cash_session_table_layout(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_cash_session_table_layout(p_cash_session_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare session_row public.cash_sessions%rowtype; layout_row public.cash_session_table_layouts%rowtype;
begin
  select cs.* into session_row from public.cash_sessions cs where cs.id = p_cash_session_id;
  if session_row.id is null or session_row.status <> 'open'
    or not public.user_has_venue_access(session_row.tenant_id, session_row.venue_id) then
    raise exception 'Sesion de caja no disponible' using errcode = '42501';
  end if;

  insert into public.cash_session_table_layouts (cash_session_id, tenant_id, venue_id, cash_register_id, tables, updated_by)
  select session_row.id, session_row.tenant_id, session_row.venue_id, session_row.cash_register_id,
    coalesce(jsonb_object_agg(rt.id::text, jsonb_build_object('positionX', rt.position_x, 'positionY', rt.position_y, 'groupId', null)), '{}'::jsonb), auth.uid()
  from public.restaurant_tables rt
  where rt.tenant_id = session_row.tenant_id and rt.venue_id = session_row.venue_id and rt.is_active
  on conflict (cash_session_id) do nothing;

  select l.* into layout_row from public.cash_session_table_layouts l where l.cash_session_id = session_row.id;
  return jsonb_build_object('cashSessionId', layout_row.cash_session_id, 'revision', layout_row.revision, 'updatedAt', layout_row.updated_at, 'tables', layout_row.tables);
end;
$$;


--
-- Name: get_catalog(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_catalog(p_venue_id uuid, p_mode text DEFAULT 'admin'::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_tenant_id uuid;
  v_active_only boolean;
begin
  if p_mode not in ('admin', 'pos') then
    raise exception 'CATALOG_INVALID_READ_MODE';
  end if;
  select v.tenant_id into v_tenant_id from public.venues v where v.id = p_venue_id;
  if v_tenant_id is null then raise exception 'CATALOG_VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role'
    and not public.user_is_tenant_admin(v_tenant_id)
    and not public.user_has_venue_access(v_tenant_id, p_venue_id)
  then raise exception 'CATALOG_READ_FORBIDDEN'; end if;
  v_active_only := p_mode = 'pos';

  return jsonb_build_object(
    'tenant_id', v_tenant_id,
    'venue_id', p_venue_id,
    'mode', p_mode,
    'products', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id) from (
        select p.id, p.tenant_id, p.venue_id, p.product_type, p.name, p.description,
          p.tax_rate, p.is_active, p.sort_order, p.created_at, p.updated_at
        from public.products p
        where p.venue_id = p_venue_id and (not v_active_only or p.is_active)
      ) x
    ), '[]'::jsonb),
    'variants', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.product_id, x.sort_order, x.name, x.id) from (
        select v.id, v.tenant_id, v.venue_id, v.product_id, v.name, v.price_cents, v.sku,
          v.is_default, v.is_active, v.sort_order, v.created_at, v.updated_at
        from public.product_variants v
        join public.products p on p.id = v.product_id and p.venue_id = p_venue_id
        where v.venue_id = p_venue_id and (not v_active_only or (v.is_active and p.is_active))
      ) x
    ), '[]'::jsonb),
    'tabs', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.label, x.id) from (
        select t.id, t.tenant_id, t.venue_id, t.key, t.label, t.icon, t.is_active,
          t.sort_order, t.created_at, t.updated_at
        from public.catalog_tabs t
        where t.venue_id = p_venue_id and (not v_active_only or t.is_active)
      ) x
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id) from (
        select c.id, c.tenant_id, c.venue_id, c.name, c.icon, c.unused, c.is_active,
          c.sort_order, c.created_at, c.updated_at
        from public.categories c
        where c.venue_id = p_venue_id and (not v_active_only or c.is_active)
      ) x
    ), '[]'::jsonb),
    'tab_categories', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.tab_id, x.sort_order, x.id) from (
        select tc.id, tc.tenant_id, tc.venue_id, tc.tab_id, tc.category_id, tc.is_active,
          tc.sort_order, tc.created_at, tc.updated_at
        from public.catalog_tab_categories tc
        join public.catalog_tabs t on t.id = tc.tab_id and t.venue_id = p_venue_id
        join public.categories c on c.id = tc.category_id and c.venue_id = p_venue_id
        where tc.venue_id = p_venue_id
          and (not v_active_only or (tc.is_active and t.is_active and c.is_active))
      ) x
    ), '[]'::jsonb),
    'placements', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.tab_id, x.category_id nulls first, x.sort_order, x.id) from (
        select cp.id, cp.tenant_id, cp.venue_id, cp.product_id, cp.tab_id, cp.category_id,
          cp.variant_id, cp.is_featured, cp.is_active, cp.sort_order, cp.created_at, cp.updated_at
        from public.catalog_placements cp
        join public.products p on p.id = cp.product_id and p.venue_id = p_venue_id
        join public.catalog_tabs t on t.id = cp.tab_id and t.venue_id = p_venue_id
        left join public.categories c on c.id = cp.category_id and c.venue_id = p_venue_id
        left join public.product_variants v on v.id = cp.variant_id and v.product_id = cp.product_id and v.venue_id = p_venue_id
        where cp.venue_id = p_venue_id and (not v_active_only or (
          cp.is_active and p.is_active and t.is_active and (cp.category_id is null or c.is_active)
          and (cp.variant_id is null or v.is_active)
        ))
      ) x
    ), '[]'::jsonb),
    'selection_groups', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id) from (
        select g.id, g.tenant_id, g.venue_id, g.name, g.kind, g.is_active,
          g.sort_order, g.created_at, g.updated_at
        from public.selection_groups g
        where g.venue_id = p_venue_id and (not v_active_only or g.is_active)
      ) x
    ), '[]'::jsonb),
    'selection_options', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.group_id, x.sort_order, x.id) from (
        select o.id, o.tenant_id, o.venue_id, o.group_id, o.product_id, o.variant_id,
          o.supplement_cents, o.default_quantity, o.max_quantity, o.is_active,
          o.sort_order, o.created_at, o.updated_at
        from public.selection_group_options o
        join public.selection_groups g on g.id = o.group_id and g.venue_id = p_venue_id
        join public.products p on p.id = o.product_id and p.venue_id = p_venue_id
        left join public.product_variants v on v.id = o.variant_id and v.product_id = o.product_id
        where o.venue_id = p_venue_id and (not v_active_only or (
          o.is_active and g.is_active and p.is_active and (o.variant_id is null or v.is_active)
        ))
      ) x
    ), '[]'::jsonb),
    'selection_assignments', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.product_id, x.sort_order, x.id) from (
        select a.id, a.tenant_id, a.venue_id, a.product_id, a.group_id, a.display_name,
          a.min_selection, a.max_selection, a.applies_to_all_variants,
          coalesce((select array_agg(av.variant_id order by av.variant_id)
            from public.product_selection_group_assignment_variants av where av.assignment_id = a.id), '{}'::uuid[]) variant_ids,
          a.is_active, a.sort_order, a.created_at, a.updated_at
        from public.product_selection_group_assignments a
        join public.products p on p.id = a.product_id and p.venue_id = p_venue_id
        join public.selection_groups g on g.id = a.group_id and g.venue_id = p_venue_id
        where a.venue_id = p_venue_id and (not v_active_only or (a.is_active and p.is_active and g.is_active))
      ) x
    ), '[]'::jsonb),
    'modifier_groups', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id) from (
        select g.id, g.tenant_id, g.venue_id, g.name, g.is_active,
          g.sort_order, g.created_at, g.updated_at
        from public.modifier_groups g
        where g.venue_id = p_venue_id and (not v_active_only or g.is_active)
      ) x
    ), '[]'::jsonb),
    'modifiers', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.group_id, x.sort_order, x.id) from (
        select m.id, m.tenant_id, m.venue_id, m.group_id, m.name, m.supplement_cents,
          m.is_default, m.is_active, m.sort_order, m.created_at, m.updated_at
        from public.modifiers m
        join public.modifier_groups g on g.id = m.group_id and g.venue_id = p_venue_id
        where m.venue_id = p_venue_id and (not v_active_only or (m.is_active and g.is_active))
      ) x
    ), '[]'::jsonb),
    'modifier_assignments', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.product_id, x.sort_order, x.id) from (
        select a.id, a.tenant_id, a.venue_id, a.product_id, a.group_id, a.display_name,
          a.min_selection, a.max_selection, a.applies_to_all_variants,
          coalesce((select array_agg(av.variant_id order by av.variant_id)
            from public.product_modifier_group_assignment_variants av where av.assignment_id = a.id), '{}'::uuid[]) variant_ids,
          a.is_active, a.sort_order, a.created_at, a.updated_at
        from public.product_modifier_group_assignments a
        join public.products p on p.id = a.product_id and p.venue_id = p_venue_id
        join public.modifier_groups g on g.id = a.group_id and g.venue_id = p_venue_id
        where a.venue_id = p_venue_id and (not v_active_only or (a.is_active and p.is_active and g.is_active))
      ) x
    ), '[]'::jsonb),
    'images', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.product_id, x.id) from (
        select i.id, i.tenant_id, i.venue_id, i.product_id, i.storage_path, i.mime_type,
          i.size_bytes, i.sha256, i.created_at, i.updated_at
        from public.product_images i
        join public.products p on p.id = i.product_id and p.venue_id = p_venue_id
        where i.venue_id = p_venue_id and (not v_active_only or p.is_active)
      ) x
    ), '[]'::jsonb)
  );
end;
$$;


--
-- Name: FUNCTION get_catalog(p_venue_id uuid, p_mode text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_catalog(p_venue_id uuid, p_mode text) IS 'Definitive venue-scoped catalogue read boundary for admin and POS.';


--
-- Name: group_restaurant_tables(uuid[], integer, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.group_restaurant_tables(p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: guard_equal_split_order_close(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_equal_split_order_close() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare split_row public.restaurant_order_equal_splits%rowtype;
begin
  if old.status = 'open' and new.status in ('paid', 'cancelled') then
    select s.* into split_row from public.restaurant_order_equal_splits s
    where s.order_id = old.id and s.status = 'open' for update;
    if split_row.id is not null and split_row.paid_parts > 0
      and current_setting('app.equal_split_finalizing', true) is distinct from split_row.id::text then
      raise exception 'La comanda tiene un cobro a partes iguales en curso' using errcode = '55000';
    elsif split_row.id is not null and split_row.paid_parts = 0 then
      update public.restaurant_order_equal_splits set status = 'cancelled', revision = revision + 1, updated_at = now()
      where id = split_row.id;
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: guard_paid_equal_split_order_lines(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_paid_equal_split_order_lines() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare guarded_order_id uuid := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
begin
  if not exists (
    select 1 from public.restaurant_order_equal_splits s
    where s.order_id = guarded_order_id and s.status = 'open' and s.paid_parts > 0
  ) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op <> 'UPDATE' or new.order_id is distinct from old.order_id
    or new.product_id is distinct from old.product_id or new.variant_id is distinct from old.variant_id
    or new.product_name is distinct from old.product_name or new.variant_name is distinct from old.variant_name
    or new.unit_price_cents is distinct from old.unit_price_cents or new.quantity is distinct from old.quantity
    or new.modifiers is distinct from old.modifiers or new.mixer_product_id is distinct from old.mixer_product_id
    or new.mixer is distinct from old.mixer or new.note is distinct from old.note then
    raise exception 'No se puede modificar una comanda con partes ya cobradas' using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: heartbeat_user_login(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.heartbeat_user_login(p_client_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
  refreshed boolean := false;
begin
  update public.user_login_leases
  set heartbeat_at = now(),
      expires_at = now() + interval '30 minutes'
  where user_id = current_user_id
    and auth_session_id = current_session_id
    and client_id = p_client_id
    and expires_at > now()
  returning true into refreshed;

  return coalesce(refreshed, false);
end;
$$;


--
-- Name: import_catalog(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.import_catalog(p_venue_id uuid, p_mode text, p_plan jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_tenant uuid; v_item jsonb; v_ref text; v_product uuid; v_assignment uuid; v_variant_ref text;
  v_existing bigint; v_removed_paths text[] := '{}';
begin
  if p_mode not in ('empty', 'replace') then raise exception 'INVALID_IMPORT_MODE'; end if;
  select tenant_id into v_tenant from public.venues where id = p_venue_id for update;
  if v_tenant is null then raise exception 'VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant) then raise exception 'CATALOG_IMPORT_FORBIDDEN'; end if;
  if p_plan->>'venueId' <> p_venue_id::text then raise exception 'PLAN_VENUE_MISMATCH'; end if;
  select (select count(*) from public.products where venue_id=p_venue_id) + (select count(*) from public.catalog_tabs where venue_id=p_venue_id) + (select count(*) from public.categories where venue_id=p_venue_id) into v_existing;
  if p_mode = 'empty' and v_existing > 0 then raise exception 'CATALOG_NOT_EMPTY'; end if;
  if p_mode = 'replace' then
    select coalesce(array_agg(storage_path), '{}') into v_removed_paths from public.product_images where venue_id=p_venue_id;
    delete from public.products where venue_id=p_venue_id;
    delete from public.catalog_tabs where venue_id=p_venue_id;
    delete from public.selection_groups where venue_id=p_venue_id;
    delete from public.modifier_groups where venue_id=p_venue_id;
    delete from public.categories where venue_id=p_venue_id;
  end if;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,categories}') loop
    v_ref:=v_item->>'ref'; insert into public.categories(id,tenant_id,venue_id,name,icon,sort_order,is_active,unused) values ((p_plan->'generatedIds'->'categories'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'name',v_item->>'icon',(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean,(v_item->>'unused')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,tabs}') loop
    v_ref:=v_item->>'ref'; insert into public.catalog_tabs(id,tenant_id,venue_id,key,label,icon,sort_order,is_active) values ((p_plan->'generatedIds'->'tabs'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'key',v_item->>'label',coalesce(v_item->>'icon','receipt'),(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,products}') loop
    v_ref:=v_item->>'ref'; insert into public.products(id,tenant_id,venue_id,name,description,product_type,tax_rate,is_active,sort_order) values ((p_plan->'generatedIds'->'products'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'name',v_item->>'description',v_item->>'type',nullif(v_item->>'taxRate','')::numeric,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,variants}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid;
    insert into public.product_variants(id,tenant_id,venue_id,product_id,name,price_cents,sku,is_default,is_active,sort_order) values ((p_plan->'generatedIds'->'variants'->>v_ref)::uuid,v_tenant,p_venue_id,v_product,v_item->>'name',(v_item->>'priceCents')::integer,v_item->>'sku',(v_item->>'isDefault')::boolean,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,images}') where not (value->>'missing')::boolean loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid;
    insert into public.product_images(id,tenant_id,venue_id,product_id,storage_path,mime_type,size_bytes,sha256) values ((p_plan->'generatedIds'->'images'->>v_ref)::uuid,v_tenant,p_venue_id,v_product,p_plan->'imagePaths'->>v_ref,v_item->>'mimeType',(v_item->>'sizeBytes')::bigint,v_item->>'sha256');
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,tabCategories}') loop
    v_ref:=v_item->>'ref'; insert into public.catalog_tab_categories(id,tenant_id,venue_id,tab_id,category_id,sort_order,is_active) values ((p_plan->'generatedIds'->'tabCategories'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'tabs'->>(v_item->>'tabRef'))::uuid,(p_plan->'generatedIds'->'categories'->>(v_item->>'categoryRef'))::uuid,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,placements}') loop
    v_ref:=v_item->>'ref'; insert into public.catalog_placements(id,tenant_id,venue_id,tab_id,category_id,product_id,variant_id,is_featured,sort_order,is_active) values ((p_plan->'generatedIds'->'placements'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'tabs'->>(v_item->>'tabRef'))::uuid,(p_plan->'generatedIds'->'categories'->>(v_item->>'categoryRef'))::uuid,(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid,(p_plan->'generatedIds'->'variants'->>(v_item->>'variantRef'))::uuid,(v_item->>'featured')::boolean,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,selectionGroups}') loop
    v_ref:=v_item->>'ref'; insert into public.selection_groups(id,tenant_id,venue_id,kind,name,sort_order,is_active) values ((p_plan->'generatedIds'->'selectionGroups'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'type',v_item->>'name',(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,selectionGroupOptions}') loop
    v_ref:=v_item->>'ref'; insert into public.selection_group_options(id,tenant_id,venue_id,group_id,product_id,variant_id,supplement_cents,default_quantity,max_quantity,sort_order,is_active) values ((p_plan->'generatedIds'->'selectionGroupOptions'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'selectionGroups'->>(v_item->>'groupRef'))::uuid,(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid,(p_plan->'generatedIds'->'variants'->>(v_item->>'variantRef'))::uuid,(v_item->>'supplementCents')::integer,(v_item->>'defaultQuantity')::integer,nullif(v_item->>'maxQuantity','')::integer,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,selectionAssignments}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid; v_assignment:=(p_plan->'generatedIds'->'selectionAssignments'->>v_ref)::uuid;
    insert into public.product_selection_group_assignments(id,tenant_id,venue_id,product_id,group_id,display_name,min_selection,max_selection,applies_to_all_variants,sort_order,is_active) values (v_assignment,v_tenant,p_venue_id,v_product,(p_plan->'generatedIds'->'selectionGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'displayName',(v_item->>'minSelection')::integer,(v_item->>'maxSelection')::integer,jsonb_array_length(v_item->'variantRefs')=0,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
    for v_variant_ref in select jsonb_array_elements_text(v_item->'variantRefs') loop insert into public.product_selection_group_assignment_variants(tenant_id,venue_id,assignment_id,product_id,variant_id) values(v_tenant,p_venue_id,v_assignment,v_product,(p_plan->'generatedIds'->'variants'->>v_variant_ref)::uuid); end loop;
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifierGroups}') loop
    v_ref:=v_item->>'ref'; insert into public.modifier_groups(id,tenant_id,venue_id,name,sort_order,is_active) values ((p_plan->'generatedIds'->'modifierGroups'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'name',(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifiers}') loop
    v_ref:=v_item->>'ref'; insert into public.modifiers(id,tenant_id,venue_id,group_id,name,supplement_cents,is_default,is_active,sort_order) values ((p_plan->'generatedIds'->'modifiers'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'modifierGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'name',(v_item->>'supplementCents')::integer,(v_item->>'isDefault')::boolean,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifierAssignments}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid; v_assignment:=(p_plan->'generatedIds'->'modifierAssignments'->>v_ref)::uuid;
    insert into public.product_modifier_group_assignments(id,tenant_id,venue_id,product_id,group_id,display_name,min_selection,max_selection,applies_to_all_variants,sort_order,is_active) values (v_assignment,v_tenant,p_venue_id,v_product,(p_plan->'generatedIds'->'modifierGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'displayName',(v_item->>'minSelection')::integer,(v_item->>'maxSelection')::integer,jsonb_array_length(v_item->'variantRefs')=0,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
    for v_variant_ref in select jsonb_array_elements_text(v_item->'variantRefs') loop insert into public.product_modifier_group_assignment_variants(tenant_id,venue_id,assignment_id,product_id,variant_id) values(v_tenant,p_venue_id,v_assignment,v_product,(p_plan->'generatedIds'->'variants'->>v_variant_ref)::uuid); end loop;
  end loop;
  set constraints all immediate;
  return jsonb_build_object('result','SUCCESS','removedImagePaths',to_jsonb(v_removed_paths));
end; $$;


--
-- Name: FUNCTION import_catalog(p_venue_id uuid, p_mode text, p_plan jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.import_catalog(p_venue_id uuid, p_mode text, p_plan jsonb) IS 'Transactional empty/replace catalogue reconstruction. Service role only.';


--
-- Name: mark_order_fully_served(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_order_fully_served(p_order_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: mark_order_line_fully_served(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_order_line_fully_served(p_order_line_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: mark_order_line_units_served(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_order_line_units_served(p_order_line_id uuid, p_units integer DEFAULT 1) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: move_restaurant_order(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.move_restaurant_order(p_order_id uuid, p_target_table_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: move_restaurant_order_lines(uuid, uuid, integer, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.move_restaurant_order_lines(p_source_order_id uuid, p_target_order_id uuid, p_expected_source_revision integer, p_expected_target_revision integer, p_moves jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: open_cash_register_session(uuid, integer, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.open_cash_register_session(p_cash_register_id uuid, p_opening_float_cents integer, p_device_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  register_row public.cash_registers%rowtype;
  device_row public.devices%rowtype;
  new_session_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Autenticacion requerida' using errcode = '42501'; end if;
  if p_opening_float_cents < 0 then raise exception 'Fondo inicial no valido'; end if;
  select cr.* into register_row from public.cash_registers cr where cr.id = p_cash_register_id for update;
  select d.* into device_row from public.devices d where d.id = p_device_id for update;
  if register_row.id is null or not register_row.is_active then raise exception 'Punto de caja no disponible'; end if;
  if device_row.id is null or not device_row.is_active
    or device_row.tenant_id <> register_row.tenant_id or device_row.venue_id <> register_row.venue_id
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id)
    or not device_row.can_open_cash_session then
    raise exception 'El dispositivo no puede abrir esta caja' using errcode = '42501';
  end if;
  if exists (select 1 from public.cash_sessions cs where cs.cash_register_id = register_row.id and cs.status = 'open') then
    raise exception 'Este punto de caja ya esta abierto' using errcode = '23505';
  end if;
  insert into public.cash_sessions (
    id, tenant_id, venue_id, cash_register_id, device_id, opened_by_device_id,
    opened_by, status, opening_float_cents, sync_source
  ) values (
    new_session_id, register_row.tenant_id, register_row.venue_id, register_row.id,
    device_row.id, device_row.id, auth.uid(), 'open', p_opening_float_cents, 'online'
  );
  return new_session_id;
end;
$$;


--
-- Name: open_restaurant_order(uuid[], integer, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.open_restaurant_order(p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: pay_restaurant_order_equal_part(uuid, text, integer, boolean, jsonb, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pay_restaurant_order_equal_part(p_split_id uuid, p_payment_method text DEFAULT NULL::text, p_received_cents integer DEFAULT NULL::integer, p_allow_pending boolean DEFAULT false, p_discount jsonb DEFAULT NULL::jsonb, p_use_default_discount boolean DEFAULT true) RETURNS jsonb
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
  line_start integer := 0;
  line_end integer;
  allocated_cents integer;
  allocated_quantity numeric;
  pending_units integer;
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

  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d
  join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id
    and dua.venue_id = order_row.venue_id and dua.is_active and d.is_active
    and d.can_take_payments
  order by case when d.id = order_row.opened_by_device_id then 0 else 1 end, d.id limit 1;
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
    allocated_cents := greatest(0, least(line_end, part_end) - greatest(line_start, part_start));
    if allocated_cents > 0 or (line_end = line_start and part_number = 1) then
      allocated_quantity := case when line_end = line_start then line_row.quantity::numeric
        else line_row.quantity::numeric * allocated_cents::numeric / (line_end - line_start)::numeric end;
      insert into public.ticket_lines (
        id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
        quantity, allocated_quantity, unit_price_cents, line_total_cents, modifiers
      ) values (
        gen_random_uuid(), line_row.tenant_id, ticket_id, line_row.product_id, line_row.variant_id,
        line_row.product_name, line_row.variant_name, 1, allocated_quantity,
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


--
-- Name: pay_restaurant_order_items(uuid, integer, jsonb, text, integer, boolean, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pay_restaurant_order_items(p_order_id uuid, p_expected_revision integer, p_items jsonb, p_payment_method text DEFAULT NULL::text, p_received_cents integer DEFAULT NULL::integer, p_allow_pending boolean DEFAULT false, p_discount jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  subtotal_cents integer;
  total_cents integer;
  pending_units integer;
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
    where coalesce((item ->> 'quantity')::integer, 0) <= 0
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
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  select count(*)::integer,
    count(ol.id)::integer,
    coalesce(sum(case when ol.id is null then 0 else selected.quantity * ol.unit_price_cents end), 0)::integer,
    coalesce(sum(case when ol.id is null then 0 else greatest(selected.quantity - least(ol.served_quantity, selected.quantity), 0) end), 0)::integer
  into requested_lines, matched_lines, subtotal_cents, pending_units
  from selected left join public.order_lines ol
    on ol.id = selected.line_id and ol.order_id = order_row.id
  where ol.id is null or selected.quantity <= ol.quantity;

  if matched_lines <> requested_lines or exists (
    with selected as (
      select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::integer)::integer quantity
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

  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d
  join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id
    and dua.venue_id = order_row.venue_id and dua.is_active and d.is_active
    and d.can_take_payments
  order by case when d.id = order_row.opened_by_device_id then 0 else 1 end, d.id limit 1;
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
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  insert into public.ticket_lines (
    id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
    quantity, unit_price_cents, line_total_cents, modifiers
  )
  select gen_random_uuid(), ol.tenant_id, ticket_id, ol.product_id, ol.variant_id,
    ol.product_name, ol.variant_name, selected.quantity, ol.unit_price_cents,
    selected.quantity * ol.unit_price_cents,
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
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::integer)::integer quantity
    from jsonb_array_elements(p_items) item group by (item ->> 'lineId')::uuid
  )
  delete from public.order_lines ol using selected
  where ol.id = selected.line_id and selected.quantity = ol.quantity;

  with selected as (
    select (item ->> 'lineId')::uuid line_id, sum((item ->> 'quantity')::integer)::integer quantity
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


--
-- Name: persist_catalog_order_line_draft(uuid, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.persist_catalog_order_line_draft(p_order_id uuid, p_expected_revision integer, p_lines jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  o public.orders%rowtype; item jsonb; current_line public.order_lines%rowtype;
  line_id uuid; selected_product_id uuid; selected_variant_id uuid; quantity_value integer; note_value text;
  retained uuid[]:='{}'; signatures text[]:='{}'; signature text; next_revision integer;
  selected_product_name text; selected_variant_name text; base_price integer;
begin
  if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)>500 then
    raise exception 'CATALOG_LINES_MUST_BE_ARRAY';
  end if;
  select * into o from public.orders where id=p_order_id for update;
  if o.id is null or o.status<>'open' or not public.user_has_venue_access(o.tenant_id,o.venue_id) then
    raise exception 'CATALOG_ORDER_NOT_FOUND' using errcode='42501';
  end if;
  if o.revision<>p_expected_revision then raise exception 'CATALOG_ORDER_REVISION_CONFLICT' using errcode='40001'; end if;
  perform 1 from public.order_lines l where l.order_id=o.id order by l.id for update;

  for item in select value from jsonb_array_elements(p_lines) loop
    line_id:=(item->>'id')::uuid;
    quantity_value:=(item->>'quantity')::integer;
    note_value:=nullif(trim(item->>'note'),'');
    if quantity_value<1 or quantity_value>9999 or line_id=any(retained) then raise exception 'CATALOG_INVALID_ORDER_DRAFT'; end if;
    select * into current_line from public.order_lines where id=line_id and order_id=o.id;
    if current_line.id is not null and current_line.served_quantity>0 then
      if quantity_value<current_line.served_quantity
        or nullif(item->>'productId','')::uuid is distinct from current_line.product_id
        or nullif(item->>'variantId','')::uuid is distinct from current_line.variant_id then
        raise exception 'CATALOG_SERVED_LINE_IMMUTABLE';
      end if;
      update public.order_lines set quantity=quantity_value,note=note_value,
        fully_served_at=case when quantity_value=served_quantity then coalesce(fully_served_at,now()) else null end
      where id=line_id;
      retained:=array_append(retained,line_id);
      continue;
    end if;

    selected_product_id:=nullif(item->>'productId','')::uuid;
    selected_variant_id:=nullif(item->>'variantId','')::uuid;
    select p.name,v.name,v.price_cents into selected_product_name,selected_variant_name,base_price
    from public.products p join public.product_variants v on v.product_id=p.id
    where p.id=selected_product_id and v.id=selected_variant_id
      and p.tenant_id=o.tenant_id and p.venue_id=o.venue_id
      and v.tenant_id=o.tenant_id and v.venue_id=o.venue_id and p.is_active and v.is_active;
    if base_price is null then raise exception 'CATALOG_PRODUCT_NOT_SELLABLE'; end if;
    signature:=concat_ws('|',selected_product_id,selected_variant_id,coalesce(item->'modifierIds','[]'::jsonb),coalesce(item->'components','[]'::jsonb),coalesce(note_value,''));
    if signature=any(signatures) then raise exception 'CATALOG_DUPLICATE_ORDER_LINE'; end if;
    signatures:=array_append(signatures,signature);

    if current_line.id is null then
      insert into public.order_lines(
        id,tenant_id,venue_id,order_id,product_id,variant_id,product_name,variant_name,
        unit_price_cents,quantity,modifiers,components,catalog_snapshot,mixer_product_id,mixer,note)
      values(line_id,o.tenant_id,o.venue_id,o.id,selected_product_id,selected_variant_id,
        selected_product_name,selected_variant_name,base_price,quantity_value,'[]','[]',
        coalesce(item->'catalogSnapshot','{}'),null,null,note_value);
    else
      update public.order_lines set product_id=selected_product_id,variant_id=selected_variant_id,
        product_name=selected_product_name,variant_name=selected_variant_name,unit_price_cents=base_price,
        quantity=quantity_value,modifiers='[]',components='[]',catalog_snapshot=coalesce(item->'catalogSnapshot','{}'),
        mixer_product_id=null,mixer=null,note=note_value,fully_served_at=null
      where id=line_id;
    end if;
    retained:=array_append(retained,line_id);
  end loop;

  if exists(select 1 from public.order_lines where order_id=o.id and not(id=any(retained)) and served_quantity>0) then
    raise exception 'CATALOG_SERVED_LINE_DELETE_FORBIDDEN';
  end if;
  delete from public.order_lines where order_id=o.id and not(id=any(retained));
  update public.orders set revision=revision+1 where id=o.id returning revision into next_revision;
  return jsonb_build_object('revision',next_revision);
end $$;


--
-- Name: protect_open_cash_register(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_open_cash_register() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if old.is_active and not new.is_active and exists (
    select 1 from public.cash_sessions cs where cs.cash_register_id = old.id and cs.status = 'open'
  ) then raise exception 'No se puede desactivar un punto de caja abierto'; end if;
  return new;
end;
$$;


--
-- Name: reconcile_cash_register_after_close(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_cash_register_after_close() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if old.status = 'open' and new.status = 'closed' then
    perform public.reconcile_device_cash_register(new.cash_register_id);
  end if;
  return new;
end;
$$;


--
-- Name: reconcile_device_cash_register(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_device_cash_register(target_device_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  device_row public.devices%rowtype;
  has_active_cashier boolean := false;
  is_cash_point boolean := false;
  next_sort_order integer;
begin
  select d.*
  into device_row
  from public.devices d
  where d.id = target_device_id;

  if not found then
    update public.cash_registers cr
    set is_active = false,
        updated_at = now()
    where cr.id = target_device_id
      and cr.is_active = true
      and not exists (
        select 1 from public.cash_sessions cs
        where cs.cash_register_id = cr.id and cs.status = 'open'
      );
    return;
  end if;

  select exists (
    select 1
    from public.device_user_assignments dua
    join public.tenant_memberships tm
      on tm.tenant_id = dua.tenant_id
     and tm.user_id = dua.user_id
    where dua.device_id = device_row.id
      and dua.tenant_id = device_row.tenant_id
      and dua.venue_id = device_row.venue_id
      and dua.is_active = true
      and tm.is_active = true
      and tm.role = 'cashier'
  )
  into has_active_cashier;

  is_cash_point := (
    device_row.is_active = true
    and device_row.device_mode in ('checkout', 'hybrid')
    and device_row.can_open_cash_session = true
    and has_active_cashier
  );

  if is_cash_point then
    -- Un punto manual antiguo podria conservar el mismo nombre. Se archiva
    -- antes de crear el punto vinculado al dispositivo real.
    update public.cash_registers cr
    set name = cr.name || ' (archivado ' || left(cr.id::text, 8) || ')',
        updated_at = now()
    where cr.id <> device_row.id
      and cr.tenant_id = device_row.tenant_id
      and cr.venue_id = device_row.venue_id
      and cr.name = device_row.name;

    select coalesce(max(cr.sort_order), 0) + 1
    into next_sort_order
    from public.cash_registers cr
    where cr.tenant_id = device_row.tenant_id
      and cr.venue_id = device_row.venue_id;

    insert into public.cash_registers (
      id,
      tenant_id,
      venue_id,
      name,
      is_active,
      sort_order
    ) values (
      device_row.id,
      device_row.tenant_id,
      device_row.venue_id,
      device_row.name,
      true,
      next_sort_order
    )
    on conflict (id) do update
    set name = excluded.name,
        is_active = true,
        updated_at = now();

    update public.devices
    set default_cash_register_id = device_row.id
    where id = device_row.id
      and default_cash_register_id is distinct from device_row.id;
  else
    update public.devices
    set default_cash_register_id = null
    where id = device_row.id
      and default_cash_register_id is not null;

    -- Si esta abierta se conserva hasta su cierre; el trigger de cash_sessions
    -- volvera a ejecutar esta funcion en ese momento.
    update public.cash_registers cr
    set is_active = false,
        updated_at = now()
    where cr.id = device_row.id
      and cr.is_active = true
      and not exists (
        select 1 from public.cash_sessions cs
        where cs.cash_register_id = cr.id and cs.status = 'open'
      );
  end if;
end;
$$;


--
-- Name: record_cash_closing_print_result(uuid, uuid, text, text, text, text, text, boolean, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_cash_closing_print_result(p_cash_closing_id uuid, p_terminal_id uuid, p_printer_id text, p_print_job_id text, p_request_id text, p_status text, p_error_code text, p_is_reprint boolean, p_copy_number integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  closing public.cash_sessions%rowtype;
  event_name text;
  member_role text;
  terminal_can_manage_cash boolean := false;
begin
  select * into closing from public.cash_sessions where id = p_cash_closing_id for update;
  if closing.id is null or closing.status <> 'closed' or not public.user_has_venue_access(closing.tenant_id, closing.venue_id) then
    raise exception 'Cierre no disponible' using errcode = '42501';
  end if;
  if p_is_reprint then
    select tm.role into member_role from public.tenant_memberships tm
    where tm.tenant_id = closing.tenant_id and tm.user_id = auth.uid() and tm.is_active limit 1;
    select coalesce(d.can_manage_cash, false) into terminal_can_manage_cash from public.devices d
    where d.id = p_terminal_id and d.tenant_id = closing.tenant_id and d.venue_id = closing.venue_id;
    if coalesce(member_role, '') not in ('owner', 'admin', 'manager') and not terminal_can_manage_cash then
      raise exception 'No tienes permiso para reimprimir cierres' using errcode = '42501';
    end if;
  elsif closing.closed_by <> auth.uid() and not public.user_is_tenant_admin(closing.tenant_id) then
    raise exception 'No tienes permiso para imprimir este cierre' using errcode = '42501';
  end if;
  if p_status not in ('pending', 'printed', 'failed', 'unknown') then raise exception 'Estado de impresion no valido'; end if;
  if p_status = 'pending' and not p_is_reprint and closing.print_status in ('pending', 'printed', 'unknown') then
    return false;
  end if;
  if p_status = 'pending' and p_is_reprint and (
    (closing.print_request_id = p_request_id and closing.print_status in ('pending', 'printed', 'unknown'))
    or p_copy_number <= closing.print_copies
  ) then
    return false;
  end if;

  update public.cash_sessions set
    print_status = p_status,
    print_job_id = coalesce(p_print_job_id, print_job_id),
    print_request_id = p_request_id,
    printed_at = case when p_status = 'printed' then now() else printed_at end,
    print_error_code = p_error_code,
    print_attempts = print_attempts + case when p_status = 'pending' then 1 else 0 end,
    print_copies = print_copies + case when p_status = 'printed' and p_is_reprint then 1 else 0 end
  where id = closing.id;

  if p_status <> 'pending' then
    event_name := case when p_status = 'printed' and p_is_reprint then 'cash_closing.reprinted'
      when p_status = 'printed' then 'cash_closing.printed' else 'cash_closing.print_failed' end;
    insert into public.cash_closing_print_events (
      tenant_id, cash_closing_id, event_type, user_id, terminal_id, printer_id,
      print_job_id, request_id, is_reprint, copy_number, error_code
    ) values (
      closing.tenant_id, closing.id, event_name, auth.uid(), p_terminal_id, p_printer_id,
      p_print_job_id, p_request_id, p_is_reprint, p_copy_number, p_error_code
    );
  end if;
  return true;
end;
$$;


--
-- Name: record_restaurant_order_event(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_restaurant_order_event(p_order_id uuid, p_event_type text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: release_user_login(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_user_login(p_client_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  delete from public.user_login_leases
  where user_id = auth.uid()
    and auth_session_id = (auth.jwt() ->> 'session_id')
    and client_id = p_client_id;
$$;


--
-- Name: remove_restaurant_order_line(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_restaurant_order_line(p_line_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: remove_restaurant_order_line_confirmed(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_restaurant_order_line_confirmed(p_line_id uuid, p_expected_revision integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  order_row public.orders%rowtype;
  line_row public.order_lines%rowtype;
  next_revision integer;
begin
  select o.* into order_row
  from public.orders o
  join public.order_lines ol on ol.order_id = o.id
  where ol.id = p_line_id
  for update of o;

  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Línea de comanda no disponible' using errcode = '42501';
  end if;

  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo'
      using errcode = '40001', detail = jsonb_build_object(
        'expectedRevision', p_expected_revision,
        'currentRevision', order_row.revision
      )::text;
  end if;

  select ol.* into line_row
  from public.order_lines ol
  where ol.id = p_line_id and ol.order_id = order_row.id
  for update;

  if line_row.id is null then
    raise exception 'Línea de comanda no disponible' using errcode = 'P0002';
  end if;

  perform public.record_restaurant_order_event(
    order_row.id,
    'line_quantity_changed',
    jsonb_build_object(
      'lineId', line_row.id,
      'oldQuantity', line_row.quantity,
      'quantity', 0,
      'servedQuantity', line_row.served_quantity,
      'removed', true
    )
  );

  delete from public.order_lines ol where ol.id = line_row.id;
  update public.orders o
  set revision = o.revision + 1
  where o.id = order_row.id
  returning o.revision into next_revision;

  return next_revision;
end;
$$;


--
-- Name: resolve_effective_tax_rate(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_effective_tax_rate(p_product_id uuid, p_tenant_id uuid, p_venue_id uuid) RETURNS numeric
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select coalesce(p.tax_rate, v.default_tax_rate)
  from public.products p
  join public.venues v
    on v.id = p.venue_id
   and v.tenant_id = p.tenant_id
  where p.id = p_product_id
    and p.tenant_id = p_tenant_id
    and p.venue_id = p_venue_id;
$$;


--
-- Name: resolve_ticket_discount(uuid, uuid, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_ticket_discount(p_tenant_id uuid, p_venue_id uuid, p_subtotal_cents integer, p_discount jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  configured public.discounts%rowtype;
  snapshot_type text;
  calculation_type text;
  snapshot_name text;
  configured_value numeric(12, 2);
  fixed_value_cents integer;
  amount_cents integer;
  total_cents integer;
  rounding_increment_cents integer;
begin
  if p_subtotal_cents < 0 then
    raise exception 'Subtotal no valido';
  end if;
  if p_discount is null or jsonb_typeof(p_discount) = 'null' then
    return jsonb_build_object('amountCents', 0, 'totalCents', p_subtotal_cents);
  end if;

  if nullif(p_discount ->> 'discountId', '') is not null then
    select d.* into configured
    from public.discounts d
    where d.id = (p_discount ->> 'discountId')::uuid
      and d.tenant_id = p_tenant_id
      and d.venue_id = p_venue_id
      and d.is_active;
    if configured.id is null then
      raise exception 'El descuento no existe, esta inactivo o pertenece a otro local' using errcode = '42501';
    end if;
    snapshot_type := configured.type;
    calculation_type := configured.type;
    snapshot_name := configured.name;
    configured_value := configured.value;
    fixed_value_cents := case when configured.type = 'fixed' then round(configured.value * 100)::integer else null end;
    rounding_increment_cents := configured.rounding_increment_cents;
  else
    if coalesce((select v.manual_discount_enabled from public.venues v
      where v.id = p_venue_id and v.tenant_id = p_tenant_id), false) is false then
      raise exception 'El descuento manual esta deshabilitado' using errcode = '42501';
    end if;
    snapshot_type := 'manual';
    calculation_type := p_discount ->> 'calculationType';
    snapshot_name := 'Descuento manual';
    rounding_increment_cents := null;
    if calculation_type = 'percentage' then
      configured_value := (p_discount ->> 'value')::numeric;
    elsif calculation_type = 'fixed' then
      fixed_value_cents := (p_discount ->> 'value')::integer;
      configured_value := fixed_value_cents::numeric / 100;
    else
      raise exception 'Tipo de descuento manual no valido';
    end if;
  end if;

  if calculation_type = 'percentage' then
    if configured_value <= 0 or configured_value > 100 then
      raise exception 'El porcentaje debe estar entre 0 y 100';
    end if;
    amount_cents := round(p_subtotal_cents * configured_value / 100)::integer;
  else
    if fixed_value_cents is null then
      fixed_value_cents := round(configured_value * 100)::integer;
    end if;
    if fixed_value_cents <= 0 then raise exception 'El importe fijo debe ser mayor que cero'; end if;
    amount_cents := fixed_value_cents;
  end if;

  amount_cents := least(p_subtotal_cents, amount_cents);
  total_cents := p_subtotal_cents - amount_cents;

  if rounding_increment_cents is not null then
    total_cents := least(
      p_subtotal_cents,
      round(total_cents::numeric / rounding_increment_cents)::integer * rounding_increment_cents
    );
    amount_cents := p_subtotal_cents - total_cents;
  end if;

  return jsonb_build_object(
    'discountId', configured.id,
    'name', snapshot_name,
    'type', snapshot_type,
    'calculationType', calculation_type,
    'value', case when calculation_type = 'fixed' then fixed_value_cents else configured_value end,
    'storedValue', configured_value,
    'roundingIncrementCents', rounding_increment_cents,
    'amountCents', amount_cents,
    'totalCents', total_cents
  );
end;
$$;


--
-- Name: restaurant_order_equal_splits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurant_order_equal_splits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    order_group_id uuid NOT NULL,
    order_id uuid NOT NULL,
    total_cents integer NOT NULL,
    part_count integer NOT NULL,
    paid_parts integer DEFAULT 0 NOT NULL,
    paid_cents integer DEFAULT 0 NOT NULL,
    allow_pending_service boolean DEFAULT false NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    default_discount jsonb,
    CONSTRAINT restaurant_order_equal_splits_paid_cents_check CHECK ((paid_cents >= 0)),
    CONSTRAINT restaurant_order_equal_splits_paid_parts_check CHECK ((paid_parts >= 0)),
    CONSTRAINT restaurant_order_equal_splits_part_count_check CHECK (((part_count >= 2) AND (part_count <= 99))),
    CONSTRAINT restaurant_order_equal_splits_progress_check CHECK (((paid_parts <= part_count) AND (paid_cents <= total_cents) AND (((status = 'completed'::text) AND (paid_parts = part_count) AND (paid_cents = total_cents) AND (completed_at IS NOT NULL)) OR ((status <> 'completed'::text) AND (completed_at IS NULL))))),
    CONSTRAINT restaurant_order_equal_splits_revision_check CHECK ((revision > 0)),
    CONSTRAINT restaurant_order_equal_splits_status_check CHECK ((status = ANY (ARRAY['open'::text, 'completed'::text, 'cancelled'::text]))),
    CONSTRAINT restaurant_order_equal_splits_total_cents_check CHECK ((total_cents > 0))
);


--
-- Name: restaurant_equal_split_to_json(public.restaurant_order_equal_splits); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.restaurant_equal_split_to_json(p_split public.restaurant_order_equal_splits) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  next_part_number integer := p_split.paid_parts + 1;
  next_subtotal integer := 0;
  next_discount_amount integer := 0;
  next_discount jsonb := null;
  calculation_type text;
  configured_value numeric;
begin
  if p_split.status = 'open' then
    next_subtotal := (p_split.total_cents / p_split.part_count)
      + case when next_part_number <= mod(p_split.total_cents, p_split.part_count) then 1 else 0 end;
  end if;

  if next_subtotal > 0 and p_split.default_discount is not null then
    calculation_type := p_split.default_discount ->> 'calculationType';
    next_discount_amount := (coalesce((p_split.default_discount ->> 'amountCents')::integer, 0) / p_split.part_count)
      + case when next_part_number <= mod(coalesce((p_split.default_discount ->> 'amountCents')::integer, 0), p_split.part_count) then 1 else 0 end;
    next_discount_amount := least(next_subtotal, next_discount_amount);
    if next_discount_amount = 0 then
      next_discount := null;
    elsif calculation_type = 'percentage' then
      configured_value := (p_split.default_discount ->> 'value')::numeric;
      next_discount := jsonb_build_object(
        'discountId', nullif(p_split.default_discount ->> 'discountId', ''),
        'name', p_split.default_discount ->> 'name',
        'type', p_split.default_discount ->> 'type',
        'calculationType', 'percentage',
        'value', configured_value,
        'roundingIncrementCents', nullif(p_split.default_discount ->> 'roundingIncrementCents', '')::integer,
        'color', p_split.default_discount -> 'color'
      );
    elsif calculation_type = 'fixed' then
      if next_discount_amount > 0 then
        next_discount := jsonb_build_object(
          'discountId', nullif(p_split.default_discount ->> 'discountId', ''),
          'name', p_split.default_discount ->> 'name',
          'type', p_split.default_discount ->> 'type',
          'calculationType', 'fixed',
          'value', next_discount_amount,
          'roundingIncrementCents', nullif(p_split.default_discount ->> 'roundingIncrementCents', '')::integer,
          'color', p_split.default_discount -> 'color'
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'id', p_split.id,
    'orderId', p_split.order_id,
    'orderGroupId', p_split.order_group_id,
    'totalCents', p_split.total_cents,
    'partCount', p_split.part_count,
    'paidParts', p_split.paid_parts,
    'paidCents', p_split.paid_cents,
    'remainingParts', p_split.part_count - p_split.paid_parts,
    'remainingCents', p_split.total_cents - p_split.paid_cents,
    'nextPartCents', next_subtotal,
    'nextDefaultDiscount', next_discount,
    'nextDefaultDiscountAmountCents', next_discount_amount,
    'nextDefaultTotalCents', next_subtotal - next_discount_amount,
    'status', p_split.status,
    'revision', p_split.revision,
    'allowPendingService', p_split.allow_pending_service
  );
end;
$$;


--
-- Name: save_cash_session_table_layout(uuid, bigint, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_cash_session_table_layout(p_cash_session_id uuid, p_expected_revision bigint, p_tables jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  session_row public.cash_sessions%rowtype;
  layout_row public.cash_session_table_layouts%rowtype;
  active_count integer;
  supplied_count integer;
begin
  select cs.* into session_row from public.cash_sessions cs where cs.id = p_cash_session_id for update;
  if session_row.id is null or session_row.status <> 'open'
    or not public.user_has_venue_access(session_row.tenant_id, session_row.venue_id) then
    raise exception 'Sesion de caja no disponible' using errcode = '42501';
  end if;
  perform public.get_cash_session_table_layout(p_cash_session_id);
  select l.* into layout_row from public.cash_session_table_layouts l where l.cash_session_id = p_cash_session_id for update;
  if layout_row.revision <> p_expected_revision then
    raise exception 'La distribucion ha cambiado en otro dispositivo' using errcode = '40001', detail = jsonb_build_object('currentRevision', layout_row.revision)::text;
  end if;
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then raise exception 'Distribucion no valida'; end if;

  select count(*) into active_count from public.restaurant_tables rt
  where rt.tenant_id = session_row.tenant_id and rt.venue_id = session_row.venue_id and rt.is_active;
  select count(*) into supplied_count from jsonb_object_keys(p_tables);
  if supplied_count <> active_count or exists (
    select 1 from jsonb_object_keys(p_tables) supplied(table_id)
    where not exists (select 1 from public.restaurant_tables rt where rt.id = supplied.table_id::uuid and rt.tenant_id = session_row.tenant_id and rt.venue_id = session_row.venue_id and rt.is_active)
  ) then raise exception 'La distribucion no contiene exactamente las mesas activas del local'; end if;

  if exists (
    select 1 from jsonb_each(p_tables) item(table_id, value)
    join public.restaurant_tables rt on rt.id = item.table_id::uuid
    where jsonb_typeof(item.value) <> 'object'
      or jsonb_typeof(item.value -> 'positionX') <> 'number'
      or jsonb_typeof(item.value -> 'positionY') <> 'number'
      or (item.value ->> 'positionX')::numeric < 0 or (item.value ->> 'positionY')::numeric < 0
      or (item.value ->> 'positionX')::numeric > 100 - rt.width
      or (item.value ->> 'positionY')::numeric > 100 - rt.height
  ) then raise exception 'Una mesa tiene una posicion no valida'; end if;

  if exists (
    select 1 from (
      select item.value ->> 'groupId' group_id, count(*) member_count
      from jsonb_each(p_tables) item(table_id, value)
      where nullif(item.value ->> 'groupId', '') is not null
      group by item.value ->> 'groupId'
    ) groups where groups.member_count < 2
  ) then raise exception 'Los grupos deben contener al menos dos mesas'; end if;

  if exists (
    select 1
    from jsonb_each(p_tables) item(table_id, value)
    join public.order_tables ot on ot.table_id = item.table_id::uuid and ot.released_at is null
    join public.orders o on o.id = ot.order_id and o.status = 'open'
    where nullif(item.value ->> 'groupId', '') is not null
    group by item.value ->> 'groupId'
    having count(distinct o.id) > 1
  ) then raise exception 'No se pueden agrupar mesas con comandas distintas'; end if;

  update public.cash_session_table_layouts l
  set tables = p_tables, revision = l.revision + 1, updated_by = auth.uid(), updated_at = now()
  where l.cash_session_id = p_cash_session_id returning l.* into layout_row;
  return jsonb_build_object('cashSessionId', layout_row.cash_session_id, 'revision', layout_row.revision, 'updatedAt', layout_row.updated_at, 'tables', layout_row.tables);
end;
$$;


--
-- Name: save_catalog_order_lines(uuid, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_catalog_order_lines(p_order_id uuid, p_expected_revision integer, p_lines jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_result jsonb;
  v_base_lines jsonb;
  v_result_lines jsonb;
  v_line jsonb;
  v_line_id uuid;
  v_product_id uuid;
  v_variant_id uuid;
  v_venue_id uuid;
  v_base_price integer;
  v_unit_price integer;
  v_sent_count integer;
  v_component_count integer;
  v_line_modifiers jsonb;
  v_submitted_modifiers jsonb;
  v_components jsonb;
begin
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'CATALOG_LINES_MUST_BE_ARRAY'; end if;
  select o.venue_id into v_venue_id from public.orders o where o.id = p_order_id;
  if v_venue_id is null then raise exception 'CATALOG_ORDER_NOT_FOUND'; end if;

  -- The proven order/revision/served-line implementation creates the rows. New
  -- catalogue selections are canonicalised below, so transitional modifier and
  -- mixer inputs are deliberately removed before calling it.
  select coalesce(jsonb_agg(value || jsonb_build_object(
    'modifierIds', '[]'::jsonb, 'mixerProductId', null, 'mixer', null
  )), '[]'::jsonb) into v_base_lines from jsonb_array_elements(p_lines);
  v_result := public.persist_catalog_order_line_draft(p_order_id, p_expected_revision, v_base_lines);

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_line_id := (v_line ->> 'id')::uuid;
    v_product_id := (v_line ->> 'productId')::uuid;
    v_variant_id := (v_line ->> 'variantId')::uuid;
    select v.price_cents into v_base_price
    from public.product_variants v
    join public.products p on p.id = v.product_id and p.venue_id = v_venue_id and p.is_active
    where v.id = v_variant_id and v.product_id = v_product_id and v.venue_id = v_venue_id and v.is_active;
    if v_base_price is null then raise exception 'CATALOG_PRODUCT_NOT_SELLABLE'; end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', value)), '[]'::jsonb)
      into v_submitted_modifiers
      from jsonb_array_elements_text(coalesce(v_line -> 'modifierIds', '[]'::jsonb));
    v_line_modifiers := public.canonical_catalog_modifiers(
      v_venue_id, v_product_id, v_variant_id, v_submitted_modifiers
    );
    if jsonb_array_length(v_line_modifiers) <> jsonb_array_length(v_submitted_modifiers) then
      raise exception 'CATALOG_INVALID_MODIFIER';
    end if;
    if exists (
      select 1
      from public.product_modifier_group_assignments a
      join public.modifier_groups g on g.id = a.group_id and g.is_active
      left join lateral (
        select count(*)::integer amount from jsonb_array_elements(v_line_modifiers) m
        where m ->> 'groupId' = g.id::text
      ) chosen on true
      where a.product_id = v_product_id and a.venue_id = v_venue_id and a.is_active
        and (a.applies_to_all_variants or exists (
          select 1 from public.product_modifier_group_assignment_variants av
          where av.assignment_id = a.id and av.variant_id = v_variant_id
        ))
        and (chosen.amount < a.min_selection or chosen.amount > a.max_selection)
    ) then raise exception 'CATALOG_MODIFIER_LIMITS'; end if;

    v_sent_count := jsonb_array_length(coalesce(v_line -> 'components', '[]'::jsonb));
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id,
      'type', g.kind,
      'selectionGroupId', g.id,
      'selectionGroupName', coalesce(a.display_name, g.name),
      'productId', p.id,
      'variantId', selected_variant.id,
      'productName', p.name,
      'variantName', selected_variant.name,
      'quantity', submitted.quantity,
      'priceDeltaCents', o.supplement_cents,
      'sortOrder', o.sort_order,
      'modifiers', public.canonical_catalog_modifiers(
        v_venue_id, p.id, selected_variant.id, submitted.modifiers
      )
    ) order by a.sort_order, g.sort_order, o.sort_order, o.id), '[]'::jsonb), count(*)::integer
    into v_components, v_component_count
    from jsonb_to_recordset(coalesce(v_line -> 'components', '[]'::jsonb)) submitted(
      id text, "selectionGroupId" text, "productId" text, "variantId" text,
      quantity integer, modifiers jsonb
    )
    join public.product_selection_group_assignments a on a.product_id = v_product_id
      and a.venue_id = v_venue_id and a.is_active
      and (a.applies_to_all_variants or exists (
        select 1 from public.product_selection_group_assignment_variants av
        where av.assignment_id = a.id and av.variant_id = v_variant_id
      ))
    join public.selection_groups g on g.id = a.group_id and g.venue_id = v_venue_id and g.is_active
      and (submitted."selectionGroupId" is null or g.id = nullif(submitted."selectionGroupId", '')::uuid)
    join public.selection_group_options o on o.id = nullif(submitted.id, '')::uuid
      and o.group_id = g.id and o.venue_id = v_venue_id and o.is_active
      and o.product_id = nullif(submitted."productId", '')::uuid
    join public.products p on p.id = o.product_id and p.venue_id = v_venue_id and p.is_active
    join lateral (
      select candidate.id, candidate.name
      from public.product_variants candidate
      where candidate.product_id = p.id and candidate.venue_id = v_venue_id and candidate.is_active
        and (o.variant_id is null and candidate.is_default or candidate.id = o.variant_id)
      order by (candidate.id = o.variant_id) desc, candidate.is_default desc, candidate.sort_order, candidate.id
      limit 1
    ) selected_variant on true
    where submitted.quantity > 0
      and (o.max_quantity is null or submitted.quantity <= o.max_quantity)
      and (submitted."variantId" is null or selected_variant.id = nullif(submitted."variantId", '')::uuid);

    if v_component_count <> v_sent_count then raise exception 'CATALOG_INVALID_SELECTION_OPTION'; end if;
    if exists (
      select 1
      from public.product_selection_group_assignments a
      join public.selection_groups g on g.id = a.group_id and g.is_active
      left join lateral (
        select coalesce(sum((component ->> 'quantity')::integer), 0)::integer amount
        from jsonb_array_elements(v_components) component
        where component ->> 'selectionGroupId' = g.id::text
      ) chosen on true
      where a.product_id = v_product_id and a.venue_id = v_venue_id and a.is_active
        and (a.applies_to_all_variants or exists (
          select 1 from public.product_selection_group_assignment_variants av
          where av.assignment_id = a.id and av.variant_id = v_variant_id
        ))
        and (chosen.amount < a.min_selection or chosen.amount > a.max_selection)
    ) then raise exception 'CATALOG_SELECTION_LIMITS'; end if;

    if exists (
      select 1
      from jsonb_array_elements(v_components) canonical
      join lateral (
        select submitted.modifiers
        from jsonb_to_recordset(coalesce(v_line -> 'components', '[]'::jsonb)) submitted(id text, modifiers jsonb)
        where submitted.id = canonical ->> 'id' limit 1
      ) source on true
      where jsonb_array_length(coalesce(canonical -> 'modifiers', '[]'::jsonb))
        <> jsonb_array_length(coalesce(source.modifiers, '[]'::jsonb))
    ) then raise exception 'CATALOG_INVALID_COMPONENT_MODIFIER'; end if;

    if exists (
      select 1
      from jsonb_array_elements(v_components) component
      join public.product_modifier_group_assignments a
        on a.product_id = (component ->> 'productId')::uuid
        and a.venue_id = v_venue_id and a.is_active
        and (a.applies_to_all_variants or exists (
          select 1 from public.product_modifier_group_assignment_variants av
          where av.assignment_id = a.id and av.variant_id = (component ->> 'variantId')::uuid
        ))
      join public.modifier_groups g on g.id = a.group_id and g.is_active
      left join lateral (
        select count(*)::integer amount
        from jsonb_array_elements(coalesce(component -> 'modifiers', '[]'::jsonb)) selected
        where selected ->> 'groupId' = g.id::text
      ) chosen on true
      where chosen.amount < a.min_selection or chosen.amount > a.max_selection
    ) then raise exception 'CATALOG_COMPONENT_MODIFIER_LIMITS'; end if;

    v_unit_price := v_base_price
      + coalesce((select sum((m ->> 'priceCents')::integer) from jsonb_array_elements(v_line_modifiers) m), 0)
      + coalesce((select sum((c ->> 'priceDeltaCents')::integer * (c ->> 'quantity')::integer) from jsonb_array_elements(v_components) c), 0)
      + coalesce((select sum((m ->> 'priceCents')::integer * (c ->> 'quantity')::integer)
        from jsonb_array_elements(v_components) c
        cross join lateral jsonb_array_elements(coalesce(c -> 'modifiers', '[]'::jsonb)) m), 0);
    if v_unit_price < 0 then raise exception 'CATALOG_NEGATIVE_FINAL_PRICE'; end if;

    update public.order_lines ol set
      modifiers = v_line_modifiers,
      components = v_components,
      mixer_product_id = null,
      mixer = null,
      catalog_snapshot = coalesce(v_line -> 'catalogSnapshot', '{}'::jsonb),
      unit_price_cents = v_unit_price
    where ol.id = v_line_id and ol.order_id = p_order_id;
    if not found then raise exception 'CATALOG_ORDER_LINE_NOT_FOUND'; end if;

    delete from public.order_line_components where order_line_id = v_line_id;
    insert into public.order_line_components(
      tenant_id, venue_id, order_line_id, component_type, selection_group_id,
      product_id, variant_id, product_name_snapshot, variant_name_snapshot,
      quantity, price_delta_cents, sort_order, metadata
    )
    select ol.tenant_id, ol.venue_id, ol.id, c.type, nullif(c."selectionGroupId", '')::uuid,
      nullif(c."productId", '')::uuid, nullif(c."variantId", '')::uuid,
      c."productName", c."variantName", c.quantity, c."priceDeltaCents", c."sortOrder",
      jsonb_build_object('modifiers', coalesce(c.modifiers, '[]'::jsonb))
    from public.order_lines ol
    cross join jsonb_to_recordset(v_components) c(
      type text, "selectionGroupId" text, "productId" text, "variantId" text,
      "productName" text, "variantName" text, quantity integer,
      "priceDeltaCents" integer, "sortOrder" integer, modifiers jsonb
    )
    where ol.id = v_line_id;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ol.id, 'tenantId', ol.tenant_id, 'venueId', ol.venue_id, 'orderId', ol.order_id,
    'productId', ol.product_id, 'variantId', ol.variant_id, 'productName', ol.product_name,
    'variantName', ol.variant_name, 'unitPriceCents', ol.unit_price_cents, 'quantity', ol.quantity,
    'servedQuantity', ol.served_quantity, 'fullyServedAt', ol.fully_served_at,
    'modifiers', ol.modifiers, 'components', ol.components, 'catalogSnapshot', ol.catalog_snapshot,
    'mixerProductId', ol.mixer_product_id, 'mixer', ol.mixer, 'note', ol.note,
    'createdAt', ol.created_at, 'updatedAt', ol.updated_at
  ) order by ol.created_at, ol.id), '[]'::jsonb)
  into v_result_lines from public.order_lines ol where ol.order_id = p_order_id;

  return jsonb_build_object('revision', (v_result ->> 'revision')::integer, 'lines', v_result_lines);
end;
$$;


--
-- Name: FUNCTION save_catalog_order_lines(p_order_id uuid, p_expected_revision integer, p_lines jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.save_catalog_order_lines(p_order_id uuid, p_expected_revision integer, p_lines jsonb) IS 'Definitive order-line command using final assignments and immutable snapshots.';


--
-- Name: set_order_cash_register(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_order_cash_register() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.cash_register_id is null then
    select cs.cash_register_id into new.cash_register_id from public.cash_sessions cs
    where cs.id = new.cash_session_id and cs.status = 'open';
  end if;
  if new.cash_register_id is null then raise exception 'La comanda requiere una caja abierta'; end if;
  return new;
end;
$$;


--
-- Name: set_restaurant_order_line_quantity(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_restaurant_order_line_quantity(p_line_id uuid, p_quantity integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: set_ticket_discount_rounding_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_ticket_discount_rounding_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.discount_id is null or new.discount_type = 'manual' then
    new.discount_rounding_increment_cents := null;
  else
    select d.rounding_increment_cents
      into new.discount_rounding_increment_cents
    from public.discounts d
    where d.id = new.discount_id
      and d.tenant_id = new.tenant_id
      and d.venue_id = new.venue_id;
  end if;
  return new;
end;
$$;


--
-- Name: set_ticket_line_fiscal_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_ticket_line_fiscal_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  ticket_venue_id uuid;
  effective_tax_rate numeric;
  breakdown record;
begin
  -- Un cambio ajeno a la identidad fiscal no debe recalcular un ticket cerrado
  -- ni completar artificialmente lineas historicas que carecian de snapshot.
  if tg_op = 'UPDATE'
    and new.tenant_id is not distinct from old.tenant_id
    and new.ticket_id is not distinct from old.ticket_id
    and new.product_id is not distinct from old.product_id
    and new.line_total_cents is not distinct from old.line_total_cents then
    new.tax_rate := old.tax_rate;
    new.taxable_base_cents := old.taxable_base_cents;
    new.tax_amount_cents := old.tax_amount_cents;
    return new;
  end if;

  -- Las FK historicas usan ON DELETE SET NULL. En ese caso se conserva el
  -- snapshot ya guardado en lugar de consultar el IVA actual.
  if new.product_id is null then
    if tg_op = 'UPDATE' then
      new.tax_rate := old.tax_rate;
      new.taxable_base_cents := old.taxable_base_cents;
      new.tax_amount_cents := old.tax_amount_cents;
      return new;
    end if;
    raise exception 'Una linea de venta nueva requiere un producto para resolver el IVA';
  end if;

  select t.venue_id
  into ticket_venue_id
  from public.tickets t
  where t.id = new.ticket_id
    and t.tenant_id = new.tenant_id;

  if ticket_venue_id is null then
    raise exception 'El ticket de la linea no pertenece al negocio indicado';
  end if;

  effective_tax_rate := public.resolve_effective_tax_rate(
    new.product_id,
    new.tenant_id,
    ticket_venue_id
  );

  if effective_tax_rate is null then
    raise exception 'No se puede resolver el IVA del producto para el local del ticket';
  end if;

  select *
  into breakdown
  from public.calculate_tax_from_gross(new.line_total_cents, effective_tax_rate);

  -- Se ignora cualquier valor fiscal aportado por el cliente.
  new.tax_rate := effective_tax_rate;
  new.taxable_base_cents := breakdown.taxable_base_cents;
  new.tax_amount_cents := breakdown.tax_amount_cents;
  return new;
end;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: set_venue_tables_enabled(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_venue_tables_enabled(p_venue_id uuid, p_enabled boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  venue_row public.venues%rowtype;
begin
  select * into venue_row from public.venues where id = p_venue_id for update;
  if venue_row.id is null or not public.user_is_tenant_admin(venue_row.tenant_id) then
    raise exception 'No autorizado para configurar este local' using errcode = '42501';
  end if;
  if not p_enabled and exists (
    select 1 from public.orders o
    where o.tenant_id = venue_row.tenant_id and o.venue_id = venue_row.id and o.status = 'open'
  ) then
    raise exception 'No se puede desactivar: existen comandas abiertas';
  end if;
  update public.venues set tables_enabled = p_enabled where id = venue_row.id;
  return p_enabled;
end;
$$;


--
-- Name: sync_assignment_cash_register(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_assignment_cash_register() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    perform public.reconcile_device_cash_register(new.device_id);
    return new;
  elsif tg_op = 'DELETE' then
    perform public.reconcile_device_cash_register(old.device_id);
    return old;
  end if;

  perform public.reconcile_device_cash_register(old.device_id);
  if new.device_id is distinct from old.device_id then
    perform public.reconcile_device_cash_register(new.device_id);
  end if;

  return new;
end;
$$;


--
-- Name: sync_device_cash_register(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_device_cash_register() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  perform public.reconcile_device_cash_register(new.id);
  return new;
end;
$$;


--
-- Name: sync_membership_cash_register(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_membership_cash_register() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  assigned_device_id uuid;
begin
  if tg_op <> 'INSERT' then
    for assigned_device_id in
      select dua.device_id
      from public.device_user_assignments dua
      where dua.tenant_id = old.tenant_id
        and dua.user_id = old.user_id
    loop
      perform public.reconcile_device_cash_register(assigned_device_id);
    end loop;
  end if;

  if tg_op <> 'DELETE' then
    for assigned_device_id in
      select dua.device_id
      from public.device_user_assignments dua
      where dua.tenant_id = new.tenant_id
        and dua.user_id = new.user_id
    loop
      perform public.reconcile_device_cash_register(assigned_device_id);
    end loop;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;


--
-- Name: sync_sale_created(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_sale_created(p_event_id uuid, p_payload jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  current_user_id uuid := auth.uid();
  ticket_payload jsonb := p_payload -> 'ticket';
  sale_payload jsonb := p_payload -> 'sale';
  payment_payload jsonb := p_payload -> 'payment';
  tenant_id_value uuid;
  ticket_id_value uuid;
  sale_id_value uuid;
  cash_session_id_value uuid;
  cash_register_id_value uuid;
  sale_cash_register_id_value uuid;
  venue_id_value uuid;
  device_id_value uuid;
  ticket_user_id_value uuid;
  sale_user_id_value uuid;
  total_cents_value bigint;
  payment_amount_value bigint;
  received_cents_value bigint;
  change_cents_value bigint;
  payment_method_value text;
  line_count integer;
  lines_total bigint;
  lines_are_valid boolean;
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  logged_event_id uuid;
begin
  if current_user_id is null then
    raise exception 'Se requiere un usuario autenticado' using errcode = '42501';
  end if;

  if p_event_id is null or jsonb_typeof(p_payload -> 'lines') is distinct from 'array' then
    raise exception 'El evento de venta no tiene un formato valido';
  end if;

  tenant_id_value := (ticket_payload ->> 'tenantId')::uuid;
  ticket_id_value := (ticket_payload ->> 'id')::uuid;
  sale_id_value := (sale_payload ->> 'id')::uuid;
  cash_session_id_value := (ticket_payload ->> 'cashSessionId')::uuid;
  cash_register_id_value := nullif(ticket_payload ->> 'cashRegisterId', '')::uuid;
  sale_cash_register_id_value := nullif(sale_payload ->> 'cashRegisterId', '')::uuid;
  venue_id_value := (ticket_payload ->> 'venueId')::uuid;
  device_id_value := (ticket_payload ->> 'deviceId')::uuid;
  ticket_user_id_value := (ticket_payload ->> 'userId')::uuid;
  sale_user_id_value := (sale_payload ->> 'userId')::uuid;
  total_cents_value := (ticket_payload ->> 'totalCents')::bigint;
  payment_amount_value := (payment_payload ->> 'amountCents')::bigint;
  received_cents_value := nullif(payment_payload ->> 'receivedCents', '')::bigint;
  change_cents_value := (payment_payload ->> 'changeCents')::bigint;
  payment_method_value := sale_payload ->> 'paymentMethod';

  if ticket_user_id_value <> current_user_id or sale_user_id_value <> current_user_id then
    raise exception 'El userId enviado no coincide con auth.uid()' using errcode = '42501';
  end if;

  if not public.user_has_tenant_access(tenant_id_value) then
    raise exception 'El usuario no tiene acceso al negocio' using errcode = '42501';
  end if;

  if (sale_payload ->> 'tenantId')::uuid <> tenant_id_value
    or (payment_payload ->> 'tenantId')::uuid <> tenant_id_value
    or (sale_payload ->> 'ticketId')::uuid <> ticket_id_value
    or (sale_payload ->> 'cashSessionId')::uuid <> cash_session_id_value
    or (sale_payload ->> 'venueId')::uuid <> venue_id_value
    or (sale_payload ->> 'deviceId')::uuid <> device_id_value
    or (payment_payload ->> 'saleId')::uuid <> sale_id_value
    or payment_payload ->> 'method' <> payment_method_value then
    raise exception 'Los datos relacionados de la venta no coinciden';
  end if;

  if exists (
    select 1
    from public.offline_event_log
    where tenant_id = tenant_id_value
      and client_event_id = p_event_id
  ) then
    return;
  end if;

  select
    count(*),
    coalesce(sum((line ->> 'lineTotalCents')::bigint), 0),
    coalesce(bool_and(
      (line ->> 'tenantId')::uuid = tenant_id_value
      and (line ->> 'ticketId')::uuid = ticket_id_value
      and (line ->> 'quantity')::integer > 0
      and (line ->> 'unitPriceCents')::bigint >= 0
      and (line ->> 'lineTotalCents')::bigint =
        (line ->> 'unitPriceCents')::bigint * (line ->> 'quantity')::integer
    ), false)
  into line_count, lines_total, lines_are_valid
  from jsonb_array_elements(p_payload -> 'lines') as line;

  if line_count = 0 or not lines_are_valid then
    raise exception 'Las lineas de la venta no son validas';
  end if;

  if total_cents_value <> lines_total
    or (sale_payload ->> 'totalCents')::bigint <> lines_total
    or payment_amount_value <> lines_total then
    raise exception 'Los totales de ticket, venta, lineas y pago no coinciden';
  end if;

  if payment_method_value = 'cash' then
    if received_cents_value is null
      or received_cents_value < total_cents_value
      or change_cents_value <> received_cents_value - total_cents_value then
      raise exception 'Los importes del pago en efectivo no son validos';
    end if;
  elsif change_cents_value <> 0 then
    raise exception 'Un pago no efectivo no puede tener cambio';
  end if;

  select *
  into session_row
  from public.cash_sessions
  where id = cash_session_id_value
  for update;

  if not found then
    raise exception 'La caja indicada no existe';
  end if;

  if session_row.status <> 'open' then
    raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000';
  end if;

  if session_row.tenant_id <> tenant_id_value
    or session_row.venue_id <> venue_id_value
    or (cash_register_id_value is not null and session_row.cash_register_id <> cash_register_id_value)
    or (sale_cash_register_id_value is not null and session_row.cash_register_id <> sale_cash_register_id_value) then
    raise exception 'La venta no coincide con el negocio, local o punto de caja';
  end if;

  cash_register_id_value := session_row.cash_register_id;

  select *
  into device_row
  from public.devices
  where id = device_id_value;

  if not found
    or device_row.tenant_id <> tenant_id_value
    or device_row.venue_id <> venue_id_value
    or device_row.is_active = false
    or device_row.can_take_payments = false
    or not public.user_has_device_access(tenant_id_value, venue_id_value, device_id_value) then
    raise exception 'El dispositivo no puede cobrar en esta caja' using errcode = '42501';
  end if;

  insert into public.offline_event_log (tenant_id, event_kind, client_event_id, payload)
  values (tenant_id_value, 'sale_created', p_event_id, p_payload)
  on conflict (tenant_id, client_event_id) do nothing
  returning id into logged_event_id;

  if logged_event_id is null then
    return;
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id,
    user_id, status, subtotal_cents, total_cents, local_created_at, created_at
  ) values (
    ticket_id_value, tenant_id_value, cash_session_id_value,
    cash_register_id_value, venue_id_value, device_id_value, current_user_id,
    'paid', total_cents_value, total_cents_value,
    (ticket_payload ->> 'createdAt')::timestamptz,
    (ticket_payload ->> 'createdAt')::timestamptz
  );

  insert into public.ticket_lines (
    id, ticket_id, tenant_id, product_id, variant_id, product_name, variant_name,
    quantity, unit_price_cents, line_total_cents, modifiers
  )
  select
    (line ->> 'id')::uuid,
    ticket_id_value,
    tenant_id_value,
    (line ->> 'productId')::uuid,
    (line ->> 'variantId')::uuid,
    line ->> 'productName',
    line ->> 'variantName',
    (line ->> 'quantity')::integer,
    (line ->> 'unitPriceCents')::integer,
    (line ->> 'lineTotalCents')::integer,
    coalesce(line -> 'modifiers', '[]'::jsonb)
  from jsonb_array_elements(p_payload -> 'lines') as line;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id,
    device_id, user_id, total_cents, payment_method, local_created_at, created_at
  ) values (
    sale_id_value, tenant_id_value, ticket_id_value, cash_session_id_value,
    cash_register_id_value, venue_id_value, device_id_value, current_user_id,
    total_cents_value, payment_method_value,
    (sale_payload ->> 'createdAt')::timestamptz,
    (sale_payload ->> 'createdAt')::timestamptz
  );

  insert into public.sale_payments (
    id, sale_id, tenant_id, method, amount_cents, received_cents, change_cents
  ) values (
    (payment_payload ->> 'id')::uuid,
    sale_id_value,
    tenant_id_value,
    payment_method_value,
    payment_amount_value,
    received_cents_value,
    change_cents_value
  );
end;
$$;


--
-- Name: sync_sale_created_v2(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_sale_created_v2(p_event_id uuid, p_payload jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  current_user_id uuid := auth.uid();
  ticket_payload jsonb := p_payload -> 'ticket';
  sale_payload jsonb := p_payload -> 'sale';
  payment_payload jsonb := p_payload -> 'payment';
  tenant_id_value uuid := (ticket_payload ->> 'tenantId')::uuid;
  ticket_id_value uuid := (ticket_payload ->> 'id')::uuid;
  sale_id_value uuid := (sale_payload ->> 'id')::uuid;
  cash_session_id_value uuid := (ticket_payload ->> 'cashSessionId')::uuid;
  cash_register_id_value uuid := nullif(ticket_payload ->> 'cashRegisterId', '')::uuid;
  venue_id_value uuid := (ticket_payload ->> 'venueId')::uuid;
  device_id_value uuid := (ticket_payload ->> 'deviceId')::uuid;
  payment_method_value text := nullif(sale_payload ->> 'paymentMethod', '');
  subtotal_cents_value integer;
  total_cents_value integer;
  discount_result jsonb;
  line_count integer;
  lines_total bigint;
  lines_are_valid boolean;
  received_cents_value integer;
  change_cents_value integer;
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  logged_event_id uuid;
begin
  if current_user_id is null then raise exception 'Se requiere un usuario autenticado' using errcode = '42501'; end if;
  if p_event_id is null or jsonb_typeof(p_payload -> 'lines') is distinct from 'array' then
    raise exception 'El evento de venta no tiene un formato valido';
  end if;
  if (ticket_payload ->> 'userId')::uuid <> current_user_id
    or (sale_payload ->> 'userId')::uuid <> current_user_id then
    raise exception 'El userId enviado no coincide con auth.uid()' using errcode = '42501';
  end if;
  if not public.user_has_tenant_access(tenant_id_value) then
    raise exception 'El usuario no tiene acceso al negocio' using errcode = '42501';
  end if;
  if (sale_payload ->> 'tenantId')::uuid <> tenant_id_value
    or (sale_payload ->> 'ticketId')::uuid <> ticket_id_value
    or (sale_payload ->> 'cashSessionId')::uuid <> cash_session_id_value
    or (sale_payload ->> 'venueId')::uuid <> venue_id_value
    or (sale_payload ->> 'deviceId')::uuid <> device_id_value then
    raise exception 'Los datos relacionados de la venta no coinciden';
  end if;
  if exists (select 1 from public.offline_event_log where tenant_id = tenant_id_value and client_event_id = p_event_id) then return; end if;

  select count(*), coalesce(sum((line ->> 'lineTotalCents')::bigint), 0), coalesce(bool_and(
    (line ->> 'tenantId')::uuid = tenant_id_value
    and (line ->> 'ticketId')::uuid = ticket_id_value
    and (line ->> 'quantity')::integer > 0
    and (line ->> 'unitPriceCents')::bigint >= 0
    and (line ->> 'lineTotalCents')::bigint = (line ->> 'unitPriceCents')::bigint * (line ->> 'quantity')::integer
  ), false)
  into line_count, lines_total, lines_are_valid
  from jsonb_array_elements(p_payload -> 'lines') as line;
  if line_count = 0 or not lines_are_valid then raise exception 'Las lineas de la venta no son validas'; end if;

  subtotal_cents_value := lines_total::integer;
  discount_result := public.resolve_ticket_discount(tenant_id_value, venue_id_value, subtotal_cents_value, ticket_payload -> 'discount');
  total_cents_value := (discount_result ->> 'totalCents')::integer;
  if (ticket_payload ->> 'subtotalCents')::integer <> subtotal_cents_value
    or (ticket_payload ->> 'discountAmountCents')::integer <> (discount_result ->> 'amountCents')::integer
    or (ticket_payload ->> 'totalCents')::integer <> total_cents_value
    or (sale_payload ->> 'totalCents')::integer <> total_cents_value then
    raise exception 'Los totales enviados no coinciden con el calculo del servidor';
  end if;

  if total_cents_value = 0 then
    if payment_method_value is not null or (payment_payload is not null and jsonb_typeof(payment_payload) <> 'null') then
      raise exception 'Un ticket a cero no requiere metodo de pago';
    end if;
  else
    if payment_method_value not in ('cash', 'card') or jsonb_typeof(payment_payload) <> 'object' then
      raise exception 'Metodo de pago no valido';
    end if;
    if (payment_payload ->> 'tenantId')::uuid <> tenant_id_value
      or (payment_payload ->> 'saleId')::uuid <> sale_id_value
      or payment_payload ->> 'method' <> payment_method_value
      or (payment_payload ->> 'amountCents')::integer <> total_cents_value then
      raise exception 'Los datos del pago no coinciden';
    end if;
    received_cents_value := nullif(payment_payload ->> 'receivedCents', '')::integer;
    change_cents_value := (payment_payload ->> 'changeCents')::integer;
    if payment_method_value = 'cash' then
      if received_cents_value is null or received_cents_value < total_cents_value
        or change_cents_value <> received_cents_value - total_cents_value then
        raise exception 'Los importes del pago en efectivo no son validos';
      end if;
    elsif change_cents_value <> 0 then raise exception 'Un pago no efectivo no puede tener cambio'; end if;
  end if;

  select * into session_row from public.cash_sessions where id = cash_session_id_value for update;
  if session_row.id is null or session_row.status <> 'open' then
    raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000';
  end if;
  if session_row.tenant_id <> tenant_id_value or session_row.venue_id <> venue_id_value
    or (cash_register_id_value is not null and session_row.cash_register_id <> cash_register_id_value) then
    raise exception 'La venta no coincide con el negocio, local o punto de caja';
  end if;
  cash_register_id_value := session_row.cash_register_id;
  select * into device_row from public.devices where id = device_id_value;
  if device_row.id is null or device_row.tenant_id <> tenant_id_value or device_row.venue_id <> venue_id_value
    or not device_row.is_active or not device_row.can_take_payments
    or not public.user_has_device_access(tenant_id_value, venue_id_value, device_id_value) then
    raise exception 'El dispositivo no puede cobrar en esta caja' using errcode = '42501';
  end if;

  insert into public.offline_event_log (tenant_id, event_kind, client_event_id, payload)
  values (tenant_id_value, 'sale_created', p_event_id, p_payload)
  on conflict (tenant_id, client_event_id) do nothing returning id into logged_event_id;
  if logged_event_id is null then return; end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, status,
    subtotal_cents, discount_id, discount_name, discount_type, discount_value_type,
    discount_value, discount_amount_cents, total_cents, local_created_at, created_at
  ) values (
    ticket_id_value, tenant_id_value, cash_session_id_value, cash_register_id_value, venue_id_value,
    device_id_value, current_user_id, 'paid', subtotal_cents_value,
    nullif(discount_result ->> 'discountId', '')::uuid, discount_result ->> 'name',
    discount_result ->> 'type', discount_result ->> 'calculationType',
    nullif(discount_result ->> 'storedValue', '')::numeric,
    case when discount_result ->> 'type' is null then null
      else nullif(discount_result ->> 'amountCents', '')::integer end, total_cents_value,
    (ticket_payload ->> 'createdAt')::timestamptz, (ticket_payload ->> 'createdAt')::timestamptz
  );
  insert into public.ticket_lines (id, ticket_id, tenant_id, product_id, variant_id, product_name, variant_name, quantity, unit_price_cents, line_total_cents, modifiers)
  select (line ->> 'id')::uuid, ticket_id_value, tenant_id_value, (line ->> 'productId')::uuid,
    (line ->> 'variantId')::uuid, line ->> 'productName', line ->> 'variantName',
    (line ->> 'quantity')::integer, (line ->> 'unitPriceCents')::integer,
    (line ->> 'lineTotalCents')::integer, coalesce(line -> 'modifiers', '[]'::jsonb)
  from jsonb_array_elements(p_payload -> 'lines') as line;
  insert into public.sales (id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id, device_id, user_id, total_cents, payment_method, local_created_at, created_at)
  values (sale_id_value, tenant_id_value, ticket_id_value, cash_session_id_value, cash_register_id_value,
    venue_id_value, device_id_value, current_user_id, total_cents_value, payment_method_value,
    (sale_payload ->> 'createdAt')::timestamptz, (sale_payload ->> 'createdAt')::timestamptz);
  if total_cents_value > 0 then
    insert into public.sale_payments (id, sale_id, tenant_id, method, amount_cents, received_cents, change_cents)
    values ((payment_payload ->> 'id')::uuid, sale_id_value, tenant_id_value, payment_method_value,
      total_cents_value, received_cents_value, change_cents_value);
  end if;
end;
$$;


--
-- Name: user_can_access_offline_event(uuid, text, jsonb, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_can_access_offline_event(target_tenant uuid, event_kind_value text, event_payload jsonb, allow_admin boolean DEFAULT true) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  event_device uuid;
  event_venue uuid;
  related_sale public.sales%rowtype;
  related_session public.cash_sessions%rowtype;
begin
  if allow_admin and public.user_is_tenant_admin(target_tenant) then
    return true;
  end if;

  if event_kind_value = 'sale_created' then
    event_device := (event_payload -> 'ticket' ->> 'deviceId')::uuid;
    event_venue := (event_payload -> 'ticket' ->> 'venueId')::uuid;
  elsif event_kind_value = 'cash_opened' then
    event_device := (event_payload -> 'session' ->> 'deviceId')::uuid;
    event_venue := (event_payload -> 'session' ->> 'venueId')::uuid;
  elsif event_kind_value = 'cash_closed' then
    select * into related_session from public.cash_sessions
    where id = (event_payload ->> 'sessionId')::uuid;
    event_device := related_session.device_id;
    event_venue := related_session.venue_id;
  elsif event_kind_value in ('sale_payment_changed', 'sale_voided') then
    select * into related_sale from public.sales
    where id = (event_payload ->> 'saleId')::uuid;
    event_device := related_sale.device_id;
    event_venue := related_sale.venue_id;
  end if;

  return event_device is not null
    and public.user_has_device_access(target_tenant, event_venue, event_device);
exception when others then
  return false;
end;
$$;


--
-- Name: user_can_view_device(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_can_view_device(target_tenant uuid, target_venue uuid, target_device uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select public.user_is_tenant_admin(target_tenant)
    or public.user_has_device_access(target_tenant, target_venue, target_device);
$$;


--
-- Name: user_has_device_access(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_has_device_access(target_tenant uuid, target_venue uuid, target_device uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.device_user_assignments dua
    join public.tenant_memberships tm
      on tm.tenant_id = dua.tenant_id
     and tm.user_id = dua.user_id
    where dua.tenant_id = target_tenant
      and dua.venue_id = target_venue
      and dua.device_id = target_device
      and dua.user_id = auth.uid()
      and dua.is_active = true
      and tm.is_active = true
      and tm.role = 'cashier'
  );
$$;


--
-- Name: user_has_tenant_access(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_has_tenant_access(target_tenant uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.is_active = true
      and t.is_active = true
  );
$$;


--
-- Name: user_has_tenant_role(uuid, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_has_tenant_role(target_tenant uuid, allowed_roles text[]) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.role = any(allowed_roles)
      and tm.is_active = true
      and t.is_active = true
  );
$$;


--
-- Name: user_has_venue_access(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_has_venue_access(target_tenant uuid, target_venue uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.device_user_assignments dua
    join public.tenant_memberships tm
      on tm.tenant_id = dua.tenant_id and tm.user_id = dua.user_id
    where dua.tenant_id = target_tenant
      and dua.venue_id = target_venue
      and dua.user_id = auth.uid()
      and dua.is_active = true
      and tm.is_active = true
      and tm.role = 'cashier'
  );
$$;


--
-- Name: user_is_superadmin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_is_superadmin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_superadmin = true
  );
$$;


--
-- Name: user_is_tenant_admin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_is_tenant_admin(target_tenant uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'admin')
      and tm.is_active = true
  );
$$;


--
-- Name: validate_cash_session_table_layout_compactness(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_cash_session_table_layout_compactness() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  perform public.validate_compact_joined_table_layout(new.tables);

  if tg_op = 'UPDATE' and exists (
    with protected_groups as (
      select distinct old_item.value ->> 'groupId' as group_id
      from jsonb_each(old.tables) old_item
      join public.order_tables ot
        on ot.table_id = old_item.key::uuid
        and ot.released_at is null
      join public.orders o
        on o.id = ot.order_id
        and o.cash_session_id = new.cash_session_id
        and o.status = 'open'
      where nullif(old_item.value ->> 'groupId', '') is not null
    )
    select 1
    from jsonb_each(old.tables) old_item
    where (old_item.value ->> 'groupId')
        is distinct from ((new.tables -> old_item.key) ->> 'groupId')
      and exists (
        select 1
        from protected_groups protected
        where protected.group_id = (old_item.value ->> 'groupId')
          or protected.group_id = ((new.tables -> old_item.key) ->> 'groupId')
      )
  ) then
    raise exception 'No se pueden separar mesas con una comanda abierta'
      using errcode = '23514';
  end if;

  return new;
end;
$$;


--
-- Name: validate_cash_session_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_cash_session_write() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and new.opened_by <> auth.uid() then raise exception 'Usuario de apertura no valido' using errcode = '42501'; end if;
    if new.status <> 'open' or new.closed_at is not null then raise exception 'Una caja nueva debe estar abierta'; end if;
    return new;
  end if;
  if new.tenant_id is distinct from old.tenant_id or new.venue_id is distinct from old.venue_id
    or new.cash_register_id is distinct from old.cash_register_id or new.opened_by is distinct from old.opened_by
    or new.opened_by_device_id is distinct from old.opened_by_device_id or new.opened_at is distinct from old.opened_at then
    raise exception 'No se puede cambiar la identidad de una sesion de caja';
  end if;
  if old.status = 'closed' and new.status is distinct from old.status then raise exception 'Una caja cerrada no se puede reabrir'; end if;
  if old.status = 'open' and new.status = 'closed' and (new.closed_by is null or new.closed_by_device_id is null or new.closed_at is null) then
    raise exception 'El cierre requiere usuario, dispositivo y fecha';
  end if;
  return new;
end;
$$;


--
-- Name: validate_catalog_entity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_catalog_entity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if not exists (select 1 from public.venues v where v.id = new.venue_id and v.tenant_id = new.tenant_id) then raise exception 'CATALOG_SCOPE_MISMATCH'; end if;
  if tg_table_name = 'selection_group_options' then
    if (select product_type from public.products where id = new.product_id) <> 'standard' then raise exception 'NESTED_MENU_NOT_ALLOWED'; end if;
  elsif tg_table_name in ('product_selection_group_assignments', 'product_modifier_group_assignments') then
    if new.is_active and not (select is_active from public.products where id = new.product_id) then raise exception 'ACTIVE_ASSIGNMENT_INACTIVE_PRODUCT'; end if;
    if new.is_active and tg_table_name = 'product_selection_group_assignments' and not (select is_active from public.selection_groups where id = new.group_id) then raise exception 'ACTIVE_ASSIGNMENT_INACTIVE_GROUP'; end if;
    if new.is_active and tg_table_name = 'product_modifier_group_assignments' and not (select is_active from public.modifier_groups where id = new.group_id) then raise exception 'ACTIVE_ASSIGNMENT_INACTIVE_GROUP'; end if;
  end if;
  return new;
end; $$;


--
-- Name: validate_compact_joined_table_layout(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_compact_joined_table_layout(p_tables jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  group_key text;
  member_count integer;
  reached_count integer;
begin
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then
    raise exception 'Distribucion de mesas no valida';
  end if;

  -- Las coordenadas son relativas a cada zona. Solo pueden colisionar mesas
  -- que comparten area_id.
  if exists (
    with entries as (
      select item.key as table_id,
        nullif(item.value ->> 'groupId', '') as group_id,
        rt.area_id,
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
    where a.area_id = b.area_id
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
    having count(distinct rt.area_id) > 1
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
      raise exception 'Las mesas juntadas deben permanecer fisicamente pegadas';
    end if;
  end loop;
end;
$$;


--
-- Name: validate_device_cash_register(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_device_cash_register() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.default_cash_register_id is not null and not exists (
    select 1 from public.cash_registers cr where cr.id = new.default_cash_register_id
      and cr.tenant_id = new.tenant_id and cr.venue_id = new.venue_id
  ) then raise exception 'La caja predeterminada debe pertenecer al mismo local'; end if;
  return new;
end;
$$;


--
-- Name: validate_device_user_assignment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_device_user_assignment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if not exists (
    select 1
    from public.devices d
    where d.id = new.device_id
      and d.tenant_id = new.tenant_id
      and d.venue_id = new.venue_id
  ) then
    raise exception 'El dispositivo no pertenece al negocio y local indicados';
  end if;

  if not exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = new.tenant_id
      and tm.user_id = new.user_id
      and tm.role = 'cashier'
  ) then
    raise exception 'La asignacion requiere una membresia con rol cashier';
  end if;

  return new;
end;
$$;


--
-- Name: validate_discount_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_discount_scope() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not exists (
    select 1 from public.venues v
    where v.id = new.venue_id and v.tenant_id = new.tenant_id
  ) then
    raise exception 'El descuento no coincide con el negocio y el local';
  end if;
  new.name := btrim(new.name);
  return new;
end;
$$;


--
-- Name: validate_final_catalog_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_final_catalog_scope() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if not exists(select 1 from public.venues v where v.id=new.venue_id and v.tenant_id=new.tenant_id) then
    raise exception 'CATALOG_SCOPE_MISMATCH';
  end if;
  if tg_table_name='product_variants' then
    if not exists(
      select 1 from public.products p where p.id=new.product_id and p.tenant_id=new.tenant_id and p.venue_id=new.venue_id
    ) then raise exception 'VARIANT_PRODUCT_SCOPE_MISMATCH'; end if;
  elsif tg_table_name='catalog_placements' then
    if not exists(select 1 from public.products p where p.id=new.product_id and p.tenant_id=new.tenant_id and p.venue_id=new.venue_id) then raise exception 'PLACEMENT_PRODUCT_SCOPE_MISMATCH'; end if;
    if not exists(select 1 from public.catalog_tabs t where t.id=new.tab_id and t.tenant_id=new.tenant_id and t.venue_id=new.venue_id) then raise exception 'PLACEMENT_TAB_SCOPE_MISMATCH'; end if;
    if new.category_id is not null and not exists(select 1 from public.categories c where c.id=new.category_id and c.tenant_id=new.tenant_id and c.venue_id=new.venue_id) then raise exception 'PLACEMENT_CATEGORY_SCOPE_MISMATCH'; end if;
    if new.variant_id is not null and not exists(select 1 from public.product_variants v where v.id=new.variant_id and v.product_id=new.product_id and v.tenant_id=new.tenant_id and v.venue_id=new.venue_id) then raise exception 'PLACEMENT_VARIANT_PRODUCT_MISMATCH'; end if;
  elsif tg_table_name='modifiers' then
    if not exists(
      select 1 from public.modifier_groups g where g.id=new.group_id and g.tenant_id=new.tenant_id and g.venue_id=new.venue_id
    ) then raise exception 'MODIFIER_GROUP_SCOPE_MISMATCH'; end if;
  end if;
  return new;
end $$;


--
-- Name: validate_modifier_capacity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_modifier_capacity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare v_group uuid:=coalesce(new.group_id,old.group_id); v_bad uuid;
begin
  select a.id into v_bad from public.product_modifier_group_assignments a
  where a.group_id=v_group and a.is_active and a.min_selection>(select count(*) from public.modifiers m where m.group_id=a.group_id and m.is_active)
  limit 1;
  if v_bad is not null then raise exception 'INSUFFICIENT_ACTIVE_MODIFIER_CAPACITY assignment %',v_bad; end if;
  return null;
end $$;


--
-- Name: validate_product_default_variant(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_product_default_variant() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare v_product uuid := coalesce(new.product_id, old.product_id); v_count integer;
begin
  if not exists (select 1 from public.products where id = v_product) then return null; end if;
  select count(*) into v_count from public.product_variants where product_id = v_product and is_active and is_default;
  if v_count <> 1 then raise exception 'INVALID_ACTIVE_DEFAULT_VARIANT_COUNT product %, count %', v_product, v_count; end if;
  return null;
end; $$;


--
-- Name: validate_product_venue(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_product_venue() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if not exists (
    select 1 from public.venues v
    where v.id = new.venue_id and v.tenant_id = new.tenant_id
  ) then
    raise exception 'El producto debe pertenecer a un local del mismo negocio';
  end if;

  return new;
end;
$$;


--
-- Name: validate_selection_capacity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_selection_capacity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare v_group uuid; v_bad uuid;
begin
  v_group := case when tg_table_name = 'selection_group_options' then coalesce(new.group_id, old.group_id) else coalesce(new.group_id, old.group_id) end;
  select a.id into v_bad from public.product_selection_group_assignments a
  where a.group_id = v_group and a.is_active and a.min_selection > (
    select coalesce(sum(coalesce(o.max_quantity, a.max_selection)), 0) from public.selection_group_options o where o.group_id = a.group_id and o.is_active
  ) limit 1;
  if v_bad is not null then raise exception 'INSUFFICIENT_ACTIVE_CAPACITY assignment %', v_bad; end if;
  return null;
end; $$;


--
-- Name: validate_ticket_line_product_venue(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_ticket_line_product_venue() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.product_id is not null and not exists (
    select 1
    from public.tickets t
    join public.products p
      on p.id = new.product_id
     and p.tenant_id = t.tenant_id
     and p.venue_id = t.venue_id
    where t.id = new.ticket_id
      and t.tenant_id = new.tenant_id
  ) then
    raise exception 'El producto de la linea no pertenece al local del ticket';
  end if;

  if new.variant_id is not null and not exists (
    select 1
    from public.product_variants pv
    where pv.id = new.variant_id
      and pv.product_id = new.product_id
      and pv.tenant_id = new.tenant_id
  ) then
    raise exception 'La variante no pertenece al producto de la linea';
  end if;

  return new;
end;
$$;


--
-- Name: validate_transaction_actor_and_cash(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_transaction_actor_and_cash() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.tenant_id is distinct from old.tenant_id
      or new.cash_session_id is distinct from old.cash_session_id or new.cash_register_id is distinct from old.cash_register_id
      or new.venue_id is distinct from old.venue_id or new.device_id is distinct from old.device_id then
      raise exception 'No se puede cambiar la identidad economica de una transaccion';
    end if;
    return new;
  end if;
  if auth.uid() is not null and new.user_id <> auth.uid() then raise exception 'Usuario de transaccion no valido' using errcode = '42501'; end if;
  select cs.* into session_row from public.cash_sessions cs where cs.id = new.cash_session_id for share;
  select d.* into device_row from public.devices d where d.id = new.device_id;
  if session_row.id is null or session_row.status <> 'open' then raise exception 'No se pueden registrar ventas en una caja cerrada' using errcode = '55000'; end if;
  if new.cash_register_id is null then new.cash_register_id := session_row.cash_register_id; end if;
  if session_row.tenant_id <> new.tenant_id or session_row.venue_id <> new.venue_id
    or session_row.cash_register_id <> new.cash_register_id then raise exception 'La venta no coincide con la caja economica'; end if;
  if device_row.id is null or device_row.tenant_id <> new.tenant_id or device_row.venue_id <> new.venue_id
    or not public.user_has_device_access(new.tenant_id, new.venue_id, new.device_id)
    or not device_row.can_take_payments then raise exception 'Dispositivo sin permiso de cobro' using errcode = '42501'; end if;
  return new;
end;
$$;


--
-- Name: cash_closing_print_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_closing_print_events (
    id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    cash_closing_id uuid NOT NULL,
    event_type text NOT NULL,
    user_id uuid NOT NULL,
    terminal_id uuid,
    printer_id text,
    print_job_id text,
    request_id text NOT NULL,
    is_reprint boolean NOT NULL,
    copy_number integer DEFAULT 0 NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_closing_print_events_event_type_check CHECK ((event_type = ANY (ARRAY['cash_closing.printed'::text, 'cash_closing.print_failed'::text, 'cash_closing.reprinted'::text])))
);


--
-- Name: cash_closing_print_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cash_closing_print_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.cash_closing_print_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cash_registers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_registers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cash_session_table_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_session_table_layouts (
    cash_session_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    cash_register_id uuid NOT NULL,
    tables jsonb DEFAULT '{}'::jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_session_table_layouts_revision_check CHECK ((revision > 0)),
    CONSTRAINT cash_session_table_layouts_tables_check CHECK ((jsonb_typeof(tables) = 'object'::text))
);


--
-- Name: cash_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    device_id uuid NOT NULL,
    opened_by uuid NOT NULL,
    closed_by uuid,
    status text NOT NULL,
    opening_float_cents integer DEFAULT 0 NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    expected_cash_cents integer,
    expected_card_cents integer,
    expected_invitation_cents integer,
    expected_other_cents integer,
    counted_cash_cents integer,
    counted_card_cents integer,
    counted_invitation_cents integer,
    counted_other_cents integer,
    discrepancy_cents integer,
    notes text,
    sync_source text DEFAULT 'online'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cash_register_id uuid NOT NULL,
    opened_by_device_id uuid NOT NULL,
    closed_by_device_id uuid,
    final_cash_fund_cents integer DEFAULT 0 NOT NULL,
    print_snapshot jsonb,
    print_status text DEFAULT 'not_requested'::text NOT NULL,
    print_job_id text,
    print_request_id text,
    printed_at timestamp with time zone,
    print_error_code text,
    print_attempts integer DEFAULT 0 NOT NULL,
    print_copies integer DEFAULT 0 NOT NULL,
    CONSTRAINT cash_sessions_final_cash_fund_cents_check CHECK ((final_cash_fund_cents >= 0)),
    CONSTRAINT cash_sessions_opening_float_cents_check CHECK ((opening_float_cents >= 0)),
    CONSTRAINT cash_sessions_print_attempts_check CHECK ((print_attempts >= 0)),
    CONSTRAINT cash_sessions_print_copies_check CHECK ((print_copies >= 0)),
    CONSTRAINT cash_sessions_print_status_check CHECK ((print_status = ANY (ARRAY['not_requested'::text, 'pending'::text, 'printed'::text, 'failed'::text, 'unknown'::text]))),
    CONSTRAINT cash_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);


--
-- Name: catalog_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_audit_log (
    id bigint NOT NULL,
    tenant_id uuid,
    venue_id uuid,
    table_name text NOT NULL,
    row_id uuid,
    action text NOT NULL,
    actor_id uuid,
    before_data jsonb,
    after_data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT catalog_audit_log_action_check CHECK ((action = ANY (ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text])))
);


--
-- Name: catalog_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.catalog_audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.catalog_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: catalog_placements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_placements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    tab_id uuid NOT NULL,
    category_id uuid,
    product_id uuid NOT NULL,
    is_featured boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    variant_id uuid
);


--
-- Name: TABLE catalog_placements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.catalog_placements IS 'Definitive visibility, featured state and optional pinned variant.';


--
-- Name: catalog_tab_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_tab_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    tab_id uuid NOT NULL,
    category_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT catalog_tab_categories_sort_order_check CHECK ((sort_order >= 0))
);


--
-- Name: catalog_tabs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_tabs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    icon text DEFAULT 'receipt'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT catalog_tabs_key_check CHECK (((key ~ '^[a-z0-9_]+$'::text) AND (key <> ALL (ARRAY['all'::text, 'top'::text])))),
    CONSTRAINT catalog_tabs_label_check CHECK (((char_length(TRIM(BOTH FROM label)) >= 1) AND (char_length(TRIM(BOTH FROM label)) <= 80)))
);


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    icon text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    venue_id uuid NOT NULL,
    unused boolean DEFAULT false NOT NULL
);


--
-- Name: device_user_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_user_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    device_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    device_mode text DEFAULT 'checkout'::text NOT NULL,
    default_cash_register_id uuid,
    can_take_orders boolean DEFAULT true NOT NULL,
    can_take_payments boolean DEFAULT true NOT NULL,
    can_open_cash_session boolean DEFAULT true NOT NULL,
    can_close_cash_session boolean DEFAULT true NOT NULL,
    can_manage_cash boolean DEFAULT true NOT NULL,
    CONSTRAINT devices_device_mode_check CHECK ((device_mode = ANY (ARRAY['satellite'::text, 'checkout'::text, 'hybrid'::text]))),
    CONSTRAINT devices_satellite_capabilities_check CHECK (((device_mode <> 'satellite'::text) OR ((NOT can_take_payments) AND (NOT can_open_cash_session) AND (NOT can_close_cash_session) AND (NOT can_manage_cash))))
);


--
-- Name: dining_areas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dining_areas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    canvas_width integer DEFAULT 1200 NOT NULL,
    canvas_height integer DEFAULT 800 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    map_elements jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT dining_areas_canvas_height_check CHECK (((canvas_height >= 320) AND (canvas_height <= 4000))),
    CONSTRAINT dining_areas_canvas_width_check CHECK (((canvas_width >= 320) AND (canvas_width <= 4000))),
    CONSTRAINT dining_areas_map_elements_array CHECK (((jsonb_typeof(map_elements) = 'array'::text) AND (jsonb_array_length(map_elements) <= 250)))
);


--
-- Name: discounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    value numeric(12,2) NOT NULL,
    color text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    rounding_increment_cents integer,
    CONSTRAINT discounts_check CHECK (((value > (0)::numeric) AND ((type <> 'percentage'::text) OR (value <= (100)::numeric)))),
    CONSTRAINT discounts_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT discounts_rounding_increment_cents_check CHECK (((rounding_increment_cents IS NULL) OR (rounding_increment_cents = ANY (ARRAY[5, 10, 50, 100])))),
    CONSTRAINT discounts_type_check CHECK ((type = ANY (ARRAY['percentage'::text, 'fixed'::text])))
);


--
-- Name: modifier_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modifier_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    venue_id uuid NOT NULL
);


--
-- Name: modifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modifiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    group_id uuid NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    venue_id uuid NOT NULL,
    supplement_cents integer DEFAULT 0 NOT NULL,
    CONSTRAINT modifiers_supplement_cents_check CHECK (((supplement_cents >= '-100000000'::integer) AND (supplement_cents <= 100000000)))
);


--
-- Name: offline_event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offline_event_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    event_kind text NOT NULL,
    client_event_id uuid NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    order_id uuid NOT NULL,
    user_id uuid,
    device_id uuid,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_events_event_type_check CHECK ((event_type = ANY (ARRAY['order_opened'::text, 'order_moved'::text, 'tables_grouped'::text, 'line_added'::text, 'line_quantity_changed'::text, 'line_partially_served'::text, 'line_fully_served'::text, 'order_fully_served'::text, 'order_paid'::text, 'order_cancelled'::text, 'order_split_created'::text, 'line_moved'::text, 'order_split_removed'::text, 'equal_split_started'::text, 'equal_split_part_paid'::text, 'equal_split_completed'::text]))),
    CONSTRAINT order_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text))
);


--
-- Name: order_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    cash_session_id uuid NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT order_groups_lifecycle_check CHECK ((((status = 'open'::text) AND (closed_at IS NULL)) OR ((status = 'closed'::text) AND (closed_at IS NOT NULL)))),
    CONSTRAINT order_groups_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);


--
-- Name: order_line_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_line_components (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    order_line_id uuid NOT NULL,
    component_type text NOT NULL,
    selection_group_id uuid,
    product_id uuid,
    variant_id uuid,
    product_name_snapshot text NOT NULL,
    variant_name_snapshot text DEFAULT ''::text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    price_delta_cents integer DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_line_components_component_type_check CHECK ((component_type = ANY (ARRAY['mixer'::text, 'menu_component'::text]))),
    CONSTRAINT order_line_components_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT order_line_components_quantity_check CHECK ((quantity > 0))
);


--
-- Name: order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    order_id uuid NOT NULL,
    product_id uuid,
    variant_id uuid,
    product_name text NOT NULL,
    variant_name text NOT NULL,
    unit_price_cents integer NOT NULL,
    quantity integer NOT NULL,
    modifiers jsonb DEFAULT '[]'::jsonb NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    served_quantity integer DEFAULT 0 NOT NULL,
    fully_served_at timestamp with time zone,
    mixer_product_id uuid,
    mixer jsonb,
    split_from_line_id uuid,
    components jsonb DEFAULT '[]'::jsonb NOT NULL,
    catalog_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT order_lines_catalog_snapshot_object CHECK ((jsonb_typeof(catalog_snapshot) = 'object'::text)),
    CONSTRAINT order_lines_components_array CHECK ((jsonb_typeof(components) = 'array'::text)),
    CONSTRAINT order_lines_mixer_object CHECK (((mixer IS NULL) OR (jsonb_typeof(mixer) = 'object'::text))),
    CONSTRAINT order_lines_modifiers_array CHECK ((jsonb_typeof(modifiers) = 'array'::text)),
    CONSTRAINT order_lines_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT order_lines_served_quantity_check CHECK (((served_quantity >= 0) AND (served_quantity <= quantity))),
    CONSTRAINT order_lines_unit_price_cents_check CHECK ((unit_price_cents >= 0))
);


--
-- Name: COLUMN order_lines.product_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.order_lines.product_id IS 'Catalogue UUID snapshot without a live foreign key.';


--
-- Name: COLUMN order_lines.variant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.order_lines.variant_id IS 'Catalogue UUID snapshot without a live foreign key.';


--
-- Name: order_tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_tables (
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    order_id uuid NOT NULL,
    table_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    order_group_id uuid NOT NULL
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    cash_session_id uuid NOT NULL,
    opened_by_user_id uuid NOT NULL,
    opened_by_device_id uuid NOT NULL,
    guest_count integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    revision integer DEFAULT 0 NOT NULL,
    cash_register_id uuid NOT NULL,
    order_group_id uuid NOT NULL,
    split_sequence integer DEFAULT 1 NOT NULL,
    CONSTRAINT orders_closed_state_check CHECK ((((status = 'open'::text) AND (closed_at IS NULL)) OR ((status = ANY (ARRAY['paid'::text, 'cancelled'::text])) AND (closed_at IS NOT NULL)))),
    CONSTRAINT orders_guest_count_check CHECK (((guest_count >= 1) AND (guest_count <= 999))),
    CONSTRAINT orders_revision_check CHECK ((revision >= 0)),
    CONSTRAINT orders_split_sequence_check CHECK ((split_sequence >= 1)),
    CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['open'::text, 'paid'::text, 'cancelled'::text])))
);


--
-- Name: product_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_images (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    product_id uuid NOT NULL,
    storage_path text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_images_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT product_images_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: product_modifier_group_assignment_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_modifier_group_assignment_variants (
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    product_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_modifier_group_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_modifier_group_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    product_id uuid NOT NULL,
    group_id uuid NOT NULL,
    display_name text,
    min_selection integer DEFAULT 0 NOT NULL,
    max_selection integer DEFAULT 1 NOT NULL,
    applies_to_all_variants boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_modifier_group_assignments_check CHECK (((max_selection >= 1) AND (max_selection >= min_selection))),
    CONSTRAINT product_modifier_group_assignments_min_selection_check CHECK ((min_selection >= 0)),
    CONSTRAINT product_modifier_group_assignments_sort_order_check CHECK ((sort_order >= 0))
);


--
-- Name: product_selection_group_assignment_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_selection_group_assignment_variants (
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    product_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_selection_group_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_selection_group_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    product_id uuid NOT NULL,
    group_id uuid NOT NULL,
    display_name text,
    min_selection integer DEFAULT 0 NOT NULL,
    max_selection integer DEFAULT 1 NOT NULL,
    applies_to_all_variants boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_selection_group_assignments_check CHECK (((max_selection >= 1) AND (max_selection >= min_selection))),
    CONSTRAINT product_selection_group_assignments_min_selection_check CHECK ((min_selection >= 0)),
    CONSTRAINT product_selection_group_assignments_sort_order_check CHECK ((sort_order >= 0))
);


--
-- Name: product_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_variants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    product_id uuid NOT NULL,
    name text NOT NULL,
    price_cents integer NOT NULL,
    sku text,
    is_default boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    venue_id uuid NOT NULL,
    CONSTRAINT product_variants_price_cents_check CHECK ((price_cents >= 0))
);


--
-- Name: TABLE product_variants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.product_variants IS 'Definitive sellable variants with integer-cent prices.';


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tax_rate numeric(5,2),
    product_type text DEFAULT 'standard'::text NOT NULL,
    CONSTRAINT products_product_type_check CHECK ((product_type = ANY (ARRAY['standard'::text, 'menu'::text]))),
    CONSTRAINT products_tax_rate_check CHECK (((tax_rate IS NULL) OR ((tax_rate >= (0)::numeric) AND (tax_rate <= (100)::numeric))))
);


--
-- Name: TABLE products; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.products IS 'Definitive venue-scoped catalogue products; visibility and category belong to placements.';


--
-- Name: COLUMN products.tax_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.tax_rate IS 'Porcentaje de IVA propio; NULL hereda venues.default_tax_rate.';


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    full_name text,
    is_superadmin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: restaurant_order_equal_split_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurant_order_equal_split_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    split_id uuid NOT NULL,
    part_number integer NOT NULL,
    amount_cents integer NOT NULL,
    payment_method text,
    received_cents integer,
    change_cents integer DEFAULT 0 NOT NULL,
    ticket_id uuid NOT NULL,
    sale_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    subtotal_cents integer NOT NULL,
    discount_amount_cents integer DEFAULT 0 NOT NULL,
    discount jsonb,
    CONSTRAINT restaurant_order_equal_split_payments_amount_cents_check CHECK ((amount_cents >= 0)),
    CONSTRAINT restaurant_order_equal_split_payments_change_cents_check CHECK ((change_cents >= 0)),
    CONSTRAINT restaurant_order_equal_split_payments_discount_check CHECK (((subtotal_cents > 0) AND ((discount_amount_cents >= 0) AND (discount_amount_cents <= subtotal_cents)) AND (amount_cents = (subtotal_cents - discount_amount_cents)) AND (((amount_cents = 0) AND (payment_method IS NULL)) OR ((amount_cents > 0) AND (payment_method IS NOT NULL))))),
    CONSTRAINT restaurant_order_equal_split_payments_part_number_check CHECK ((part_number > 0)),
    CONSTRAINT restaurant_order_equal_split_payments_payment_method_check CHECK (((payment_method IS NULL) OR (payment_method = ANY (ARRAY['cash'::text, 'card'::text]))))
);


--
-- Name: restaurant_tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurant_tables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    area_id uuid NOT NULL,
    name text NOT NULL,
    capacity integer DEFAULT 2 NOT NULL,
    shape text DEFAULT 'square'::text NOT NULL,
    position_x numeric(8,3) DEFAULT 0 NOT NULL,
    position_y numeric(8,3) DEFAULT 0 NOT NULL,
    width numeric(8,3) DEFAULT 12 NOT NULL,
    height numeric(8,3) DEFAULT 12 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    reserved_until timestamp with time zone,
    reservation_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT restaurant_tables_capacity_check CHECK (((capacity >= 1) AND (capacity <= 99))),
    CONSTRAINT restaurant_tables_height_check CHECK (((height >= (4)::numeric) AND (height <= (100)::numeric))),
    CONSTRAINT restaurant_tables_position_x_check CHECK (((position_x >= (0)::numeric) AND (position_x <= (100)::numeric))),
    CONSTRAINT restaurant_tables_position_y_check CHECK (((position_y >= (0)::numeric) AND (position_y <= (100)::numeric))),
    CONSTRAINT restaurant_tables_shape_check CHECK ((shape = ANY (ARRAY['square'::text, 'rectangle'::text, 'round'::text]))),
    CONSTRAINT restaurant_tables_width_check CHECK (((width >= (4)::numeric) AND (width <= (100)::numeric)))
);


--
-- Name: sale_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sale_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    sale_id uuid NOT NULL,
    method text NOT NULL,
    amount_cents integer NOT NULL,
    received_cents integer,
    change_cents integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sale_payments_amount_cents_check CHECK ((amount_cents >= 0)),
    CONSTRAINT sale_payments_change_cents_check CHECK ((change_cents >= 0))
);


--
-- Name: sales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    cash_session_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    device_id uuid NOT NULL,
    user_id uuid NOT NULL,
    total_cents integer NOT NULL,
    payment_method text,
    local_created_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cash_register_id uuid NOT NULL,
    CONSTRAINT sales_total_cents_check CHECK ((total_cents >= 0))
);


--
-- Name: selection_group_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.selection_group_options (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    group_id uuid NOT NULL,
    product_id uuid NOT NULL,
    variant_id uuid,
    supplement_cents integer DEFAULT 0 NOT NULL,
    default_quantity integer DEFAULT 0 NOT NULL,
    max_quantity integer,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT selection_group_options_check CHECK (((max_quantity IS NULL) OR (max_quantity >= default_quantity))),
    CONSTRAINT selection_group_options_default_quantity_check CHECK ((default_quantity >= 0)),
    CONSTRAINT selection_group_options_sort_order_check CHECK ((sort_order >= 0)),
    CONSTRAINT selection_group_options_supplement_cents_check CHECK (((supplement_cents >= '-100000000'::integer) AND (supplement_cents <= 100000000)))
);


--
-- Name: selection_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.selection_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT selection_groups_kind_check CHECK ((kind = ANY (ARRAY['mixer'::text, 'menu_component'::text]))),
    CONSTRAINT selection_groups_name_check CHECK (((char_length(TRIM(BOTH FROM name)) >= 1) AND (char_length(TRIM(BOTH FROM name)) <= 100)))
);


--
-- Name: tenant_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'cashier'::text])))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    max_venues integer DEFAULT 1 NOT NULL,
    max_devices integer DEFAULT 5 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenants_max_devices_check CHECK ((max_devices >= 0)),
    CONSTRAINT tenants_max_venues_check CHECK ((max_venues >= 1))
);


--
-- Name: ticket_line_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_line_components (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    ticket_line_id uuid NOT NULL,
    component_type text NOT NULL,
    selection_group_id uuid,
    selection_group_name_snapshot text DEFAULT ''::text NOT NULL,
    product_id uuid,
    variant_id uuid,
    product_name_snapshot text NOT NULL,
    variant_name_snapshot text DEFAULT ''::text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    price_delta_cents integer DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_line_components_component_type_check CHECK ((component_type = ANY (ARRAY['mixer'::text, 'menu_component'::text]))),
    CONSTRAINT ticket_line_components_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT ticket_line_components_quantity_check CHECK ((quantity > 0))
);


--
-- Name: TABLE ticket_line_components; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ticket_line_components IS 'Immutable product components selected as mixers or menu items; never synthetic modifiers.';


--
-- Name: ticket_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    product_id uuid,
    variant_id uuid,
    product_name text NOT NULL,
    variant_name text NOT NULL,
    quantity integer NOT NULL,
    unit_price_cents integer NOT NULL,
    line_total_cents integer NOT NULL,
    modifiers jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tax_rate numeric(5,2),
    taxable_base_cents integer,
    tax_amount_cents integer,
    allocated_quantity numeric(18,9),
    sale_format_id uuid,
    sale_format_name_snapshot text,
    category_id_snapshot uuid,
    category_name_snapshot text,
    catalog_tab_id_snapshot uuid,
    catalog_tab_name_snapshot text,
    base_price_cents integer,
    component_delta_cents integer,
    modifier_delta_cents integer,
    gross_before_discount_cents integer,
    CONSTRAINT ticket_lines_allocated_quantity_check CHECK (((allocated_quantity IS NULL) OR (allocated_quantity > (0)::numeric))),
    CONSTRAINT ticket_lines_fiscal_snapshot_check CHECK ((((tax_rate IS NULL) AND (taxable_base_cents IS NULL) AND (tax_amount_cents IS NULL)) OR (((tax_rate >= (0)::numeric) AND (tax_rate <= (100)::numeric)) AND (taxable_base_cents >= 0) AND (tax_amount_cents >= 0) AND ((taxable_base_cents + tax_amount_cents) = line_total_cents)))),
    CONSTRAINT ticket_lines_line_total_cents_check CHECK ((line_total_cents >= 0)),
    CONSTRAINT ticket_lines_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT ticket_lines_unit_price_cents_check CHECK ((unit_price_cents >= 0))
);


--
-- Name: TABLE ticket_lines; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ticket_lines IS 'Immutable history. Historical sale format columns are snapshots, never live catalogue relations.';


--
-- Name: COLUMN ticket_lines.product_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ticket_lines.product_id IS 'Historical catalogue UUID snapshot without a live foreign key.';


--
-- Name: COLUMN ticket_lines.variant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ticket_lines.variant_id IS 'Historical catalogue UUID snapshot without a live foreign key.';


--
-- Name: COLUMN ticket_lines.tax_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ticket_lines.tax_rate IS 'Snapshot del porcentaje de IVA efectivo en el momento de persistir la venta.';


--
-- Name: COLUMN ticket_lines.taxable_base_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ticket_lines.taxable_base_cents IS 'Snapshot de la base imponible de la linea, redondeada al centimo.';


--
-- Name: COLUMN ticket_lines.tax_amount_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ticket_lines.tax_amount_cents IS 'Snapshot de la cuota de IVA de la linea; base + cuota = line_total_cents.';


--
-- Name: tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    cash_session_id uuid NOT NULL,
    venue_id uuid NOT NULL,
    device_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text NOT NULL,
    subtotal_cents integer NOT NULL,
    total_cents integer NOT NULL,
    local_created_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cash_register_id uuid NOT NULL,
    discount_id uuid,
    discount_name text,
    discount_type text,
    discount_value_type text,
    discount_value numeric(12,2),
    discount_amount_cents integer,
    equal_split_id uuid,
    equal_split_part_number integer,
    discount_rounding_increment_cents integer,
    CONSTRAINT tickets_discount_amount_cents_check CHECK (((discount_amount_cents IS NULL) OR (discount_amount_cents >= 0))),
    CONSTRAINT tickets_discount_rounding_increment_cents_check CHECK (((discount_rounding_increment_cents IS NULL) OR (discount_rounding_increment_cents = ANY (ARRAY[5, 10, 50, 100])))),
    CONSTRAINT tickets_discount_snapshot_check CHECK ((((discount_type IS NULL) AND (discount_name IS NULL) AND (discount_value_type IS NULL) AND (discount_value IS NULL) AND (discount_amount_cents IS NULL)) OR ((discount_type IS NOT NULL) AND (NULLIF(btrim(discount_name), ''::text) IS NOT NULL) AND (discount_value_type IS NOT NULL) AND (discount_value IS NOT NULL) AND (discount_value > (0)::numeric) AND (discount_amount_cents IS NOT NULL) AND (discount_amount_cents <= subtotal_cents) AND (total_cents = (subtotal_cents - discount_amount_cents))))),
    CONSTRAINT tickets_discount_type_check CHECK (((discount_type IS NULL) OR (discount_type = ANY (ARRAY['percentage'::text, 'fixed'::text, 'manual'::text])))),
    CONSTRAINT tickets_discount_value_type_check CHECK (((discount_value_type IS NULL) OR (discount_value_type = ANY (ARRAY['percentage'::text, 'fixed'::text])))),
    CONSTRAINT tickets_equal_split_snapshot_check CHECK ((((equal_split_id IS NULL) AND (equal_split_part_number IS NULL)) OR ((equal_split_id IS NOT NULL) AND (equal_split_part_number > 0)))),
    CONSTRAINT tickets_status_check CHECK ((status = ANY (ARRAY['paid'::text, 'void'::text]))),
    CONSTRAINT tickets_subtotal_cents_check CHECK ((subtotal_cents >= 0)),
    CONSTRAINT tickets_total_cents_check CHECK ((total_cents >= 0))
);


--
-- Name: user_login_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_login_leases (
    user_id uuid NOT NULL,
    auth_session_id text NOT NULL,
    client_id uuid NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:30:00'::interval) NOT NULL
);


--
-- Name: venues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    address text,
    legal_name text,
    tax_id text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tables_enabled boolean DEFAULT false NOT NULL,
    default_tax_rate numeric(5,2) DEFAULT 21 NOT NULL,
    manual_discount_enabled boolean DEFAULT false NOT NULL,
    timezone text DEFAULT 'Europe/Madrid'::text NOT NULL,
    currency_code text DEFAULT 'EUR'::text NOT NULL,
    catalog_profile text DEFAULT 'bar_classic'::text NOT NULL,
    CONSTRAINT venues_address_check CHECK (((address IS NULL) OR (char_length(address) <= 300))),
    CONSTRAINT venues_catalog_profile_check CHECK ((catalog_profile = ANY (ARRAY['bar_classic'::text, 'restaurant'::text, 'custom'::text]))),
    CONSTRAINT venues_default_tax_rate_check CHECK (((default_tax_rate >= (0)::numeric) AND (default_tax_rate <= (100)::numeric))),
    CONSTRAINT venues_legal_name_check CHECK (((legal_name IS NULL) OR (char_length(legal_name) <= 80))),
    CONSTRAINT venues_tax_id_check CHECK (((tax_id IS NULL) OR (char_length(tax_id) <= 80))),
    CONSTRAINT venues_ticket_fiscal_details_check CHECK ((((address IS NULL) OR (char_length(address) <= 300)) AND ((legal_name IS NULL) OR (char_length(legal_name) <= 80)) AND ((tax_id IS NULL) OR (char_length(tax_id) <= 80))))
);


--
-- Name: COLUMN venues.address; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.venues.address IS 'Direccion postal que se imprime en la cabecera del ticket.';


--
-- Name: COLUMN venues.legal_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.venues.legal_name IS 'Razon social que se imprime como Razon Social en el ticket.';


--
-- Name: COLUMN venues.tax_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.venues.tax_id IS 'NIF o CIF que se imprime como NIF/CIF en el ticket.';


--
-- Name: COLUMN venues.default_tax_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.venues.default_tax_rate IS 'Porcentaje de IVA heredado por los productos cuyo tax_rate es NULL.';


--
-- Name: cash_closing_print_events cash_closing_print_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_closing_print_events
    ADD CONSTRAINT cash_closing_print_events_pkey PRIMARY KEY (id);


--
-- Name: cash_movements cash_movements_category_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.cash_movements
    ADD CONSTRAINT cash_movements_category_check CHECK (((category IS NULL) OR (category = ANY (ARRAY['cash_in'::text, 'cash_out'::text, 'card_cashback'::text])))) NOT VALID;


--
-- Name: cash_movements cash_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT cash_movements_pkey PRIMARY KEY (id);


--
-- Name: cash_registers cash_registers_id_tenant_id_venue_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_id_tenant_id_venue_id_key UNIQUE (id, tenant_id, venue_id);


--
-- Name: cash_registers cash_registers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_pkey PRIMARY KEY (id);


--
-- Name: cash_registers cash_registers_tenant_id_venue_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_tenant_id_venue_id_name_key UNIQUE (tenant_id, venue_id, name);


--
-- Name: cash_session_table_layouts cash_session_table_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_session_table_layouts
    ADD CONSTRAINT cash_session_table_layouts_pkey PRIMARY KEY (cash_session_id);


--
-- Name: cash_sessions cash_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_sessions
    ADD CONSTRAINT cash_sessions_pkey PRIMARY KEY (id);


--
-- Name: catalog_audit_log catalog_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_audit_log
    ADD CONSTRAINT catalog_audit_log_pkey PRIMARY KEY (id);


--
-- Name: catalog_placements catalog_placements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_placements
    ADD CONSTRAINT catalog_placements_pkey PRIMARY KEY (id);


--
-- Name: catalog_tab_categories catalog_tab_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tab_categories
    ADD CONSTRAINT catalog_tab_categories_pkey PRIMARY KEY (id);


--
-- Name: catalog_tab_categories catalog_tab_categories_tab_id_category_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tab_categories
    ADD CONSTRAINT catalog_tab_categories_tab_id_category_id_key UNIQUE (tab_id, category_id);


--
-- Name: catalog_tabs catalog_tabs_id_tenant_id_venue_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tabs
    ADD CONSTRAINT catalog_tabs_id_tenant_id_venue_id_key UNIQUE (id, tenant_id, venue_id);


--
-- Name: catalog_tabs catalog_tabs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tabs
    ADD CONSTRAINT catalog_tabs_pkey PRIMARY KEY (id);


--
-- Name: catalog_tabs catalog_tabs_tenant_id_venue_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tabs
    ADD CONSTRAINT catalog_tabs_tenant_id_venue_id_key_key UNIQUE (tenant_id, venue_id, key);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: device_user_assignments device_user_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_user_assignments
    ADD CONSTRAINT device_user_assignments_pkey PRIMARY KEY (id);


--
-- Name: device_user_assignments device_user_assignments_tenant_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_user_assignments
    ADD CONSTRAINT device_user_assignments_tenant_id_user_id_key UNIQUE (tenant_id, user_id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: devices devices_tenant_id_venue_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_tenant_id_venue_id_name_key UNIQUE (tenant_id, venue_id, name);


--
-- Name: dining_areas dining_areas_id_tenant_id_venue_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dining_areas
    ADD CONSTRAINT dining_areas_id_tenant_id_venue_id_key UNIQUE (id, tenant_id, venue_id);


--
-- Name: dining_areas dining_areas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dining_areas
    ADD CONSTRAINT dining_areas_pkey PRIMARY KEY (id);


--
-- Name: discounts discounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts
    ADD CONSTRAINT discounts_pkey PRIMARY KEY (id);


--
-- Name: modifier_groups modifier_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_groups
    ADD CONSTRAINT modifier_groups_pkey PRIMARY KEY (id);


--
-- Name: modifiers modifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifiers
    ADD CONSTRAINT modifiers_pkey PRIMARY KEY (id);


--
-- Name: offline_event_log offline_event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offline_event_log
    ADD CONSTRAINT offline_event_log_pkey PRIMARY KEY (id);


--
-- Name: offline_event_log offline_event_log_tenant_id_client_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offline_event_log
    ADD CONSTRAINT offline_event_log_tenant_id_client_event_id_key UNIQUE (tenant_id, client_event_id);


--
-- Name: order_events order_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_pkey PRIMARY KEY (id);


--
-- Name: order_groups order_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_groups
    ADD CONSTRAINT order_groups_pkey PRIMARY KEY (id);


--
-- Name: order_groups order_groups_tenant_venue_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_groups
    ADD CONSTRAINT order_groups_tenant_venue_unique UNIQUE (id, tenant_id, venue_id);


--
-- Name: order_line_components order_line_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_line_components
    ADD CONSTRAINT order_line_components_pkey PRIMARY KEY (id);


--
-- Name: order_line_components order_line_components_price_delta_cents_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.order_line_components
    ADD CONSTRAINT order_line_components_price_delta_cents_check CHECK (((price_delta_cents >= '-100000000'::integer) AND (price_delta_cents <= 100000000))) NOT VALID;


--
-- Name: order_lines order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_lines
    ADD CONSTRAINT order_lines_pkey PRIMARY KEY (id);


--
-- Name: order_tables order_tables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_tables
    ADD CONSTRAINT order_tables_pkey PRIMARY KEY (order_id, table_id);


--
-- Name: orders orders_id_tenant_id_venue_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_id_tenant_id_venue_id_key UNIQUE (id, tenant_id, venue_id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: product_images product_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_pkey PRIMARY KEY (id);


--
-- Name: product_images product_images_product_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_product_id_key UNIQUE (product_id);


--
-- Name: product_modifier_group_assignments product_modifier_group_assign_id_product_id_tenant_id_venue_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignments
    ADD CONSTRAINT product_modifier_group_assign_id_product_id_tenant_id_venue_key UNIQUE (id, product_id, tenant_id, venue_id);


--
-- Name: product_modifier_group_assignment_variants product_modifier_group_assignment_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignment_variants
    ADD CONSTRAINT product_modifier_group_assignment_variants_pkey PRIMARY KEY (assignment_id, variant_id);


--
-- Name: product_modifier_group_assignments product_modifier_group_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignments
    ADD CONSTRAINT product_modifier_group_assignments_pkey PRIMARY KEY (id);


--
-- Name: product_modifier_group_assignments product_modifier_group_assignments_product_id_group_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignments
    ADD CONSTRAINT product_modifier_group_assignments_product_id_group_id_key UNIQUE (product_id, group_id);


--
-- Name: product_selection_group_assignments product_selection_group_assig_id_product_id_tenant_id_venue_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignments
    ADD CONSTRAINT product_selection_group_assig_id_product_id_tenant_id_venue_key UNIQUE (id, product_id, tenant_id, venue_id);


--
-- Name: product_selection_group_assignment_variants product_selection_group_assignment_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignment_variants
    ADD CONSTRAINT product_selection_group_assignment_variants_pkey PRIMARY KEY (assignment_id, variant_id);


--
-- Name: product_selection_group_assignments product_selection_group_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignments
    ADD CONSTRAINT product_selection_group_assignments_pkey PRIMARY KEY (id);


--
-- Name: product_selection_group_assignments product_selection_group_assignments_product_id_group_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignments
    ADD CONSTRAINT product_selection_group_assignments_product_id_group_id_key UNIQUE (product_id, group_id);


--
-- Name: product_variants product_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: restaurant_order_equal_split_payments restaurant_order_equal_split_payment_part_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_split_payments
    ADD CONSTRAINT restaurant_order_equal_split_payment_part_unique UNIQUE (split_id, part_number);


--
-- Name: restaurant_order_equal_split_payments restaurant_order_equal_split_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_split_payments
    ADD CONSTRAINT restaurant_order_equal_split_payments_pkey PRIMARY KEY (id);


--
-- Name: restaurant_order_equal_splits restaurant_order_equal_splits_id_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_splits
    ADD CONSTRAINT restaurant_order_equal_splits_id_scope_unique UNIQUE (id, tenant_id, venue_id);


--
-- Name: restaurant_order_equal_splits restaurant_order_equal_splits_order_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_splits
    ADD CONSTRAINT restaurant_order_equal_splits_order_unique UNIQUE (order_id);


--
-- Name: restaurant_order_equal_splits restaurant_order_equal_splits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_splits
    ADD CONSTRAINT restaurant_order_equal_splits_pkey PRIMARY KEY (id);


--
-- Name: restaurant_tables restaurant_tables_id_tenant_id_venue_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_tables
    ADD CONSTRAINT restaurant_tables_id_tenant_id_venue_id_key UNIQUE (id, tenant_id, venue_id);


--
-- Name: restaurant_tables restaurant_tables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_tables
    ADD CONSTRAINT restaurant_tables_pkey PRIMARY KEY (id);


--
-- Name: sale_payments sale_payments_method_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.sale_payments
    ADD CONSTRAINT sale_payments_method_check CHECK ((method = ANY (ARRAY['cash'::text, 'card'::text]))) NOT VALID;


--
-- Name: sale_payments sale_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payments
    ADD CONSTRAINT sale_payments_pkey PRIMARY KEY (id);


--
-- Name: sales sales_payment_method_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.sales
    ADD CONSTRAINT sales_payment_method_check CHECK (((payment_method IS NULL) OR (payment_method = ANY (ARRAY['cash'::text, 'card'::text])))) NOT VALID;


--
-- Name: sales sales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_pkey PRIMARY KEY (id);


--
-- Name: selection_group_options selection_group_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_group_options
    ADD CONSTRAINT selection_group_options_pkey PRIMARY KEY (id);


--
-- Name: selection_groups selection_groups_id_tenant_id_venue_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_groups
    ADD CONSTRAINT selection_groups_id_tenant_id_venue_id_key UNIQUE (id, tenant_id, venue_id);


--
-- Name: selection_groups selection_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_groups
    ADD CONSTRAINT selection_groups_pkey PRIMARY KEY (id);


--
-- Name: tenant_memberships tenant_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_memberships
    ADD CONSTRAINT tenant_memberships_pkey PRIMARY KEY (id);


--
-- Name: tenant_memberships tenant_memberships_tenant_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_memberships
    ADD CONSTRAINT tenant_memberships_tenant_id_user_id_key UNIQUE (tenant_id, user_id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);


--
-- Name: ticket_line_components ticket_line_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_line_components
    ADD CONSTRAINT ticket_line_components_pkey PRIMARY KEY (id);


--
-- Name: ticket_line_components ticket_line_components_price_delta_cents_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.ticket_line_components
    ADD CONSTRAINT ticket_line_components_price_delta_cents_check CHECK (((price_delta_cents >= '-100000000'::integer) AND (price_delta_cents <= 100000000))) NOT VALID;


--
-- Name: ticket_lines ticket_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_lines
    ADD CONSTRAINT ticket_lines_pkey PRIMARY KEY (id);


--
-- Name: tickets tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);


--
-- Name: user_login_leases user_login_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_login_leases
    ADD CONSTRAINT user_login_leases_pkey PRIMARY KEY (user_id);


--
-- Name: venues venues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_pkey PRIMARY KEY (id);


--
-- Name: cash_movements_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_movements_session_idx ON public.cash_movements USING btree (cash_session_id, created_at);


--
-- Name: cash_movements_session_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cash_movements_session_request_idx ON public.cash_movements USING btree (cash_session_id, request_id) WHERE (request_id IS NOT NULL);


--
-- Name: cash_session_table_layouts_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_session_table_layouts_scope_idx ON public.cash_session_table_layouts USING btree (tenant_id, venue_id, cash_register_id, cash_session_id);


--
-- Name: cash_sessions_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_sessions_tenant_idx ON public.cash_sessions USING btree (tenant_id, opened_at DESC);


--
-- Name: cash_sessions_venue_open_register_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_sessions_venue_open_register_idx ON public.cash_sessions USING btree (tenant_id, venue_id, cash_register_id) WHERE (status = 'open'::text);


--
-- Name: catalog_audit_log_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_audit_log_scope_idx ON public.catalog_audit_log USING btree (tenant_id, venue_id, created_at DESC);


--
-- Name: catalog_placements_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_placements_category_idx ON public.catalog_placements USING btree (tenant_id, venue_id, category_id, is_active);


--
-- Name: catalog_placements_identity_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX catalog_placements_identity_final_idx ON public.catalog_placements USING btree (product_id, tab_id, COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: catalog_placements_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_placements_product_idx ON public.catalog_placements USING btree (product_id, is_active);


--
-- Name: catalog_placements_tab_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_placements_tab_idx ON public.catalog_placements USING btree (tenant_id, venue_id, tab_id, is_active, sort_order);


--
-- Name: catalog_tab_categories_order_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_tab_categories_order_final_idx ON public.catalog_tab_categories USING btree (tenant_id, venue_id, tab_id, is_active, sort_order, id);


--
-- Name: catalog_tabs_venue_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX catalog_tabs_venue_active_idx ON public.catalog_tabs USING btree (tenant_id, venue_id, is_active, sort_order);


--
-- Name: categories_catalog_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX categories_catalog_scope_idx ON public.categories USING btree (id, tenant_id, venue_id);


--
-- Name: categories_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_tenant_idx ON public.categories USING btree (tenant_id, sort_order);


--
-- Name: categories_venue_order_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_venue_order_final_idx ON public.categories USING btree (tenant_id, venue_id, is_active, sort_order, id);


--
-- Name: device_user_assignments_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_user_assignments_user_idx ON public.device_user_assignments USING btree (user_id, tenant_id) WHERE (is_active = true);


--
-- Name: devices_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_tenant_idx ON public.devices USING btree (tenant_id, venue_id);


--
-- Name: dining_areas_venue_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dining_areas_venue_active_idx ON public.dining_areas USING btree (tenant_id, venue_id, is_active, sort_order);


--
-- Name: discounts_tenant_venue_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX discounts_tenant_venue_order_idx ON public.discounts USING btree (tenant_id, venue_id, sort_order, name);


--
-- Name: modifier_groups_catalog_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX modifier_groups_catalog_scope_idx ON public.modifier_groups USING btree (id, tenant_id, venue_id);


--
-- Name: modifier_groups_venue_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX modifier_groups_venue_active_idx ON public.modifier_groups USING btree (tenant_id, venue_id, is_active, sort_order);


--
-- Name: modifiers_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX modifiers_group_idx ON public.modifiers USING btree (group_id, sort_order);


--
-- Name: modifiers_order_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX modifiers_order_final_idx ON public.modifiers USING btree (tenant_id, venue_id, group_id, is_active, sort_order, id);


--
-- Name: one_active_order_per_restaurant_table; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX one_active_order_per_restaurant_table ON public.order_tables USING btree (table_id) WHERE (released_at IS NULL);


--
-- Name: one_active_user_per_device; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX one_active_user_per_device ON public.device_user_assignments USING btree (tenant_id, device_id) WHERE (is_active = true);


--
-- Name: one_open_cash_session_per_register; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX one_open_cash_session_per_register ON public.cash_sessions USING btree (cash_register_id) WHERE (status = 'open'::text);


--
-- Name: order_events_order_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_events_order_created_idx ON public.order_events USING btree (order_id, created_at DESC);


--
-- Name: order_events_venue_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_events_venue_created_idx ON public.order_events USING btree (tenant_id, venue_id, created_at DESC);


--
-- Name: order_line_components_line_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_line_components_line_idx ON public.order_line_components USING btree (tenant_id, venue_id, order_line_id, component_type, sort_order);


--
-- Name: order_lines_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_lines_order_idx ON public.order_lines USING btree (order_id, created_at);


--
-- Name: order_lines_pending_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_lines_pending_order_idx ON public.order_lines USING btree (order_id) WHERE (served_quantity < quantity);


--
-- Name: order_lines_split_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_lines_split_source_idx ON public.order_lines USING btree (split_from_line_id) WHERE (split_from_line_id IS NOT NULL);


--
-- Name: order_tables_active_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_tables_active_group_idx ON public.order_tables USING btree (order_group_id) WHERE (released_at IS NULL);


--
-- Name: order_tables_order_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_tables_order_active_idx ON public.order_tables USING btree (order_id, table_id) WHERE (released_at IS NULL);


--
-- Name: orders_cash_session_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_cash_session_open_idx ON public.orders USING btree (cash_session_id, opened_at) WHERE (status = 'open'::text);


--
-- Name: orders_group_split_sequence_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX orders_group_split_sequence_unique ON public.orders USING btree (order_group_id, split_sequence);


--
-- Name: orders_open_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_open_group_idx ON public.orders USING btree (order_group_id, status) WHERE (status = 'open'::text);


--
-- Name: orders_register_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_register_open_idx ON public.orders USING btree (tenant_id, cash_register_id, opened_at) WHERE (status = 'open'::text);


--
-- Name: orders_venue_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_venue_open_idx ON public.orders USING btree (tenant_id, venue_id, opened_at) WHERE (status = 'open'::text);


--
-- Name: product_images_storage_path_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_images_storage_path_final_idx ON public.product_images USING btree (tenant_id, venue_id, storage_path);


--
-- Name: product_modifier_assignment_variants_variant_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_modifier_assignment_variants_variant_final_idx ON public.product_modifier_group_assignment_variants USING btree (tenant_id, venue_id, variant_id, assignment_id);


--
-- Name: product_modifier_assignments_order_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_modifier_assignments_order_final_idx ON public.product_modifier_group_assignments USING btree (tenant_id, venue_id, product_id, is_active, sort_order, id);


--
-- Name: product_selection_assignment_variants_variant_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_selection_assignment_variants_variant_final_idx ON public.product_selection_group_assignment_variants USING btree (tenant_id, venue_id, variant_id, assignment_id);


--
-- Name: product_selection_assignments_order_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_selection_assignments_order_final_idx ON public.product_selection_group_assignments USING btree (tenant_id, venue_id, product_id, is_active, sort_order, id);


--
-- Name: product_variants_catalog_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_variants_catalog_scope_idx ON public.product_variants USING btree (id, product_id, tenant_id, venue_id);


--
-- Name: product_variants_one_active_default_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_variants_one_active_default_idx ON public.product_variants USING btree (product_id) WHERE (is_default AND is_active);


--
-- Name: product_variants_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_variants_product_idx ON public.product_variants USING btree (product_id, sort_order);


--
-- Name: product_variants_product_order_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_variants_product_order_final_idx ON public.product_variants USING btree (tenant_id, venue_id, product_id, is_active, sort_order, id);


--
-- Name: products_catalog_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX products_catalog_scope_idx ON public.products USING btree (id, tenant_id, venue_id);


--
-- Name: products_tenant_venue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_tenant_venue_idx ON public.products USING btree (tenant_id, venue_id, sort_order);


--
-- Name: products_venue_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_venue_active_idx ON public.products USING btree (tenant_id, venue_id, is_active, sort_order);


--
-- Name: products_venue_order_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_venue_order_final_idx ON public.products USING btree (tenant_id, venue_id, is_active, sort_order, id);


--
-- Name: profiles_superadmin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_superadmin_idx ON public.profiles USING btree (id) WHERE (is_superadmin = true);


--
-- Name: restaurant_order_equal_splits_open_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restaurant_order_equal_splits_open_group_idx ON public.restaurant_order_equal_splits USING btree (order_group_id) WHERE (status = 'open'::text);


--
-- Name: restaurant_tables_area_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restaurant_tables_area_active_idx ON public.restaurant_tables USING btree (tenant_id, venue_id, area_id, is_active, sort_order);


--
-- Name: restaurant_tables_reserved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restaurant_tables_reserved_idx ON public.restaurant_tables USING btree (venue_id, reserved_until) WHERE ((is_active = true) AND (reserved_until IS NOT NULL));


--
-- Name: sales_register_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sales_register_created_idx ON public.sales USING btree (tenant_id, cash_register_id, created_at DESC);


--
-- Name: sales_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sales_tenant_idx ON public.sales USING btree (tenant_id, created_at DESC);


--
-- Name: selection_group_options_identity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX selection_group_options_identity_idx ON public.selection_group_options USING btree (group_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: selection_group_options_order_final_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX selection_group_options_order_final_idx ON public.selection_group_options USING btree (tenant_id, venue_id, group_id, is_active, sort_order, id);


--
-- Name: selection_groups_venue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX selection_groups_venue_idx ON public.selection_groups USING btree (tenant_id, venue_id, kind, is_active, sort_order);


--
-- Name: tenant_memberships_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tenant_memberships_user_idx ON public.tenant_memberships USING btree (user_id);


--
-- Name: ticket_line_components_line_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ticket_line_components_line_idx ON public.ticket_line_components USING btree (tenant_id, ticket_line_id, component_type, sort_order);


--
-- Name: tickets_equal_split_part_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tickets_equal_split_part_unique ON public.tickets USING btree (equal_split_id, equal_split_part_number) WHERE (equal_split_id IS NOT NULL);


--
-- Name: tickets_register_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tickets_register_created_idx ON public.tickets USING btree (tenant_id, cash_register_id, created_at DESC);


--
-- Name: tickets_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tickets_tenant_idx ON public.tickets USING btree (tenant_id, created_at DESC);


--
-- Name: user_login_leases_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_login_leases_expiry_idx ON public.user_login_leases USING btree (expires_at);


--
-- Name: venues_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX venues_tenant_idx ON public.venues USING btree (tenant_id);


--
-- Name: order_lines audit_restaurant_order_lines; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_restaurant_order_lines AFTER INSERT OR UPDATE ON public.order_lines FOR EACH ROW EXECUTE FUNCTION public.audit_restaurant_order_change();


--
-- Name: order_tables audit_restaurant_order_tables; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_restaurant_order_tables AFTER INSERT OR UPDATE ON public.order_tables FOR EACH ROW EXECUTE FUNCTION public.audit_restaurant_order_change();


--
-- Name: orders audit_restaurant_orders; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_restaurant_orders AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.audit_restaurant_order_change();


--
-- Name: cash_sessions block_cash_close_with_open_restaurant_orders; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER block_cash_close_with_open_restaurant_orders BEFORE UPDATE OF status ON public.cash_sessions FOR EACH ROW EXECUTE FUNCTION public.block_cash_close_with_open_restaurant_orders();


--
-- Name: ticket_lines capture_ticket_line_catalog_snapshot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER capture_ticket_line_catalog_snapshot BEFORE INSERT ON public.ticket_lines FOR EACH ROW EXECUTE FUNCTION public.capture_ticket_line_catalog_snapshot();


--
-- Name: ticket_lines capture_ticket_line_components; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER capture_ticket_line_components AFTER INSERT ON public.ticket_lines FOR EACH ROW EXECUTE FUNCTION public.capture_ticket_line_components();


--
-- Name: catalog_placements catalog_placements_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_placements_audit AFTER INSERT OR DELETE OR UPDATE ON public.catalog_placements FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: catalog_placements catalog_placements_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_placements_catalog_validate BEFORE INSERT OR UPDATE ON public.catalog_placements FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: catalog_placements catalog_placements_final_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_placements_final_scope BEFORE INSERT OR UPDATE ON public.catalog_placements FOR EACH ROW EXECUTE FUNCTION public.validate_final_catalog_scope();


--
-- Name: catalog_placements catalog_placements_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_placements_updated_at BEFORE UPDATE ON public.catalog_placements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: catalog_tab_categories catalog_tab_categories_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_tab_categories_audit AFTER INSERT OR DELETE OR UPDATE ON public.catalog_tab_categories FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: catalog_tab_categories catalog_tab_categories_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_tab_categories_catalog_validate BEFORE INSERT OR UPDATE ON public.catalog_tab_categories FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: catalog_tab_categories catalog_tab_categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_tab_categories_updated_at BEFORE UPDATE ON public.catalog_tab_categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: catalog_tabs catalog_tabs_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_tabs_audit AFTER INSERT OR DELETE OR UPDATE ON public.catalog_tabs FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: catalog_tabs catalog_tabs_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_tabs_catalog_validate BEFORE INSERT OR UPDATE ON public.catalog_tabs FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: catalog_tabs catalog_tabs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER catalog_tabs_updated_at BEFORE UPDATE ON public.catalog_tabs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_variants catalog_variants_default_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER catalog_variants_default_guard AFTER INSERT OR DELETE OR UPDATE ON public.product_variants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_product_default_variant();


--
-- Name: categories categories_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_audit AFTER INSERT OR DELETE OR UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: categories categories_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_catalog_validate BEFORE INSERT OR UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: categories categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: cash_sessions clear_closed_cash_session_table_layout; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clear_closed_cash_session_table_layout AFTER UPDATE OF status ON public.cash_sessions FOR EACH ROW EXECUTE FUNCTION public.clear_closed_cash_session_table_layout();


--
-- Name: devices create_device_cash_register; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER create_device_cash_register AFTER INSERT ON public.devices FOR EACH ROW EXECUTE FUNCTION public.sync_device_cash_register();


--
-- Name: devices enforce_device_plan_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_device_plan_limit BEFORE INSERT ON public.devices FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_plan_limit();


--
-- Name: tenant_memberships enforce_user_plan_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_user_plan_limit BEFORE INSERT ON public.tenant_memberships FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_plan_limit();


--
-- Name: venues enforce_venue_plan_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_venue_plan_limit BEFORE INSERT ON public.venues FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_plan_limit();


--
-- Name: orders guard_equal_split_order_close; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_equal_split_order_close BEFORE UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.guard_equal_split_order_close();


--
-- Name: order_lines guard_paid_equal_split_order_lines; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_paid_equal_split_order_lines BEFORE INSERT OR DELETE OR UPDATE ON public.order_lines FOR EACH ROW EXECUTE FUNCTION public.guard_paid_equal_split_order_lines();


--
-- Name: product_modifier_group_assignments modifier_assignments_capacity_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER modifier_assignments_capacity_guard AFTER INSERT OR DELETE OR UPDATE ON public.product_modifier_group_assignments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_modifier_capacity();


--
-- Name: modifier_groups modifier_groups_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER modifier_groups_audit AFTER INSERT OR DELETE OR UPDATE ON public.modifier_groups FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: modifier_groups modifier_groups_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER modifier_groups_catalog_validate BEFORE INSERT OR UPDATE ON public.modifier_groups FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: modifier_groups modifier_groups_final_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER modifier_groups_final_scope BEFORE INSERT OR UPDATE ON public.modifier_groups FOR EACH ROW EXECUTE FUNCTION public.validate_final_catalog_scope();


--
-- Name: modifier_groups modifier_groups_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER modifier_groups_updated_at BEFORE UPDATE ON public.modifier_groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: modifiers modifiers_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER modifiers_audit AFTER INSERT OR DELETE OR UPDATE ON public.modifiers FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: modifiers modifiers_capacity_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER modifiers_capacity_guard AFTER INSERT OR DELETE OR UPDATE ON public.modifiers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_modifier_capacity();


--
-- Name: modifiers modifiers_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER modifiers_catalog_validate BEFORE INSERT OR UPDATE ON public.modifiers FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: modifiers modifiers_final_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER modifiers_final_scope BEFORE INSERT OR UPDATE ON public.modifiers FOR EACH ROW EXECUTE FUNCTION public.validate_final_catalog_scope();


--
-- Name: modifiers modifiers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER modifiers_updated_at BEFORE UPDATE ON public.modifiers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_images product_images_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_images_audit AFTER INSERT OR DELETE OR UPDATE ON public.product_images FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: product_images product_images_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_images_updated_at BEFORE UPDATE ON public.product_images FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_modifier_group_assignment_variants product_modifier_group_assignment_variants_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_modifier_group_assignment_variants_audit AFTER INSERT OR DELETE OR UPDATE ON public.product_modifier_group_assignment_variants FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: product_modifier_group_assignments product_modifier_group_assignments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_modifier_group_assignments_audit AFTER INSERT OR DELETE OR UPDATE ON public.product_modifier_group_assignments FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: product_modifier_group_assignments product_modifier_group_assignments_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_modifier_group_assignments_catalog_validate BEFORE INSERT OR UPDATE ON public.product_modifier_group_assignments FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: product_modifier_group_assignments product_modifier_group_assignments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_modifier_group_assignments_updated_at BEFORE UPDATE ON public.product_modifier_group_assignments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_selection_group_assignment_variants product_selection_group_assignment_variants_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_selection_group_assignment_variants_audit AFTER INSERT OR DELETE OR UPDATE ON public.product_selection_group_assignment_variants FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: product_selection_group_assignments product_selection_group_assignments_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_selection_group_assignments_audit AFTER INSERT OR DELETE OR UPDATE ON public.product_selection_group_assignments FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: product_selection_group_assignments product_selection_group_assignments_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_selection_group_assignments_catalog_validate BEFORE INSERT OR UPDATE ON public.product_selection_group_assignments FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: product_selection_group_assignments product_selection_group_assignments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_selection_group_assignments_updated_at BEFORE UPDATE ON public.product_selection_group_assignments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_variants product_variants_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_variants_audit AFTER INSERT OR DELETE OR UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: product_variants product_variants_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_variants_catalog_validate BEFORE INSERT OR UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: product_variants product_variants_final_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER product_variants_final_scope BEFORE INSERT OR UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.validate_final_catalog_scope();


--
-- Name: products products_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER products_audit AFTER INSERT OR DELETE OR UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: products products_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER products_catalog_validate BEFORE INSERT OR UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: products products_final_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER products_final_scope BEFORE INSERT OR UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.validate_final_catalog_scope();


--
-- Name: products products_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: cash_registers protect_open_cash_register; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER protect_open_cash_register BEFORE UPDATE ON public.cash_registers FOR EACH ROW EXECUTE FUNCTION public.protect_open_cash_register();


--
-- Name: cash_sessions reconcile_cash_register_after_close; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reconcile_cash_register_after_close AFTER UPDATE OF status ON public.cash_sessions FOR EACH ROW EXECUTE FUNCTION public.reconcile_cash_register_after_close();


--
-- Name: product_selection_group_assignments selection_assignments_capacity_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER selection_assignments_capacity_guard AFTER INSERT OR DELETE OR UPDATE ON public.product_selection_group_assignments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_selection_capacity();


--
-- Name: selection_group_options selection_group_options_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER selection_group_options_audit AFTER INSERT OR DELETE OR UPDATE ON public.selection_group_options FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: selection_group_options selection_group_options_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER selection_group_options_catalog_validate BEFORE INSERT OR UPDATE ON public.selection_group_options FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: selection_group_options selection_group_options_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER selection_group_options_updated_at BEFORE UPDATE ON public.selection_group_options FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: selection_groups selection_groups_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER selection_groups_audit AFTER INSERT OR DELETE OR UPDATE ON public.selection_groups FOR EACH ROW EXECUTE FUNCTION public.audit_catalog_change();


--
-- Name: selection_groups selection_groups_catalog_validate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER selection_groups_catalog_validate BEFORE INSERT OR UPDATE ON public.selection_groups FOR EACH ROW EXECUTE FUNCTION public.validate_catalog_entity();


--
-- Name: selection_groups selection_groups_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER selection_groups_updated_at BEFORE UPDATE ON public.selection_groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: selection_group_options selection_options_capacity_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER selection_options_capacity_guard AFTER INSERT OR DELETE OR UPDATE ON public.selection_group_options DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_selection_capacity();


--
-- Name: cash_sessions set_cash_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_cash_sessions_updated_at BEFORE UPDATE ON public.cash_sessions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: catalog_placements set_catalog_placements_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_catalog_placements_updated_at BEFORE UPDATE ON public.catalog_placements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: catalog_tabs set_catalog_tabs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_catalog_tabs_updated_at BEFORE UPDATE ON public.catalog_tabs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: categories set_categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_categories_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: device_user_assignments set_device_user_assignments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_device_user_assignments_updated_at BEFORE UPDATE ON public.device_user_assignments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: devices set_devices_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_devices_updated_at BEFORE UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: dining_areas set_dining_areas_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_dining_areas_updated_at BEFORE UPDATE ON public.dining_areas FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: discounts set_discounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_discounts_updated_at BEFORE UPDATE ON public.discounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: modifier_groups set_modifier_groups_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_modifier_groups_updated_at BEFORE UPDATE ON public.modifier_groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: modifiers set_modifiers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_modifiers_updated_at BEFORE UPDATE ON public.modifiers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: orders set_order_cash_register; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_order_cash_register BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_order_cash_register();


--
-- Name: order_lines set_order_lines_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_order_lines_updated_at BEFORE UPDATE ON public.order_lines FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: orders set_orders_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: product_variants set_product_variants_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_product_variants_updated_at BEFORE UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: products set_products_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: profiles set_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: restaurant_tables set_restaurant_tables_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_restaurant_tables_updated_at BEFORE UPDATE ON public.restaurant_tables FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: sales set_sales_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_sales_updated_at BEFORE UPDATE ON public.sales FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: selection_groups set_selection_groups_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_selection_groups_updated_at BEFORE UPDATE ON public.selection_groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tenant_memberships set_tenant_memberships_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_tenant_memberships_updated_at BEFORE UPDATE ON public.tenant_memberships FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tenants set_tenants_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_tenants_updated_at BEFORE UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tickets set_ticket_discount_rounding_snapshot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_ticket_discount_rounding_snapshot BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.set_ticket_discount_rounding_snapshot();


--
-- Name: ticket_lines set_ticket_line_fiscal_snapshot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_ticket_line_fiscal_snapshot BEFORE INSERT OR UPDATE ON public.ticket_lines FOR EACH ROW EXECUTE FUNCTION public.set_ticket_line_fiscal_snapshot();


--
-- Name: tickets set_tickets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_tickets_updated_at BEFORE UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: venues set_venues_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_venues_updated_at BEFORE UPDATE ON public.venues FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: device_user_assignments sync_assignment_cash_register; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_assignment_cash_register AFTER INSERT OR DELETE OR UPDATE OF device_id, user_id, is_active ON public.device_user_assignments FOR EACH ROW EXECUTE FUNCTION public.sync_assignment_cash_register();


--
-- Name: tenant_memberships sync_membership_cash_register; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_membership_cash_register AFTER INSERT OR DELETE OR UPDATE OF role, is_active ON public.tenant_memberships FOR EACH ROW EXECUTE FUNCTION public.sync_membership_cash_register();


--
-- Name: devices update_device_cash_register; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_device_cash_register AFTER UPDATE OF name, device_mode, is_active, can_open_cash_session ON public.devices FOR EACH ROW EXECUTE FUNCTION public.sync_device_cash_register();


--
-- Name: cash_session_table_layouts validate_cash_session_table_layout_compactness; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_cash_session_table_layout_compactness BEFORE INSERT OR UPDATE OF tables ON public.cash_session_table_layouts FOR EACH ROW EXECUTE FUNCTION public.validate_cash_session_table_layout_compactness();


--
-- Name: cash_sessions validate_cash_session_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_cash_session_write BEFORE INSERT OR UPDATE ON public.cash_sessions FOR EACH ROW EXECUTE FUNCTION public.validate_cash_session_write();


--
-- Name: devices validate_device_cash_register; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_device_cash_register BEFORE INSERT OR UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.validate_device_cash_register();


--
-- Name: device_user_assignments validate_device_user_assignment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_device_user_assignment BEFORE INSERT OR UPDATE ON public.device_user_assignments FOR EACH ROW EXECUTE FUNCTION public.validate_device_user_assignment();


--
-- Name: discounts validate_discount_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_discount_scope BEFORE INSERT OR UPDATE ON public.discounts FOR EACH ROW EXECUTE FUNCTION public.validate_discount_scope();


--
-- Name: products validate_product_venue; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_product_venue BEFORE INSERT OR UPDATE OF tenant_id, venue_id ON public.products FOR EACH ROW EXECUTE FUNCTION public.validate_product_venue();


--
-- Name: sales validate_sale_actor_and_cash; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_sale_actor_and_cash BEFORE INSERT OR UPDATE ON public.sales FOR EACH ROW EXECUTE FUNCTION public.validate_transaction_actor_and_cash();


--
-- Name: tickets validate_ticket_actor_and_cash; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_ticket_actor_and_cash BEFORE INSERT OR UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.validate_transaction_actor_and_cash();


--
-- Name: ticket_lines validate_ticket_line_product_venue; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_ticket_line_product_venue BEFORE INSERT OR UPDATE OF tenant_id, ticket_id, product_id, variant_id ON public.ticket_lines FOR EACH ROW EXECUTE FUNCTION public.validate_ticket_line_product_venue();


--
-- Name: cash_closing_print_events cash_closing_print_events_cash_closing_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_closing_print_events
    ADD CONSTRAINT cash_closing_print_events_cash_closing_id_fkey FOREIGN KEY (cash_closing_id) REFERENCES public.cash_sessions(id) ON DELETE RESTRICT;


--
-- Name: cash_closing_print_events cash_closing_print_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_closing_print_events
    ADD CONSTRAINT cash_closing_print_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cash_closing_print_events cash_closing_print_events_terminal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_closing_print_events
    ADD CONSTRAINT cash_closing_print_events_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES public.devices(id) ON DELETE SET NULL;


--
-- Name: cash_closing_print_events cash_closing_print_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_closing_print_events
    ADD CONSTRAINT cash_closing_print_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: cash_movements cash_movements_cash_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT cash_movements_cash_session_id_fkey FOREIGN KEY (cash_session_id) REFERENCES public.cash_sessions(id) ON DELETE RESTRICT;


--
-- Name: cash_movements cash_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT cash_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: cash_movements cash_movements_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT cash_movements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cash_movements cash_movements_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT cash_movements_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: cash_registers cash_registers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cash_registers cash_registers_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: cash_session_table_layouts cash_session_table_layouts_cash_register_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_session_table_layouts
    ADD CONSTRAINT cash_session_table_layouts_cash_register_id_fkey FOREIGN KEY (cash_register_id) REFERENCES public.cash_registers(id) ON DELETE CASCADE;


--
-- Name: cash_session_table_layouts cash_session_table_layouts_cash_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_session_table_layouts
    ADD CONSTRAINT cash_session_table_layouts_cash_session_id_fkey FOREIGN KEY (cash_session_id) REFERENCES public.cash_sessions(id) ON DELETE CASCADE;


--
-- Name: cash_session_table_layouts cash_session_table_layouts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_session_table_layouts
    ADD CONSTRAINT cash_session_table_layouts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cash_session_table_layouts cash_session_table_layouts_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_session_table_layouts
    ADD CONSTRAINT cash_session_table_layouts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: cash_session_table_layouts cash_session_table_layouts_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_session_table_layouts
    ADD CONSTRAINT cash_session_table_layouts_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: cash_sessions cash_sessions_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_sessions
    ADD CONSTRAINT cash_sessions_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: cash_sessions cash_sessions_closed_device_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_sessions
    ADD CONSTRAINT cash_sessions_closed_device_fk FOREIGN KEY (closed_by_device_id) REFERENCES public.devices(id) ON DELETE RESTRICT;


--
-- Name: cash_sessions cash_sessions_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_sessions
    ADD CONSTRAINT cash_sessions_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE RESTRICT;


--
-- Name: cash_sessions cash_sessions_opened_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_sessions
    ADD CONSTRAINT cash_sessions_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: cash_sessions cash_sessions_opened_device_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_sessions
    ADD CONSTRAINT cash_sessions_opened_device_fk FOREIGN KEY (opened_by_device_id) REFERENCES public.devices(id) ON DELETE RESTRICT;


--
-- Name: cash_sessions cash_sessions_register_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_sessions
    ADD CONSTRAINT cash_sessions_register_fk FOREIGN KEY (cash_register_id, tenant_id, venue_id) REFERENCES public.cash_registers(id, tenant_id, venue_id) ON DELETE RESTRICT;


--
-- Name: cash_sessions cash_sessions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_sessions
    ADD CONSTRAINT cash_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cash_sessions cash_sessions_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_sessions
    ADD CONSTRAINT cash_sessions_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: catalog_placements catalog_placements_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_placements
    ADD CONSTRAINT catalog_placements_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE RESTRICT;


--
-- Name: catalog_placements catalog_placements_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_placements
    ADD CONSTRAINT catalog_placements_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: catalog_placements catalog_placements_tab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_placements
    ADD CONSTRAINT catalog_placements_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES public.catalog_tabs(id) ON DELETE CASCADE;


--
-- Name: catalog_placements catalog_placements_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_placements
    ADD CONSTRAINT catalog_placements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: catalog_placements catalog_placements_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_placements
    ADD CONSTRAINT catalog_placements_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE RESTRICT;


--
-- Name: catalog_placements catalog_placements_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_placements
    ADD CONSTRAINT catalog_placements_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: catalog_tab_categories catalog_tab_categories_category_id_tenant_id_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tab_categories
    ADD CONSTRAINT catalog_tab_categories_category_id_tenant_id_venue_id_fkey FOREIGN KEY (category_id, tenant_id, venue_id) REFERENCES public.categories(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: catalog_tab_categories catalog_tab_categories_tab_id_tenant_id_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tab_categories
    ADD CONSTRAINT catalog_tab_categories_tab_id_tenant_id_venue_id_fkey FOREIGN KEY (tab_id, tenant_id, venue_id) REFERENCES public.catalog_tabs(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: catalog_tab_categories catalog_tab_categories_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tab_categories
    ADD CONSTRAINT catalog_tab_categories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: catalog_tab_categories catalog_tab_categories_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tab_categories
    ADD CONSTRAINT catalog_tab_categories_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: catalog_tabs catalog_tabs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tabs
    ADD CONSTRAINT catalog_tabs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: catalog_tabs catalog_tabs_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_tabs
    ADD CONSTRAINT catalog_tabs_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: categories categories_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: categories categories_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: device_user_assignments device_user_assignments_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_user_assignments
    ADD CONSTRAINT device_user_assignments_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: device_user_assignments device_user_assignments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_user_assignments
    ADD CONSTRAINT device_user_assignments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: device_user_assignments device_user_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_user_assignments
    ADD CONSTRAINT device_user_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: device_user_assignments device_user_assignments_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_user_assignments
    ADD CONSTRAINT device_user_assignments_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: devices devices_default_cash_register_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_default_cash_register_fk FOREIGN KEY (default_cash_register_id) REFERENCES public.cash_registers(id) ON DELETE SET NULL;


--
-- Name: devices devices_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: devices devices_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: dining_areas dining_areas_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dining_areas
    ADD CONSTRAINT dining_areas_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dining_areas dining_areas_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dining_areas
    ADD CONSTRAINT dining_areas_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: discounts discounts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts
    ADD CONSTRAINT discounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: discounts discounts_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts
    ADD CONSTRAINT discounts_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: modifier_groups modifier_groups_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_groups
    ADD CONSTRAINT modifier_groups_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: modifier_groups modifier_groups_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_groups
    ADD CONSTRAINT modifier_groups_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: modifiers modifiers_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifiers
    ADD CONSTRAINT modifiers_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.modifier_groups(id) ON DELETE CASCADE;


--
-- Name: modifiers modifiers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifiers
    ADD CONSTRAINT modifiers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: modifiers modifiers_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifiers
    ADD CONSTRAINT modifiers_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: offline_event_log offline_event_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offline_event_log
    ADD CONSTRAINT offline_event_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: order_events order_events_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE SET NULL;


--
-- Name: order_events order_events_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_events order_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: order_events order_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: order_events order_events_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: order_groups order_groups_cash_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_groups
    ADD CONSTRAINT order_groups_cash_session_id_fkey FOREIGN KEY (cash_session_id) REFERENCES public.cash_sessions(id) ON DELETE RESTRICT;


--
-- Name: order_groups order_groups_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_groups
    ADD CONSTRAINT order_groups_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: order_groups order_groups_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_groups
    ADD CONSTRAINT order_groups_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: order_line_components order_line_components_order_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_line_components
    ADD CONSTRAINT order_line_components_order_line_id_fkey FOREIGN KEY (order_line_id) REFERENCES public.order_lines(id) ON DELETE CASCADE;


--
-- Name: order_line_components order_line_components_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_line_components
    ADD CONSTRAINT order_line_components_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: order_line_components order_line_components_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_line_components
    ADD CONSTRAINT order_line_components_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: order_lines order_lines_order_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_lines
    ADD CONSTRAINT order_lines_order_fk FOREIGN KEY (order_id, tenant_id, venue_id) REFERENCES public.orders(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: order_lines order_lines_split_from_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_lines
    ADD CONSTRAINT order_lines_split_from_line_id_fkey FOREIGN KEY (split_from_line_id) REFERENCES public.order_lines(id) ON DELETE SET NULL;


--
-- Name: order_tables order_tables_order_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_tables
    ADD CONSTRAINT order_tables_order_fk FOREIGN KEY (order_id, tenant_id, venue_id) REFERENCES public.orders(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: order_tables order_tables_order_group_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_tables
    ADD CONSTRAINT order_tables_order_group_fk FOREIGN KEY (order_group_id, tenant_id, venue_id) REFERENCES public.order_groups(id, tenant_id, venue_id) ON DELETE RESTRICT;


--
-- Name: order_tables order_tables_table_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_tables
    ADD CONSTRAINT order_tables_table_fk FOREIGN KEY (table_id, tenant_id, venue_id) REFERENCES public.restaurant_tables(id, tenant_id, venue_id) ON DELETE RESTRICT;


--
-- Name: orders orders_cash_register_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_cash_register_fk FOREIGN KEY (cash_register_id) REFERENCES public.cash_registers(id) ON DELETE RESTRICT;


--
-- Name: orders orders_cash_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_cash_session_id_fkey FOREIGN KEY (cash_session_id) REFERENCES public.cash_sessions(id) ON DELETE RESTRICT;


--
-- Name: orders orders_opened_by_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_opened_by_device_id_fkey FOREIGN KEY (opened_by_device_id) REFERENCES public.devices(id) ON DELETE RESTRICT;


--
-- Name: orders orders_opened_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_opened_by_user_id_fkey FOREIGN KEY (opened_by_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: orders orders_order_group_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_order_group_fk FOREIGN KEY (order_group_id, tenant_id, venue_id) REFERENCES public.order_groups(id, tenant_id, venue_id) ON DELETE RESTRICT;


--
-- Name: orders orders_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: orders orders_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: product_images product_images_product_id_tenant_id_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_product_id_tenant_id_venue_id_fkey FOREIGN KEY (product_id, tenant_id, venue_id) REFERENCES public.products(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: product_images product_images_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: product_images product_images_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: product_modifier_group_assignment_variants product_modifier_group_assign_assignment_id_product_id_ten_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignment_variants
    ADD CONSTRAINT product_modifier_group_assign_assignment_id_product_id_ten_fkey FOREIGN KEY (assignment_id, product_id, tenant_id, venue_id) REFERENCES public.product_modifier_group_assignments(id, product_id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: product_modifier_group_assignments product_modifier_group_assign_product_id_tenant_id_venue_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignments
    ADD CONSTRAINT product_modifier_group_assign_product_id_tenant_id_venue_i_fkey FOREIGN KEY (product_id, tenant_id, venue_id) REFERENCES public.products(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: product_modifier_group_assignment_variants product_modifier_group_assign_variant_id_product_id_tenant_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignment_variants
    ADD CONSTRAINT product_modifier_group_assign_variant_id_product_id_tenant_fkey FOREIGN KEY (variant_id, product_id, tenant_id, venue_id) REFERENCES public.product_variants(id, product_id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: product_modifier_group_assignments product_modifier_group_assignm_group_id_tenant_id_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignments
    ADD CONSTRAINT product_modifier_group_assignm_group_id_tenant_id_venue_id_fkey FOREIGN KEY (group_id, tenant_id, venue_id) REFERENCES public.modifier_groups(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: product_modifier_group_assignment_variants product_modifier_group_assignment_variants_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignment_variants
    ADD CONSTRAINT product_modifier_group_assignment_variants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: product_modifier_group_assignment_variants product_modifier_group_assignment_variants_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignment_variants
    ADD CONSTRAINT product_modifier_group_assignment_variants_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: product_modifier_group_assignments product_modifier_group_assignments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignments
    ADD CONSTRAINT product_modifier_group_assignments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: product_modifier_group_assignments product_modifier_group_assignments_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_modifier_group_assignments
    ADD CONSTRAINT product_modifier_group_assignments_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: product_selection_group_assignment_variants product_selection_group_assig_assignment_id_product_id_ten_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignment_variants
    ADD CONSTRAINT product_selection_group_assig_assignment_id_product_id_ten_fkey FOREIGN KEY (assignment_id, product_id, tenant_id, venue_id) REFERENCES public.product_selection_group_assignments(id, product_id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: product_selection_group_assignments product_selection_group_assig_product_id_tenant_id_venue_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignments
    ADD CONSTRAINT product_selection_group_assig_product_id_tenant_id_venue_i_fkey FOREIGN KEY (product_id, tenant_id, venue_id) REFERENCES public.products(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: product_selection_group_assignment_variants product_selection_group_assig_variant_id_product_id_tenant_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignment_variants
    ADD CONSTRAINT product_selection_group_assig_variant_id_product_id_tenant_fkey FOREIGN KEY (variant_id, product_id, tenant_id, venue_id) REFERENCES public.product_variants(id, product_id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: product_selection_group_assignments product_selection_group_assign_group_id_tenant_id_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignments
    ADD CONSTRAINT product_selection_group_assign_group_id_tenant_id_venue_id_fkey FOREIGN KEY (group_id, tenant_id, venue_id) REFERENCES public.selection_groups(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: product_selection_group_assignment_variants product_selection_group_assignment_variants_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignment_variants
    ADD CONSTRAINT product_selection_group_assignment_variants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: product_selection_group_assignment_variants product_selection_group_assignment_variants_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignment_variants
    ADD CONSTRAINT product_selection_group_assignment_variants_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: product_selection_group_assignments product_selection_group_assignments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignments
    ADD CONSTRAINT product_selection_group_assignments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: product_selection_group_assignments product_selection_group_assignments_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_selection_group_assignments
    ADD CONSTRAINT product_selection_group_assignments_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: product_variants product_variants_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_variants product_variants_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: product_variants product_variants_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: products products_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: products products_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: restaurant_order_equal_split_payments restaurant_order_equal_split_payments_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_split_payments
    ADD CONSTRAINT restaurant_order_equal_split_payments_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE RESTRICT;


--
-- Name: restaurant_order_equal_split_payments restaurant_order_equal_split_payments_split_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_split_payments
    ADD CONSTRAINT restaurant_order_equal_split_payments_split_fk FOREIGN KEY (split_id, tenant_id, venue_id) REFERENCES public.restaurant_order_equal_splits(id, tenant_id, venue_id) ON DELETE RESTRICT;


--
-- Name: restaurant_order_equal_split_payments restaurant_order_equal_split_payments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_split_payments
    ADD CONSTRAINT restaurant_order_equal_split_payments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: restaurant_order_equal_split_payments restaurant_order_equal_split_payments_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_split_payments
    ADD CONSTRAINT restaurant_order_equal_split_payments_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE RESTRICT;


--
-- Name: restaurant_order_equal_split_payments restaurant_order_equal_split_payments_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_split_payments
    ADD CONSTRAINT restaurant_order_equal_split_payments_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: restaurant_order_equal_splits restaurant_order_equal_splits_group_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_splits
    ADD CONSTRAINT restaurant_order_equal_splits_group_fk FOREIGN KEY (order_group_id, tenant_id, venue_id) REFERENCES public.order_groups(id, tenant_id, venue_id) ON DELETE RESTRICT;


--
-- Name: restaurant_order_equal_splits restaurant_order_equal_splits_order_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_splits
    ADD CONSTRAINT restaurant_order_equal_splits_order_fk FOREIGN KEY (order_id, tenant_id, venue_id) REFERENCES public.orders(id, tenant_id, venue_id) ON DELETE RESTRICT;


--
-- Name: restaurant_order_equal_splits restaurant_order_equal_splits_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_splits
    ADD CONSTRAINT restaurant_order_equal_splits_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: restaurant_order_equal_splits restaurant_order_equal_splits_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_order_equal_splits
    ADD CONSTRAINT restaurant_order_equal_splits_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: restaurant_tables restaurant_tables_area_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_tables
    ADD CONSTRAINT restaurant_tables_area_fk FOREIGN KEY (area_id, tenant_id, venue_id) REFERENCES public.dining_areas(id, tenant_id, venue_id) ON DELETE RESTRICT;


--
-- Name: restaurant_tables restaurant_tables_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_tables
    ADD CONSTRAINT restaurant_tables_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: restaurant_tables restaurant_tables_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_tables
    ADD CONSTRAINT restaurant_tables_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: sale_payments sale_payments_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payments
    ADD CONSTRAINT sale_payments_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: sale_payments sale_payments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payments
    ADD CONSTRAINT sale_payments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: sales sales_cash_register_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_cash_register_fk FOREIGN KEY (cash_register_id) REFERENCES public.cash_registers(id) ON DELETE RESTRICT;


--
-- Name: sales sales_cash_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_cash_session_id_fkey FOREIGN KEY (cash_session_id) REFERENCES public.cash_sessions(id) ON DELETE RESTRICT;


--
-- Name: sales sales_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE RESTRICT;


--
-- Name: sales sales_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: sales sales_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE RESTRICT;


--
-- Name: sales sales_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: sales sales_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: selection_group_options selection_group_options_group_id_tenant_id_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_group_options
    ADD CONSTRAINT selection_group_options_group_id_tenant_id_venue_id_fkey FOREIGN KEY (group_id, tenant_id, venue_id) REFERENCES public.selection_groups(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: selection_group_options selection_group_options_product_id_tenant_id_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_group_options
    ADD CONSTRAINT selection_group_options_product_id_tenant_id_venue_id_fkey FOREIGN KEY (product_id, tenant_id, venue_id) REFERENCES public.products(id, tenant_id, venue_id) ON DELETE CASCADE;


--
-- Name: selection_group_options selection_group_options_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_group_options
    ADD CONSTRAINT selection_group_options_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: selection_group_options selection_group_options_variant_id_product_id_tenant_id_ve_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_group_options
    ADD CONSTRAINT selection_group_options_variant_id_product_id_tenant_id_ve_fkey FOREIGN KEY (variant_id, product_id, tenant_id, venue_id) REFERENCES public.product_variants(id, product_id, tenant_id, venue_id) ON DELETE RESTRICT;


--
-- Name: selection_group_options selection_group_options_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_group_options
    ADD CONSTRAINT selection_group_options_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: selection_groups selection_groups_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_groups
    ADD CONSTRAINT selection_groups_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: selection_groups selection_groups_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selection_groups
    ADD CONSTRAINT selection_groups_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: tenant_memberships tenant_memberships_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_memberships
    ADD CONSTRAINT tenant_memberships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_memberships tenant_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_memberships
    ADD CONSTRAINT tenant_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ticket_line_components ticket_line_components_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_line_components
    ADD CONSTRAINT ticket_line_components_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_line_components ticket_line_components_ticket_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_line_components
    ADD CONSTRAINT ticket_line_components_ticket_line_id_fkey FOREIGN KEY (ticket_line_id) REFERENCES public.ticket_lines(id) ON DELETE CASCADE;


--
-- Name: ticket_lines ticket_lines_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_lines
    ADD CONSTRAINT ticket_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_lines ticket_lines_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_lines
    ADD CONSTRAINT ticket_lines_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: tickets tickets_cash_register_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_cash_register_fk FOREIGN KEY (cash_register_id) REFERENCES public.cash_registers(id) ON DELETE RESTRICT;


--
-- Name: tickets tickets_cash_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_cash_session_id_fkey FOREIGN KEY (cash_session_id) REFERENCES public.cash_sessions(id) ON DELETE RESTRICT;


--
-- Name: tickets tickets_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE RESTRICT;


--
-- Name: tickets tickets_discount_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_discount_id_fkey FOREIGN KEY (discount_id) REFERENCES public.discounts(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_equal_split_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_equal_split_fk FOREIGN KEY (equal_split_id) REFERENCES public.restaurant_order_equal_splits(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tickets tickets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: tickets tickets_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE RESTRICT;


--
-- Name: user_login_leases user_login_leases_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_login_leases
    ADD CONSTRAINT user_login_leases_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: venues venues_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cash_closing_print_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_closing_print_events ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_closing_print_events cash_closing_print_events_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cash_closing_print_events_select ON public.cash_closing_print_events FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR (EXISTS ( SELECT 1
   FROM public.cash_sessions cs
  WHERE ((cs.id = cash_closing_print_events.cash_closing_id) AND public.user_has_venue_access(cs.tenant_id, cs.venue_id))))));


--
-- Name: cash_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_movements cash_movements_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cash_movements_select ON public.cash_movements FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: cash_registers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_registers ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_registers cash_registers_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cash_registers_select ON public.cash_registers FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: cash_session_table_layouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_session_table_layouts ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_session_table_layouts cash_session_table_layouts_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cash_session_table_layouts_select ON public.cash_session_table_layouts FOR SELECT TO authenticated USING (public.user_has_venue_access(tenant_id, venue_id));


--
-- Name: cash_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_sessions cash_sessions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cash_sessions_select ON public.cash_sessions FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: catalog_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.catalog_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: catalog_audit_log catalog_audit_log_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_audit_log_select ON public.catalog_audit_log FOR SELECT TO authenticated USING (public.user_is_tenant_admin(tenant_id));


--
-- Name: catalog_placements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.catalog_placements ENABLE ROW LEVEL SECURITY;

--
-- Name: catalog_placements catalog_placements_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_placements_admin_manage ON public.catalog_placements TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: catalog_placements catalog_placements_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_placements_select ON public.catalog_placements FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: catalog_tab_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.catalog_tab_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: catalog_tab_categories catalog_tab_categories_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_tab_categories_manage ON public.catalog_tab_categories TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: catalog_tab_categories catalog_tab_categories_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_tab_categories_select ON public.catalog_tab_categories FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: catalog_tabs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.catalog_tabs ENABLE ROW LEVEL SECURITY;

--
-- Name: catalog_tabs catalog_tabs_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_tabs_admin_manage ON public.catalog_tabs TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: catalog_tabs catalog_tabs_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY catalog_tabs_select ON public.catalog_tabs FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

--
-- Name: categories categories_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_admin_manage ON public.categories TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: categories categories_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_select ON public.categories FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: device_user_assignments device_assignments_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY device_assignments_admin_manage ON public.device_user_assignments TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: device_user_assignments device_assignments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY device_assignments_select ON public.device_user_assignments FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR public.user_is_tenant_admin(tenant_id)));


--
-- Name: device_user_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_user_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

--
-- Name: devices devices_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY devices_admin_manage ON public.devices TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: devices devices_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY devices_select ON public.devices FOR SELECT TO authenticated USING (public.user_can_view_device(tenant_id, venue_id, id));


--
-- Name: dining_areas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dining_areas ENABLE ROW LEVEL SECURITY;

--
-- Name: dining_areas dining_areas_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dining_areas_admin_manage ON public.dining_areas TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: dining_areas dining_areas_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dining_areas_select ON public.dining_areas FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: discounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discounts ENABLE ROW LEVEL SECURITY;

--
-- Name: discounts discounts_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY discounts_admin_manage ON public.discounts TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: discounts discounts_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY discounts_select ON public.discounts FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR (is_active AND public.user_has_venue_access(tenant_id, venue_id))));


--
-- Name: tenant_memberships memberships_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_admin_all ON public.tenant_memberships USING (public.user_has_tenant_role(tenant_id, ARRAY['owner'::text, 'admin'::text])) WITH CHECK (public.user_has_tenant_role(tenant_id, ARRAY['owner'::text, 'admin'::text]));


--
-- Name: tenant_memberships memberships_self_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_self_select ON public.tenant_memberships FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: modifier_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modifier_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: modifier_groups modifier_groups_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY modifier_groups_admin_manage ON public.modifier_groups TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: modifier_groups modifier_groups_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY modifier_groups_select ON public.modifier_groups FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: modifiers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modifiers ENABLE ROW LEVEL SECURITY;

--
-- Name: modifiers modifiers_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY modifiers_admin_manage ON public.modifiers TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: modifiers modifiers_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY modifiers_select ON public.modifiers FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: offline_event_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.offline_event_log ENABLE ROW LEVEL SECURITY;

--
-- Name: offline_event_log offline_event_log_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY offline_event_log_insert ON public.offline_event_log FOR INSERT TO authenticated WITH CHECK (public.user_can_access_offline_event(tenant_id, event_kind, payload, false));


--
-- Name: offline_event_log offline_event_log_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY offline_event_log_select ON public.offline_event_log FOR SELECT TO authenticated USING (public.user_can_access_offline_event(tenant_id, event_kind, payload, true));


--
-- Name: order_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;

--
-- Name: order_events order_events_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_events_select ON public.order_events FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: order_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: order_groups order_groups_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_groups_select ON public.order_groups FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: order_line_components; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_line_components ENABLE ROW LEVEL SECURITY;

--
-- Name: order_line_components order_line_components_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_line_components_select ON public.order_line_components FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: order_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: order_lines order_lines_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_lines_select ON public.order_lines FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: order_tables; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_tables ENABLE ROW LEVEL SECURITY;

--
-- Name: order_tables order_tables_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_tables_select ON public.order_tables FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

--
-- Name: orders orders_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_select ON public.orders FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: product_images; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;

--
-- Name: product_images product_images_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_images_manage ON public.product_images TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: product_images product_images_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_images_select ON public.product_images FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: product_modifier_group_assignment_variants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_modifier_group_assignment_variants ENABLE ROW LEVEL SECURITY;

--
-- Name: product_modifier_group_assignment_variants product_modifier_group_assignment_variants_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_modifier_group_assignment_variants_manage ON public.product_modifier_group_assignment_variants TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: product_modifier_group_assignment_variants product_modifier_group_assignment_variants_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_modifier_group_assignment_variants_select ON public.product_modifier_group_assignment_variants FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: product_modifier_group_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_modifier_group_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: product_modifier_group_assignments product_modifier_group_assignments_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_modifier_group_assignments_manage ON public.product_modifier_group_assignments TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: product_modifier_group_assignments product_modifier_group_assignments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_modifier_group_assignments_select ON public.product_modifier_group_assignments FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: product_selection_group_assignment_variants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_selection_group_assignment_variants ENABLE ROW LEVEL SECURITY;

--
-- Name: product_selection_group_assignment_variants product_selection_group_assignment_variants_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_selection_group_assignment_variants_manage ON public.product_selection_group_assignment_variants TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: product_selection_group_assignment_variants product_selection_group_assignment_variants_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_selection_group_assignment_variants_select ON public.product_selection_group_assignment_variants FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: product_selection_group_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_selection_group_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: product_selection_group_assignments product_selection_group_assignments_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_selection_group_assignments_manage ON public.product_selection_group_assignments TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: product_selection_group_assignments product_selection_group_assignments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_selection_group_assignments_select ON public.product_selection_group_assignments FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: product_variants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;

--
-- Name: product_variants product_variants_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_variants_admin_manage ON public.product_variants TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: product_variants product_variants_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_variants_select ON public.product_variants FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_variants.product_id) AND (public.user_is_tenant_admin(p.tenant_id) OR public.user_has_venue_access(p.tenant_id, p.venue_id))))));


--
-- Name: products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

--
-- Name: products products_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY products_admin_manage ON public.products TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: products products_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY products_select ON public.products FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_self_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_self_select ON public.profiles FOR SELECT USING ((id = auth.uid()));


--
-- Name: restaurant_order_equal_split_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.restaurant_order_equal_split_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurant_order_equal_split_payments restaurant_order_equal_split_payments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY restaurant_order_equal_split_payments_select ON public.restaurant_order_equal_split_payments FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: restaurant_order_equal_splits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.restaurant_order_equal_splits ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurant_order_equal_splits restaurant_order_equal_splits_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY restaurant_order_equal_splits_select ON public.restaurant_order_equal_splits FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: restaurant_tables; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.restaurant_tables ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurant_tables restaurant_tables_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY restaurant_tables_admin_manage ON public.restaurant_tables TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: restaurant_tables restaurant_tables_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY restaurant_tables_select ON public.restaurant_tables FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: sale_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sale_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: sale_payments sale_payments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sale_payments_select ON public.sale_payments FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.sales s
  WHERE ((s.id = sale_payments.sale_id) AND (public.user_is_tenant_admin(s.tenant_id) OR public.user_has_venue_access(s.tenant_id, s.venue_id))))));


--
-- Name: sale_payments sale_payments_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sale_payments_write ON public.sale_payments TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.sales s
  WHERE ((s.id = sale_payments.sale_id) AND public.user_has_device_access(s.tenant_id, s.venue_id, s.device_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.sales s
  WHERE ((s.id = sale_payments.sale_id) AND public.user_has_device_access(s.tenant_id, s.venue_id, s.device_id)))));


--
-- Name: sales; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

--
-- Name: sales sales_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_delete ON public.sales FOR DELETE TO authenticated USING (public.user_has_device_access(tenant_id, venue_id, device_id));


--
-- Name: sales sales_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_insert ON public.sales FOR INSERT TO authenticated WITH CHECK ((public.user_has_device_access(tenant_id, venue_id, device_id) AND (user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: sales sales_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_select ON public.sales FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: sales sales_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sales_update ON public.sales FOR UPDATE TO authenticated USING (public.user_has_device_access(tenant_id, venue_id, device_id)) WITH CHECK (public.user_has_device_access(tenant_id, venue_id, device_id));


--
-- Name: selection_group_options; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.selection_group_options ENABLE ROW LEVEL SECURITY;

--
-- Name: selection_group_options selection_group_options_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY selection_group_options_manage ON public.selection_group_options TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: selection_group_options selection_group_options_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY selection_group_options_select ON public.selection_group_options FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: selection_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.selection_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: selection_groups selection_groups_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY selection_groups_admin_manage ON public.selection_groups TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: selection_groups selection_groups_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY selection_groups_select ON public.selection_groups FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: tenant_memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: tenants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

--
-- Name: tenants tenants_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenants_select_member ON public.tenants FOR SELECT USING (public.user_has_tenant_access(id));


--
-- Name: ticket_line_components; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_line_components ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_line_components ticket_line_components_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ticket_line_components_select ON public.ticket_line_components FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.ticket_lines tl
     JOIN public.tickets t ON ((t.id = tl.ticket_id)))
  WHERE ((tl.id = ticket_line_components.ticket_line_id) AND public.user_can_view_device(t.tenant_id, t.venue_id, t.device_id)))));


--
-- Name: ticket_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_lines ticket_lines_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ticket_lines_select ON public.ticket_lines FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.tickets t
  WHERE ((t.id = ticket_lines.ticket_id) AND (public.user_is_tenant_admin(t.tenant_id) OR public.user_has_venue_access(t.tenant_id, t.venue_id))))));


--
-- Name: ticket_lines ticket_lines_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ticket_lines_write ON public.ticket_lines TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.tickets t
  WHERE ((t.id = ticket_lines.ticket_id) AND public.user_has_device_access(t.tenant_id, t.venue_id, t.device_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.tickets t
  WHERE ((t.id = ticket_lines.ticket_id) AND public.user_has_device_access(t.tenant_id, t.venue_id, t.device_id)))));


--
-- Name: tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: tickets tickets_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tickets_delete ON public.tickets FOR DELETE TO authenticated USING (public.user_has_device_access(tenant_id, venue_id, device_id));


--
-- Name: tickets tickets_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tickets_insert ON public.tickets FOR INSERT TO authenticated WITH CHECK ((public.user_has_device_access(tenant_id, venue_id, device_id) AND (user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: tickets tickets_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tickets_select ON public.tickets FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR public.user_has_venue_access(tenant_id, venue_id)));


--
-- Name: tickets tickets_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tickets_update ON public.tickets FOR UPDATE TO authenticated USING (public.user_has_device_access(tenant_id, venue_id, device_id)) WITH CHECK (public.user_has_device_access(tenant_id, venue_id, device_id));


--
-- Name: user_login_leases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_login_leases ENABLE ROW LEVEL SECURITY;

--
-- Name: venues; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.venues ENABLE ROW LEVEL SECURITY;

--
-- Name: venues venues_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY venues_admin_manage ON public.venues TO authenticated USING (public.user_is_tenant_admin(tenant_id)) WITH CHECK (public.user_is_tenant_admin(tenant_id));


--
-- Name: venues venues_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY venues_select ON public.venues FOR SELECT TO authenticated USING ((public.user_is_tenant_admin(tenant_id) OR (EXISTS ( SELECT 1
   FROM public.device_user_assignments dua
  WHERE ((dua.tenant_id = venues.tenant_id) AND (dua.venue_id = venues.id) AND (dua.user_id = ( SELECT auth.uid() AS uid)) AND (dua.is_active = true))))));


--
-- Name: FUNCTION audit_restaurant_order_change(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.audit_restaurant_order_change() FROM PUBLIC;


--
-- Name: FUNCTION block_cash_close_with_open_restaurant_orders(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.block_cash_close_with_open_restaurant_orders() FROM PUBLIC;


--
-- Name: FUNCTION calculate_tax_from_gross(p_gross_cents integer, p_tax_rate numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.calculate_tax_from_gross(p_gross_cents integer, p_tax_rate numeric) FROM PUBLIC;


--
-- Name: FUNCTION cancel_empty_restaurant_order(p_order_id uuid, p_expected_revision integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cancel_empty_restaurant_order(p_order_id uuid, p_expected_revision integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_empty_restaurant_order(p_order_id uuid, p_expected_revision integer) TO authenticated;


--
-- Name: FUNCTION canonical_catalog_modifiers(p_venue_id uuid, p_product_id uuid, p_variant_id uuid, p_submitted jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.canonical_catalog_modifiers(p_venue_id uuid, p_product_id uuid, p_variant_id uuid, p_submitted jsonb) FROM PUBLIC;


--
-- Name: FUNCTION catalog_command(p_venue_id uuid, p_command text, p_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.catalog_command(p_venue_id uuid, p_command text, p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.catalog_command(p_venue_id uuid, p_command text, p_payload jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.catalog_command(p_venue_id uuid, p_command text, p_payload jsonb) TO service_role;


--
-- Name: FUNCTION catalog_command_batch(p_venue_id uuid, p_commands jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.catalog_command_batch(p_venue_id uuid, p_commands jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.catalog_command_batch(p_venue_id uuid, p_commands jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.catalog_command_batch(p_venue_id uuid, p_commands jsonb) TO service_role;


--
-- Name: FUNCTION catalog_export_ref(p_prefix text, p_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.catalog_export_ref(p_prefix text, p_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION catalog_image_command(p_venue_id uuid, p_action text, p_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.catalog_image_command(p_venue_id uuid, p_action text, p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.catalog_image_command(p_venue_id uuid, p_action text, p_payload jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.catalog_image_command(p_venue_id uuid, p_action text, p_payload jsonb) TO service_role;


--
-- Name: FUNCTION catalog_tab_category_command(p_venue_id uuid, p_action text, p_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.catalog_tab_category_command(p_venue_id uuid, p_action text, p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.catalog_tab_category_command(p_venue_id uuid, p_action text, p_payload jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.catalog_tab_category_command(p_venue_id uuid, p_action text, p_payload jsonb) TO service_role;


--
-- Name: FUNCTION check_user_login(p_client_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.check_user_login(p_client_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.check_user_login(p_client_id uuid) TO authenticated;


--
-- Name: FUNCTION claim_user_login(p_client_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_user_login(p_client_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_user_login(p_client_id uuid) TO authenticated;


--
-- Name: FUNCTION clear_closed_cash_session_table_layout(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.clear_closed_cash_session_table_layout() FROM PUBLIC;


--
-- Name: FUNCTION close_cash_register_session(p_cash_session_id uuid, p_device_id uuid, p_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.close_cash_register_session(p_cash_session_id uuid, p_device_id uuid, p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.close_cash_register_session(p_cash_session_id uuid, p_device_id uuid, p_payload jsonb) TO authenticated;


--
-- Name: FUNCTION close_order_and_create_sale(p_order_id uuid, p_payment_method text, p_received_cents integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.close_order_and_create_sale(p_order_id uuid, p_payment_method text, p_received_cents integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.close_order_and_create_sale(p_order_id uuid, p_payment_method text, p_received_cents integer) TO authenticated;


--
-- Name: FUNCTION close_order_and_create_sale_v2(p_order_id uuid, p_payment_method text, p_received_cents integer, p_discount jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.close_order_and_create_sale_v2(p_order_id uuid, p_payment_method text, p_received_cents integer, p_discount jsonb) FROM PUBLIC;


--
-- Name: FUNCTION close_restaurant_order_checked(p_order_id uuid, p_payment_method text, p_received_cents integer, p_allow_pending boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.close_restaurant_order_checked(p_order_id uuid, p_payment_method text, p_received_cents integer, p_allow_pending boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.close_restaurant_order_checked(p_order_id uuid, p_payment_method text, p_received_cents integer, p_allow_pending boolean) TO authenticated;


--
-- Name: FUNCTION close_restaurant_order_checked_v2(p_order_id uuid, p_payment_method text, p_received_cents integer, p_allow_pending boolean, p_discount jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.close_restaurant_order_checked_v2(p_order_id uuid, p_payment_method text, p_received_cents integer, p_allow_pending boolean, p_discount jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.close_restaurant_order_checked_v2(p_order_id uuid, p_payment_method text, p_received_cents integer, p_allow_pending boolean, p_discount jsonb) TO authenticated;


--
-- Name: FUNCTION configure_restaurant_order_equal_split(p_order_id uuid, p_part_count integer, p_expected_order_revision integer, p_default_discount jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.configure_restaurant_order_equal_split(p_order_id uuid, p_part_count integer, p_expected_order_revision integer, p_default_discount jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.configure_restaurant_order_equal_split(p_order_id uuid, p_part_count integer, p_expected_order_revision integer, p_default_discount jsonb) TO authenticated;


--
-- Name: TABLE cash_movements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.cash_movements TO authenticated;


--
-- Name: FUNCTION create_cash_movement(p_cash_session_id uuid, p_device_id uuid, p_movement_type text, p_amount_cents integer, p_notes text, p_request_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_cash_movement(p_cash_session_id uuid, p_device_id uuid, p_movement_type text, p_amount_cents integer, p_notes text, p_request_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_cash_movement(p_cash_session_id uuid, p_device_id uuid, p_movement_type text, p_amount_cents integer, p_notes text, p_request_id uuid) TO authenticated;


--
-- Name: FUNCTION export_catalog(p_venue_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.export_catalog(p_venue_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.export_catalog(p_venue_id uuid) TO service_role;


--
-- Name: FUNCTION force_claim_user_login(p_client_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.force_claim_user_login(p_client_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.force_claim_user_login(p_client_id uuid) TO authenticated;


--
-- Name: FUNCTION get_cash_session_table_layout(p_cash_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_cash_session_table_layout(p_cash_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_cash_session_table_layout(p_cash_session_id uuid) TO authenticated;


--
-- Name: FUNCTION get_catalog(p_venue_id uuid, p_mode text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_catalog(p_venue_id uuid, p_mode text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_catalog(p_venue_id uuid, p_mode text) TO authenticated;
GRANT ALL ON FUNCTION public.get_catalog(p_venue_id uuid, p_mode text) TO service_role;


--
-- Name: FUNCTION group_restaurant_tables(p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.group_restaurant_tables(p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.group_restaurant_tables(p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid) TO authenticated;


--
-- Name: FUNCTION guard_equal_split_order_close(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_equal_split_order_close() FROM PUBLIC;


--
-- Name: FUNCTION guard_paid_equal_split_order_lines(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_paid_equal_split_order_lines() FROM PUBLIC;


--
-- Name: FUNCTION heartbeat_user_login(p_client_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.heartbeat_user_login(p_client_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.heartbeat_user_login(p_client_id uuid) TO authenticated;


--
-- Name: FUNCTION import_catalog(p_venue_id uuid, p_mode text, p_plan jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.import_catalog(p_venue_id uuid, p_mode text, p_plan jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.import_catalog(p_venue_id uuid, p_mode text, p_plan jsonb) TO service_role;


--
-- Name: FUNCTION mark_order_fully_served(p_order_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_order_fully_served(p_order_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_order_fully_served(p_order_id uuid) TO authenticated;


--
-- Name: FUNCTION mark_order_line_fully_served(p_order_line_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_order_line_fully_served(p_order_line_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_order_line_fully_served(p_order_line_id uuid) TO authenticated;


--
-- Name: FUNCTION mark_order_line_units_served(p_order_line_id uuid, p_units integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_order_line_units_served(p_order_line_id uuid, p_units integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_order_line_units_served(p_order_line_id uuid, p_units integer) TO authenticated;


--
-- Name: FUNCTION move_restaurant_order(p_order_id uuid, p_target_table_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.move_restaurant_order(p_order_id uuid, p_target_table_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.move_restaurant_order(p_order_id uuid, p_target_table_id uuid) TO authenticated;


--
-- Name: FUNCTION move_restaurant_order_lines(p_source_order_id uuid, p_target_order_id uuid, p_expected_source_revision integer, p_expected_target_revision integer, p_moves jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.move_restaurant_order_lines(p_source_order_id uuid, p_target_order_id uuid, p_expected_source_revision integer, p_expected_target_revision integer, p_moves jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.move_restaurant_order_lines(p_source_order_id uuid, p_target_order_id uuid, p_expected_source_revision integer, p_expected_target_revision integer, p_moves jsonb) TO authenticated;


--
-- Name: FUNCTION open_cash_register_session(p_cash_register_id uuid, p_opening_float_cents integer, p_device_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.open_cash_register_session(p_cash_register_id uuid, p_opening_float_cents integer, p_device_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.open_cash_register_session(p_cash_register_id uuid, p_opening_float_cents integer, p_device_id uuid) TO authenticated;


--
-- Name: FUNCTION open_restaurant_order(p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.open_restaurant_order(p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.open_restaurant_order(p_table_ids uuid[], p_guest_count integer, p_cash_session_id uuid, p_device_id uuid) TO authenticated;


--
-- Name: FUNCTION pay_restaurant_order_equal_part(p_split_id uuid, p_payment_method text, p_received_cents integer, p_allow_pending boolean, p_discount jsonb, p_use_default_discount boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pay_restaurant_order_equal_part(p_split_id uuid, p_payment_method text, p_received_cents integer, p_allow_pending boolean, p_discount jsonb, p_use_default_discount boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.pay_restaurant_order_equal_part(p_split_id uuid, p_payment_method text, p_received_cents integer, p_allow_pending boolean, p_discount jsonb, p_use_default_discount boolean) TO authenticated;


--
-- Name: FUNCTION pay_restaurant_order_items(p_order_id uuid, p_expected_revision integer, p_items jsonb, p_payment_method text, p_received_cents integer, p_allow_pending boolean, p_discount jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pay_restaurant_order_items(p_order_id uuid, p_expected_revision integer, p_items jsonb, p_payment_method text, p_received_cents integer, p_allow_pending boolean, p_discount jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.pay_restaurant_order_items(p_order_id uuid, p_expected_revision integer, p_items jsonb, p_payment_method text, p_received_cents integer, p_allow_pending boolean, p_discount jsonb) TO authenticated;


--
-- Name: FUNCTION persist_catalog_order_line_draft(p_order_id uuid, p_expected_revision integer, p_lines jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.persist_catalog_order_line_draft(p_order_id uuid, p_expected_revision integer, p_lines jsonb) FROM PUBLIC;


--
-- Name: FUNCTION reconcile_cash_register_after_close(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reconcile_cash_register_after_close() FROM PUBLIC;


--
-- Name: FUNCTION reconcile_device_cash_register(target_device_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reconcile_device_cash_register(target_device_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION record_cash_closing_print_result(p_cash_closing_id uuid, p_terminal_id uuid, p_printer_id text, p_print_job_id text, p_request_id text, p_status text, p_error_code text, p_is_reprint boolean, p_copy_number integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_cash_closing_print_result(p_cash_closing_id uuid, p_terminal_id uuid, p_printer_id text, p_print_job_id text, p_request_id text, p_status text, p_error_code text, p_is_reprint boolean, p_copy_number integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_cash_closing_print_result(p_cash_closing_id uuid, p_terminal_id uuid, p_printer_id text, p_print_job_id text, p_request_id text, p_status text, p_error_code text, p_is_reprint boolean, p_copy_number integer) TO authenticated;


--
-- Name: FUNCTION record_restaurant_order_event(p_order_id uuid, p_event_type text, p_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_restaurant_order_event(p_order_id uuid, p_event_type text, p_payload jsonb) FROM PUBLIC;


--
-- Name: FUNCTION release_user_login(p_client_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_user_login(p_client_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_user_login(p_client_id uuid) TO authenticated;


--
-- Name: FUNCTION remove_restaurant_order_line(p_line_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.remove_restaurant_order_line(p_line_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.remove_restaurant_order_line(p_line_id uuid) TO authenticated;


--
-- Name: FUNCTION remove_restaurant_order_line_confirmed(p_line_id uuid, p_expected_revision integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.remove_restaurant_order_line_confirmed(p_line_id uuid, p_expected_revision integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.remove_restaurant_order_line_confirmed(p_line_id uuid, p_expected_revision integer) TO authenticated;


--
-- Name: FUNCTION resolve_effective_tax_rate(p_product_id uuid, p_tenant_id uuid, p_venue_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_effective_tax_rate(p_product_id uuid, p_tenant_id uuid, p_venue_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION resolve_ticket_discount(p_tenant_id uuid, p_venue_id uuid, p_subtotal_cents integer, p_discount jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_ticket_discount(p_tenant_id uuid, p_venue_id uuid, p_subtotal_cents integer, p_discount jsonb) FROM PUBLIC;


--
-- Name: TABLE restaurant_order_equal_splits; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.restaurant_order_equal_splits TO authenticated;


--
-- Name: FUNCTION restaurant_equal_split_to_json(p_split public.restaurant_order_equal_splits); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.restaurant_equal_split_to_json(p_split public.restaurant_order_equal_splits) FROM PUBLIC;


--
-- Name: FUNCTION save_cash_session_table_layout(p_cash_session_id uuid, p_expected_revision bigint, p_tables jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.save_cash_session_table_layout(p_cash_session_id uuid, p_expected_revision bigint, p_tables jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.save_cash_session_table_layout(p_cash_session_id uuid, p_expected_revision bigint, p_tables jsonb) TO authenticated;


--
-- Name: FUNCTION save_catalog_order_lines(p_order_id uuid, p_expected_revision integer, p_lines jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.save_catalog_order_lines(p_order_id uuid, p_expected_revision integer, p_lines jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.save_catalog_order_lines(p_order_id uuid, p_expected_revision integer, p_lines jsonb) TO authenticated;


--
-- Name: FUNCTION set_restaurant_order_line_quantity(p_line_id uuid, p_quantity integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_restaurant_order_line_quantity(p_line_id uuid, p_quantity integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_restaurant_order_line_quantity(p_line_id uuid, p_quantity integer) TO authenticated;


--
-- Name: FUNCTION set_ticket_discount_rounding_snapshot(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_ticket_discount_rounding_snapshot() FROM PUBLIC;


--
-- Name: FUNCTION set_ticket_line_fiscal_snapshot(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_ticket_line_fiscal_snapshot() FROM PUBLIC;


--
-- Name: FUNCTION set_venue_tables_enabled(p_venue_id uuid, p_enabled boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_venue_tables_enabled(p_venue_id uuid, p_enabled boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_venue_tables_enabled(p_venue_id uuid, p_enabled boolean) TO authenticated;


--
-- Name: FUNCTION sync_assignment_cash_register(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_assignment_cash_register() FROM PUBLIC;


--
-- Name: FUNCTION sync_device_cash_register(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_device_cash_register() FROM PUBLIC;


--
-- Name: FUNCTION sync_membership_cash_register(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_membership_cash_register() FROM PUBLIC;


--
-- Name: FUNCTION sync_sale_created(p_event_id uuid, p_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_sale_created(p_event_id uuid, p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_sale_created(p_event_id uuid, p_payload jsonb) TO authenticated;


--
-- Name: FUNCTION sync_sale_created_v2(p_event_id uuid, p_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_sale_created_v2(p_event_id uuid, p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_sale_created_v2(p_event_id uuid, p_payload jsonb) TO authenticated;


--
-- Name: FUNCTION user_can_access_offline_event(target_tenant uuid, event_kind_value text, event_payload jsonb, allow_admin boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_can_access_offline_event(target_tenant uuid, event_kind_value text, event_payload jsonb, allow_admin boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_can_access_offline_event(target_tenant uuid, event_kind_value text, event_payload jsonb, allow_admin boolean) TO authenticated;


--
-- Name: FUNCTION user_can_view_device(target_tenant uuid, target_venue uuid, target_device uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_can_view_device(target_tenant uuid, target_venue uuid, target_device uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_can_view_device(target_tenant uuid, target_venue uuid, target_device uuid) TO authenticated;


--
-- Name: FUNCTION user_has_device_access(target_tenant uuid, target_venue uuid, target_device uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_has_device_access(target_tenant uuid, target_venue uuid, target_device uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_has_device_access(target_tenant uuid, target_venue uuid, target_device uuid) TO authenticated;


--
-- Name: FUNCTION user_has_venue_access(target_tenant uuid, target_venue uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_has_venue_access(target_tenant uuid, target_venue uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_has_venue_access(target_tenant uuid, target_venue uuid) TO authenticated;


--
-- Name: FUNCTION user_is_superadmin(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_is_superadmin() FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_is_superadmin() TO authenticated;


--
-- Name: FUNCTION user_is_tenant_admin(target_tenant uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_is_tenant_admin(target_tenant uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_is_tenant_admin(target_tenant uuid) TO authenticated;


--
-- Name: FUNCTION validate_cash_session_table_layout_compactness(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_cash_session_table_layout_compactness() FROM PUBLIC;


--
-- Name: FUNCTION validate_cash_session_write(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_cash_session_write() FROM PUBLIC;


--
-- Name: FUNCTION validate_compact_joined_table_layout(p_tables jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_compact_joined_table_layout(p_tables jsonb) FROM PUBLIC;


--
-- Name: FUNCTION validate_device_user_assignment(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_device_user_assignment() FROM PUBLIC;


--
-- Name: FUNCTION validate_discount_scope(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_discount_scope() FROM PUBLIC;


--
-- Name: FUNCTION validate_product_venue(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_product_venue() FROM PUBLIC;


--
-- Name: FUNCTION validate_ticket_line_product_venue(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_ticket_line_product_venue() FROM PUBLIC;


--
-- Name: FUNCTION validate_transaction_actor_and_cash(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_transaction_actor_and_cash() FROM PUBLIC;


--
-- Name: TABLE cash_registers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.cash_registers TO authenticated;


--
-- Name: TABLE cash_session_table_layouts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.cash_session_table_layouts TO authenticated;


--
-- Name: TABLE catalog_audit_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.catalog_audit_log TO authenticated;


--
-- Name: TABLE catalog_placements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.catalog_placements TO authenticated;


--
-- Name: TABLE catalog_tab_categories; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.catalog_tab_categories TO authenticated;


--
-- Name: TABLE catalog_tabs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.catalog_tabs TO authenticated;


--
-- Name: TABLE categories; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.categories TO authenticated;


--
-- Name: TABLE dining_areas; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.dining_areas TO authenticated;


--
-- Name: TABLE modifier_groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.modifier_groups TO authenticated;


--
-- Name: TABLE modifiers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.modifiers TO authenticated;


--
-- Name: TABLE order_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.order_events TO authenticated;


--
-- Name: TABLE order_groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.order_groups TO authenticated;


--
-- Name: TABLE order_line_components; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.order_line_components TO authenticated;


--
-- Name: TABLE order_lines; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.order_lines TO authenticated;


--
-- Name: TABLE order_tables; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.order_tables TO authenticated;


--
-- Name: TABLE orders; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.orders TO authenticated;


--
-- Name: TABLE product_images; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.product_images TO authenticated;


--
-- Name: TABLE product_modifier_group_assignment_variants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.product_modifier_group_assignment_variants TO authenticated;


--
-- Name: TABLE product_modifier_group_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.product_modifier_group_assignments TO authenticated;


--
-- Name: TABLE product_selection_group_assignment_variants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.product_selection_group_assignment_variants TO authenticated;


--
-- Name: TABLE product_selection_group_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.product_selection_group_assignments TO authenticated;


--
-- Name: TABLE product_variants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.product_variants TO authenticated;


--
-- Name: TABLE products; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.products TO authenticated;


--
-- Name: TABLE restaurant_order_equal_split_payments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.restaurant_order_equal_split_payments TO authenticated;


--
-- Name: TABLE restaurant_tables; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.restaurant_tables TO authenticated;


--
-- Name: TABLE selection_group_options; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.selection_group_options TO authenticated;


--
-- Name: TABLE selection_groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.selection_groups TO authenticated;


--
-- Name: TABLE ticket_line_components; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.ticket_line_components TO authenticated;


--
-- Supabase Storage: final product image bucket and tenant-admin policies.
-- These objects live outside public and are therefore not emitted by the
-- public-only schema dump above.
--

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('product-images', 'product-images', true, 1048576, ARRAY['image/webp'])
ON CONFLICT (id) DO UPDATE
SET public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

DROP POLICY IF EXISTS product_images_public_read ON storage.objects;
DROP POLICY IF EXISTS product_images_tenant_select ON storage.objects;
DROP POLICY IF EXISTS product_images_tenant_insert ON storage.objects;
DROP POLICY IF EXISTS product_images_tenant_update ON storage.objects;
DROP POLICY IF EXISTS product_images_tenant_delete ON storage.objects;

CREATE POLICY product_images_tenant_select ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'product-images'
  AND public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);
CREATE POLICY product_images_tenant_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'product-images'
  AND public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);
CREATE POLICY product_images_tenant_update ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'product-images'
  AND public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
)
WITH CHECK (
  bucket_id = 'product-images'
  AND public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);
CREATE POLICY product_images_tenant_delete ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'product-images'
  AND public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);

--
-- PostgreSQL database dump complete
--
