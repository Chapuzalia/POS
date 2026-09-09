begin;

-- A manual supplier choice remains excluded from tenant metadata, aliases and
-- repair learning, but it may still confirm the globally reusable line parser.
create or replace function public.learn_confirmed_supplier_document_global_before_line_guard(
  p_document_id uuid,
  p_previous_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_metadata jsonb;
begin
  select extraction_metadata
  into v_metadata
  from public.supplier_documents
  where id = p_document_id;

  if public.supplier_document_learning_excluded(p_document_id)
    and not (
      coalesce(v_metadata ->> 'learningExcluded' = 'true', false)
      and v_metadata ->> 'learningExclusionReason' = 'manual_supplier_selection'
      and v_metadata ->> 'linesReparsedAt' is null
    )
  then
    update public.supplier_documents d
    set
      global_profile_id = (
        select p.id
        from public.global_supplier_document_profiles p
        join public.suppliers s on s.global_supplier_id = p.global_supplier_id
        where s.id = d.supplier_id
          and s.tenant_id = d.tenant_id
          and s.venue_id = d.venue_id
          and p.id = p_previous_profile_id
          and p.document_type = d.document_type
      ),
      extraction_metadata = extraction_metadata || jsonb_build_object(
        'learningExcluded', true,
        'globalProfileResolution', jsonb_build_object(
          'mode', 'none',
          'reason', 'manual_supplier_selection'
        )
      )
    where d.id = p_document_id;
    return;
  end if;

  perform public.learn_confirmed_supplier_document_global_before_guard(
    p_document_id,
    p_previous_profile_id
  );
end;
$$;

revoke all on function
  public.learn_confirmed_supplier_document_global_before_line_guard(uuid, uuid)
from public, anon, authenticated;

commit;
