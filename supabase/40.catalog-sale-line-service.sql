begin;

create or replace function public.save_catalog_order_lines(
  p_order_id uuid,
  p_expected_revision integer,
  p_lines jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  v_result := public.save_restaurant_order_lines(p_order_id, p_expected_revision, v_base_lines);

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

revoke all on function public.save_catalog_order_lines(uuid, integer, jsonb) from public, anon;
grant execute on function public.save_catalog_order_lines(uuid, integer, jsonb) to authenticated;
comment on function public.save_catalog_order_lines(uuid, integer, jsonb) is
  'Definitive order-line command using final selection and modifier assignments. Historical snapshots remain independent of live catalogue rows.';

commit;
