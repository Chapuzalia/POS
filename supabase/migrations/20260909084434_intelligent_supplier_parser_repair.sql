begin;

-- Proposals are isolated from the profile that actually extracted the invoice.
-- This service-only boundary never updates active rules, counts or statuses.
create function public.record_supplier_parser_repair_proposal(p_document_id uuid, p_proposal jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare d public.supplier_documents%rowtype; p public.global_supplier_document_profiles%rowtype;
  v_id uuid; v_parent uuid; v_rules jsonb := p_proposal -> 'rules';
begin
  select * into strict d from public.supplier_documents where id = p_document_id for update;
  if d.status not in ('review', 'confirmed') or d.extraction_metadata -> 'parserRepairProposal' is distinct from p_proposal
    then raise exception 'PROFILE_REPAIR_PROPOSAL_STALE' using errcode = '40001'; end if;
  if coalesce(p_proposal ->> 'decision','') not in ('repair', 'new_layout') or jsonb_typeof(v_rules) is distinct from 'object'
    or v_rules ->> 'version' is distinct from '1' then raise exception 'PROFILE_REPAIR_PROPOSAL_INVALID'; end if;
  if d.global_supplier_id is not null and not coalesce(public.supplier_document_learning_excluded(d.id),false) then
    perform id from public.global_suppliers where id=d.global_supplier_id for update;
  end if;
  select * into p from public.global_supplier_document_profiles
    where id::text = p_proposal ->> 'sourceProfileId' and document_type = d.document_type
      and status in ('verified', 'active') for share;
  if p.id is null then raise exception 'PROFILE_REPAIR_SOURCE_NOT_ACTIVE'; end if;
  v_parent := case when p_proposal ->> 'decision' = 'repair' then p.id end;
  if (p_proposal ->> 'parentProfileId') is distinct from v_parent::text then raise exception 'PROFILE_REPAIR_PARENT_INVALID'; end if;
  if public.supplier_document_learning_excluded(d.id) or d.global_supplier_id is null then
    update public.supplier_documents set extraction_metadata = extraction_metadata || jsonb_build_object(
      'parserRepairCandidate', jsonb_build_object('scope','local','status','candidate','profileId',null,
        'sourceProfileId',p.id,'parentProfileId',v_parent,'validation','pending')) where id=d.id;
    return null;
  end if;
  if p.global_supplier_id is distinct from d.global_supplier_id then raise exception 'PROFILE_REPAIR_SUPPLIER_MISMATCH'; end if;
  select id into v_id from public.global_supplier_document_profiles where global_supplier_id=d.global_supplier_id
    and document_type=d.document_type and status='candidate' and rules_json=v_rules
    and parent_profile_id is not distinct from v_parent order by created_at,id limit 1;
  if v_id is null then
    insert into public.global_supplier_document_profiles(global_supplier_id,document_type,rules_json,fingerprint_json,status,parent_profile_id)
      values(d.global_supplier_id,d.document_type,v_rules,jsonb_build_object('requiredTexts',v_rules->'requiredTexts'),'candidate',v_parent)
      returning id into v_id;
  end if;
  update public.supplier_documents set extraction_metadata=extraction_metadata || jsonb_build_object(
    'parserRepairCandidate',jsonb_build_object('scope','global','status','candidate','profileId',v_id,
      'sourceProfileId',p.id,'parentProfileId',v_parent,'validation','pending')) where id=d.id;
  return v_id;
end;
$$;
revoke all on function public.record_supplier_parser_repair_proposal(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_supplier_parser_repair_proposal(uuid,jsonb) to service_role;

create or replace function public.supplier_profile_repair_evidence(p_document_id uuid)
returns text language sql stable set search_path to '' as $$
  select md5(jsonb_build_object('ocr',d.ocr_snapshot,'supplier',d.supplier_id,'global',d.global_supplier_id,
    'type',d.document_type,'date',d.document_date,'number',d.document_number,'profile',d.global_profile_id,
    'metadata',d.extraction_metadata->'metadataExtraction',
    'lines',(select jsonb_agg(to_jsonb(l) order by l.line_number,l.id)
      from public.supplier_document_lines l where l.supplier_document_id=d.id))::text)
  from public.supplier_documents d where d.id=p_document_id;
$$;

create or replace function public.claim_supplier_profile_repair(p_document_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare d public.supplier_documents%rowtype; s public.suppliers%rowtype;
  p public.global_supplier_document_profiles%rowtype; v_token uuid := gen_random_uuid(); v_attempts integer;
  v_evidence text;
begin
  select * into d from public.supplier_documents where id=p_document_id for update;
  if d.id is null or d.status <> 'confirmed' or coalesce(public.supplier_document_learning_excluded(d.id),false)
    or d.global_supplier_id is null then return null; end if;
  if d.extraction_metadata->>'profileRepairPending' is distinct from 'true' and not exists (
    select 1 from jsonb_each(coalesce(d.extraction_metadata->'metadataExtraction','{}')) m
      where m.key in ('date','number') and (m.value->>'userModified'='true' or m.value->>'profileFailed'='true')
  ) then return null; end if;
  if d.extraction_metadata #>> '{profileRepair,status}'='processing'
    and (d.extraction_metadata #>> '{profileRepair,startedAt}')::timestamptz > now()-interval '5 minutes' then return null; end if;
  v_evidence := public.supplier_profile_repair_evidence(d.id);
  if d.extraction_metadata #>> '{profileRepair,evidence}'=v_evidence
    and d.extraction_metadata #>> '{profileRepair,status}' in ('candidate','no_change') then return null; end if;
  v_attempts := coalesce((d.extraction_metadata #>> '{profileRepair,attempts}')::integer,0);
  if v_attempts >= 3 then return null; end if;
  select * into s from public.suppliers where id=d.supplier_id and tenant_id=d.tenant_id
    and venue_id=d.venue_id and global_supplier_id=d.global_supplier_id;
  if s.id is null then return null; end if;
  select * into p from public.global_supplier_document_profiles where global_supplier_id=d.global_supplier_id
    and document_type=d.document_type and status in ('verified','active')
    and (id=d.global_profile_id or id::text=d.extraction_metadata #>> '{parserRepairProposal,sourceProfileId}')
    order by case when id=d.global_profile_id then 0 else 1 end limit 1;
  if p.id is null then return null; end if;
  update public.supplier_documents set extraction_metadata=extraction_metadata || jsonb_build_object(
    'profileRepair',jsonb_build_object('status','processing','token',v_token,'startedAt',now(),
      'attempts',v_attempts+1,'evidence',v_evidence,'sourceProfileId',p.id)) where id=d.id;
  return jsonb_build_object('token',v_token,'document',to_jsonb(d),'supplier',to_jsonb(s),'profile',to_jsonb(p),
    'lines',(select jsonb_agg(to_jsonb(l) order by l.line_number,l.id) from public.supplier_document_lines l where l.supplier_document_id=d.id));
end;
$$;

-- Keep legacy five-argument calls compatible, but never accept unscoped rules.
drop function public.finish_supplier_profile_repair(uuid,uuid,jsonb,text,jsonb);
create function public.finish_supplier_profile_repair(p_document_id uuid,p_token uuid,
  p_rules jsonb,p_error text,p_traces jsonb,p_proposal jsonb default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare d public.supplier_documents%rowtype; v_id uuid; v_error text := p_error;
begin
  select * into d from public.supplier_documents where id=p_document_id for update;
  if d.id is null or d.extraction_metadata #>> '{profileRepair,token}' is distinct from p_token::text
    or d.extraction_metadata #>> '{profileRepair,status}' is distinct from 'processing' then return null; end if;
  if d.status <> 'confirmed' or coalesce(public.supplier_document_learning_excluded(d.id),false)
    or d.extraction_metadata #>> '{profileRepair,evidence}' is distinct from public.supplier_profile_repair_evidence(d.id)
    then v_error := 'PROFILE_REPAIR_EVIDENCE_CHANGED'; end if;
  if v_error is null and (p_proposal is null or coalesce(p_proposal->>'decision','') not in ('repair','new_layout','no_change')
    or p_proposal->>'sourceProfileId' is distinct from d.extraction_metadata #>> '{profileRepair,sourceProfileId}')
    then v_error := 'PROFILE_REPAIR_PROPOSAL_INVALID'; end if;
  if v_error is null and p_proposal->>'decision' <> 'no_change' then
    if p_rules is distinct from p_proposal->'rules' then v_error := 'PROFILE_REPAIR_RULES_MISMATCH';
    else
      begin
        update public.supplier_documents set extraction_metadata=extraction_metadata || jsonb_build_object('parserRepairProposal',p_proposal) where id=d.id;
        v_id := public.record_supplier_parser_repair_proposal(d.id,p_proposal);
      exception when others then v_error := sqlerrm;
      end;
    end if;
  end if;
  update public.supplier_documents set extraction_metadata=extraction_metadata || jsonb_build_object(
    'profileRepairPending',false,'profileRepair',coalesce(extraction_metadata->'profileRepair','{}') || jsonb_build_object(
      'status',case when v_error is not null then 'rejected' when v_id is not null then 'candidate' else 'no_change' end,
      'finishedAt',now(),'error',v_error,'proposal',p_proposal,'candidateProfileId',v_id,'aiResponses',coalesce(p_traces,'[]')))
    where id=d.id;
  return v_id;
end;
$$;
revoke all on function public.finish_supplier_profile_repair(uuid,uuid,jsonb,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.finish_supplier_profile_repair(uuid,uuid,jsonb,text,jsonb,jsonb) to service_role;

commit;
