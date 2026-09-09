begin;

-- Existing UUIDs remain version identifiers, with no rewriting/reclassification
-- of historical rules or statuses. Different layouts can remain active together.
alter table public.global_supplier_document_profiles
  drop constraint global_supplier_profiles_status_check,
  add constraint global_supplier_profiles_status_check
    check (status in ('candidate', 'verified', 'active', 'deprecated')),
  add column parent_profile_id uuid references public.global_supplier_document_profiles(id);
create index global_supplier_profiles_parent_idx
  on public.global_supplier_document_profiles(parent_profile_id) where parent_profile_id is not null;
comment on column public.global_supplier_document_profiles.parent_profile_id is
  'Optional immutable version lineage. NULL preserves legacy versions and new independent layouts.';

create function public.guard_supplier_parser_version()
returns trigger language plpgsql set search_path to '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id or new.global_supplier_id is distinct from old.global_supplier_id
    or new.document_type is distinct from old.document_type
    or new.rules_json is distinct from old.rules_json
    or new.fingerprint_json is distinct from old.fingerprint_json
    or new.parent_profile_id is distinct from old.parent_profile_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'SUPPLIER_PARSER_VERSION_IMMUTABLE' using errcode = '55000';
  end if;
  if tg_op = 'INSERT' and new.parent_profile_id is not null then
    if new.parent_profile_id = new.id or not exists (
      select 1 from public.global_supplier_document_profiles p where p.id = new.parent_profile_id
        and p.global_supplier_id = new.global_supplier_id and p.document_type = new.document_type
    ) then raise exception 'SUPPLIER_PARSER_PARENT_INVALID' using errcode = '22023'; end if;
    -- A derived version always starts as a proposal; its parent stays usable.
    new.status := 'candidate';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_supplier_parser_version() from public, anon, authenticated;
create trigger guard_supplier_parser_version before insert or update
  on public.global_supplier_document_profiles for each row execute function public.guard_supplier_parser_version();

create function public.create_supplier_parser_candidate(
  p_global_supplier_id uuid, p_document_type text, p_rules jsonb, p_parent_profile_id uuid default null
) returns uuid language plpgsql set search_path to '' as $$
declare v_id uuid;
begin
  -- Serializes identical proposals while allowing any number of distinct layouts.
  perform id from public.global_suppliers where id = p_global_supplier_id for update;
  if not found then raise exception 'SUPPLIER_PARSER_SUPPLIER_INVALID' using errcode = '22023'; end if;
  if jsonb_typeof(p_rules) is distinct from 'object' or p_rules ->> 'version' is distinct from '1'
    then raise exception 'SUPPLIER_PARSER_RULES_INVALID' using errcode = '22023'; end if;
  if p_parent_profile_id is not null and not exists (
    select 1 from public.global_supplier_document_profiles where id = p_parent_profile_id
      and global_supplier_id = p_global_supplier_id and document_type = p_document_type
  ) then raise exception 'SUPPLIER_PARSER_PARENT_INVALID' using errcode = '22023'; end if;
  select id into v_id from public.global_supplier_document_profiles
    where global_supplier_id = p_global_supplier_id and document_type = p_document_type and rules_json = p_rules
      and status in ('verified', 'active', 'candidate')
    order by case when status in ('verified', 'active') then 0 else 1 end, created_at, id limit 1;
  if v_id is not null then return v_id; end if;
  if exists (select 1 from public.global_supplier_document_profiles where global_supplier_id = p_global_supplier_id
    and document_type = p_document_type and rules_json = p_rules and status = 'deprecated') then return null; end if;
  insert into public.global_supplier_document_profiles(global_supplier_id, document_type, rules_json,
    fingerprint_json, status, parent_profile_id)
    values(p_global_supplier_id, p_document_type, p_rules,
      jsonb_build_object('requiredTexts', p_rules -> 'requiredTexts'), 'candidate', p_parent_profile_id)
    returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.create_supplier_parser_candidate(uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.create_supplier_parser_candidate(uuid, text, jsonb, uuid) to service_role;

create or replace function public.learn_confirmed_supplier_document_global_knowledge_base(p_document_id uuid, p_previous_profile_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_supplier public.suppliers%rowtype;
  v_global_id uuid;
  v_matches uuid[];
  v_tax text;
  v_supplier_mode text := 'unresolved';
  v_supplier_reason text := 'missing_or_invalid_tax_id';
  v_profile_id uuid;
  v_profile_mode text := 'none';
  v_profile_reason text := 'no_valid_profile';
  v_rules jsonb;
  v_previous public.global_supplier_document_profiles%rowtype;
  v_parsed_count integer := 0;
  v_profile_valid boolean;
  v_profile_pending boolean;
  v_line_count integer;
  v_correction_count integer;
begin
  select * into strict v_document from public.supplier_documents where id = p_document_id for update;
  if v_document.status <> 'confirmed' or v_document.supplier_id is null then
    raise exception 'SUPPLIER_DOCUMENT_NOT_CONFIRMED' using errcode = '55000';
  end if;
  select * into strict v_supplier from public.suppliers
  where id = v_document.supplier_id and tenant_id = v_document.tenant_id and venue_id = v_document.venue_id
  for update;
  v_global_id := v_supplier.global_supplier_id;
  if v_global_id is not null then
    v_supplier_mode := 'existing_link';
    v_supplier_reason := null;
  else
    -- Only confirmed local supplier fields, never raw supplierExtraction or a
    -- discarded provisional. This is format validation, not a VAT registry check.
    v_tax := public.normalize_global_supplier_tax_id(v_supplier.tax_id);
    if v_tax ~ '^[A-Z0-9]{6,40}$' and v_tax ~ '[0-9]' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('global-supplier-tax:' || v_tax, 0));
      select array_agg(id order by created_at, id) into v_matches from public.global_suppliers
      where public.normalize_global_supplier_tax_id(tax_id) = v_tax;
      if coalesce(cardinality(v_matches), 0) = 0 then
        insert into public.global_suppliers(name, legal_name, tax_id)
        values (v_supplier.name, nullif(btrim(v_supplier.legal_name), ''), v_tax)
        returning id into v_global_id;
        v_supplier_mode := 'created_by_tax_id';
        v_supplier_reason := null;
      elsif cardinality(v_matches) = 1 then
        v_global_id := v_matches[1];
        v_supplier_mode := 'existing_by_tax_id';
        v_supplier_reason := null;
      else
        v_supplier_reason := 'ambiguous_tax_id';
      end if;
    end if;
    if v_global_id is not null then
      update public.suppliers set global_supplier_id = v_global_id, updated_at = now()
      where id = v_supplier.id and tenant_id = v_document.tenant_id and venue_id = v_document.venue_id;
    end if;
  end if;

  if v_global_id is not null then
    -- Serialize equivalent profile lookups/inserts for this global supplier.
    perform id from public.global_suppliers where id = v_global_id for update;
    select count(*), count(*) filter (where was_corrected) into v_line_count, v_correction_count
    from public.supplier_document_lines where supplier_document_id = p_document_id
      and tenant_id = v_document.tenant_id and venue_id = v_document.venue_id;
    if v_document.extraction_metadata ->> 'profileParsedLineCount' ~ '^[1-9][0-9]{0,2}$' then
      v_parsed_count := (v_document.extraction_metadata ->> 'profileParsedLineCount')::integer;
    end if;
    select * into v_previous from public.global_supplier_document_profiles
    where id = p_previous_profile_id and document_type = v_document.document_type
      and status in ('candidate', 'verified', 'active');
    v_rules := nullif(v_document.extraction_metadata -> 'lineParserProfile', 'null'::jsonb);
    -- A known deterministic profile may predate profileParsedLineCount metadata
    -- or have lost its tentative ID when the user selected another supplier.
    if v_document.extraction_metadata ->> 'parserMode' = 'deterministic' then
      v_rules := coalesce(v_rules, v_previous.rules_json);
      if v_document.extraction_metadata ->> 'profileParsedLineCount' is null and v_rules is not null
        then v_parsed_count := v_line_count; end if;
    end if;
    v_profile_pending := v_document.extraction_metadata #>> '{profileValidation,reason}' = 'PROFILE_VALIDATION_PENDING';
    v_profile_valid := v_line_count > 0 and (v_profile_pending or (v_parsed_count between 1 and 500 and (
      v_document.extraction_metadata #> '{profileValidation,candidate}' = 'true'::jsonb
      or (v_document.extraction_metadata ->> 'parserMode' = 'deterministic'
        and v_document.extraction_metadata #> '{profileValidation,candidate}' is distinct from 'false'::jsonb)
      or (v_document.extraction_metadata ->> 'linesReparsedAt' is not null
        and v_document.extraction_metadata ->> 'linesSupplierId' = v_supplier.id::text)
    )));
    -- Pending proposals have only passed schema validation, never execution.
    -- Defend the persistence boundary against missing/legacy malformed metadata.
    v_profile_valid := coalesce(v_profile_valid, false)
      and jsonb_typeof(v_rules) = 'object' and v_rules ->> 'version' = '1'
      and case when jsonb_typeof(v_rules -> 'requiredTexts') = 'array'
        then jsonb_array_length(v_rules -> 'requiredTexts') between 1 and 20 else false end
      and case when jsonb_typeof(v_rules -> 'columns') = 'array'
        then jsonb_array_length(v_rules -> 'columns') between 3 and 16 else false end;
    if v_profile_valid then
      select id into v_profile_id from public.global_supplier_document_profiles
      where global_supplier_id = v_global_id and document_type = v_document.document_type
        and rules_json = v_rules and status in ('candidate', 'verified', 'active')
      order by case when status in ('verified', 'active') then 0 else 1 end, success_count desc, created_at, id limit 1;
      if v_profile_id is not null then
        v_profile_mode := 'existing';
        v_profile_reason := null;
      elsif exists (select 1 from public.global_supplier_document_profiles
        where global_supplier_id = v_global_id and document_type = v_document.document_type
          and rules_json = v_rules and status = 'deprecated') then
        v_profile_reason := 'profile_deprecated';
      else
        v_profile_id := public.create_supplier_parser_candidate(v_global_id, v_document.document_type, v_rules,
          case when v_previous.global_supplier_id = v_global_id then v_previous.id end);
        v_profile_mode := 'created';
        v_profile_reason := null;
      end if;
      if v_profile_id is not null and not coalesce(v_profile_pending, false) then
        update public.global_supplier_document_profiles
        set success_count = success_count + 1, correction_count = correction_count + v_correction_count, updated_at = now()
        where id = v_profile_id;
      end if;
    end if;
  else
    v_profile_reason := 'global_supplier_unresolved';
  end if;

  update public.supplier_documents set global_supplier_id = v_global_id, global_profile_id = v_profile_id,
    extraction_metadata = extraction_metadata || jsonb_build_object(
      'globalSupplierResolution', jsonb_build_object('mode', v_supplier_mode, 'globalSupplierId', v_global_id, 'reason', v_supplier_reason),
      'globalProfileResolution', jsonb_build_object('mode', v_profile_mode, 'globalProfileId', v_profile_id, 'reason', v_profile_reason)
    ), updated_at = now() where id = p_document_id;
end;
$$;
revoke all on function public.learn_confirmed_supplier_document_global_knowledge_base(uuid, uuid) from public, anon, authenticated;

-- The legacy wrapper aligned metadata with mutable rules. With immutable
-- versions, preserve the exact snapshot and all surrounding exclusion guards.
create or replace function public.learn_confirmed_supplier_document_global_before_guard(
  p_document_id uuid, p_previous_profile_id uuid
) returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.learn_confirmed_supplier_document_global_knowledge_base(p_document_id, p_previous_profile_id);
end;
$$;
revoke all on function public.learn_confirmed_supplier_document_global_before_guard(uuid, uuid) from public, anon, authenticated;


create or replace function public.learn_confirmed_supplier_document_metadata_before_guard(p_document_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_profile public.global_supplier_document_profiles%rowtype;
  v_field text; v_rule text; v_entry jsonb; v_old text; v_new text; v_count integer; v_labels integer;
  v_rules jsonb; v_candidate_id uuid;
  v_learning jsonb := '[]';
begin
  select * into strict v_document from public.supplier_documents where id = p_document_id and status = 'confirmed';
  select * into v_profile from public.global_supplier_document_profiles where id = v_document.global_profile_id
    and global_supplier_id = v_document.global_supplier_id and document_type = v_document.document_type
    and status in ('verified', 'active') for update;
  if v_profile.id is null or public.supplier_document_learning_excluded(p_document_id) then return; end if;
  v_rules := v_profile.rules_json;
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
      and not coalesce(public.supplier_document_learning_excluded(d.id), false)
      and entry ->> 'learningEligible' = 'true' and entry ->> 'profileFailed' = 'true'
      and (nullif(entry ->> 'globalProfileId', '') is null or entry ->> 'globalProfileId' = d.global_profile_id::text)
      and public.normalize_supplier_metadata_label(entry ->> 'profileLabel') = public.normalize_supplier_metadata_label(v_old)
      and public.normalize_supplier_metadata_label(grounded ->> 'labelCandidate') = public.normalize_supplier_metadata_label(entry ->> 'labelCandidate')
      and public.normalize_supplier_metadata_value(v_field, entry ->> 'value') = public.normalize_supplier_metadata_value(v_field,
        case v_field when 'date' then d.document_date::text else d.document_number end)
      and exists (select 1 from public.supplier_metadata_ocr_texts(d.ocr_snapshot)
        where position(entry ->> 'evidence' in content) > 0);
    if v_count >= 2 and v_labels = 1 then
      -- Accumulate a new candidate; the executed version remains unchanged.
      v_rules := jsonb_set(v_rules, array[v_rule], to_jsonb(v_new));
      v_learning := v_learning || jsonb_build_array(jsonb_build_object('field', v_rule, 'previousValue', v_old,
        'newValue', v_new, 'evidenceCount', v_count, 'globalProfileId', v_profile.id));
    end if;
  end loop;
  if jsonb_array_length(v_learning) > 0 then
    v_candidate_id := public.create_supplier_parser_candidate(v_profile.global_supplier_id, v_profile.document_type, v_rules, v_profile.id);
    update public.supplier_documents set extraction_metadata = extraction_metadata || jsonb_build_object('profileMetadataLearning', v_learning,
      'profileMetadataCandidateId', v_candidate_id)
      where id = p_document_id;
  end if;
end;
$$;


revoke all on function public.learn_confirmed_supplier_document_metadata_before_guard(uuid) from public, anon, authenticated;

-- The service RPC cannot reintroduce a candidate or an untracked JSON snapshot
-- when replacing real invoice lines. Keep the existing atomic replacement.
alter function public.replace_supplier_document_lines_from_ocr(uuid, uuid, jsonb, boolean, jsonb, uuid, jsonb)
  rename to replace_supplier_document_lines_before_profile_guard;
revoke all on function public.replace_supplier_document_lines_before_profile_guard(uuid, uuid, jsonb, boolean, jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role;
create function public.replace_supplier_document_lines_from_ocr(
  p_document_id uuid, p_supplier_id uuid, p_expected_lines jsonb, p_allow_overwrite boolean,
  p_lines jsonb, p_profile_id uuid, p_profile_rules jsonb
) returns void language plpgsql security definer set search_path to '' as $$
begin
  perform p.id from public.global_supplier_document_profiles p
    join public.supplier_documents d on d.id = p_document_id
    join public.suppliers s on s.id = p_supplier_id and s.tenant_id = d.tenant_id and s.venue_id = d.venue_id
    where p.id = p_profile_id and p.global_supplier_id = s.global_supplier_id
      and p.document_type = d.document_type and p.rules_json = p_profile_rules
      and p.status in ('verified', 'active') for share of p;
  if not found then raise exception 'SUPPLIER_DOCUMENT_PROFILE_NOT_EXECUTABLE' using errcode = '22023'; end if;
  perform public.replace_supplier_document_lines_before_profile_guard(p_document_id, p_supplier_id,
    p_expected_lines, p_allow_overwrite, p_lines, p_profile_id, p_profile_rules);
end;
$$;
revoke all on function public.replace_supplier_document_lines_from_ocr(uuid, uuid, jsonb, boolean, jsonb, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_supplier_document_lines_from_ocr(uuid, uuid, jsonb, boolean, jsonb, uuid, jsonb) to service_role;

commit;
