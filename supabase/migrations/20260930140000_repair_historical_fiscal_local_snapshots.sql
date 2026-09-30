-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

create or replace function public.repair_historical_fiscal_local_snapshots()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
begin
  if current_user <> 'postgres'
    or coalesce(current_setting('app.allow_fiscal_test_rewrite', true), '') <> 'yes' then
    raise exception 'FISCAL_TEST_REWRITE_FORBIDDEN' using errcode = '42501';
  end if;

  alter table public.fiscal_local_records disable trigger user;

  with source_rows as (
    select
      record.id,
      record.tenant_id,
      record.fiscal_subject_id,
      record.installation_id,
      record.venue_id,
      record.cash_register_id,
      record.ticket_id,
      record.sale_id,
      record.invoice_id,
      record.chain_position,
      record.previous_hash,
      record.hash,
      record.canonical_record,
      record.generated_at,
      subject.legal_name as issuer_name,
      subject.nif as issuer_nif,
      venue.address as issuer_address,
      ticket.total_cents,
      ticket.customer_snapshot,
      coalesce(venue.timezone, 'Europe/Madrid') as timezone,
      previous.canonical_record as previous_canonical,
      payment.id as payment_id,
      coalesce(lines.items, '[]'::jsonb) as lines,
      coalesce(lines.tax_cents, 0)::integer as tax_cents
    from public.fiscal_local_records record
    join public.fiscal_subjects subject
      on subject.id = record.fiscal_subject_id and subject.tenant_id = record.tenant_id
    join public.tickets ticket
      on ticket.id = record.ticket_id and ticket.tenant_id = record.tenant_id
    join public.venues venue
      on venue.id = record.venue_id and venue.tenant_id = record.tenant_id
    left join lateral (
      select prior.canonical_record
      from public.fiscal_local_records prior
      where prior.tenant_id = record.tenant_id
        and prior.installation_id = record.installation_id
        and prior.chain_position = record.chain_position - 1
      limit 1
    ) previous on true
    left join lateral (
      select sale_payment.id
      from public.sale_payments sale_payment
      where sale_payment.tenant_id = record.tenant_id and sale_payment.sale_id = record.sale_id
      order by sale_payment.id
      limit 1
    ) payment on true
    left join lateral (
      select
        jsonb_agg(jsonb_build_object(
          'description', concat_ws(' — ', line.product_name, line.variant_name),
          'grossCents', coalesce(line.line_total_cents, 0),
          'discountCents', coalesce(line.discount_amount_cents, 0),
          'baseCents', coalesce(line.taxable_base_cents, line.net_total_cents, line.line_total_cents, 0),
          'taxCents', coalesce(line.tax_amount_cents, 0),
          'taxRate', to_char(coalesce(line.tax_rate, venue.default_tax_rate), 'FM990.00')
        ) order by line.created_at, line.id) as items,
        sum(coalesce(line.tax_amount_cents, 0)) as tax_cents
      from public.ticket_lines line
      where line.tenant_id = record.tenant_id and line.ticket_id = record.ticket_id
    ) lines on true
    where record.record_kind = 'alta'
  )
  update public.fiscal_local_records record
  set
    record_envelope = jsonb_build_object(
      'idempotencyKey', source.id,
      'environment', 'production',
      'tenantId', source.tenant_id,
      'fiscalSubjectId', source.fiscal_subject_id,
      'issuerNif', source.issuer_nif,
      'venueId', source.venue_id,
      'cashRegisterId', source.cash_register_id,
      'installationId', source.installation_id,
      'deviceId', (select installation.device_id from public.fiscal_sif_installations installation where installation.id = source.installation_id),
      'invoiceId', source.invoice_id,
      'chainPosition', source.chain_position,
      'previous', case when source.previous_hash is null then null else jsonb_build_object(
        'issuerNif', coalesce(source.previous_canonical -> 'RegistroAlta' -> 'IDFactura' ->> 'IDEmisorFactura', source.previous_canonical -> 'RegistroAnulacion' -> 'IDFactura' ->> 'IDEmisorFacturaAnulada'),
        'seriesAndNumber', coalesce(source.previous_canonical -> 'RegistroAlta' -> 'IDFactura' ->> 'NumSerieFactura', source.previous_canonical -> 'RegistroAnulacion' -> 'IDFactura' ->> 'NumSerieFacturaAnulada'),
        'issueDate', coalesce(source.previous_canonical -> 'RegistroAlta' -> 'IDFactura' ->> 'FechaExpedicionFactura', source.previous_canonical -> 'RegistroAnulacion' -> 'IDFactura' ->> 'FechaExpedicionFacturaAnulada'),
        'hash', source.previous_hash
      ) end,
      'hash', source.hash,
      'generatedAt', to_char(source.generated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'canonicalSchema', 'aeat-registro-v1',
      'canonicalRecord', source.canonical_record
    ),
    invoice_snapshot = jsonb_build_object(
      'issuerName', source.issuer_name,
      'issuerNif', source.issuer_nif,
      'issuerAddress', coalesce(source.issuer_address, ''),
      'series', split_part(source.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'NumSerieFactura', '/', 1),
      'number', split_part(source.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'NumSerieFactura', '/', 2)::bigint,
      'issuedAt', to_char(source.generated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'qrUrl', 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=' || source.issuer_nif || '&numserie=' || replace(source.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'NumSerieFactura', '/', '%2F') || '&fecha=' || replace(source.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'FechaExpedicionFactura', '-', '%2D') || '&importe=' || (source.canonical_record -> 'RegistroAlta' ->> 'ImporteTotal'),
      'ticketId', source.ticket_id,
      'saleId', source.sale_id,
      'paymentId', source.payment_id,
      'lines', source.lines,
      'recipient', case when source.customer_snapshot is null then null else jsonb_build_object(
        'name', source.customer_snapshot ->> 'legalName',
        'nif', source.customer_snapshot ->> 'taxId'
      ) end,
      'totalCents', source.total_cents,
      'taxCents', source.tax_cents,
      'transmissionMode', 'local-only'
    )
  from source_rows source
  where record.id = source.id;

  get diagnostics v_updated = row_count;
  alter table public.fiscal_local_records enable trigger user;
  return v_updated;
exception when others then
  alter table public.fiscal_local_records enable trigger user;
  raise;
end;
$$;

revoke all on function public.repair_historical_fiscal_local_snapshots() from public, anon, authenticated;

select set_config('app.allow_fiscal_test_rewrite', 'yes', true);
select public.repair_historical_fiscal_local_snapshots();
