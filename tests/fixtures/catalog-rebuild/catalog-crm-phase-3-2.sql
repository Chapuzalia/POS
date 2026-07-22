begin;
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_venue uuid;
  v_tenant uuid;
  v_tab uuid := gen_random_uuid();
  v_category uuid := gen_random_uuid();
  v_product uuid := gen_random_uuid();
  v_product_2 uuid := gen_random_uuid();
  v_variant uuid := gen_random_uuid();
  v_variant_2 uuid := gen_random_uuid();
  v_placement uuid := gen_random_uuid();
  v_group uuid := gen_random_uuid();
  v_option uuid := gen_random_uuid();
  v_result jsonb;
  v_path text;
begin
  select id, tenant_id into v_venue, v_tenant from public.venues order by created_at limit 1;
  if v_venue is null then raise exception 'PHASE32_VENUE_MISSING'; end if;

  perform public.catalog_command_batch(v_venue, jsonb_build_array(
    jsonb_build_object('command', 'save_tab', 'payload', jsonb_build_object(
      'id', v_tab, 'key', 'fase_32', 'label', 'Fase 3.2', 'icon', 'receipt', 'active', true, 'sortOrder', 9990
    )),
    jsonb_build_object('command', 'save_category', 'payload', jsonb_build_object(
      'id', v_category, 'name', 'Categoría Fase 3.2', 'active', true, 'unused', false, 'sortOrder', 9990
    )),
    jsonb_build_object('command', 'save_tab_category', 'payload', jsonb_build_object(
      'id', gen_random_uuid(), 'tabId', v_tab, 'categoryId', v_category, 'active', true, 'sortOrder', 0
    )),
    jsonb_build_object('command', 'create_product', 'payload', jsonb_build_object(
      'id', v_product, 'type', 'menu', 'name', 'Menú CRM Fase 3.2', 'vatRate', 10,
      'active', true, 'sortOrder', 9990,
      'variants', jsonb_build_array(
        jsonb_build_object('id', v_variant, 'name', 'Mediodía', 'priceCents', 1500, 'active', true, 'isDefault', true, 'sortOrder', 0),
        jsonb_build_object('id', v_variant_2, 'name', 'Noche', 'priceCents', 2200, 'active', true, 'isDefault', false, 'sortOrder', 10)
      )
    )),
    jsonb_build_object('command', 'create_placement', 'payload', jsonb_build_object(
      'id', v_placement, 'productId', v_product, 'tabId', v_tab, 'categoryId', v_category,
      'pinnedVariantId', v_variant, 'featured', true, 'active', true, 'sortOrder', 0
    )),
    jsonb_build_object('command', 'create_product', 'payload', jsonb_build_object(
      'id', v_product_2, 'type', 'standard', 'name', 'Interno CRM Fase 3.2', 'vatRate', 10,
      'active', true, 'sortOrder', 10000,
      'variants', jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid(), 'name', 'Normal', 'priceCents', 100, 'active', true, 'isDefault', true, 'sortOrder', 0
      ))
    )),
    jsonb_build_object('command', 'save_selection_group', 'payload', jsonb_build_object(
      'id', v_group, 'name', 'Primeros', 'type', 'menu_component', 'active', true, 'sortOrder', 0
    )),
    jsonb_build_object('command', 'save_selection_option', 'payload', jsonb_build_object(
      'id', v_option, 'groupId', v_group, 'productId', v_product_2, 'supplementCents', -50,
      'defaultQuantity', 0, 'maxQuantity', 1, 'active', true, 'sortOrder', 0
    )),
    jsonb_build_object('command', 'save_assignment', 'payload', jsonb_build_object(
      'id', gen_random_uuid(), 'domain', 'selection', 'productId', v_product, 'groupId', v_group,
      'minSelection', 1, 'maxSelection', 1, 'appliesToAllVariants', false,
      'variantIds', jsonb_build_array(v_variant), 'active', true, 'sortOrder', 0
    ))
  ));

  v_result := public.get_catalog(v_venue, 'admin');
  if not exists (
    select 1 from jsonb_array_elements(v_result -> 'products') item
    where item ->> 'id' = v_product::text and item ->> 'product_type' = 'menu'
  ) then raise exception 'PHASE32_PRODUCT_BATCH_FAILED'; end if;
  if not exists (
    select 1 from jsonb_array_elements(v_result -> 'selection_options') item
    where item ->> 'id' = v_option::text and (item ->> 'supplement_cents')::integer = -50
  ) then raise exception 'PHASE32_NEGATIVE_SUPPLEMENT_FAILED'; end if;

  v_path := v_tenant::text || '/' || v_venue::text || '/products/shared-phase-32.webp';
  perform public.catalog_image_command(v_venue, 'save', jsonb_build_object(
    'id', gen_random_uuid(), 'productId', v_product, 'storagePath', v_path,
    'mimeType', 'image/webp', 'sizeBytes', 100, 'sha256', repeat('0', 64)
  ));
  perform public.catalog_image_command(v_venue, 'save', jsonb_build_object(
    'id', gen_random_uuid(), 'productId', v_product_2, 'storagePath', v_path,
    'mimeType', 'image/webp', 'sizeBytes', 100, 'sha256', repeat('1', 64)
  ));
  v_result := public.catalog_image_command(v_venue, 'delete', jsonb_build_object('productId', v_product));
  if jsonb_array_length(v_result -> 'orphanedImagePaths') <> 0 then
    raise exception 'PHASE32_SHARED_IMAGE_REMOVED_TOO_EARLY';
  end if;
  v_result := public.catalog_image_command(v_venue, 'delete', jsonb_build_object('productId', v_product_2));
  if v_result -> 'orphanedImagePaths' ->> 0 <> v_path then
    raise exception 'PHASE32_ORPHAN_IMAGE_NOT_RETURNED';
  end if;

  raise notice 'PHASE32_ISOLATED_OK';
end;
$$;

rollback;
