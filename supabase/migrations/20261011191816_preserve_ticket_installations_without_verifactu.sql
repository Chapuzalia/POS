-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Retains RPC signatures, authorization and idempotent requests; local numbering shares the existing ledger, and activation retires identities without deleting historical records. New reads remain scoped and authenticated.
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Installed clients can still synchronize legacy sales generated before this expand.
alter table public.tenant_verifactu_integrations add column local_records_required_at timestamptz default now();
insert into public.tenant_verifactu_integrations(tenant_id) select id from public.tenants on conflict (tenant_id) do nothing;
alter table public.fiscal_sif_installations add column retired_for_verifactu_at timestamptz;

create or replace function public.fiscal_bridge_identity_marker() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    -- Also serializes older activation RPCs with tenant-wide activation.
    perform 1 from public.tenants where id = new.tenant_id for update;
    new.bridge_requested := exists(select 1 from public.tenant_verifactu_integrations
      where tenant_id = new.tenant_id and enabled_at is not null);
  elsif new.bridge_requested is distinct from old.bridge_requested then
    raise exception 'FISCAL_BRIDGE_IDENTITY_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function public.fiscal_bridge_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.bridge_requested then
    insert into public.fiscal_bridge_requests(installation_id, bridge_url)
      values(new.id, (select bridge_url from public.fiscal_pos_bridge_settings where tenant_id = new.tenant_id));
  end if;
  return new;
end;
$$;

-- A retired local identity can only be replaced automatically through the dialog
-- when retirement was caused by this tenant's Verifactu activation.
create function public.pos_verifactu_retired_identity(p_tenant_id uuid, p_venue_id uuid, p_register_id uuid, p_device_id uuid, p_installation_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select auth.uid() is not null and public.user_has_device_access(p_tenant_id, p_venue_id, p_device_id) and exists(
    select 1 from public.fiscal_sif_installations i
    join public.tenant_verifactu_integrations integration on integration.tenant_id = i.tenant_id
    where i.id = p_installation_id and i.tenant_id = p_tenant_id and i.venue_id = p_venue_id
      and i.cash_register_id = p_register_id and i.device_id = p_device_id
      and i.retired_at is not null and i.retired_for_verifactu_at = integration.enabled_at
  );
$$;
revoke all on function public.pos_verifactu_retired_identity(uuid,uuid,uuid,uuid,uuid) from public, anon;
grant execute on function public.pos_verifactu_retired_identity(uuid,uuid,uuid,uuid,uuid) to authenticated;

create or replace function public.fiscal_local_require_sale_record() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists(select 1 from public.tenant_verifactu_integrations integration
    where integration.tenant_id = new.tenant_id
      and new.local_created_at >= least(integration.local_records_required_at, integration.enabled_at)
  ) and coalesce(current_setting('app.local_fiscal_sale', true), '') <> 'yes' then
    raise exception 'LOCAL_FISCAL_RECORD_REQUIRED' using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function public.configure_verifactu_integration(p_tenant_id uuid, p_bridge_url text, p_producer_name text,
  p_producer_nif text, p_system_id text, p_system_version text, p_activate boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result public.tenant_verifactu_integrations;
begin
  if auth.uid() is null or not public.user_is_superadmin() then
    raise exception 'Solo el superadmin puede configurar y activar Verifactu' using errcode = '42501';
  end if;
  perform 1 from public.tenants where id = p_tenant_id for update;
  select * into result from public.tenant_verifactu_integrations where tenant_id = p_tenant_id for update;
  if not found or result.requested_at is null then
    raise exception 'El cliente no ha solicitado Verifactu' using errcode = '23514';
  end if;
  if (p_activate or result.enabled_at is not null) and nullif(trim(p_bridge_url), '') is null then
    raise exception 'Configura la URL del puente antes de activar Verifactu' using errcode = '23514';
  end if;
  insert into public.fiscal_pos_bridge_settings(tenant_id, bridge_url, producer_name, producer_nif, system_id, system_version, aeat_environment, print_ticket_qr)
  values (p_tenant_id, nullif(trim(p_bridge_url), ''), trim(p_producer_name), upper(trim(p_producer_nif)), upper(trim(p_system_id)), trim(p_system_version), result.aeat_environment, result.print_ticket_qr)
  on conflict (tenant_id) do update set bridge_url = excluded.bridge_url, producer_name = excluded.producer_name,
    producer_nif = excluded.producer_nif, system_id = excluded.system_id, system_version = excluded.system_version;
  if p_activate and result.enabled_at is null then
    -- Finish any in-flight record commits before recording the retirement boundary.
    perform 1 from public.fiscal_sif_installations where tenant_id = p_tenant_id and retired_at is null order by id for update;
    update public.tenant_verifactu_integrations set enabled_at = clock_timestamp(), enabled_by = auth.uid()
    where tenant_id = p_tenant_id returning * into result;
    update public.fiscal_sif_installations set retired_at = result.enabled_at, retired_for_verifactu_at = result.enabled_at
    where tenant_id = p_tenant_id and retired_at is null;
  end if;
  return to_jsonb(result);
end;
$$;

create or replace function public.activate_pwa_fiscal_installation(
  p_tenant_id uuid, p_venue_id uuid, p_register_id uuid, p_device_id uuid,
  p_request_id uuid, p_expected_installation_id uuid, p_recover_for_testing boolean default false
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  prior public.fiscal_sif_installations%rowtype;
  historical public.fiscal_sif_installations%rowtype;
  retry public.fiscal_pwa_activation_requests%rowtype;
  subject_id uuid;
  new_id uuid := gen_random_uuid();
  venue_code text;
  register_code text;
begin
  if auth.uid() is null or p_request_id is null or p_recover_for_testing is null
    or not public.user_has_device_access(p_tenant_id, p_venue_id, p_device_id)
    or not exists (select 1 from public.cash_registers where id = p_register_id and tenant_id = p_tenant_id and venue_id = p_venue_id and is_active)
    or not exists (select 1 from public.devices where id = p_device_id and tenant_id = p_tenant_id and venue_id = p_venue_id and is_active and can_take_payments) then
    raise exception 'FISCAL_ACTIVATION_FORBIDDEN' using errcode = '42501';
  end if;
  perform 1 from public.tenants where id = p_tenant_id for update;
  insert into public.tenant_verifactu_integrations(tenant_id) values(p_tenant_id) on conflict (tenant_id) do nothing;
  -- Lock ordering matches CRM setup: venue first, register second; serialize concurrent confirmations.
  perform 1 from public.venues where id = p_venue_id and tenant_id = p_tenant_id for update;
  perform pg_advisory_xact_lock(hashtextextended('fiscal-pwa:' || p_tenant_id::text || ':' || p_register_id::text, 0));
  if p_recover_for_testing and not exists (select 1 from public.fiscal_pos_bridge_settings where tenant_id = p_tenant_id and aeat_environment = 'test') then
    raise exception 'FISCAL_TEST_RECOVERY_FORBIDDEN' using errcode = '42501';
  end if;
  select * into retry from public.fiscal_pwa_activation_requests where tenant_id = p_tenant_id and request_id = p_request_id;
  if retry.request_id is not null then
    if (retry.venue_id, retry.cash_register_id, retry.device_id, retry.recover_for_testing)
      is distinct from (p_venue_id, p_register_id, p_device_id, p_recover_for_testing) then
      raise exception 'FISCAL_ACTIVATION_REQUEST_CONFLICT' using errcode = '23505';
    end if;
    if not exists (select 1 from public.fiscal_sif_installations where id = retry.installation_id and retired_at is null) then
      raise exception 'FISCAL_ACTIVATION_ALREADY_RETIRED' using errcode = '55000';
    end if;
    return retry.installation_id;
  end if;
  select * into prior from public.fiscal_sif_installations
    where tenant_id = p_tenant_id and cash_register_id = p_register_id and retired_at is null for update;
  if prior.id is distinct from p_expected_installation_id then
    raise exception 'FISCAL_ACTIVATION_CONFIRMATION_STALE' using errcode = '55000';
  end if;
  if p_recover_for_testing then
    if prior.id is null or prior.device_id <> p_device_id or prior.mode <> 'production'
      or not exists (select 1 from public.fiscal_pos_bridge_settings where tenant_id = p_tenant_id and aeat_environment = 'test') then
      raise exception 'FISCAL_TEST_RECOVERY_FORBIDDEN' using errcode = '42501';
    end if;
    new_id := prior.id;
  else
    select fiscal_code into venue_code from public.venues where id = p_venue_id and tenant_id = p_tenant_id;
    select * into historical from public.fiscal_sif_installations
      where tenant_id = p_tenant_id and cash_register_id = p_register_id order by installation_sequence desc limit 1;
    subject_id := historical.fiscal_subject_id;
    if subject_id is null then
      if (select count(*) from public.fiscal_subjects where tenant_id = p_tenant_id) <> 1 then
        raise exception 'FISCAL_SUBJECT_SETUP_REQUIRED' using errcode = '55000';
      end if;
      select id into subject_id from public.fiscal_subjects where tenant_id = p_tenant_id;
    end if;
    if venue_code is null then raise exception 'FISCAL_VENUE_SETUP_REQUIRED' using errcode = '55000'; end if;
    select r.fiscal_code into register_code from public.cash_registers r where r.id = p_register_id and r.tenant_id = p_tenant_id;
    register_code := coalesce(register_code, historical.register_code);
    if register_code is null then
      select 'C' || (coalesce(max(substring(r.fiscal_code from '^C([0-9]+)$')::integer), 0) + 1)::text
        into register_code from public.cash_registers r where r.tenant_id = p_tenant_id and r.venue_id = p_venue_id;
    end if;
    -- A device active on a different register needs explicit reconciliation, not implicit retirement.
    if exists (select 1 from public.fiscal_sif_installations where tenant_id = p_tenant_id and device_id = p_device_id and retired_at is null and cash_register_id <> p_register_id) then
      raise exception 'FISCAL_DEVICE_REGISTER_CONFLICT' using errcode = '55000';
    end if;
    if prior.id is not null then update public.fiscal_sif_installations set retired_at = clock_timestamp() where id = prior.id; end if;
    insert into public.fiscal_sif_installations(id, tenant_id, fiscal_subject_id, venue_id, cash_register_id, device_id,
      installation_number, venue_code, register_code, installation_code, mode, series_version)
    values (new_id, p_tenant_id, subject_id, p_venue_id, p_register_id, p_device_id,
      'allocated-by-trigger', venue_code, register_code, upper(substr(replace(new_id::text, '-', ''), 1, 8)), 'production', 2);
  end if;
  -- Same local development producer defaults used by the historical ledger migration. Superadmin replaces them before remittance.
  insert into public.fiscal_pos_bridge_settings(tenant_id, bridge_url, producer_name, producer_nif, system_id, system_version, aeat_environment, print_ticket_qr)
  select p_tenant_id, null, 'Alteil Solutions, S.L.', 'B12345678', 'TK', '1.0.0', aeat_environment, print_ticket_qr
  from public.tenant_verifactu_integrations where tenant_id = p_tenant_id on conflict (tenant_id) do nothing;
  insert into public.fiscal_pwa_activation_requests(tenant_id, request_id, venue_id, cash_register_id, device_id, installation_id, recover_for_testing)
    values (p_tenant_id, p_request_id, p_venue_id, p_register_id, p_device_id, new_id, p_recover_for_testing);
  return new_id;
end;
$$;

create or replace function public.fiscal_bridge_pending(p_bridge_url text, p_after bigint default 0)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_data order by sequence), '[]'::jsonb) from (
    select q.sequence, jsonb_build_object('sequence',q.sequence,'installation',to_jsonb(i),'subject',to_jsonb(s)) as row_data
    from public.fiscal_bridge_requests q
    join public.fiscal_sif_installations i on i.id=q.installation_id
    join public.fiscal_subjects s on s.id=i.fiscal_subject_id and s.tenant_id=i.tenant_id
    join public.fiscal_pos_bridge_settings c on c.tenant_id=i.tenant_id
    where i.bridge_requested and i.retired_for_verifactu_at is null and exists(select 1 from public.tenant_verifactu_integrations integration where integration.tenant_id=i.tenant_id and integration.enabled_at is not null) and q.provisioned_at is null and q.sequence>p_after and i.mode='production'
      and rtrim(coalesce(q.bridge_url,c.bridge_url),'/')=rtrim(p_bridge_url,'/')
    order by q.sequence limit 100
  ) pending;
$$;

create or replace function public.fiscal_bridge_authorize(p_installation_id uuid, p_bridge_url text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('installation',to_jsonb(i),'subject',to_jsonb(s),'aeatEnvironment',c.aeat_environment)
  from public.fiscal_sif_installations i
  join public.fiscal_subjects s on s.id=i.fiscal_subject_id and s.tenant_id=i.tenant_id
  join public.fiscal_pos_bridge_settings c on c.tenant_id=i.tenant_id
  where i.retired_for_verifactu_at is null and exists(select 1 from public.tenant_verifactu_integrations integration where integration.tenant_id=i.tenant_id and integration.enabled_at is not null) and auth.uid() is not null and i.id=p_installation_id and i.bridge_requested
    and rtrim(c.bridge_url,'/')=rtrim(p_bridge_url,'/')
    and public.user_has_device_access(i.tenant_id,i.venue_id,i.device_id)
    and exists(select 1 from public.devices d where d.id=i.device_id and d.tenant_id=i.tenant_id
      and d.venue_id=i.venue_id and d.is_active and d.can_take_payments);
$$;

create or replace function public.fiscal_bridge_confirm_record(p_installation_id uuid,p_record_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('record',r.record_envelope,'snapshot',r.invoice_snapshot,'reason',r.economic_snapshot->>'reason')
  from public.fiscal_local_records r join public.fiscal_sif_installations i on i.id=r.installation_id and i.tenant_id=r.tenant_id
  where i.retired_for_verifactu_at is null and exists(select 1 from public.tenant_verifactu_integrations integration where integration.tenant_id=i.tenant_id and integration.enabled_at is not null) and auth.uid() is not null and i.id=p_installation_id and i.bridge_requested and r.id=p_record_id
    and public.user_has_device_access(i.tenant_id,i.venue_id,i.device_id);
$$;
