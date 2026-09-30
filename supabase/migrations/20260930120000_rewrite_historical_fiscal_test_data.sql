-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

create or replace function public.rewrite_historical_fiscal_test_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants%rowtype;
  v_venue public.venues%rowtype;
  v_register public.cash_registers%rowtype;
  v_ticket public.tickets%rowtype;
  v_subject public.fiscal_subjects%rowtype;
  v_installation public.fiscal_sif_installations%rowtype;
  v_device public.devices%rowtype;
  v_previous_hash text;
  v_position bigint;
  v_number bigint;
  v_series text;
  v_kind text;
  v_type text;
  v_issue_date text;
  v_generated_at timestamptz;
  v_tax_total numeric;
  v_invoice_total numeric;
  v_details jsonb;
  v_canonical jsonb;
  v_hash text;
  v_invoice_id uuid;
  v_count integer := 0;
  v_installations integer := 0;
  v_nif text;
  v_venue_code text;
  v_register_code text;
  v_device_id uuid;
  v_record_id uuid;
  v_line_count integer;
begin
  if current_user <> 'postgres'
    or coalesce(current_setting('app.allow_fiscal_test_rewrite', true), '') <> 'yes' then
    raise exception 'FISCAL_TEST_REWRITE_FORBIDDEN' using errcode = '42501';
  end if;

  delete from public.fiscal_invoice_events;
  delete from public.fiscal_invoices;
  perform set_config('app.allow_fiscal_dev_reset', 'yes', true);
  for v_tenant in select * from public.tenants loop
    perform public.reset_fiscal_local_dev_data(v_tenant.id);
  end loop;

  create temporary table historical_scope (
    tenant_id uuid not null,
    venue_id uuid not null,
    cash_register_id uuid not null,
    device_id uuid not null,
    venue_code text not null,
    register_code text not null,
    primary key (tenant_id, venue_id, cash_register_id)
  ) on commit drop;

  for v_tenant in select * from public.tenants order by id loop
    select * into v_subject
    from public.fiscal_subjects
    where tenant_id = v_tenant.id
    order by created_at, id
    limit 1;

    if v_subject.id is null then
      select upper(nullif(btrim(venue.tax_id), '')) into v_nif
      from public.venues venue
      where venue.tenant_id = v_tenant.id
        and upper(nullif(btrim(venue.tax_id), '')) ~ '^[A-Z0-9]{9}$'
      order by venue.created_at, venue.id
      limit 1;
      v_nif := coalesce(v_nif, 'T' || upper(substr(md5(v_tenant.id::text), 1, 8)));
      select coalesce(nullif(btrim(venue.legal_name), ''), v_tenant.id::text)
      into v_venue_code
      from public.venues venue
      where venue.tenant_id = v_tenant.id
      order by venue.created_at, venue.id
      limit 1;
      insert into public.fiscal_subjects (tenant_id, legal_name, nif)
      values (v_tenant.id, coalesce(v_venue_code, v_tenant.id::text), v_nif)
      returning * into v_subject;
    end if;

    for v_venue in select * from public.venues where tenant_id = v_tenant.id order by id loop
      v_venue_code := coalesce(nullif(v_venue.fiscal_code, ''), 'V' || upper(substr(md5(v_venue.id::text), 1, 7)));
      update public.venues set fiscal_code = v_venue_code where id = v_venue.id;

      for v_register in select * from public.cash_registers where tenant_id = v_tenant.id and venue_id = v_venue.id order by id loop
        v_device_id := ('00000000-0000-4000-8000-' || substr(md5(v_tenant.id::text || ':' || v_venue.id::text || ':' || v_register.id::text), 1, 12))::uuid;
        insert into public.devices (id, tenant_id, venue_id, name, is_active, device_mode,
          can_take_orders, can_take_payments, can_open_cash_session, can_close_cash_session, can_manage_cash)
        values (v_device_id, v_tenant.id, v_venue.id, 'Historical test device ' || v_register.name, true, 'checkout', true, true, true, true, true)
        on conflict (id) do update set name = excluded.name
        returning * into v_device;

        select 'C' || count(*)::text
        into v_register_code
        from public.cash_registers register_row
        where register_row.tenant_id = v_tenant.id
          and register_row.venue_id = v_venue.id
          and register_row.id <= v_register.id;
        insert into historical_scope values (v_tenant.id, v_venue.id, v_register.id, v_device.id, v_venue_code, v_register_code);
        insert into public.fiscal_sif_installations (
          tenant_id, fiscal_subject_id, venue_id, cash_register_id, device_id,
          installation_number, venue_code, register_code, installation_code, mode
        ) values (
          v_tenant.id, v_subject.id, v_venue.id, v_register.id, v_device.id,
          'HIST-' || upper(substr(md5(v_tenant.id::text || ':' || v_venue.id::text || ':' || v_register.id::text), 1, 12)),
          v_venue_code, v_register_code, 'H' || upper(substr(md5(v_tenant.id::text || ':' || v_venue.id::text || ':' || v_register.id::text), 1, 7)), 'production'
        ) returning * into v_installation;
        v_installations := v_installations + 1;
      end loop;
    end loop;
  end loop;

  alter table public.tickets disable trigger user;
  update public.tickets ticket
  set device_id = scope.device_id
  from historical_scope scope
  where ticket.tenant_id = scope.tenant_id
    and ticket.venue_id = scope.venue_id
    and ticket.cash_register_id = scope.cash_register_id
    and ticket.status = 'paid';

  for v_ticket in
    select ticket.*
    from public.tickets ticket
    join historical_scope scope on scope.tenant_id = ticket.tenant_id
      and scope.venue_id = ticket.venue_id
      and scope.cash_register_id = ticket.cash_register_id
    where ticket.status = 'paid'
    order by ticket.tenant_id, ticket.local_created_at, ticket.id
  loop
    select scope.venue_code, scope.register_code
    into v_venue_code, v_register_code
    from historical_scope scope
    where scope.tenant_id = v_ticket.tenant_id
      and scope.venue_id = v_ticket.venue_id
      and scope.cash_register_id = v_ticket.cash_register_id;

    select installation.* into v_installation
    from public.fiscal_sif_installations installation
    where installation.tenant_id = v_ticket.tenant_id
      and installation.venue_id = v_ticket.venue_id
      and installation.cash_register_id = v_ticket.cash_register_id
      and installation.device_id = v_ticket.device_id;

    v_subject := null;
    select * into v_subject from public.fiscal_subjects where id = v_installation.fiscal_subject_id;
    v_generated_at := v_ticket.local_created_at;
    v_issue_date := to_char(v_generated_at at time zone coalesce((select timezone from public.venues where id = v_ticket.venue_id), 'Europe/Madrid'), 'DD-MM-YYYY');
    v_type := case when v_ticket.is_invoice and jsonb_typeof(v_ticket.customer_snapshot) = 'object'
      and nullif(v_ticket.customer_snapshot ->> 'taxId', '') is not null then 'F1' else 'F2' end;
    v_kind := case when v_type = 'F1' then 'complete' else 'simplified' end;
    v_series := v_venue_code || '-' || v_register_code || '-' || extract(year from v_generated_at at time zone coalesce((select timezone from public.venues where id = v_ticket.venue_id), 'Europe/Madrid'))::integer::text || '-' || case when v_type = 'F1' then 'F' else 'S' end;

    select count(*) into v_line_count from public.ticket_lines where ticket_id = v_ticket.id;
    select coalesce(sum(line.tax_amount_cents), 0)::numeric,
      coalesce(sum(line.net_total_cents), v_ticket.total_cents)::numeric
    into v_tax_total, v_invoice_total
    from public.ticket_lines line
    where line.ticket_id = v_ticket.id;

    if v_line_count = 0 then
      v_details := jsonb_build_array(jsonb_build_object(
        'Impuesto', '01', 'ClaveRegimen', '01', 'CalificacionOperacion', 'S1',
        'TipoImpositivo', to_char(coalesce((select default_tax_rate from public.venues where id = v_ticket.venue_id), 21), 'FM990.00'),
        'BaseImponibleOimporteNoSujeto', to_char(v_ticket.total_cents - v_tax_total, 'FM9999999990.00'),
        'CuotaRepercutida', to_char(v_tax_total, 'FM9999999990.00')
      ));
    else
      select jsonb_agg(jsonb_build_object(
        'Impuesto', '01', 'ClaveRegimen', '01', 'CalificacionOperacion', 'S1',
        'TipoImpositivo', to_char(grouped.tax_rate, 'FM990.00'),
        'BaseImponibleOimporteNoSujeto', to_char(grouped.base_cents / 100.0, 'FM9999999990.00'),
        'CuotaRepercutida', to_char(grouped.tax_cents / 100.0, 'FM9999999990.00')
      ) order by grouped.tax_rate)
      into v_details
      from (
        select coalesce(line.tax_rate, (select default_tax_rate from public.venues where id = v_ticket.venue_id)) as tax_rate,
          sum(coalesce(line.taxable_base_cents, line.net_total_cents, line.line_total_cents))::numeric as base_cents,
          sum(coalesce(line.tax_amount_cents, 0))::numeric as tax_cents
        from public.ticket_lines line
        where line.ticket_id = v_ticket.id
        group by coalesce(line.tax_rate, (select default_tax_rate from public.venues where id = v_ticket.venue_id))
      ) grouped;
    end if;

    v_tax_total := coalesce(v_tax_total, 0) / 100;
    v_invoice_total := coalesce(v_invoice_total, v_ticket.total_cents) / 100;
    select coalesce(max(chain_position), 0) + 1, max(hash)
    into v_position, v_previous_hash
    from public.fiscal_local_records
    where tenant_id = v_ticket.tenant_id and installation_id = v_installation.id;
    v_number := coalesce((select max(last_number) from public.fiscal_local_series where tenant_id = v_ticket.tenant_id and fiscal_subject_id = v_subject.id and installation_id = v_installation.id and series = v_series), 0) + 1;
    v_invoice_id := ('00000000-0000-4000-8000-' || substr(md5('invoice:' || v_ticket.id::text), 1, 12))::uuid;

    v_hash := upper(encode(extensions.digest(
      'IDEmisorFactura=' || v_subject.nif || '&NumSerieFactura=' || v_series || '/' || v_number::text ||
      '&FechaExpedicionFactura=' || v_issue_date || '&TipoFactura=' || v_type ||
      '&CuotaTotal=' || to_char(v_tax_total, 'FM9999999990.00') || '&ImporteTotal=' || to_char(v_invoice_total, 'FM9999999990.00') ||
      '&Huella=' || coalesce(v_previous_hash, '') || '&FechaHoraHusoGenRegistro=' || to_char(v_generated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'sha256'), 'hex'));

    v_canonical := jsonb_build_object('RegistroAlta', jsonb_build_object(
      'IDVersion', '1.0',
      'IDFactura', jsonb_build_object('IDEmisorFactura', v_subject.nif, 'NumSerieFactura', v_series || '/' || v_number::text, 'FechaExpedicionFactura', v_issue_date),
      'NombreRazonEmisor', v_subject.legal_name, 'TipoFactura', v_type, 'DescripcionOperacion', 'Venta de bienes y servicios',
      'Desglose', jsonb_build_object('DetalleDesglose', v_details),
      'CuotaTotal', to_char(v_tax_total, 'FM9999999990.00'), 'ImporteTotal', to_char(v_invoice_total, 'FM9999999990.00'),
      'Encadenamiento', case when v_previous_hash is null then jsonb_build_object('PrimerRegistro', 'S') else jsonb_build_object('RegistroAnterior', jsonb_build_object('IDEmisorFactura', v_subject.nif, 'NumSerieFactura', (select canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'NumSerieFactura' from public.fiscal_local_records where tenant_id = v_ticket.tenant_id and installation_id = v_installation.id order by chain_position desc limit 1), 'FechaExpedicionFactura', (select canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'FechaExpedicionFactura' from public.fiscal_local_records where tenant_id = v_ticket.tenant_id and installation_id = v_installation.id order by chain_position desc limit 1), 'Huella', v_previous_hash)) end,
      'SistemaInformatico', jsonb_build_object('NombreRazon', 'Historical test rewrite', 'NIF', v_subject.nif, 'NombreSistemaInformatico', 'Tickit', 'IdSistemaInformatico', 'TK', 'Version', 'test-rewrite', 'NumeroInstalacion', v_installation.installation_number, 'TipoUsoPosibleSoloVerifactu', 'S', 'TipoUsoPosibleMultiOT', 'S', 'IndicadorMultiplesOT', 'S'),
      'FechaHoraHusoGenRegistro', to_char(v_generated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'TipoHuella', '01', 'Huella', v_hash
    ));

    insert into public.fiscal_local_series (tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, device_id, document_kind, exercise, series, last_number)
    values (v_ticket.tenant_id, v_subject.id, v_installation.id, v_ticket.venue_id, v_ticket.cash_register_id, v_ticket.device_id, v_kind, extract(year from v_generated_at at time zone coalesce((select timezone from public.venues where id = v_ticket.venue_id), 'Europe/Madrid'))::integer, v_series, v_number)
    on conflict (tenant_id, fiscal_subject_id, series) do update set last_number = greatest(public.fiscal_local_series.last_number, excluded.last_number);

    if v_type = 'F1' and v_ticket.is_invoice and v_ticket.customer_id is not null
      and jsonb_typeof(v_ticket.customer_snapshot) = 'object' then
      update public.tickets
      set invoice_series = v_series, invoice_number = v_number::text, invoice_issued_at = v_generated_at
      where id = v_ticket.id;
    end if;
    v_record_id := v_invoice_id;
    insert into public.fiscal_local_records (
      id, tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, invoice_id, ticket_id, sale_id,
      record_kind, chain_position, previous_hash, hash, canonical_schema, canonical_record, record_envelope,
      invoice_snapshot, economic_snapshot, generated_at, idempotency_key
    ) values (
      v_record_id, v_ticket.tenant_id, v_subject.id, v_installation.id, v_ticket.venue_id, v_ticket.cash_register_id,
      v_invoice_id, v_ticket.id, (select sale.id from public.sales sale where sale.tenant_id = v_ticket.tenant_id and sale.ticket_id = v_ticket.id order by sale.created_at desc, sale.id desc limit 1),
      'alta', v_position, v_previous_hash, v_hash, 'aeat-registro-v1', v_canonical,
      jsonb_build_object('idempotencyKey', v_record_id, 'environment', 'production', 'tenantId', v_ticket.tenant_id, 'venueId', v_ticket.venue_id, 'cashRegisterId', v_ticket.cash_register_id, 'deviceId', v_ticket.device_id, 'installationId', v_installation.id, 'invoiceId', v_invoice_id, 'chainPosition', v_position, 'generatedAt', v_generated_at, 'hash', v_hash, 'canonicalRecord', v_canonical),
      jsonb_build_object('invoiceId', v_invoice_id, 'ticketId', v_ticket.id, 'saleId', (select sale.id from public.sales sale where sale.tenant_id = v_ticket.tenant_id and sale.ticket_id = v_ticket.id order by sale.created_at desc, sale.id desc limit 1), 'series', v_series, 'number', v_number, 'issuedAt', v_generated_at, 'totalCents', v_ticket.total_cents),
      jsonb_build_object('rewrittenFrom', 'legacy-test-ticket', 'originalTicket', to_jsonb(v_ticket)), v_generated_at, v_record_id
    );
    v_previous_hash := v_hash;
    v_count := v_count + 1;
  end loop;
  alter table public.tickets enable trigger user;

  return jsonb_build_object('rewrittenTickets', v_count, 'createdInstallations', v_installations, 'mode', 'test-only-retroactive-rewrite');
end;
$$;

revoke all on function public.rewrite_historical_fiscal_test_data() from public, anon, authenticated;

select set_config('app.allow_fiscal_test_rewrite', 'yes', true);
select public.rewrite_historical_fiscal_test_data();
