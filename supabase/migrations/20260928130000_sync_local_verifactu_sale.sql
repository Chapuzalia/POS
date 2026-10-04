-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Older PWAs may coexist with this expand migration. A register enters this
-- strict path only after its installation is explicitly set to production.
create function public.fiscal_local_require_sale_record() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from public.fiscal_sif_installations i
    where i.tenant_id = new.tenant_id and i.venue_id = new.venue_id
      and i.cash_register_id = new.cash_register_id
      and i.retired_at is null and i.mode = 'production'
  ) and coalesce(current_setting('app.local_fiscal_sale', true), '') <> 'yes' then
    raise exception 'LOCAL_FISCAL_RECORD_REQUIRED' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger fiscal_local_sale_required before insert on public.sales
for each row execute function public.fiscal_local_require_sale_record();

create function public.sync_local_fiscal_sale_created(
  p_event_id uuid, p_payload jsonb, p_record jsonb, p_invoice jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := (p_payload -> 'ticket' ->> 'tenantId')::uuid;
  v_venue uuid := (p_payload -> 'ticket' ->> 'venueId')::uuid;
  v_register uuid := (p_payload -> 'ticket' ->> 'cashRegisterId')::uuid;
  v_device uuid := (p_payload -> 'ticket' ->> 'deviceId')::uuid;
  v_ticket uuid := (p_payload -> 'ticket' ->> 'id')::uuid;
  v_sale uuid := (p_payload -> 'sale' ->> 'id')::uuid;
  v_installation public.fiscal_sif_installations%rowtype;
  v_subject public.fiscal_subjects%rowtype;
  v_prior public.fiscal_local_records%rowtype;
  v_existing public.fiscal_local_records%rowtype;
  v_series public.fiscal_local_series%rowtype;
  v_record jsonb := p_record -> 'canonicalRecord' -> 'RegistroAlta';
  v_type text := v_record ->> 'TipoFactura';
  v_number bigint := (p_invoice ->> 'number')::bigint;
  v_series_name text := p_invoice ->> 'series';
  v_issued_at timestamptz := (p_invoice ->> 'issuedAt')::timestamptz;
  v_position bigint := (p_record ->> 'chainPosition')::bigint;
  v_previous_hash text := p_record -> 'previous' ->> 'hash';
  v_hash text := p_record ->> 'hash';
  v_idempotency uuid := (p_record ->> 'idempotencyKey')::uuid;
  v_customer uuid := nullif(p_payload -> 'ticket' -> 'invoice' ->> 'customerId', '')::uuid;
  v_exercise integer := split_part(v_series_name, '-', 4)::integer;
  v_kind text;
  v_expected_series text;
  v_timezone text;
begin
  if auth.uid() is null or p_event_id is null or jsonb_typeof(p_payload) <> 'object'
    or jsonb_typeof(p_record) <> 'object' or jsonb_typeof(p_invoice) <> 'object'
    or jsonb_typeof(v_record) <> 'object' then
    raise exception 'LOCAL_FISCAL_BAD_REQUEST' using errcode = '22023';
  end if;
  select * into v_existing from public.fiscal_local_records
    where tenant_id = v_tenant and idempotency_key = v_idempotency;
  if v_existing.id is not null then
    if v_existing.record_envelope is distinct from p_record
      or v_existing.invoice_snapshot is distinct from p_invoice
      or v_existing.economic_snapshot is distinct from p_payload
      or v_existing.client_event_id is distinct from p_event_id
      or v_existing.ticket_id is distinct from v_ticket
      or v_existing.sale_id is distinct from v_sale then
      raise exception 'LOCAL_FISCAL_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return;
  end if;
  if exists (select 1 from public.offline_event_log e
    where e.tenant_id = v_tenant and e.client_event_id = p_event_id) then
    raise exception 'LOCAL_FISCAL_EVENT_WITHOUT_RECORD' using errcode = '23505';
  end if;

  select * into v_installation from public.fiscal_sif_installations i
    where i.id = (p_record ->> 'installationId')::uuid for update;
  if v_installation.id is null or v_installation.retired_at is not null or v_installation.mode <> 'production'
    or (v_installation.tenant_id, v_installation.venue_id, v_installation.cash_register_id, v_installation.device_id)
      is distinct from (v_tenant, v_venue, v_register, v_device)
    or not public.user_has_device_access(v_tenant, v_venue, v_device) then
    raise exception 'LOCAL_FISCAL_INSTALLATION_FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_subject from public.fiscal_subjects s
    where s.id = v_installation.fiscal_subject_id and s.tenant_id = v_tenant;
  if v_subject.id is null or p_record ->> 'fiscalSubjectId' <> v_subject.id::text
    or p_record ->> 'issuerNif' <> v_subject.nif
    or p_record ->> 'environment' <> 'production'
    or p_record ->> 'tenantId' <> v_tenant::text
    or p_record ->> 'venueId' <> v_venue::text
    or p_record ->> 'cashRegisterId' <> v_register::text
    or p_record ->> 'deviceId' <> v_device::text
    or p_record ->> 'invoiceId' <> (p_invoice ->> 'invoiceId')
    or p_record ->> 'generatedAt' <> p_invoice ->> 'issuedAt'
    or p_record ->> 'canonicalSchema' <> 'aeat-registro-v1'
    or coalesce((p_record -> 'lease' ->> 'fencingToken')::bigint, 0) < 1 then
    raise exception 'LOCAL_FISCAL_SCOPE_MISMATCH' using errcode = '42501';
  end if;
  if v_type not in ('F1', 'F2') or v_number < 1 or v_hash !~ '^[0-9A-F]{64}$'
    or v_record ->> 'Huella' <> v_hash
    or v_record -> 'IDFactura' ->> 'IDEmisorFactura' <> v_subject.nif
    or v_record -> 'IDFactura' ->> 'NumSerieFactura' <> v_series_name || '/' || v_number::text
    or v_record ->> 'FechaHoraHusoGenRegistro' <> p_record ->> 'generatedAt'
    or (v_record ->> 'ImporteTotal')::numeric * 100 <> (p_payload -> 'ticket' ->> 'totalCents')::numeric
    or (p_invoice ->> 'totalCents')::bigint <> (p_payload -> 'ticket' ->> 'totalCents')::bigint
    or p_invoice ->> 'ticketId' <> v_ticket::text
    or p_invoice ->> 'saleId' <> v_sale::text then
    raise exception 'LOCAL_FISCAL_INVOICE_MISMATCH' using errcode = '22023';
  end if;
  select coalesce(v.timezone, 'Europe/Madrid') into v_timezone
    from public.venues v where v.id = v_venue and v.tenant_id = v_tenant;
  if v_timezone is null or v_record -> 'IDFactura' ->> 'FechaExpedicionFactura'
      <> to_char(v_issued_at at time zone v_timezone, 'DD-MM-YYYY') then
    raise exception 'LOCAL_FISCAL_ISSUE_DATE_MISMATCH' using errcode = '22023';
  end if;
  v_kind := case when v_type = 'F1' then 'complete' else 'simplified' end;
  v_expected_series := v_installation.venue_code || '-' || v_installation.register_code || '-'
    || v_installation.installation_code || '-' || v_exercise::text || '-'
    || case when v_type = 'F1' then 'F' else 'S' end;
  if v_series_name <> v_expected_series
    or v_exercise <> extract(year from v_issued_at at time zone v_timezone)::integer then
    raise exception 'LOCAL_FISCAL_SERIES_MISMATCH' using errcode = '22023';
  end if;
  if v_type = 'F1' then
    if v_customer is null or p_payload -> 'ticket' -> 'invoice' -> 'customer' ->> 'taxId'
      <> v_record -> 'Destinatarios' -> 'IDDestinatario' -> 0 ->> 'NIF'
      or not exists (select 1 from public.customers c
        where c.id = v_customer and c.tenant_id = v_tenant) then
      raise exception 'LOCAL_FISCAL_RECIPIENT_MISMATCH' using errcode = '22023';
    end if;
  elsif v_customer is not null then
    raise exception 'LOCAL_FISCAL_RECIPIENT_REQUIRES_F1' using errcode = '22023';
  end if;
  if exists (select 1 from public.fiscal_integration_settings s
    where s.tenant_id = v_tenant and s.enabled) then
    raise exception 'LOCAL_FISCAL_LEGACY_PROVIDER_ENABLED' using errcode = '55000';
  end if;

  select * into v_prior from public.fiscal_local_records r
    where r.tenant_id = v_tenant and r.fiscal_subject_id = v_subject.id
      and r.installation_id = v_installation.id
    order by r.chain_position desc limit 1;
  if v_position <> coalesce(v_prior.chain_position, 0) + 1
    or (v_prior.id is null and v_previous_hash is not null)
    or (v_prior.id is null and v_record -> 'Encadenamiento' ->> 'PrimerRegistro' is distinct from 'S')
    or (v_prior.id is not null and v_previous_hash is distinct from v_prior.hash)
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'issuerNif') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'IDEmisorFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'IDEmisorFacturaAnulada'))
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'seriesAndNumber') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'NumSerieFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'NumSerieFacturaAnulada'))
    or (v_prior.id is not null and (p_record -> 'previous' ->> 'issueDate') is distinct from
      coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'FechaExpedicionFactura',
        v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'FechaExpedicionFacturaAnulada'))
    or (v_prior.id is not null and v_record -> 'Encadenamiento' -> 'RegistroAnterior' is distinct from
      jsonb_build_object('IDEmisorFactura', p_record -> 'previous' ->> 'issuerNif',
        'NumSerieFactura', p_record -> 'previous' ->> 'seriesAndNumber',
        'FechaExpedicionFactura', p_record -> 'previous' ->> 'issueDate', 'Huella', v_previous_hash)) then
    raise exception 'LOCAL_FISCAL_CHAIN_CONFLICT' using errcode = '23505';
  end if;
  insert into public.fiscal_local_series (
    tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, device_id,
    document_kind, exercise, series
  ) values (v_tenant, v_subject.id, v_installation.id, v_venue, v_register, v_device,
    v_kind, v_exercise, v_series_name)
  on conflict (tenant_id, fiscal_subject_id, series) do nothing;
  select * into v_series from public.fiscal_local_series s
    where s.tenant_id = v_tenant and s.fiscal_subject_id = v_subject.id and s.series = v_series_name
    for update;
  if v_series.id is null or v_series.installation_id <> v_installation.id
    or v_series.document_kind <> v_kind or v_series.last_number + 1 <> v_number then
    raise exception 'LOCAL_FISCAL_NUMBER_CONFLICT' using errcode = '23505';
  end if;

  perform set_config('app.local_fiscal_sale', 'yes', true);
  perform public.sync_sale_created_v2(p_event_id, p_payload);
  if v_type = 'F1' then
    update public.tickets t set is_invoice = true, customer_id = v_customer,
      customer_snapshot = p_payload -> 'ticket' -> 'invoice' -> 'customer',
      invoice_series = v_series_name, invoice_number = v_number::text, invoice_issued_at = v_issued_at
    where t.id = v_ticket and t.tenant_id = v_tenant and t.status = 'paid';
    if not found then raise exception 'LOCAL_FISCAL_TICKET_NOT_STORED' using errcode = '55000'; end if;
  end if;
  insert into public.fiscal_local_records (
    id, tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id,
    invoice_id, ticket_id, sale_id, client_event_id, record_kind, chain_position,
    previous_hash, hash, canonical_schema, canonical_record, record_envelope,
    invoice_snapshot, economic_snapshot, generated_at, idempotency_key
  ) values (
    v_idempotency, v_tenant, v_subject.id, v_installation.id, v_venue, v_register,
    (p_record ->> 'invoiceId')::uuid, v_ticket, v_sale, p_event_id, 'alta', v_position,
    v_previous_hash, v_hash, 'aeat-registro-v1', p_record -> 'canonicalRecord', p_record,
    p_invoice, p_payload,
    (p_record ->> 'generatedAt')::timestamptz, v_idempotency
  );
  update public.fiscal_local_series set last_number = v_number where id = v_series.id;
end;
$$;

revoke all on function public.sync_local_fiscal_sale_created(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.sync_local_fiscal_sale_created(uuid, jsonb, jsonb, jsonb) to authenticated;
