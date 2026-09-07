begin;

-- Reprocessing replaces diagnostics; it must never erase a previous manual
-- supplier decision, including when a concurrent worker writes an old snapshot.
create function public.preserve_supplier_document_learning_exclusion()
returns trigger language plpgsql security invoker set search_path to '' as $$
begin
  if coalesce(old.extraction_metadata ->> 'learningExcluded' = 'true', false)
    or old.extraction_metadata ->> 'linesReparsedAt' is not null
    or old.extraction_metadata #>> '{supplierSelection,source}' = 'manual'
    or new.extraction_metadata ->> 'linesReparsedAt' is not null then
    new.extraction_metadata := coalesce(new.extraction_metadata, '{}') || jsonb_build_object(
      'learningExcluded', true,
      'learningExclusionReason', coalesce(old.extraction_metadata ->> 'learningExclusionReason', 'manual_supplier_selection'));
  end if;
  return new;
end;
$$;
revoke all on function public.preserve_supplier_document_learning_exclusion() from public, anon, authenticated;
create trigger preserve_supplier_document_learning_exclusion
  before update of extraction_metadata on public.supplier_documents
  for each row execute function public.preserve_supplier_document_learning_exclusion();

commit;
