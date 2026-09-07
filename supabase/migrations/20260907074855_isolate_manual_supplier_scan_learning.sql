begin;
-- Explicit supplier choices can re-use knowledge, but are not training evidence.
-- Keep the decision on the server and sticky throughout the document lifecycle.
alter function public.update_supplier_document_supplier(uuid, uuid)
  rename to update_supplier_document_supplier_before_learning_guard;
revoke all on function public.update_supplier_document_supplier_before_learning_guard(uuid, uuid) from public, anon, authenticated;
create function public.update_supplier_document_supplier(p_document_id uuid, p_supplier_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_result jsonb;
begin
  v_result := public.update_supplier_document_supplier_before_learning_guard(p_document_id, p_supplier_id);
  update public.supplier_documents set extraction_metadata = extraction_metadata ||
    jsonb_build_object('learningExcluded', true, 'learningExclusionReason', 'manual_supplier_selection')
    where id = p_document_id;
  return v_result;
end;
$$;
revoke all on function public.update_supplier_document_supplier(uuid, uuid) from public, anon, authenticated;
grant execute on function public.update_supplier_document_supplier(uuid, uuid) to authenticated;

create function public.supplier_document_learning_excluded(p_document_id uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce(extraction_metadata ->> 'learningExcluded' = 'true', false)
    or extraction_metadata ->> 'linesReparsedAt' is not null
    or extraction_metadata #>> '{supplierSelection,source}' = 'manual'
  from public.supplier_documents where id = p_document_id;
$$;
revoke all on function public.supplier_document_learning_excluded(uuid) from public, anon, authenticated;

alter function public.learn_confirmed_supplier_document_global_knowledge(uuid, uuid)
  rename to learn_confirmed_supplier_document_global_before_guard;
revoke all on function public.learn_confirmed_supplier_document_global_before_guard(uuid, uuid) from public, anon, authenticated;
create function public.learn_confirmed_supplier_document_global_knowledge(p_document_id uuid, p_previous_profile_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if public.supplier_document_learning_excluded(p_document_id) then
    update public.supplier_documents d set
      global_profile_id = (select p.id from public.global_supplier_document_profiles p
        join public.suppliers s on s.global_supplier_id = p.global_supplier_id
        where s.id = d.supplier_id and s.tenant_id = d.tenant_id and s.venue_id = d.venue_id
          and p.id = p_previous_profile_id and p.document_type = d.document_type),
      extraction_metadata = extraction_metadata || jsonb_build_object('learningExcluded', true,
        'globalProfileResolution', jsonb_build_object('mode', 'none', 'reason', 'manual_supplier_selection'))
      where d.id = p_document_id;
    return;
  end if;
  perform public.learn_confirmed_supplier_document_global_before_guard(p_document_id, p_previous_profile_id);
end;
$$;
revoke all on function public.learn_confirmed_supplier_document_global_knowledge(uuid, uuid) from public, anon, authenticated;

alter function public.learn_confirmed_supplier_document_metadata(uuid)
  rename to learn_confirmed_supplier_document_metadata_before_guard;
revoke all on function public.learn_confirmed_supplier_document_metadata_before_guard(uuid) from public, anon, authenticated;
create function public.learn_confirmed_supplier_document_metadata(p_document_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if public.supplier_document_learning_excluded(p_document_id) then
    update public.supplier_documents set extraction_metadata = jsonb_set(extraction_metadata,
      '{metadataExtraction}', coalesce(extraction_metadata -> 'metadataExtraction', '{}') ||
        jsonb_build_object('date', coalesce(extraction_metadata #> '{metadataExtraction,date}', '{}') ||
            jsonb_build_object('learningEligible', false),
          'number', coalesce(extraction_metadata #> '{metadataExtraction,number}', '{}') ||
            jsonb_build_object('learningEligible', false)))
      where id = p_document_id;
    return;
  end if;
  perform public.learn_confirmed_supplier_document_metadata_before_guard(p_document_id);
end;
$$;
revoke all on function public.learn_confirmed_supplier_document_metadata(uuid) from public, anon, authenticated;

alter function public.learn_confirmed_supplier_document_identities(uuid)
  rename to learn_confirmed_supplier_document_identities_before_guard;
revoke all on function public.learn_confirmed_supplier_document_identities_before_guard(uuid) from public, anon, authenticated;
create function public.learn_confirmed_supplier_document_identities(p_document_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if public.supplier_document_learning_excluded(p_document_id) then return; end if;
  perform public.learn_confirmed_supplier_document_identities_before_guard(p_document_id);
end;
$$;
revoke all on function public.learn_confirmed_supplier_document_identities(uuid) from public, anon, authenticated;

commit;

