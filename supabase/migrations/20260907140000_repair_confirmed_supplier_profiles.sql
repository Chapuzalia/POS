begin;

create function public.supplier_profile_repair_evidence(p_document_id uuid)
returns text language sql stable set search_path to '' as $$
  select md5(jsonb_build_object('ocr', d.ocr_snapshot, 'supplier', d.supplier_id,
    'global', d.global_supplier_id, 'type', d.document_type,
    'lines', (select jsonb_agg(to_jsonb(l) order by l.line_number, l.id)
      from public.supplier_document_lines l where l.supplier_document_id=d.id))::text)
  from public.supplier_documents d where d.id=p_document_id;
$$;
revoke all on function public.supplier_profile_repair_evidence(uuid) from public, anon, authenticated;

create function public.claim_supplier_profile_repair(p_document_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_supplier public.suppliers%rowtype;
  v_token uuid := gen_random_uuid();
  v_attempts integer;
begin
  select * into v_document from public.supplier_documents where id=p_document_id for update;
  if v_document.id is null or v_document.status <> 'confirmed'
    or coalesce(public.supplier_document_learning_excluded(p_document_id), false)
    or v_document.global_supplier_id is null
    or v_document.extraction_metadata ->> 'profileRepairPending' is distinct from 'true'
    then return null; end if;
  if v_document.extraction_metadata #>> '{profileRepair,status}' = 'processing'
    and (v_document.extraction_metadata #>> '{profileRepair,startedAt}')::timestamptz > now()-interval '5 minutes'
    then return null; end if;
  v_attempts := coalesce((v_document.extraction_metadata #>> '{profileRepair,attempts}')::integer, 0);
  if v_attempts >= 3 then return null; end if;
  select * into v_supplier from public.suppliers where id=v_document.supplier_id
    and tenant_id=v_document.tenant_id and venue_id=v_document.venue_id
    and global_supplier_id=v_document.global_supplier_id;
  if v_supplier.id is null then return null; end if;
  update public.supplier_documents set extraction_metadata = extraction_metadata ||
    jsonb_build_object('profileRepair', jsonb_build_object('status','processing','token',v_token,
      'startedAt',now(),'attempts',v_attempts+1,
      'evidence',public.supplier_profile_repair_evidence(p_document_id))) where id=p_document_id;
  return jsonb_build_object('token',v_token,'document',to_jsonb(v_document),'supplier',to_jsonb(v_supplier),
    'lines',(select jsonb_agg(to_jsonb(l) order by l.line_number,l.id)
      from public.supplier_document_lines l where l.supplier_document_id=p_document_id));
end;
$$;
revoke all on function public.claim_supplier_profile_repair(uuid) from public, anon, authenticated;
grant execute on function public.claim_supplier_profile_repair(uuid) to service_role;

create function public.finish_supplier_profile_repair(p_document_id uuid, p_token uuid,
  p_rules jsonb, p_error text, p_traces jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare
  v_document public.supplier_documents%rowtype;
  v_profile_id uuid;
  v_error text := p_error;
begin
  select * into v_document from public.supplier_documents where id=p_document_id for update;
  if v_document.id is null or v_document.extraction_metadata #>> '{profileRepair,token}' is distinct from p_token::text
    or v_document.extraction_metadata #>> '{profileRepair,status}' is distinct from 'processing'
    then return null; end if;
  if v_document.status <> 'confirmed' or coalesce(public.supplier_document_learning_excluded(p_document_id),false)
    or v_document.extraction_metadata #>> '{profileRepair,evidence}' is distinct from public.supplier_profile_repair_evidence(p_document_id)
    then v_error := 'PROFILE_REPAIR_EVIDENCE_CHANGED'; end if;
  if v_error is null and (jsonb_typeof(p_rules) is distinct from 'object'
    or p_rules->>'version' is distinct from '1') then v_error := 'PROFILE_REPAIR_RULES_MISSING'; end if;
  if v_error is null then
    perform id from public.global_suppliers where id=v_document.global_supplier_id for update;
    if exists(select 1 from public.global_supplier_document_profiles where global_supplier_id=v_document.global_supplier_id
      and document_type=v_document.document_type and rules_json=p_rules and status='deprecated') then
      v_error := 'PROFILE_DEPRECATED';
    else
      select id into v_profile_id from public.global_supplier_document_profiles
        where global_supplier_id=v_document.global_supplier_id and document_type=v_document.document_type
          and rules_json=p_rules and status in ('candidate','verified') order by created_at,id limit 1;
      if v_profile_id is null then
        insert into public.global_supplier_document_profiles(global_supplier_id,document_type,fingerprint_json,rules_json,status)
          values(v_document.global_supplier_id,v_document.document_type,
            jsonb_build_object('requiredTexts',p_rules->'requiredTexts'),p_rules,'candidate') returning id into v_profile_id;
      end if;
      update public.global_supplier_document_profiles set success_count=success_count+1,updated_at=now() where id=v_profile_id;
    end if;
  end if;
  update public.supplier_documents set
    global_profile_id=coalesce(v_profile_id,global_profile_id),
    extraction_metadata=extraction_metadata || jsonb_build_object('profileRepairPending',false,
      'profileRepair', (extraction_metadata->'profileRepair') || jsonb_build_object(
        'status',case when v_profile_id is null then 'rejected' else 'completed' end,
        'finishedAt',now(),'error',v_error,'aiResponses',coalesce(p_traces,'[]'::jsonb)))
      || case when v_profile_id is null then '{}'::jsonb else jsonb_build_object(
        'lineParserProfile',p_rules,'profileValidation',jsonb_build_object('candidate',true,'reason',null),
        'globalProfileResolution',jsonb_build_object('mode','repaired','globalProfileId',v_profile_id)) end
    where id=p_document_id;
  return v_profile_id;
end;
$$;
revoke all on function public.finish_supplier_profile_repair(uuid,uuid,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.finish_supplier_profile_repair(uuid,uuid,jsonb,text,jsonb) to service_role;
commit;
