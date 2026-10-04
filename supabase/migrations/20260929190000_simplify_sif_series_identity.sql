-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserves routine signatures, permissions and behavior while changing only SIF series validation; the reset RPC is explicitly admin-confirmed and development-only.
set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.venues add column if not exists fiscal_code text;
create unique index if not exists venues_tenant_fiscal_code_idx on public.venues (tenant_id, fiscal_code) where fiscal_code is not null;
alter table public.fiscal_sif_installations drop constraint if exists fiscal_sif_installations_register_code_check;
alter table public.fiscal_sif_installations add constraint fiscal_sif_installations_register_code_check check (register_code ~ '^C[1-9][0-9]*$') not valid;

-- Keep setup identity compatible with the latest deployed setup contract.
create or replace function public.save_fiscal_sif_setup(p_tenant_id uuid,p_legal_name text,p_nif text,p_installations jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_subject public.fiscal_subjects%rowtype; v_item jsonb; v_venue public.venues%rowtype; v_register public.cash_registers%rowtype; v_device public.devices%rowtype; v_installation public.fiscal_sif_installations%rowtype; v_replaced public.fiscal_sif_installations%rowtype; v_existing_subject public.fiscal_subjects%rowtype; v_installation_id uuid; v_replace_installation_id uuid; v_result jsonb := '[]'::jsonb; v_legal_name text := btrim(p_legal_name); v_nif text := upper(btrim(p_nif)); v_installation_number text; v_venue_code text; v_register_code text; v_installation_code text; v_next_register_number integer;
begin
 if p_tenant_id is null or not public.user_is_tenant_admin(p_tenant_id) then raise exception 'FISCAL_SETUP_FORBIDDEN' using errcode='42501'; end if;
 if v_legal_name='' or char_length(v_legal_name)>120 or v_nif !~ '^[A-Z0-9]{9}$' or jsonb_typeof(p_installations)<>'array' or jsonb_array_length(p_installations)=0 then raise exception 'FISCAL_SETUP_INVALID' using errcode='22023'; end if;
 select * into v_existing_subject from public.fiscal_subjects where tenant_id=p_tenant_id order by created_at limit 1 for update;
 if v_existing_subject.id is null then insert into public.fiscal_subjects(tenant_id,legal_name,nif) values(p_tenant_id,v_legal_name,v_nif) returning * into v_subject; else update public.fiscal_subjects set legal_name=v_legal_name,nif=v_nif where id=v_existing_subject.id returning * into v_subject; end if;
 for v_item in select value from jsonb_array_elements(p_installations) loop
  v_installation_id=nullif(v_item->>'installationId','')::uuid; v_replace_installation_id=nullif(v_item->>'replaceInstallationId','')::uuid; v_installation_number=btrim(v_item->>'installationNumber'); v_venue_code=upper(btrim(v_item->>'venueCode')); v_installation_code=upper(btrim(v_item->>'installationCode'));
  if (v_installation_id is not null and v_replace_installation_id is not null) or nullif(v_item->>'venueId','') is null or nullif(v_item->>'cashRegisterId','') is null or nullif(v_item->>'deviceId','') is null or v_installation_number='' or v_venue_code !~ '^[A-Z0-9]{1,8}$' or v_installation_code !~ '^[A-Z0-9]{1,8}$' then raise exception 'FISCAL_INSTALLATION_INVALID' using errcode='22023'; end if;
  select * into v_venue from public.venues where id=(v_item->>'venueId')::uuid and tenant_id=p_tenant_id for update; select * into v_register from public.cash_registers where id=(v_item->>'cashRegisterId')::uuid and tenant_id=p_tenant_id and venue_id=v_venue.id; select * into v_device from public.devices where id=(v_item->>'deviceId')::uuid and tenant_id=p_tenant_id and venue_id=v_venue.id;
  if v_venue.id is null or v_register.id is null or v_device.id is null then raise exception 'FISCAL_INSTALLATION_SCOPE_MISMATCH' using errcode='23514'; end if;
  if v_venue.fiscal_code is null then update public.venues set fiscal_code=v_venue_code where id=v_venue.id returning * into v_venue; elsif v_venue.fiscal_code<>v_venue_code then raise exception 'FISCAL_VENUE_CODE_IMMUTABLE' using errcode='55000'; end if;
  if v_installation_id is null then
   if v_replace_installation_id is not null then select * into v_replaced from public.fiscal_sif_installations where id=v_replace_installation_id and tenant_id=p_tenant_id for update; if v_replaced.id is null or v_replaced.retired_at is not null or v_replaced.fiscal_subject_id<>v_subject.id or v_replaced.venue_id<>v_venue.id or (v_replaced.cash_register_id<>v_register.id and v_replaced.device_id<>v_device.id) then raise exception 'FISCAL_INSTALLATION_REPLACEMENT_MISMATCH' using errcode='23514'; end if; update public.fiscal_sif_installations set retired_at=clock_timestamp() where id=v_replaced.id; v_register_code=v_replaced.register_code;
   else perform pg_advisory_xact_lock(hashtextextended(v_venue.id::text,0)); select coalesce(max(nullif(regexp_replace(i.register_code,'[^0-9]','','g'),'')::integer),0)+1 into v_next_register_number from public.fiscal_sif_installations i where i.tenant_id=p_tenant_id and i.venue_id=v_venue.id; v_register_code='C'||v_next_register_number::text; end if;
   insert into public.fiscal_sif_installations(tenant_id,fiscal_subject_id,venue_id,cash_register_id,device_id,installation_number,venue_code,register_code,installation_code,mode) values(p_tenant_id,v_subject.id,v_venue.id,v_register.id,v_device.id,v_installation_number,v_venue.fiscal_code,v_register_code,v_installation_code,'production') returning * into v_installation;
  else
   select * into v_installation from public.fiscal_sif_installations where id=v_installation_id and tenant_id=p_tenant_id for update;
   if v_installation.id is null or v_installation.retired_at is not null or v_installation.fiscal_subject_id<>v_subject.id or (v_installation.venue_id,v_installation.cash_register_id,v_installation.device_id,v_installation.installation_number,v_installation.venue_code,v_installation.register_code,v_installation.installation_code) is distinct from (v_venue.id,v_register.id,v_device.id,v_installation_number,v_venue.fiscal_code,v_installation.register_code,v_installation_code) then raise exception 'FISCAL_INSTALLATION_IMMUTABLE' using errcode='55000'; end if;
   if v_installation.mode='disabled' then update public.fiscal_sif_installations set mode='production' where id=v_installation.id; end if;
  end if;
  v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_installation.id,'venueId',v_installation.venue_id,'cashRegisterId',v_installation.cash_register_id,'deviceId',v_installation.device_id,'installationNumber',v_installation.installation_number,'registerCode',v_installation.register_code,'mode','production'));
 end loop;
 return jsonb_build_object('subject',jsonb_build_object('id',v_subject.id,'legalName',v_subject.legal_name,'nif',v_subject.nif),'installations',v_result);
end; $$;
revoke all on function public.save_fiscal_sif_setup(uuid,text,text,jsonb) from public,anon;
grant execute on function public.save_fiscal_sif_setup(uuid,text,text,jsonb) to authenticated;

-- Recreate the two latest routines from their installed definitions, changing only
-- the series exercise segment (3) and removing installation_code from the identity.
do $$ declare d text; begin
 select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='sync_local_fiscal_sale_created' and pg_get_function_identity_arguments(p.oid)='p_event_id uuid, p_payload jsonb, p_record jsonb, p_invoice jsonb';
 if d is not null then
  d:=replace(d,'split_part(v_series_name, ''-'', 4)::integer','split_part(v_series_name, ''-'', 3)::integer'); d:=replace(d,' || v_installation.installation_code || ''-''',''); d:=replace(d,'create function public.sync_local_fiscal_sale_created(','create or replace function public.sync_local_fiscal_sale_created('); execute d;
 end if;
 select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pay_restaurant_local_fiscal';
 if d is not null then
  d:=replace(d,'split_part(v_series_name, ''-'', 4)::integer','split_part(v_series_name, ''-'', 3)::integer'); d:=replace(d,' || v_installation.installation_code || ''-''',''); d:=replace(d,'create function public.pay_restaurant_local_fiscal(','create or replace function public.pay_restaurant_local_fiscal('); execute d;
 end if;
end $$;

-- Explicit, administrator-only development reset; tickets, sales and catalog are untouched.
create or replace function public.reset_fiscal_local_dev_data(p_tenant_id uuid) returns void language plpgsql security definer set search_path='' as $$ begin
 if current_user<>'postgres' or coalesce(current_setting('app.allow_fiscal_dev_reset',true),'')<>'yes' or p_tenant_id is null then raise exception 'FISCAL_DEV_RESET_FORBIDDEN' using errcode='42501'; end if;
 alter table public.fiscal_local_records disable trigger user; alter table public.fiscal_local_series disable trigger user; alter table public.fiscal_sif_installations disable trigger user;
 delete from public.fiscal_local_records where tenant_id=p_tenant_id; delete from public.fiscal_local_series where tenant_id=p_tenant_id; delete from public.fiscal_sif_installations where tenant_id=p_tenant_id; delete from public.fiscal_subjects where tenant_id=p_tenant_id;
 alter table public.fiscal_sif_installations enable trigger user; alter table public.fiscal_local_series enable trigger user; alter table public.fiscal_local_records enable trigger user;
exception when others then alter table public.fiscal_sif_installations enable trigger user; alter table public.fiscal_local_series enable trigger user; alter table public.fiscal_local_records enable trigger user; raise; end; $$;
revoke all on function public.reset_fiscal_local_dev_data(uuid) from public,anon,authenticated;
