\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_venue constant uuid := '11111111-1111-4111-8111-111111111111';
  v_other_venue constant uuid := '22222222-2222-4222-8222-222222222222';
  v_product uuid;
  v_other_product uuid;
  v_variant uuid;
  v_second_variant uuid;
  v_tab uuid;
  v_category uuid;
  v_placement uuid;
  v_ticket_line uuid;
  v_order_line uuid;
  v_order_revision integer;
  v_before integer;
  v_result jsonb;
begin
  if jsonb_array_length(public.get_catalog(v_venue, 'admin') -> 'products') <> 116 then
    raise exception 'PHASE31_ADMIN_READ_COUNT';
  end if;
  if exists (
    select 1 from jsonb_array_elements(public.get_catalog(v_venue, 'admin') -> 'products') row
    where row ->> 'venue_id' <> v_venue::text
  ) then raise exception 'PHASE31_READ_SCOPE'; end if;

  select count(*) into v_before from public.products where venue_id = v_venue;
  v_result := public.catalog_command(v_venue, 'create_product', jsonb_build_object(
    'type', 'standard', 'name', 'Phase 3.1 isolated', 'description', 'transactional',
    'vatRate', 21, 'active', true, 'sortOrder', 999,
    'variants', jsonb_build_array(
      jsonb_build_object('name', 'Default', 'priceCents', 1000, 'isDefault', true, 'active', true, 'sortOrder', 0),
      jsonb_build_object('name', 'Alternative', 'priceCents', 1200, 'isDefault', false, 'active', true, 'sortOrder', 10)
    )
  ));
  v_product := (v_result ->> 'id')::uuid;
  select id into v_variant from public.product_variants where product_id = v_product and is_default;
  select id into v_second_variant from public.product_variants where product_id = v_product and id <> v_variant;
  if (select count(*) from public.products where venue_id = v_venue) <> v_before + 1 then
    raise exception 'PHASE31_CREATE_PRODUCT';
  end if;

  perform public.catalog_command(v_venue, 'set_default_variant', jsonb_build_object('productId', v_product, 'variantId', v_second_variant));
  if not exists (select 1 from public.product_variants where id = v_second_variant and is_default and is_active) then
    raise exception 'PHASE31_SET_DEFAULT';
  end if;

  begin
    perform public.catalog_command(v_venue, 'delete_variant', jsonb_build_object('productId', v_product, 'id', v_second_variant));
    raise exception 'PHASE31_DEFAULT_DELETE_NOT_REJECTED';
  exception when others then
    if sqlerrm not like '%CATALOG_DEFAULT_VARIANT_REQUIRES_REPLACEMENT%' then raise; end if;
  end;

  select id into v_tab from public.catalog_tabs where venue_id = v_venue order by sort_order, id limit 1;
  select id into v_category from public.categories where venue_id = v_venue order by sort_order, id limit 1;
  v_result := public.catalog_command(v_venue, 'create_placement', jsonb_build_object(
    'productId', v_product, 'tabId', v_tab, 'categoryId', v_category,
    'pinnedVariantId', v_second_variant, 'featured', true, 'active', true, 'sortOrder', 999
  ));
  v_placement := (v_result ->> 'id')::uuid;
  if not exists (select 1 from public.catalog_placements where id = v_placement and variant_id = v_second_variant) then
    raise exception 'PHASE31_CREATE_PLACEMENT';
  end if;

  perform public.catalog_command(v_venue, 'reorder', jsonb_build_object(
    'entity', 'placements', 'items', jsonb_build_array(jsonb_build_object('id', v_placement, 'sortOrder', 321))
  ));
  if (select sort_order from public.catalog_placements where id = v_placement) <> 321 then
    raise exception 'PHASE31_REORDER';
  end if;

  select ol.id, o.revision into v_order_line, v_order_revision
    from public.orders o join public.order_lines ol on ol.order_id = o.id
    where o.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid limit 1;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
  v_result := public.save_catalog_order_lines(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid, v_order_revision,
    jsonb_build_array(jsonb_build_object(
      'id', v_order_line, 'productId', v_product, 'variantId', v_second_variant,
      'modifierIds', '[]'::jsonb, 'components', '[]'::jsonb,
      'catalogSnapshot', jsonb_build_object('catalogTabId', v_tab, 'categoryId', v_category),
      'quantity', 1, 'note', null
    ))
  );
  if (select unit_price_cents from public.order_lines where id = v_order_line) <> 1200 then
    raise exception 'PHASE31_SALE_LINE_PRICE';
  end if;
  if jsonb_array_length(v_result -> 'lines') <> 1 then raise exception 'PHASE31_SALE_LINE_RESULT'; end if;
  perform set_config('request.jwt.claim.role', 'service_role', true);

  v_result := public.catalog_command(v_other_venue, 'create_product', jsonb_build_object(
    'type', 'standard', 'name', 'Other venue', 'vatRate', 21, 'active', true, 'sortOrder', 0,
    'variants', jsonb_build_array(jsonb_build_object('name', 'Default', 'priceCents', 100, 'isDefault', true, 'active', true, 'sortOrder', 0))
  ));
  v_other_product := (v_result ->> 'id')::uuid;
  begin
    perform public.catalog_command(v_venue, 'create_placement', jsonb_build_object(
      'productId', v_other_product, 'tabId', v_tab, 'categoryId', v_category,
      'pinnedVariantId', null, 'featured', false, 'active', true, 'sortOrder', 0
    ));
    raise exception 'PHASE31_CROSS_VENUE_NOT_REJECTED';
  exception when others then
    if sqlerrm not like '%PLACEMENT_PRODUCT_SCOPE_MISMATCH%' then raise; end if;
  end;

  select count(*) into v_before from public.products where venue_id = v_venue;
  begin
    perform public.catalog_command(v_venue, 'create_product', jsonb_build_object(
      'type', 'standard', 'name', 'Invalid defaults', 'vatRate', 21, 'active', true, 'sortOrder', 0,
      'variants', jsonb_build_array(
        jsonb_build_object('name', 'A', 'priceCents', 100, 'isDefault', true, 'active', true, 'sortOrder', 0),
        jsonb_build_object('name', 'B', 'priceCents', 100, 'isDefault', true, 'active', true, 'sortOrder', 1)
      )
    ));
    raise exception 'PHASE31_INVALID_COMPOSITE_NOT_REJECTED';
  exception when others then
    if sqlerrm not like '%INVALID_ACTIVE_DEFAULT_VARIANT_COUNT%' then raise; end if;
  end;
  if (select count(*) from public.products where venue_id = v_venue) <> v_before then
    raise exception 'PHASE31_COMPOSITE_ROLLBACK';
  end if;

  select id into v_ticket_line from public.ticket_lines limit 1;
  if v_ticket_line is null then raise exception 'PHASE31_TICKET_FIXTURE_MISSING'; end if;
  update public.ticket_lines set product_id = v_product, variant_id = v_second_variant,
    product_name = 'Phase 3.1 historical snapshot' where id = v_ticket_line;
  perform public.catalog_command(v_venue, 'delete_product', jsonb_build_object('id', v_product));
  if not exists (select 1 from public.ticket_lines where id = v_ticket_line and product_id = v_product and product_name = 'Phase 3.1 historical snapshot') then
    raise exception 'PHASE31_HISTORY_BROKEN';
  end if;

  raise notice 'PHASE31_ISOLATED_OK';
end;
$$;

rollback;
