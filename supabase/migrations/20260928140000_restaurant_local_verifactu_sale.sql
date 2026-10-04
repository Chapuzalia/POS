-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

create function public.pay_restaurant_local_fiscal(
  p_action text, p_params jsonb, p_record jsonb, p_invoice jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_installation public.fiscal_sif_installations%rowtype;
  v_subject public.fiscal_subjects%rowtype;
  v_prior public.fiscal_local_records%rowtype;
  v_existing public.fiscal_local_records%rowtype;
  v_series public.fiscal_local_series%rowtype;
  v_canonical jsonb := p_record -> 'canonicalRecord' -> 'RegistroAlta';
  v_type text := v_canonical ->> 'TipoFactura';
  v_idempotency uuid := (p_record ->> 'idempotencyKey')::uuid;
  v_position bigint := (p_record ->> 'chainPosition')::bigint;
  v_previous_hash text := p_record -> 'previous' ->> 'hash';
  v_hash text := p_record ->> 'hash';
  v_number bigint := (p_invoice ->> 'number')::bigint;
  v_series_name text := p_invoice ->> 'series';
  v_issued_at timestamptz := (p_invoice ->> 'issuedAt')::timestamptz;
  v_exercise integer := split_part(v_series_name, '-', 4)::integer;
  v_timezone text;
  v_expected_series text;
  v_kind text;
  v_result jsonb;
  v_ticket uuid;
  v_sale uuid;
  v_payment uuid;
  v_total bigint;
  v_customer uuid := nullif(p_params ->> 'customerId', '')::uuid;
begin
  if auth.uid() is null or p_action not in ('close', 'equal_part', 'selected_items')
    or jsonb_typeof(p_params) <> 'object' or jsonb_typeof(p_record) <> 'object'
    or jsonb_typeof(p_invoice) <> 'object' or jsonb_typeof(v_canonical) <> 'object' then
    raise exception 'LOCAL_FISCAL_BAD_REQUEST' using errcode = '22023';
  end if;
  select * into v_existing from public.fiscal_local_records r
    where r.tenant_id = (p_record ->> 'tenantId')::uuid and r.idempotency_key = v_idempotency;
  if v_existing.id is not null then
    if v_existing.record_envelope is distinct from p_record
      or v_existing.invoice_snapshot is distinct from p_invoice
      or v_existing.rpc_result is null then
      raise exception 'LOCAL_FISCAL_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return v_existing.rpc_result;
  end if;
  select * into v_installation from public.fiscal_sif_installations i
    where i.id = (p_record ->> 'installationId')::uuid for update;
  if v_installation.id is null or v_installation.retired_at is not null or v_installation.mode <> 'production'
    or (v_installation.tenant_id::text, v_installation.venue_id::text,
        v_installation.cash_register_id::text, v_installation.device_id::text)
      is distinct from (p_record ->> 'tenantId', p_record ->> 'venueId',
        p_record ->> 'cashRegisterId', p_record ->> 'deviceId')
    or not public.user_has_device_access(v_installation.tenant_id, v_installation.venue_id, v_installation.device_id) then
    raise exception 'LOCAL_FISCAL_INSTALLATION_FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_subject from public.fiscal_subjects s
    where s.id = v_installation.fiscal_subject_id and s.tenant_id = v_installation.tenant_id;
  select coalesce(v.timezone, 'Europe/Madrid') into v_timezone from public.venues v
    where v.id = v_installation.venue_id and v.tenant_id = v_installation.tenant_id;
  if v_subject.id is null or v_timezone is null
    or p_record ->> 'fiscalSubjectId' <> v_subject.id::text
    or p_record ->> 'issuerNif' <> v_subject.nif
    or p_record ->> 'environment' <> 'production'
    or p_record ->> 'generatedAt' <> p_invoice ->> 'issuedAt'
    or p_record ->> 'canonicalSchema' <> 'aeat-registro-v1'
    or p_record ->> 'invoiceId' <> p_invoice ->> 'invoiceId'
    or coalesce((p_record -> 'lease' ->> 'fencingToken')::bigint, 0) < 1
    or v_hash !~ '^[0-9A-F]{64}$'
    or v_canonical ->> 'Huella' <> v_hash
    or v_canonical -> 'IDFactura' ->> 'IDEmisorFactura' <> v_subject.nif
    or v_canonical -> 'IDFactura' ->> 'NumSerieFactura' <> v_series_name || '/' || v_number::text
    or v_canonical -> 'IDFactura' ->> 'FechaExpedicionFactura'
      <> to_char(v_issued_at at time zone v_timezone, 'DD-MM-YYYY')
    or v_canonical ->> 'FechaHoraHusoGenRegistro' <> p_record ->> 'generatedAt'
    or (v_canonical ->> 'ImporteTotal')::numeric * 100 <> (p_invoice ->> 'totalCents')::numeric then
    raise exception 'LOCAL_FISCAL_RECORD_MISMATCH' using errcode = '22023';
  end if;
  v_kind := case when v_type = 'F1' then 'complete' when v_type = 'F2' then 'simplified' else null end;
  v_expected_series := v_installation.venue_code || '-' || v_installation.register_code || '-'
    || v_installation.installation_code || '-' || v_exercise::text || '-'
    || case when v_type = 'F1' then 'F' else 'S' end;
  if v_kind is null or v_number < 1 or v_series_name <> v_expected_series
    or v_exercise <> extract(year from v_issued_at at time zone v_timezone)::integer then
    raise exception 'LOCAL_FISCAL_SERIES_MISMATCH' using errcode = '22023';
  end if;
  if (v_type = 'F1' and (v_customer is null
      or p_params -> 'customerSnapshot' ->> 'taxId'
        <> v_canonical -> 'Destinatarios' -> 'IDDestinatario' -> 0 ->> 'NIF'
      or not exists (select 1 from public.customers c where c.id = v_customer and c.tenant_id = v_installation.tenant_id)))
    or (v_type = 'F2' and v_customer is not null) then
    raise exception 'LOCAL_FISCAL_RECIPIENT_MISMATCH' using errcode = '22023';
  end if;
  if exists (select 1 from public.fiscal_integration_settings s
    where s.tenant_id = v_installation.tenant_id and s.enabled) then
    raise exception 'LOCAL_FISCAL_LEGACY_PROVIDER_ENABLED' using errcode = '55000';
  end if;
  select * into v_prior from public.fiscal_local_records r
    where r.tenant_id = v_installation.tenant_id and r.fiscal_subject_id = v_subject.id
      and r.installation_id = v_installation.id
    order by r.chain_position desc limit 1;
  if v_position <> coalesce(v_prior.chain_position, 0) + 1
    or (v_prior.id is null and v_previous_hash is not null)
    or (v_prior.id is null and v_canonical -> 'Encadenamiento' ->> 'PrimerRegistro' is distinct from 'S')
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
    or (v_prior.id is not null and v_canonical -> 'Encadenamiento' -> 'RegistroAnterior' is distinct from
      jsonb_build_object('IDEmisorFactura', p_record -> 'previous' ->> 'issuerNif',
        'NumSerieFactura', p_record -> 'previous' ->> 'seriesAndNumber',
        'FechaExpedicionFactura', p_record -> 'previous' ->> 'issueDate', 'Huella', v_previous_hash)) then
    raise exception 'LOCAL_FISCAL_CHAIN_CONFLICT' using errcode = '23505';
  end if;
  insert into public.fiscal_local_series (
    tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,device_id,
    document_kind,exercise,series
  ) values (v_installation.tenant_id,v_subject.id,v_installation.id,v_installation.venue_id,
    v_installation.cash_register_id,v_installation.device_id,v_kind,v_exercise,v_series_name)
  on conflict (tenant_id,fiscal_subject_id,series) do nothing;
  select * into v_series from public.fiscal_local_series s
    where s.tenant_id = v_installation.tenant_id and s.fiscal_subject_id = v_subject.id
      and s.series = v_series_name for update;
  if v_series.id is null or v_series.installation_id <> v_installation.id
    or v_series.document_kind <> v_kind or v_series.last_number + 1 <> v_number then
    raise exception 'LOCAL_FISCAL_NUMBER_CONFLICT' using errcode = '23505';
  end if;

  perform set_config('app.local_fiscal_sale', 'yes', true);
  if p_action = 'close' then
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.close_restaurant_order_cashlogy(
        (p_params ->> 'orderId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId', null);
    else
      v_result := public.close_restaurant_order_checked_v2(
        (p_params ->> 'orderId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  elsif p_action = 'equal_part' then
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.pay_restaurant_order_equal_part_cashlogy(
        (p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        (p_params ->> 'useDefaultDiscount')::boolean,
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      v_result := public.pay_restaurant_order_equal_part(
        (p_params ->> 'splitId')::uuid, p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        (p_params ->> 'useDefaultDiscount')::boolean);
    end if;
  else
    if nullif(p_params ->> 'cashlogyRequestId', '') is not null then
      v_result := public.pay_restaurant_order_items_cashlogy(
        (p_params ->> 'orderId')::uuid, (p_params ->> 'expectedRevision')::integer,
        p_params -> 'moves', p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount',
        p_params ->> 'cashlogyRequestId', p_params ->> 'cashlogyTransactionId');
    else
      v_result := public.pay_restaurant_order_items(
        (p_params ->> 'orderId')::uuid, (p_params ->> 'expectedRevision')::integer,
        p_params -> 'moves', p_params ->> 'method', (p_params ->> 'receivedCents')::integer,
        (p_params ->> 'allowPending')::boolean, p_params -> 'discount');
    end if;
  end if;
  if coalesce((v_result ->> 'requiresConfirmation')::boolean, false) then return v_result; end if;
  v_ticket := (v_result ->> 'ticketId')::uuid;
  v_sale := (v_result ->> 'saleId')::uuid;
  v_payment := nullif(v_result ->> 'paymentId', '')::uuid;
  v_total := (coalesce(v_result ->> 'totalCents', v_result ->> 'paidAmountCents'))::bigint;
  -- Legacy restaurant RPCs choose the first assigned device for the cashier.
  -- Bind the new paid document to the authenticated checkout installation.
  update public.tickets t set device_id = v_installation.device_id
    where t.id = v_ticket and t.tenant_id = v_installation.tenant_id
      and t.venue_id = v_installation.venue_id and t.cash_register_id = v_installation.cash_register_id;
  update public.sales s set device_id = v_installation.device_id
    where s.id = v_sale and s.tenant_id = v_installation.tenant_id
      and s.venue_id = v_installation.venue_id and s.cash_register_id = v_installation.cash_register_id;
  if v_ticket is null or v_sale is null or v_total is null
    or v_total <> (p_invoice ->> 'totalCents')::bigint
    or not exists (select 1 from public.sales s where s.id = v_sale and s.ticket_id = v_ticket
      and s.tenant_id = v_installation.tenant_id and s.venue_id = v_installation.venue_id
      and s.cash_register_id = v_installation.cash_register_id and s.device_id = v_installation.device_id) then
    raise exception 'LOCAL_FISCAL_RESTAURANT_SALE_MISMATCH' using errcode = '22023';
  end if;
  if v_type = 'F1' then
    update public.tickets t set is_invoice = true, customer_id = v_customer,
      customer_snapshot = p_params -> 'customerSnapshot', invoice_series = v_series_name,
      invoice_number = v_number::text, invoice_issued_at = v_issued_at
    where t.id = v_ticket and t.tenant_id = v_installation.tenant_id and t.status = 'paid';
    if not found then raise exception 'LOCAL_FISCAL_TICKET_NOT_STORED' using errcode = '55000'; end if;
  end if;
  insert into public.fiscal_local_records (
    id,tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,
    invoice_id,ticket_id,sale_id,record_kind,chain_position,previous_hash,hash,
    canonical_schema,canonical_record,record_envelope,invoice_snapshot,
    generated_at,idempotency_key,rpc_result
  ) values (v_idempotency,v_installation.tenant_id,v_subject.id,v_installation.id,v_installation.venue_id,
    v_installation.cash_register_id,(p_record ->> 'invoiceId')::uuid,v_ticket,v_sale,'alta',v_position,
    v_previous_hash,v_hash,'aeat-registro-v1',p_record -> 'canonicalRecord',p_record,p_invoice,
    (p_record ->> 'generatedAt')::timestamptz,v_idempotency,v_result);
  update public.fiscal_local_series set last_number = v_number where id = v_series.id;
  return v_result;
end;
$$;

revoke all on function public.pay_restaurant_local_fiscal(text,jsonb,jsonb,jsonb) from public, anon;
grant execute on function public.pay_restaurant_local_fiscal(text,jsonb,jsonb,jsonb) to authenticated;
