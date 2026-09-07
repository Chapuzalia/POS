begin;

-- Keep tenant inventory mapping separate from corrections to the OCR output.
create function public.supplier_document_line_extraction_changed(p_line public.supplier_document_lines)
returns boolean language sql immutable set search_path to '' as $$
  select case
    when jsonb_typeof(p_line.raw_extraction_metadata -> 'originalExtraction') = 'object'
      then (p_line.raw_extraction_metadata -> 'originalExtraction') is distinct from
        (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(p_line))
          where key = any(array['supplier_reference','description_raw','barcode','quantity',
            'purchase_unit','unit_price','discount_amount','charges_amount','gross_cost',
            'net_cost','line_total','tax_rate']))
    else coalesce(p_line.was_corrected, false)
  end;
$$;
revoke all on function public.supplier_document_line_extraction_changed(public.supplier_document_lines)
  from public, anon, authenticated;

alter function public.learn_confirmed_supplier_document_global_knowledge(uuid, uuid)
  rename to learn_confirmed_supplier_document_global_before_line_guard;
revoke all on function public.learn_confirmed_supplier_document_global_before_line_guard(uuid, uuid)
  from public, anon, authenticated;

create function public.learn_confirmed_supplier_document_global_knowledge(p_document_id uuid, p_previous_profile_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_changed boolean;
begin
  select * into strict v_document from public.supplier_documents where id = p_document_id for update;
  if v_document.status <> 'confirmed' then
    raise exception 'SUPPLIER_DOCUMENT_NOT_CONFIRMED' using errcode = '55000';
  end if;
  if not coalesce(public.supplier_document_learning_excluded(p_document_id), false) then
    select coalesce(bool_or(public.supplier_document_line_extraction_changed(l)), false)
      or (v_document.extraction_metadata ->> 'profileParsedLineCount' is not null
        and (v_document.extraction_metadata ->> 'profileParsedLineCount') <> count(*)::text)
      into v_changed
    from public.supplier_document_lines l where l.supplier_document_id = p_document_id
      and l.tenant_id = v_document.tenant_id and l.venue_id = v_document.venue_id;
    if v_changed then
      -- The old validation compared the parser to its initial interpretation,
      -- not to these confirmed corrections. A repaired profile must be validated anew.
      update public.supplier_documents set extraction_metadata = extraction_metadata ||
        jsonb_build_object('profileValidation', jsonb_build_object('candidate', false,
          'reason', 'CONFIRMED_EXTRACTION_CHANGED'), 'profileRepairPending', true)
        where id = p_document_id;
    end if;
  end if;
  perform public.learn_confirmed_supplier_document_global_before_line_guard(p_document_id, p_previous_profile_id);
end;
$$;
revoke all on function public.learn_confirmed_supplier_document_global_knowledge(uuid, uuid)
  from public, anon, authenticated;
commit;
