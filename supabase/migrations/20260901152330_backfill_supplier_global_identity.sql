-- A supplier identity is useful independently of whether an AI-proposed parser
-- is safe enough to become shared knowledge. Backfill documents created before
-- those two concerns were separated, using only exact normalized identities.

do $$
declare
  v_supplier record;
  v_global_supplier_id uuid;
  v_tax_id text;
  v_name_key text;
begin
  for v_supplier in
    select id, name, tax_id
    from public.suppliers
    where global_supplier_id is null
    order by created_at, id
    for update
  loop
    v_tax_id := nullif(upper(regexp_replace(coalesce(v_supplier.tax_id, ''), '[^A-Za-z0-9]', '', 'g')), '');
    if char_length(coalesce(v_tax_id, '')) < 6 then
      v_tax_id := null;
    end if;
    v_name_key := lower(regexp_replace(btrim(v_supplier.name), '[^[:alnum:]]+', '', 'g'));
    v_global_supplier_id := null;

    if v_tax_id is not null then
      select id into v_global_supplier_id
      from public.global_suppliers
      where upper(regexp_replace(coalesce(tax_id, ''), '[^A-Za-z0-9]', '', 'g')) = v_tax_id
      order by created_at, id
      limit 1;
    end if;

    if v_global_supplier_id is null then
      select id into v_global_supplier_id
      from public.global_suppliers
      where lower(regexp_replace(btrim(name), '[^[:alnum:]]+', '', 'g')) = v_name_key
        and not (
          v_tax_id is not null
          and nullif(regexp_replace(coalesce(tax_id, ''), '[^A-Za-z0-9]', '', 'g'), '') is not null
          and upper(regexp_replace(tax_id, '[^A-Za-z0-9]', '', 'g')) <> v_tax_id
        )
      order by created_at, id
      limit 1;
    end if;

    if v_global_supplier_id is null then
      insert into public.global_suppliers (name, tax_id)
      values (v_supplier.name, v_tax_id)
      returning id into v_global_supplier_id;
    end if;

    update public.suppliers
    set global_supplier_id = v_global_supplier_id,
        updated_at = now()
    where id = v_supplier.id;
  end loop;

  update public.supplier_documents as document
  set global_supplier_id = supplier.global_supplier_id,
      updated_at = now()
  from public.suppliers as supplier
  where document.supplier_id = supplier.id
    and document.tenant_id = supplier.tenant_id
    and document.global_supplier_id is null
    and supplier.global_supplier_id is not null;
end
$$;

-- Repair the five Coca-Cola delivery notes whose issuer was alternately read as
-- the delivery recipient. The hashes make this correction a no-op everywhere
-- except for the exact documents reviewed with this change.
do $$
declare
  v_tenant_id uuid;
  v_global_supplier_id uuid;
  v_local_supplier_id uuid;
  v_obsolete_global_ids uuid[];
begin
  select tenant_id into v_tenant_id
  from public.supplier_documents
  where lower(file_hash) in (
    '24e53288659e0baa08a67a71ca877050f9f3a8c7220960763abd6c38679f93cf',
    'b60f236861911ff5463326933a71d461ba95d1b06d533c7f1c249acec95ffb11',
    'd8fb51f37fe82154fa34e4f6af2631ee2bf8008699cef216c2a88028bc844ca1',
    '40fd16347cf30d0a81f4805f628189b0b50f29c59a4e0c6912f60a6f02ba9c7d',
    'fea0f39ad0af06e3c99861c94764ff87e27276710afa7bbbd5bae288ee97acc1'
  )
  group by tenant_id
  order by count(*) desc
  limit 1;

  if v_tenant_id is null then
    return;
  end if;

  select id into v_global_supplier_id
  from public.global_suppliers
  where lower(regexp_replace(name, '[^[:alnum:]]+', '', 'g')) like '%cocacolaeuropacificpartners%'
  order by created_at, id
  limit 1;

  if v_global_supplier_id is null then
    insert into public.global_suppliers (name, tax_id)
    values ('Coca-Cola Europacific Partners', null)
    returning id into v_global_supplier_id;
  end if;

  select id into v_local_supplier_id
  from public.suppliers
  where tenant_id = v_tenant_id
    and lower(regexp_replace(name, '[^[:alnum:]]+', '', 'g')) like '%cocacolaeuropacificpartners%'
  order by created_at, id
  limit 1;

  if v_local_supplier_id is null then
    insert into public.suppliers (tenant_id, global_supplier_id, name, tax_id)
    values (v_tenant_id, v_global_supplier_id, 'Coca-Cola Europacific Partners', null)
    returning id into v_local_supplier_id;
  else
    update public.suppliers
    set global_supplier_id = v_global_supplier_id,
        updated_at = now()
    where id = v_local_supplier_id;
  end if;

  with learned_aliases as (
    select
      document.tenant_id,
      document.venue_id,
      alias.alias_type,
      alias.alias_value,
      line.inventory_item_id,
      jsonb_build_object(
        'packageCount', line.package_count,
        'unitQuantity', line.package_unit_quantity,
        'unitSymbol', line.package_unit_symbol
      ) as packaging_json,
      line.updated_at
    from public.supplier_documents as document
    join public.supplier_document_lines as line
      on line.supplier_document_id = document.id
     and line.tenant_id = document.tenant_id
     and line.venue_id = document.venue_id
    cross join lateral (values
      ('ean'::text, nullif(regexp_replace(lower(btrim(line.barcode)), '[^0-9a-z]+', '', 'g'), '')),
      ('supplier_reference'::text, nullif(lower(btrim(line.supplier_reference)), '')),
      ('description'::text, nullif(lower(btrim(line.description_normalized)), ''))
    ) as alias(alias_type, alias_value)
    where lower(document.file_hash) in (
      '24e53288659e0baa08a67a71ca877050f9f3a8c7220960763abd6c38679f93cf',
      'b60f236861911ff5463326933a71d461ba95d1b06d533c7f1c249acec95ffb11',
      'd8fb51f37fe82154fa34e4f6af2631ee2bf8008699cef216c2a88028bc844ca1',
      '40fd16347cf30d0a81f4805f628189b0b50f29c59a4e0c6912f60a6f02ba9c7d',
      'fea0f39ad0af06e3c99861c94764ff87e27276710afa7bbbd5bae288ee97acc1'
    )
      and document.tenant_id = v_tenant_id
      and line.inventory_item_id is not null
      and alias.alias_value is not null
  ), deduplicated_aliases as (
    select distinct on (tenant_id, venue_id, alias_type, alias_value)
      tenant_id, venue_id, alias_type, alias_value, inventory_item_id, packaging_json
    from learned_aliases
    order by tenant_id, venue_id, alias_type, alias_value, updated_at desc
  )
  insert into public.supplier_item_aliases (
    tenant_id, venue_id, supplier_id, alias_type, alias_value,
    inventory_item_id, packaging_json
  )
  select
    tenant_id, venue_id, v_local_supplier_id, alias_type, alias_value,
    inventory_item_id, packaging_json
  from deduplicated_aliases
  on conflict (tenant_id, venue_id, supplier_id, alias_type, alias_value)
  do update set
    inventory_item_id = excluded.inventory_item_id,
    packaging_json = excluded.packaging_json,
    last_confirmed_at = now(),
    updated_at = now();

  update public.supplier_documents
  set supplier_id = v_local_supplier_id,
      global_supplier_id = v_global_supplier_id,
      updated_at = now()
  where tenant_id = v_tenant_id
    and lower(file_hash) in (
      '24e53288659e0baa08a67a71ca877050f9f3a8c7220960763abd6c38679f93cf',
      'b60f236861911ff5463326933a71d461ba95d1b06d533c7f1c249acec95ffb11',
      'd8fb51f37fe82154fa34e4f6af2631ee2bf8008699cef216c2a88028bc844ca1',
      '40fd16347cf30d0a81f4805f628189b0b50f29c59a4e0c6912f60a6f02ba9c7d',
      'fea0f39ad0af06e3c99861c94764ff87e27276710afa7bbbd5bae288ee97acc1'
    );

  select array_agg(distinct global_supplier_id) into v_obsolete_global_ids
  from public.suppliers
  where tenant_id = v_tenant_id
    and id in (
      '8d717d2e-bdf6-4315-8735-a55d24c0fead'::uuid,
      'ac322cb9-f2ba-4d47-a439-d3dfa01c19b7'::uuid
    )
    and id <> v_local_supplier_id
    and global_supplier_id is not null;

  delete from public.suppliers as supplier
  where supplier.tenant_id = v_tenant_id
    and supplier.id in (
      '8d717d2e-bdf6-4315-8735-a55d24c0fead'::uuid,
      'ac322cb9-f2ba-4d47-a439-d3dfa01c19b7'::uuid
    )
    and supplier.id <> v_local_supplier_id
    and not exists (
      select 1 from public.supplier_documents as document
      where document.supplier_id = supplier.id
    );

  delete from public.global_suppliers as global_supplier
  where global_supplier.id = any(coalesce(v_obsolete_global_ids, array[]::uuid[]))
    and global_supplier.id <> v_global_supplier_id
    and not exists (
      select 1 from public.suppliers as supplier
      where supplier.global_supplier_id = global_supplier.id
    )
    and not exists (
      select 1 from public.supplier_documents as document
      where document.global_supplier_id = global_supplier.id
    )
    and not exists (
      select 1 from public.global_supplier_document_profiles as profile
      where profile.global_supplier_id = global_supplier.id
    );
end
$$;
