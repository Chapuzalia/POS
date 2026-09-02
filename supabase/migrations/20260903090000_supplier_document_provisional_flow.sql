-- Prepared only: supplier selection/creation and cached-OCR line reparsing.
-- The existing confirmation implementation (stock, costs and links) is reused unchanged.
alter table public.supplier_documents add column ocr_snapshot jsonb;
alter table public.suppliers
  add column legal_name text,
  add column email text,
  add column phone text,
  add column address text;

create function public.supplier_document_grounded_value(p_metadata jsonb, p_ocr jsonb, p_field text)
returns text language sql immutable set search_path to '' as $$
  select case when p_metadata #>> '{supplierExtraction,groundingVersion}' = '1'
    and nullif(btrim(p_metadata #>> array['supplierExtraction', p_field, 'value']), '') is not null
    and nullif(btrim(p_metadata #>> array['supplierExtraction', p_field, 'evidence']), '') is not null
    and exists (
      select 1 from jsonb_path_query(coalesce(p_ocr, '{}'::jsonb), '$.**.text') fragment
      where position((p_metadata #>> array['supplierExtraction', p_field, 'evidence']) in (fragment #>> '{}')) > 0
    )
    then p_metadata #>> array['supplierExtraction', p_field, 'value'] else null end;
$$;
revoke all on function public.supplier_document_grounded_value(jsonb, jsonb, text) from public, anon, authenticated;

create function public.learn_confirmed_supplier_document_identities(p_document_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_supplier public.suppliers%rowtype;
  v_identity jsonb;
  v_tax text;
begin
  select * into strict v_document from public.supplier_documents where id = p_document_id;
  if v_document.status <> 'confirmed' or v_document.supplier_id is null then return; end if;
  select * into strict v_supplier from public.suppliers where id = v_document.supplier_id;
  v_tax := public.supplier_document_grounded_value(v_document.extraction_metadata, v_document.ocr_snapshot, 'taxId');
  -- A manual selection does not authorize teaching a contradictory tax identity.
  if v_tax is not null and v_supplier.tax_id is not null
    and upper(regexp_replace(v_tax, '[^A-Za-z0-9]', '', 'g'))
      <> upper(regexp_replace(v_supplier.tax_id, '[^A-Za-z0-9]', '', 'g')) then return; end if;
  if v_document.extraction_metadata #>> '{supplierExtraction,groundingVersion}' is distinct from '1' then return; end if;
  for v_identity in select value from jsonb_array_elements(coalesce(v_document.extraction_metadata #> '{supplierExtraction,identities}', '[]'::jsonb)) loop
    if v_identity ->> 'type' not in ('tax_id', 'email', 'email_domain', 'phone', 'name', 'address')
      or nullif(btrim(v_identity ->> 'normalizedValue'), '') is null
      or char_length(v_identity ->> 'normalizedValue') > 500
      or nullif(v_identity ->> 'evidence', '') is null
      or not exists (
        select 1 from jsonb_path_query(coalesce(v_document.ocr_snapshot, '{}'::jsonb), '$.**.text') fragment
        where position((v_identity ->> 'evidence') in (fragment #>> '{}')) > 0
      ) then continue; end if;
    insert into public.supplier_identity_aliases (
      tenant_id, venue_id, supplier_id, identity_type, normalized_value, source, confirmed_by
    ) values (
      v_document.tenant_id, v_document.venue_id, v_supplier.id,
      v_identity ->> 'type', v_identity ->> 'normalizedValue', 'user_confirmed', auth.uid()
    ) on conflict (tenant_id, venue_id, identity_type, normalized_value)
    do update set source = 'user_confirmed', confirmed_by = excluded.confirmed_by, updated_at = now()
    where public.supplier_identity_aliases.supplier_id = excluded.supplier_id;
    -- Conflicting identities are never reassigned or deleted silently.
  end loop;
end;
$$;
revoke all on function public.learn_confirmed_supplier_document_identities(uuid) from public, anon, authenticated;

create or replace function public.update_supplier_document_supplier(p_document_id uuid, p_supplier_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_supplier public.suppliers%rowtype;
  v_name text;
  v_kind text;
begin
  if auth.uid() is null then raise exception 'SUPPLIER_DOCUMENT_UNAUTHENTICATED' using errcode = '42501'; end if;
  select * into v_document from public.supplier_documents where id = p_document_id for update;
  if v_document.id is null then raise exception 'SUPPLIER_DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_is_tenant_admin(v_document.tenant_id)
    and not public.user_has_venue_access(v_document.tenant_id, v_document.venue_id)
    then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  if v_document.status <> 'review' then raise exception 'SUPPLIER_DOCUMENT_NOT_EDITABLE' using errcode = '55000'; end if;
  if p_supplier_id is null then
    v_name := public.supplier_document_grounded_value(v_document.extraction_metadata, v_document.ocr_snapshot, 'name');
    if v_name is null then raise exception 'SUPPLIER_DOCUMENT_PROVISIONAL_UNAVAILABLE' using errcode = '22023'; end if;
    v_kind := 'provisional';
  else
    select * into v_supplier from public.suppliers where id = p_supplier_id
      and tenant_id = v_document.tenant_id and venue_id = v_document.venue_id;
    if v_supplier.id is null then raise exception 'SUPPLIER_DOCUMENT_SUPPLIER_INVALID' using errcode = '22023'; end if;
    v_name := v_supplier.name;
    v_kind := 'existing';
  end if;
  update public.supplier_documents document
  set supplier_id = p_supplier_id,
      global_supplier_id = v_supplier.global_supplier_id,
      global_profile_id = case when exists (
        select 1 from public.global_supplier_document_profiles profile
        where profile.id = document.global_profile_id and profile.global_supplier_id = v_supplier.global_supplier_id
      ) then document.global_profile_id else null end,
      extraction_metadata = document.extraction_metadata || jsonb_build_object(
        'supplierSelection', jsonb_build_object('kind', v_kind, 'supplierId', p_supplier_id, 'manual', true),
        'supplierResolution', jsonb_build_object('supplierId', p_supplier_id, 'confidence',
          case when p_supplier_id is null then 'unresolved' else 'high' end,
          'signals', '[]'::jsonb, 'reasons', jsonb_build_array('manual_selection')),
        'linesNeedReparse', coalesce(document.extraction_metadata ->> 'linesSupplierId', '') <> coalesce(p_supplier_id::text, '')
      ), updated_at = now()
  where document.id = v_document.id;
  -- Do not modify lines, run OCR or learn aliases until confirmation.
  return jsonb_build_object('documentId', v_document.id, 'supplierId', p_supplier_id, 'supplierName', v_name);
end;
$$;
revoke all on function public.update_supplier_document_supplier(uuid, uuid) from public, anon, authenticated;
grant execute on function public.update_supplier_document_supplier(uuid, uuid) to authenticated;

alter function public.confirm_supplier_document(uuid, date, boolean, uuid[])
  rename to confirm_supplier_document_existing;
revoke all on function public.confirm_supplier_document_existing(uuid, date, boolean, uuid[]) from public, anon, authenticated;

create function public.confirm_supplier_document(
  p_document_id uuid, p_document_date date, p_affects_stock boolean,
  p_delivery_note_ids uuid[] default '{}'::uuid[]
)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_supplier public.suppliers%rowtype;
  v_name text;
  v_tax text;
  v_email text;
  v_phone text;
  v_matches uuid[];
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'SUPPLIER_DOCUMENT_UNAUTHENTICATED' using errcode = '42501'; end if;
  select * into v_document from public.supplier_documents where id = p_document_id for update;
  if v_document.id is null then raise exception 'SUPPLIER_DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_is_tenant_admin(v_document.tenant_id)
    and not public.user_has_venue_access(v_document.tenant_id, v_document.venue_id)
    then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  if v_document.status = 'confirmed' then
    return public.confirm_supplier_document_existing(p_document_id, p_document_date, p_affects_stock, p_delivery_note_ids);
  end if;
  if v_document.status <> 'review' then raise exception 'SUPPLIER_DOCUMENT_NOT_READY' using errcode = '55000'; end if;
  if p_document_date is null then raise exception 'SUPPLIER_DOCUMENT_DATE_REQUIRED' using errcode = '22023'; end if;
  if v_document.supplier_id is null then
    if v_document.extraction_metadata #>> '{supplierSelection,kind}' is distinct from 'provisional'
      then raise exception 'SUPPLIER_DOCUMENT_SUPPLIER_REQUIRED' using errcode = '22023'; end if;
    v_name := public.supplier_document_grounded_value(v_document.extraction_metadata, v_document.ocr_snapshot, 'name');
    v_tax := public.supplier_document_grounded_value(v_document.extraction_metadata, v_document.ocr_snapshot, 'taxId');
    v_email := public.supplier_document_grounded_value(v_document.extraction_metadata, v_document.ocr_snapshot, 'email');
    v_phone := public.supplier_document_grounded_value(v_document.extraction_metadata, v_document.ocr_snapshot, 'phone');
    if v_name is null or char_length(v_name) > 160 then raise exception 'SUPPLIER_DOCUMENT_PROVISIONAL_INVALID' using errcode = '22023'; end if;
    v_tax := nullif(upper(regexp_replace(coalesce(v_tax, ''), '[^A-Za-z0-9]', '', 'g')), '');
    -- Serializes with all supplier INSERT/UPDATE paths, including manual creation
    -- between OCR and confirmation. No global/venue data is merged.
    lock table public.suppliers in share row exclusive mode;
    if v_tax is not null then
      select array_agg(distinct supplier.id) into v_matches from public.suppliers supplier
      where supplier.tenant_id = v_document.tenant_id and supplier.venue_id = v_document.venue_id
        and (upper(regexp_replace(coalesce(supplier.tax_id, ''), '[^A-Za-z0-9]', '', 'g')) = v_tax
          or (supplier.tax_id is null and exists (select 1 from public.supplier_identity_aliases alias where alias.supplier_id = supplier.id
            and alias.tenant_id = v_document.tenant_id and alias.venue_id = v_document.venue_id
            and alias.source = 'user_confirmed'
            and alias.identity_type = 'tax_id' and alias.normalized_value = v_tax)));
    end if;
    if coalesce(cardinality(v_matches), 0) = 0 then
      select array_agg(distinct supplier.id) into v_matches from public.suppliers supplier
      where supplier.tenant_id = v_document.tenant_id and supplier.venue_id = v_document.venue_id
        and (v_tax is null or supplier.tax_id is null)
        and ((v_email is not null and lower(btrim(supplier.email)) = lower(btrim(v_email)))
          or (v_phone is not null and regexp_replace(supplier.phone, '[^0-9]', '', 'g') = regexp_replace(v_phone, '[^0-9]', '', 'g'))
          or btrim(regexp_replace(lower(supplier.name), '[^[:alnum:]]+', ' ', 'g'))
            = btrim(regexp_replace(lower(v_name), '[^[:alnum:]]+', ' ', 'g')));
    end if;
    if cardinality(v_matches) > 1 then raise exception 'SUPPLIER_DOCUMENT_SUPPLIER_AMBIGUOUS' using errcode = '22023'; end if;
    if cardinality(v_matches) = 1 then
      select * into strict v_supplier from public.suppliers where id = v_matches[1];
    else
      insert into public.suppliers (tenant_id, venue_id, name, tax_id, legal_name, email, phone, address)
      values (v_document.tenant_id, v_document.venue_id, v_name, v_tax,
        public.supplier_document_grounded_value(v_document.extraction_metadata, v_document.ocr_snapshot, 'legalName'),
        v_email, v_phone,
        public.supplier_document_grounded_value(v_document.extraction_metadata, v_document.ocr_snapshot, 'address'))
      returning * into v_supplier;
    end if;
    update public.supplier_documents set supplier_id = v_supplier.id, global_supplier_id = v_supplier.global_supplier_id,
      extraction_metadata = extraction_metadata || jsonb_build_object(
        'supplierSelection', jsonb_build_object('kind', 'existing', 'supplierId', v_supplier.id, 'confirmedFromProvisional', true),
        'supplierResolution', jsonb_build_object('supplierId', v_supplier.id, 'confidence', 'high',
          'signals', '[]'::jsonb, 'reasons', jsonb_build_array('confirmed_provisional'))
      ) where id = v_document.id;
  end if;
  -- Any error below rolls back the supplier creation and association as well.
  v_result := public.confirm_supplier_document_existing(p_document_id, p_document_date, p_affects_stock, p_delivery_note_ids);
  perform public.learn_confirmed_supplier_document_identities(p_document_id);
  return v_result;
end;
$$;
revoke all on function public.confirm_supplier_document(uuid, date, boolean, uuid[]) from public, anon, authenticated;
grant execute on function public.confirm_supplier_document(uuid, date, boolean, uuid[]) to authenticated;

create function public.replace_supplier_document_lines_from_ocr(
  p_document_id uuid, p_supplier_id uuid, p_expected_lines jsonb, p_allow_overwrite boolean,
  p_lines jsonb, p_profile_id uuid, p_profile_rules jsonb
)
returns void language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
begin
  select * into v_document from public.supplier_documents where id = p_document_id for update;
  if v_document.id is null or v_document.status <> 'review' or v_document.supplier_id is distinct from p_supplier_id
    then raise exception 'SUPPLIER_DOCUMENT_REPARSE_STALE' using errcode = '40001'; end if;
  if p_supplier_id is null or v_document.ocr_snapshot is null then raise exception 'SUPPLIER_DOCUMENT_REPARSE_UNAVAILABLE' using errcode = '22023'; end if;
  perform id from public.supplier_document_lines where supplier_document_id = p_document_id for update;
  if not coalesce(p_allow_overwrite, false) and exists (
    select 1 from public.supplier_document_lines where supplier_document_id = p_document_id
      and (was_corrected or reference_cost_decided or update_reference_cost)
  ) then raise exception 'SUPPLIER_DOCUMENT_REPARSE_CONFIRMATION_REQUIRED' using errcode = '55000'; end if;
  if (select count(*) from public.supplier_document_lines where supplier_document_id = p_document_id) <> jsonb_array_length(p_expected_lines)
    or exists (
      select 1 from public.supplier_document_lines line
      left join jsonb_to_recordset(p_expected_lines) expected(id uuid, updated_at timestamptz) on expected.id = line.id
      where line.supplier_document_id = p_document_id and (expected.id is null or line.updated_at is distinct from expected.updated_at)
    ) then raise exception 'SUPPLIER_DOCUMENT_REPARSE_STALE' using errcode = '40001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 500
    then raise exception 'SUPPLIER_DOCUMENT_LINES_REQUIRED' using errcode = '22023'; end if;
  if p_profile_id is not null and not exists (
    select 1 from public.global_supplier_document_profiles profile join public.suppliers supplier
      on supplier.global_supplier_id = profile.global_supplier_id
    where supplier.id = p_supplier_id and profile.id = p_profile_id
      and profile.document_type = v_document.document_type
  ) then raise exception 'SUPPLIER_DOCUMENT_PROFILE_INVALID' using errcode = '22023'; end if;
  delete from public.supplier_document_lines where supplier_document_id = p_document_id;
  insert into public.supplier_document_lines (
    supplier_document_id, tenant_id, venue_id, line_number, supplier_reference, description_raw, description_normalized,
    barcode, quantity, purchase_unit, package_count, package_unit_quantity, package_unit_symbol, unit_price,
    discount_amount, charges_amount, gross_cost, net_cost, line_total, tax_rate, inventory_item_id, warehouse_id,
    base_quantity, normalized_unit_cost, match_status, extraction_confidence, raw_extraction_metadata
  ) select p_document_id, v_document.tenant_id, v_document.venue_id, line.line_number, line.supplier_reference,
    line.description_raw, line.description_normalized, line.barcode, line.quantity, line.purchase_unit,
    line.package_count, line.package_unit_quantity, line.package_unit_symbol, line.unit_price, line.discount_amount,
    line.charges_amount, line.gross_cost, line.net_cost, line.line_total, line.tax_rate, line.inventory_item_id,
    line.warehouse_id, line.base_quantity, line.normalized_unit_cost, line.match_status, line.extraction_confidence,
    line.raw_extraction_metadata
  from jsonb_populate_recordset(null::public.supplier_document_lines, p_lines) line;
  update public.supplier_documents set global_profile_id = p_profile_id,
    extraction_metadata = extraction_metadata || jsonb_build_object(
      'linesSupplierId', p_supplier_id, 'linesNeedReparse', false, 'linesReparsedAt', now(),
      'profileParsedLineCount', jsonb_array_length(p_lines), 'lineParserProfile', p_profile_rules
    ), updated_at = now() where id = p_document_id;
end;
$$;
revoke all on function public.replace_supplier_document_lines_from_ocr(uuid, uuid, jsonb, boolean, jsonb, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_supplier_document_lines_from_ocr(uuid, uuid, jsonb, boolean, jsonb, uuid, jsonb) to service_role;
