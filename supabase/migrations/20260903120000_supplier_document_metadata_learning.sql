-- Prepared only: existing-global selection and confirmed metadata-only learning.
-- No OCR, global creation, stock, cost or invoice/delivery-note algorithms change.
create function public.resolve_supplier_document_existing_global(p_document_id uuid, p_supplier_id uuid)
returns uuid language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_supplier public.suppliers%rowtype;
  v_matches uuid[];
  v_tax text;
begin
  select * into v_document from public.supplier_documents where id = p_document_id for update;
  if v_document.id is null or v_document.status <> 'review' or v_document.supplier_id is distinct from p_supplier_id
    then raise exception 'SUPPLIER_DOCUMENT_REPARSE_STALE' using errcode = '40001'; end if;
  select * into v_supplier from public.suppliers where id = p_supplier_id
    and tenant_id = v_document.tenant_id and venue_id = v_document.venue_id for update;
  if v_supplier.id is null then raise exception 'SUPPLIER_DOCUMENT_SUPPLIER_INVALID' using errcode = '22023'; end if;
  if v_supplier.global_supplier_id is null then
    v_tax := public.normalize_global_supplier_tax_id(v_supplier.tax_id);
    if v_tax ~ '^[A-Z0-9]{6,40}$' and v_tax ~ '[0-9]' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('global-supplier-tax:' || v_tax, 0));
      select array_agg(id) into v_matches from public.global_suppliers
        where public.normalize_global_supplier_tax_id(tax_id) = v_tax;
      if cardinality(v_matches) = 1 then
        v_supplier.global_supplier_id := v_matches[1];
        update public.suppliers set global_supplier_id = v_matches[1], updated_at = now() where id = v_supplier.id;
      end if;
    end if;
  end if;
  update public.supplier_documents set global_supplier_id = v_supplier.global_supplier_id,
    global_profile_id = case when exists (select 1 from public.global_supplier_document_profiles
      where id = v_document.global_profile_id and global_supplier_id = v_supplier.global_supplier_id)
      then v_document.global_profile_id else null end,
    extraction_metadata = extraction_metadata || jsonb_build_object('selectedSupplierGlobalResolution', jsonb_build_object(
      'globalSupplierId', v_supplier.global_supplier_id,
      'mode', case when v_supplier.global_supplier_id is null then 'unresolved'
        when cardinality(v_matches) = 1 then 'existing_by_tax_id' else 'existing_link' end)),
    updated_at = now() where id = p_document_id;
  return v_supplier.global_supplier_id;
end;
$$;
revoke all on function public.resolve_supplier_document_existing_global(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resolve_supplier_document_existing_global(uuid, uuid) to service_role;

alter function public.update_supplier_document_supplier(uuid, uuid) rename to update_supplier_document_supplier_selection;
revoke all on function public.update_supplier_document_supplier_selection(uuid, uuid) from public, anon, authenticated;
create function public.update_supplier_document_supplier(p_document_id uuid, p_supplier_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_result jsonb; v_global uuid;
begin
  -- The existing RPC checks authentication, tenant/venue access and review state.
  v_result := public.update_supplier_document_supplier_selection(p_document_id, p_supplier_id);
  if p_supplier_id is not null then
    v_global := public.resolve_supplier_document_existing_global(p_document_id, p_supplier_id);
  end if;
  return v_result || jsonb_build_object('globalSupplierId', v_global);
end;
$$;
revoke all on function public.update_supplier_document_supplier(uuid, uuid) from public, anon, authenticated;
grant execute on function public.update_supplier_document_supplier(uuid, uuid) to authenticated;

create function public.normalize_supplier_metadata_label(p_value text)
returns text language sql immutable set search_path to '' as $$
  select btrim(regexp_replace(translate(upper(coalesce(p_value, '')), 'ÁÉÍÓÚÜÑ', 'AEIOUUN'), '[^A-Z0-9]+', ' ', 'g'));
$$;
create function public.normalize_supplier_metadata_value(p_field text, p_value text)
returns text language plpgsql immutable set search_path to '' as $$
declare v_parts text[]; v_date date;
begin
  if p_field = 'number' then return case when char_length(btrim(p_value)) <= 80 then nullif(btrim(p_value), '') end; end if;
  if p_field <> 'date' then return null; end if;
  v_parts := regexp_match(btrim(p_value), '^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$');
  if v_parts is not null then v_date := make_date(v_parts[1]::int, v_parts[2]::int, v_parts[3]::int);
  else
    v_parts := regexp_match(btrim(p_value), '^([0-9]{1,2})[./-]([0-9]{1,2})[./-]([0-9]{4})$');
    if v_parts is null then return null; end if;
    v_date := make_date(v_parts[3]::int, v_parts[2]::int, v_parts[1]::int);
  end if;
  return case when extract(year from v_date) >= 1900 then to_char(v_date, 'YYYY-MM-DD') end;
exception when datetime_field_overflow or invalid_text_representation then return null;
end;
$$;

create function public.supplier_metadata_ocr_texts(p_ocr jsonb)
returns table(content text) language sql immutable set search_path to '' as $$
  select distinct value #>> '{}' from jsonb_path_query(coalesce(p_ocr, '{}'), '$.**.text') value
  union
  select string_agg(cell ->> 'text', ' | ' order by (cell ->> 'columnIndex')::int)
  from jsonb_path_query(coalesce(p_ocr, '{}'), '$.pages[*].tables[*]') table_data,
    lateral jsonb_array_elements(case when jsonb_typeof(table_data -> 'cells') = 'array' then table_data -> 'cells' else '[]'::jsonb end) cell
  group by table_data, cell ->> 'rowIndex';
$$;

-- Re-derive manual/confirmed evidence at the persistence boundary, not from
-- caller-provided labels. The same pair in aggregate/page/table text counts once.
create function public.supplier_metadata_candidates(p_ocr jsonb, p_field text)
returns table(value text, evidence text, label text) language plpgsql immutable set search_path to '' as $$
declare v_text text; v_line text; v_match text[]; v_label text; v_pattern text;
begin
  if p_field not in ('date', 'number') then return; end if;
  v_pattern := case when p_field = 'date'
    then '([^0-9|]{2,80})[[:space:]:#|]+([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|[0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{4})'
    else '([^0-9|]{2,80})[[:space:]:#|]+([A-Za-z0-9][A-Za-z0-9/_.-]*[0-9][A-Za-z0-9/_.-]*|[0-9])' end;
  for v_text in select content from public.supplier_metadata_ocr_texts(p_ocr) loop
    for v_line in
      with lines as (select line, lead(line) over(order by ordinal) next_line
        from regexp_split_to_table(v_text, E'\n') with ordinality items(line, ordinal))
      select line from lines union all select line || E'\n' || next_line from lines
        where line !~ '[0-9]' and char_length(line) between 2 and 80
          and next_line ~ '^[[:space:]]*[A-Za-z0-9/_.-]*[0-9][A-Za-z0-9/_.-]*([[:space:]|]|$)'
    loop
      for v_match in select regexp_matches(v_line, v_pattern, 'g') loop
        v_label := btrim(regexp_replace(v_match[1], '^[[:space:]|:#-]+|[[:space:]|:#-]+$', '', 'g'));
        if char_length(v_label) not between 2 and 80 or v_label !~ '[[:alpha:]]' or v_label ~ '[0-9]'
          or public.normalize_supplier_metadata_label(v_label) ~ '\m(VENCIMIENTO|ENTREGA|PEDIDO|PAGO|CADUCIDAD|CLIENTE|CIF|NIF|VAT|TELEFONO|IBAN|TOTAL|IMPORTE|REFERENCIA)\M'
          or public.normalize_supplier_metadata_value(p_field, v_match[2]) is null
          or (p_field = 'number' and public.normalize_supplier_metadata_value('date', v_match[2]) is not null)
          or (p_field = 'number' and public.normalize_supplier_metadata_label(v_label) !~ '\m(FACTURA|ALBARAN|DOCUMENTO|NUMERO|NUM|NRO)\M'
            and v_label !~* 'n[º°.]')
          then continue; end if;
        if char_length(v_line) > 500 then continue; end if;
        value := v_match[2]; label := v_label; evidence := btrim(v_line);
        return next;
      end loop;
    end loop;
  end loop;
end;
$$;

create function public.supplier_metadata_confirmed_candidate(p_ocr jsonb, p_field text, p_value text)
returns jsonb language sql immutable set search_path to '' as $$
  with pairs as (
    select distinct public.normalize_supplier_metadata_value(p_field, value) value,
      public.normalize_supplier_metadata_label(label) normalized_label, label, evidence
    from public.supplier_metadata_candidates(p_ocr, p_field)
  ), matches as (
    select * from pairs where value = public.normalize_supplier_metadata_value(p_field, p_value)
  )
  select case when (select count(distinct normalized_label) from matches) = 1
    and (select count(distinct value) from pairs where normalized_label in (select normalized_label from matches)) = 1
    then (select jsonb_build_object('value', value, 'labelCandidate', label, 'evidence', evidence)
      from matches order by char_length(evidence), label limit 1) end;
$$;

create index supplier_documents_metadata_evidence_idx on public.supplier_documents(global_profile_id, document_type, global_supplier_id)
  where status = 'confirmed' and global_profile_id is not null;

-- Keep the existing learning/creation implementation. Align a known profile's
-- metadata-only revision AFTER local/provisional confirmation, under the same
-- supplier -> tax -> global lock order as global learning. This also covers two
-- reviews confirmed concurrently and provisional suppliers not created earlier.
alter function public.learn_confirmed_supplier_document_global_knowledge(uuid, uuid)
  rename to learn_confirmed_supplier_document_global_knowledge_base;
revoke all on function public.learn_confirmed_supplier_document_global_knowledge_base(uuid, uuid) from public, anon, authenticated;
create function public.learn_confirmed_supplier_document_global_knowledge(p_document_id uuid, p_previous_profile_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare v_document public.supplier_documents%rowtype; v_supplier public.suppliers%rowtype; v_rules jsonb; v_global uuid; v_tax text;
begin
  select * into strict v_document from public.supplier_documents where id = p_document_id and status = 'confirmed' for update;
  select * into strict v_supplier from public.suppliers where id = v_document.supplier_id
    and tenant_id = v_document.tenant_id and venue_id = v_document.venue_id for update;
  v_global := v_supplier.global_supplier_id;
  if v_global is null then
    v_tax := public.normalize_global_supplier_tax_id(v_supplier.tax_id);
    if v_tax ~ '^[A-Z0-9]{6,40}$' and v_tax ~ '[0-9]' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('global-supplier-tax:' || v_tax, 0));
      select (array_agg(id))[1] into v_global from public.global_suppliers
        where public.normalize_global_supplier_tax_id(tax_id) = v_tax having count(*) = 1;
    end if;
  end if;
  if v_global is not null then
    perform id from public.global_suppliers where id = v_global for update;
    select rules_json into v_rules from public.global_supplier_document_profiles
      where id = p_previous_profile_id and global_supplier_id = v_global and document_type = v_document.document_type
        and status in ('candidate', 'verified')
        and (rules_json - array['documentDateLabel','documentNumberLabel']) =
          ((case when jsonb_typeof(v_document.extraction_metadata -> 'lineParserProfile') = 'object'
            then v_document.extraction_metadata -> 'lineParserProfile' end) - array['documentDateLabel','documentNumberLabel']);
    if v_rules is not null then
      update public.supplier_documents set extraction_metadata = jsonb_set(extraction_metadata, '{lineParserProfile}', v_rules)
        where id = p_document_id;
    end if;
  end if;
  perform public.learn_confirmed_supplier_document_global_knowledge_base(p_document_id, p_previous_profile_id);
end;
$$;
revoke all on function public.learn_confirmed_supplier_document_global_knowledge(uuid, uuid) from public, anon, authenticated;

create function public.learn_confirmed_supplier_document_metadata(p_document_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_profile public.global_supplier_document_profiles%rowtype;
  v_field text; v_rule text; v_entry jsonb; v_old text; v_new text; v_count integer; v_labels integer;
  v_learning jsonb := '[]';
begin
  select * into strict v_document from public.supplier_documents where id = p_document_id and status = 'confirmed';
  select * into v_profile from public.global_supplier_document_profiles where id = v_document.global_profile_id
    and global_supplier_id = v_document.global_supplier_id and document_type = v_document.document_type
    and status in ('candidate', 'verified') for update;
  if v_profile.id is null then return; end if;
  foreach v_field in array array['date','number'] loop
    v_rule := case v_field when 'date' then 'documentDateLabel' else 'documentNumberLabel' end;
    v_entry := v_document.extraction_metadata #> array['metadataExtraction', v_field];
    v_old := v_profile.rules_json ->> v_rule;
    v_new := v_entry ->> 'labelCandidate';
    if v_entry ->> 'learningEligible' is distinct from 'true' or v_entry ->> 'profileFailed' is distinct from 'true'
      or public.normalize_supplier_metadata_label(v_entry ->> 'profileLabel') <> public.normalize_supplier_metadata_label(v_old)
      or (nullif(v_entry ->> 'globalProfileId', '') is not null and v_entry ->> 'globalProfileId' <> v_profile.id::text)
      or nullif(v_new, '') is null or public.normalize_supplier_metadata_label(v_new) = public.normalize_supplier_metadata_label(v_old)
      then continue; end if;
    -- Evidence is isolated by exact profile/type/global identity, including when
    -- multiple tenants share that profile. No raw tenant data is copied globally.
    select count(*) filter (where public.normalize_supplier_metadata_label(entry ->> 'labelCandidate') = public.normalize_supplier_metadata_label(v_new)),
      count(distinct public.normalize_supplier_metadata_label(entry ->> 'labelCandidate')) into v_count, v_labels
    from public.supplier_documents d
    cross join lateral (select d.extraction_metadata #> array['metadataExtraction', v_field] entry) metadata
    cross join lateral (select public.supplier_metadata_confirmed_candidate(d.ocr_snapshot, v_field,
      case v_field when 'date' then d.document_date::text else d.document_number end) grounded) proof
    where d.status = 'confirmed' and d.global_profile_id = v_profile.id and d.global_supplier_id = v_profile.global_supplier_id
      and d.document_type = v_profile.document_type
      and entry ->> 'learningEligible' = 'true' and entry ->> 'profileFailed' = 'true'
      and (nullif(entry ->> 'globalProfileId', '') is null or entry ->> 'globalProfileId' = d.global_profile_id::text)
      and public.normalize_supplier_metadata_label(entry ->> 'profileLabel') = public.normalize_supplier_metadata_label(v_old)
      and public.normalize_supplier_metadata_label(grounded ->> 'labelCandidate') = public.normalize_supplier_metadata_label(entry ->> 'labelCandidate')
      and public.normalize_supplier_metadata_value(v_field, entry ->> 'value') = public.normalize_supplier_metadata_value(v_field,
        case v_field when 'date' then d.document_date::text else d.document_number end)
      and exists (select 1 from public.supplier_metadata_ocr_texts(d.ocr_snapshot)
        where position(entry ->> 'evidence' in content) > 0);
    if v_count >= 2 and v_labels = 1 then
      -- Patch ONLY one allowed metadata key; all line rules/fingerprint stay byte-for-byte JSONB equivalent.
      update public.global_supplier_document_profiles set rules_json = jsonb_set(rules_json, array[v_rule], to_jsonb(v_new)), updated_at = now()
        where id = v_profile.id;
      v_learning := v_learning || jsonb_build_array(jsonb_build_object('field', v_rule, 'previousValue', v_old,
        'newValue', v_new, 'evidenceCount', v_count, 'globalProfileId', v_profile.id));
    end if;
  end loop;
  if jsonb_array_length(v_learning) > 0 then
    update public.supplier_documents set extraction_metadata = extraction_metadata || jsonb_build_object('profileMetadataLearning', v_learning)
      where id = p_document_id;
  end if;
end;
$$;

alter function public.confirm_supplier_document(uuid, date, boolean, uuid[]) rename to confirm_supplier_document_global;
revoke all on function public.confirm_supplier_document_global(uuid, date, boolean, uuid[]) from public, anon, authenticated;
create function public.confirm_supplier_document(
  p_document_id uuid, p_document_date date, p_affects_stock boolean,
  p_delivery_note_ids uuid[] default '{}', p_document_number text default null
)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype; v_result jsonb; v_field text; v_value text; v_proposed jsonb;
  v_candidate jsonb; v_metadata jsonb; v_changed boolean; v_eligible boolean; v_rules jsonb;
begin
  if auth.uid() is null then raise exception 'SUPPLIER_DOCUMENT_UNAUTHENTICATED' using errcode = '42501'; end if;
  select * into v_document from public.supplier_documents where id = p_document_id for update;
  if v_document.id is null then raise exception 'SUPPLIER_DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_is_tenant_admin(v_document.tenant_id) and not public.user_has_venue_access(v_document.tenant_id, v_document.venue_id)
    then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  if v_document.status = 'confirmed' then
    return public.confirm_supplier_document_global(p_document_id, p_document_date, p_affects_stock, p_delivery_note_ids);
  end if;
  if v_document.status <> 'review' then raise exception 'SUPPLIER_DOCUMENT_NOT_READY' using errcode = '55000'; end if;
  if p_document_number is not null and char_length(btrim(p_document_number)) > 80
    then raise exception 'SUPPLIER_DOCUMENT_NUMBER_INVALID' using errcode = '22023'; end if;
  v_metadata := v_document.extraction_metadata;
  v_rules := v_metadata -> 'lineParserProfile';
  foreach v_field in array array['date','number'] loop
    v_proposed := v_metadata #> array['metadataExtraction', v_field];
    v_value := case v_field when 'date' then p_document_date::text else coalesce(p_document_number, v_document.document_number) end;
    v_changed := public.normalize_supplier_metadata_value(v_field, v_proposed ->> 'value')
      is distinct from public.normalize_supplier_metadata_value(v_field, v_value);
    v_candidate := public.supplier_metadata_confirmed_candidate(v_document.ocr_snapshot, v_field, v_value);
    v_eligible := v_candidate is not null;
    if not v_changed and v_proposed ->> 'source' in ('profile','generic','ai') then
      v_eligible := v_eligible
        and public.normalize_supplier_metadata_label(v_proposed ->> 'labelCandidate') = public.normalize_supplier_metadata_label(v_candidate ->> 'labelCandidate')
        and public.normalize_supplier_metadata_label(public.supplier_metadata_confirmed_candidate(
          jsonb_build_object('text', v_proposed ->> 'evidence'), v_field, v_value) ->> 'labelCandidate')
          = public.normalize_supplier_metadata_label(v_candidate ->> 'labelCandidate')
        and v_proposed ->> 'ambiguous' is distinct from 'true'
        and exists (select 1 from public.supplier_metadata_ocr_texts(v_document.ocr_snapshot)
          where position(v_proposed ->> 'evidence' in content) > 0);
      v_candidate := coalesce(v_proposed, '{}');
    else
      -- A changed generic/AI proposal is never counted as a positive extraction.
      -- A missing field or corrected failing profile may supply independent manual evidence.
      v_eligible := v_eligible and not (coalesce(v_proposed ->> 'source', '') in ('generic','ai')
        and nullif(v_proposed ->> 'value', '') is not null);
      v_candidate := coalesce(v_candidate, '{}') || jsonb_build_object('source', 'manual', 'confidence', 1,
        'proposedExtraction', v_proposed);
    end if;
    if nullif(v_proposed ->> 'globalProfileId', '') is not null
      and v_proposed ->> 'globalProfileId' is distinct from v_document.global_profile_id::text then
      v_eligible := false;
    end if;
    v_candidate := v_candidate || jsonb_build_object('value', v_value, 'userModified', v_changed, 'confirmed', true,
      'learningEligible', coalesce(v_eligible, false), 'profileLabel', case when v_proposed ? 'profileLabel'
        then v_proposed ->> 'profileLabel' else v_rules ->> case v_field when 'date' then 'documentDateLabel' else 'documentNumberLabel' end end,
      'profileFailed', coalesce((v_proposed ->> 'profileFailed') = 'true', true) or v_changed);
    v_metadata := jsonb_set(v_metadata, '{metadataExtraction}', coalesce(v_metadata -> 'metadataExtraction', '{}') || jsonb_build_object(v_field, v_candidate));
  end loop;
  update public.supplier_documents set extraction_metadata = v_metadata,
    document_number = case when p_document_number is null then document_number else nullif(btrim(p_document_number), '') end
    where id = p_document_id;
  v_result := public.confirm_supplier_document_global(p_document_id, p_document_date, p_affects_stock, p_delivery_note_ids);
  perform public.learn_confirmed_supplier_document_metadata(p_document_id);
  return v_result;
end;
$$;
revoke all on function public.confirm_supplier_document(uuid, date, boolean, uuid[], text) from public, anon, authenticated;
grant execute on function public.confirm_supplier_document(uuid, date, boolean, uuid[], text) to authenticated;
revoke all on function public.normalize_supplier_metadata_label(text), public.normalize_supplier_metadata_value(text, text),
  public.supplier_metadata_ocr_texts(jsonb), public.supplier_metadata_candidates(jsonb, text),
  public.supplier_metadata_confirmed_candidate(jsonb, text, text), public.learn_confirmed_supplier_document_metadata(uuid)
  from public, anon, authenticated;
