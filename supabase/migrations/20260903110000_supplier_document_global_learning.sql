-- Prepared only. Global knowledge is learned in the existing confirmation
-- transaction, never while OCR is processing or the document is in review.
alter table public.global_suppliers add column legal_name text;

create function public.normalize_global_supplier_tax_id(p_tax_id text)
returns text language sql immutable set search_path to '' as $$
  select nullif(upper(regexp_replace(coalesce(p_tax_id, ''), '[^A-Za-z0-9]', '', 'g')), '');
$$;
revoke all on function public.normalize_global_supplier_tax_id(text) from public, anon, authenticated;

-- Existing formatted duplicates are preserved, not merged/deleted/reassigned.
-- Normally (including an empty catalog) this is a normalized UNIQUE index. A
-- legacy catalog with collisions gets a lookup index plus the write guard below;
-- ambiguous identities remain unresolved until explicitly repaired.
do $$
begin
  if exists (
    select 1 from public.global_suppliers
    where public.normalize_global_supplier_tax_id(tax_id) is not null
    group by public.normalize_global_supplier_tax_id(tax_id) having count(*) > 1
  ) then
    create index global_suppliers_normalized_tax_idx on public.global_suppliers
      (public.normalize_global_supplier_tax_id(tax_id))
      where public.normalize_global_supplier_tax_id(tax_id) is not null;
  else
    create unique index global_suppliers_normalized_tax_idx on public.global_suppliers
      (public.normalize_global_supplier_tax_id(tax_id))
      where public.normalize_global_supplier_tax_id(tax_id) is not null;
  end if;
end;
$$;

create function public.guard_global_supplier_tax_identity()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_tax text := public.normalize_global_supplier_tax_id(new.tax_id);
begin
  if v_tax is null then return new; end if;
  if tg_op = 'UPDATE' and v_tax is not distinct from public.normalize_global_supplier_tax_id(old.tax_id)
    then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('global-supplier-tax:' || v_tax, 0));
  if exists (select 1 from public.global_suppliers where id <> new.id
    and public.normalize_global_supplier_tax_id(tax_id) = v_tax)
    then raise exception 'GLOBAL_SUPPLIER_TAX_ID_DUPLICATE' using errcode = '23505'; end if;
  return new;
end;
$$;
revoke all on function public.guard_global_supplier_tax_identity() from public, anon, authenticated;
create trigger guard_global_supplier_tax_identity
before insert or update of tax_id on public.global_suppliers
for each row execute function public.guard_global_supplier_tax_identity();

create function public.learn_confirmed_supplier_document_global_knowledge(p_document_id uuid, p_previous_profile_id uuid)
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
      and status in ('candidate', 'verified');
    v_rules := nullif(v_document.extraction_metadata -> 'lineParserProfile', 'null'::jsonb);
    -- A known deterministic profile may predate profileParsedLineCount metadata
    -- or have lost its tentative ID when the user selected another supplier.
    if v_document.extraction_metadata ->> 'parserMode' = 'deterministic' then
      v_rules := coalesce(v_rules, v_previous.rules_json);
      if v_document.extraction_metadata ->> 'profileParsedLineCount' is null and v_rules is not null
        then v_parsed_count := v_line_count; end if;
    end if;
    v_profile_valid := v_line_count > 0 and v_parsed_count between 1 and 500 and (
      v_document.extraction_metadata #> '{profileValidation,candidate}' = 'true'::jsonb
      or (v_document.extraction_metadata ->> 'parserMode' = 'deterministic'
        and v_document.extraction_metadata #> '{profileValidation,candidate}' is distinct from 'false'::jsonb)
      or (v_document.extraction_metadata ->> 'linesReparsedAt' is not null
        and v_document.extraction_metadata ->> 'linesSupplierId' = v_supplier.id::text)
    );
    -- The Edge already validated rules with Zod and reproduced the line output.
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
        and rules_json = v_rules and status in ('candidate', 'verified')
      order by case status when 'verified' then 0 else 1 end, success_count desc, created_at, id limit 1;
      if v_profile_id is not null then
        v_profile_mode := 'existing';
        v_profile_reason := null;
      elsif exists (select 1 from public.global_supplier_document_profiles
        where global_supplier_id = v_global_id and document_type = v_document.document_type
          and rules_json = v_rules and status = 'deprecated') then
        v_profile_reason := 'profile_deprecated';
      else
        insert into public.global_supplier_document_profiles(
          global_supplier_id, document_type, fingerprint_json, rules_json, status
        ) values (v_global_id, v_document.document_type,
          jsonb_build_object('requiredTexts', v_rules -> 'requiredTexts'), v_rules, 'candidate')
        returning id into v_profile_id;
        v_profile_mode := 'created';
        v_profile_reason := null;
      end if;
      if v_profile_id is not null then
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
revoke all on function public.learn_confirmed_supplier_document_global_knowledge(uuid, uuid) from public, anon, authenticated;

-- Wrap, do not copy or modify, the provisional/local supplier confirmation and
-- the underlying stock/cost/link transaction. Failures roll everything back.
alter function public.confirm_supplier_document(uuid, date, boolean, uuid[])
  rename to confirm_supplier_document_local;
revoke all on function public.confirm_supplier_document_local(uuid, date, boolean, uuid[]) from public, anon, authenticated;

create function public.confirm_supplier_document(
  p_document_id uuid, p_document_date date, p_affects_stock boolean,
  p_delivery_note_ids uuid[] default '{}'::uuid[]
)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'SUPPLIER_DOCUMENT_UNAUTHENTICATED' using errcode = '42501'; end if;
  select * into v_document from public.supplier_documents where id = p_document_id for update;
  if v_document.id is null then raise exception 'SUPPLIER_DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_is_tenant_admin(v_document.tenant_id)
    and not public.user_has_venue_access(v_document.tenant_id, v_document.venue_id)
    then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  if v_document.status = 'confirmed' then
    return public.confirm_supplier_document_local(p_document_id, p_document_date, p_affects_stock, p_delivery_note_ids);
  end if;
  if v_document.status <> 'review' then raise exception 'SUPPLIER_DOCUMENT_NOT_READY' using errcode = '55000'; end if;
  -- Prevent counting an OCR-selected profile belonging to the wrong supplier.
  -- Global learning below increments exactly the final profile, once.
  update public.supplier_documents set global_profile_id = null where id = p_document_id;
  v_result := public.confirm_supplier_document_local(p_document_id, p_document_date, p_affects_stock, p_delivery_note_ids);
  perform public.learn_confirmed_supplier_document_global_knowledge(p_document_id, v_document.global_profile_id);
  return v_result;
end;
$$;
revoke all on function public.confirm_supplier_document(uuid, date, boolean, uuid[]) from public, anon, authenticated;
grant execute on function public.confirm_supplier_document(uuid, date, boolean, uuid[]) to authenticated;
