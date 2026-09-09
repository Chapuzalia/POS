begin;

create function public.record_supplier_parser_candidate_ai_confirmation(
  p_profile_id uuid
)
returns jsonb
language plpgsql
set search_path to ''
as $$
declare
  v_profile public.global_supplier_document_profiles%rowtype;
begin
  update public.global_supplier_document_profiles
  set
    success_count = success_count + 1,
    updated_at = now()
  where id = p_profile_id
    and status in ('candidate', 'verified')
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'SUPPLIER_PARSER_CANDIDATE_NOT_EXECUTABLE'
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'profileId', v_profile.id,
    'status', v_profile.status,
    'successCount', v_profile.success_count
  );
end;
$$;

revoke all on function public.record_supplier_parser_candidate_ai_confirmation(uuid)
from public, anon, authenticated;

grant execute on function public.record_supplier_parser_candidate_ai_confirmation(uuid)
to service_role;

commit;
