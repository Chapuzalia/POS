begin;

create or replace function public.learn_confirmed_supplier_document_global_knowledge_base(
  p_document_id uuid,
  p_previous_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
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
  select *
  into strict v_document
  from public.supplier_documents
  where id = p_document_id
  for update;

  if v_document.status <> 'confirmed' or v_document.supplier_id is null then
    raise exception 'SUPPLIER_DOCUMENT_NOT_CONFIRMED'
      using errcode = '55000';
  end if;

  select *
  into strict v_supplier
  from public.suppliers
  where id = v_document.supplier_id
    and tenant_id = v_document.tenant_id
    and venue_id = v_document.venue_id
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
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('global-supplier-tax:' || v_tax, 0)
      );

      select array_agg(id order by created_at, id)
      into v_matches
      from public.global_suppliers
      where public.normalize_global_supplier_tax_id(tax_id) = v_tax;

      if coalesce(cardinality(v_matches), 0) = 0 then
        insert into public.global_suppliers(
          name,
          legal_name,
          tax_id
        )
        values (
          v_supplier.name,
          nullif(btrim(v_supplier.legal_name), ''),
          v_tax
        )
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
      update public.suppliers
      set
        global_supplier_id = v_global_id,
        updated_at = now()
      where id = v_supplier.id
        and tenant_id = v_document.tenant_id
        and venue_id = v_document.venue_id;
    end if;
  end if;

  if v_global_id is not null then
    -- Serialize equivalent profile lookups/inserts for this global supplier.
    perform id
    from public.global_suppliers
    where id = v_global_id
    for update;

    /*
     * A supplier line can have was_corrected=true simply because the user
     * linked it to an inventory item, warehouse, base quantity, etc.
     *
     * For parser learning, only changes to the original extracted fields
     * count as corrections.
     */
    select
      count(*),
      count(*) filter (
        where public.supplier_document_line_extraction_changed(line)
      )
    into
      v_line_count,
      v_correction_count
    from public.supplier_document_lines line
    where line.supplier_document_id = p_document_id
      and line.tenant_id = v_document.tenant_id
      and line.venue_id = v_document.venue_id;

    if v_document.extraction_metadata ->> 'profileParsedLineCount'
      ~ '^[1-9][0-9]{0,2}$'
    then
      v_parsed_count :=
        (v_document.extraction_metadata ->> 'profileParsedLineCount')::integer;
    end if;

    select *
    into v_previous
    from public.global_supplier_document_profiles
    where id = p_previous_profile_id
      and document_type = v_document.document_type
      and status in ('candidate', 'verified', 'active');

    v_rules := nullif(
      v_document.extraction_metadata -> 'lineParserProfile',
      'null'::jsonb
    );

    -- A known deterministic profile may predate profileParsedLineCount metadata
    -- or have lost its tentative ID when the user selected another supplier.
    if v_document.extraction_metadata ->> 'parserMode' = 'deterministic' then
      v_rules := coalesce(v_rules, v_previous.rules_json);

      if v_document.extraction_metadata ->> 'profileParsedLineCount' is null
        and v_rules is not null
      then
        v_parsed_count := v_line_count;
      end if;
    end if;

    v_profile_pending :=
      v_document.extraction_metadata #>> '{profileValidation,reason}'
        = 'PROFILE_VALIDATION_PENDING';

    v_profile_valid :=
      v_line_count > 0
      and (
        v_profile_pending
        or (
          v_parsed_count between 1 and 500
          and (
            v_document.extraction_metadata
              #> '{profileValidation,candidate}' = 'true'::jsonb

            or (
              v_document.extraction_metadata ->> 'parserMode' = 'deterministic'
              and v_document.extraction_metadata
                #> '{profileValidation,candidate}'
                is distinct from 'false'::jsonb
            )

            or (
              v_document.extraction_metadata ->> 'linesReparsedAt' is not null
              and v_document.extraction_metadata ->> 'linesSupplierId'
                = v_supplier.id::text
            )
          )
        )
      );

    -- Pending proposals have only passed schema validation, never execution.
    -- Defend the persistence boundary against missing/legacy malformed metadata.
    v_profile_valid :=
      coalesce(v_profile_valid, false)
      and jsonb_typeof(v_rules) = 'object'
      and v_rules ->> 'version' = '1'
      and case
        when jsonb_typeof(v_rules -> 'requiredTexts') = 'array'
          then jsonb_array_length(v_rules -> 'requiredTexts') between 1 and 20
        else false
      end
      and case
        when jsonb_typeof(v_rules -> 'columns') = 'array'
          then jsonb_array_length(v_rules -> 'columns') between 3 and 16
        else false
      end;

    if v_profile_valid then
      select id
      into v_profile_id
      from public.global_supplier_document_profiles
      where global_supplier_id = v_global_id
        and document_type = v_document.document_type
        and rules_json = v_rules
        and status in ('candidate', 'verified', 'active')
      order by
        case when status in ('verified', 'active') then 0 else 1 end,
        success_count desc,
        created_at,
        id
      limit 1;

      if v_profile_id is not null then
        v_profile_mode := 'existing';
        v_profile_reason := null;

      elsif exists (
        select 1
        from public.global_supplier_document_profiles
        where global_supplier_id = v_global_id
          and document_type = v_document.document_type
          and rules_json = v_rules
          and status = 'deprecated'
      ) then
        v_profile_reason := 'profile_deprecated';

      else
        v_profile_id := public.create_supplier_parser_candidate(
          v_global_id,
          v_document.document_type,
          v_rules,
          case
            when v_previous.global_supplier_id = v_global_id
              then v_previous.id
          end
        );

        v_profile_mode := 'created';
        v_profile_reason := null;
      end if;

      if v_profile_id is not null
        and not coalesce(v_profile_pending, false)
      then
        update public.global_supplier_document_profiles
        set
          success_count = success_count + 1,
          correction_count = correction_count + v_correction_count,
          updated_at = now()
        where id = v_profile_id;
      end if;
    end if;

  else
    v_profile_reason := 'global_supplier_unresolved';
  end if;

  update public.supplier_documents
  set
    global_supplier_id = v_global_id,
    global_profile_id = v_profile_id,
    extraction_metadata =
      extraction_metadata
      || jsonb_build_object(
        'globalSupplierResolution',
        jsonb_build_object(
          'mode', v_supplier_mode,
          'globalSupplierId', v_global_id,
          'reason', v_supplier_reason
        ),
        'globalProfileResolution',
        jsonb_build_object(
          'mode', v_profile_mode,
          'globalProfileId', v_profile_id,
          'reason', v_profile_reason
        )
      ),
    updated_at = now()
  where id = p_document_id;
end;
$$;

revoke all on function
  public.learn_confirmed_supplier_document_global_knowledge_base(uuid, uuid)
from public, anon, authenticated;

commit;