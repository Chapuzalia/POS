-- migration-safety: expand
-- Development/Staging-only atomic rebuild of the local fiscal ledger.
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Metadata is needed during the reconstruction, before the PWA activation expand.
alter table public.fiscal_sif_installations add column if not exists installation_sequence integer;
alter table public.fiscal_sif_installations add column if not exists series_version integer;
alter table public.cash_registers add column if not exists fiscal_code text;

create or replace function public.rewrite_historical_fiscal_test_data()
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t record; src record; prior record; subject_row record; installation_row record; settings_row record;
  sale_row record; payment_row record; invoice_row record; event_row record;
  canonical_inner jsonb; canonical jsonb; envelope jsonb; invoice_snapshot jsonb; economic jsonb;
  details jsonb; invoice_lines jsonb; recipient jsonb; previous_json jsonb; system_json jsonb;
  offline_payload jsonb;
  subject_nif text; subject_name text; recipient_name text; recipient_nif text;
  series_name text; number_text text; number_value bigint; invoice_type text; issue_date_text text;
  venue_code_value text; register_code_value text;
  document_kind_value text; exercise_value integer; installation_sequence_value integer;
  generated_at timestamptz; generated_text text; issued_text text; timezone_name text;
  previous_hash text; hash_value text; hash_source text; previous_identity jsonb;
  position_value bigint; invoice_id_value uuid; record_id_value uuid; payment_id_value uuid;
  sale_id_value uuid; tax_cents bigint; total_cents bigint; source_count integer; line_count integer;
  lines_complete boolean; void_reason text; void_at timestamptz; staged_count integer := 0;
begin
  if current_user <> 'postgres'
    or coalesce(current_setting('app.allow_fiscal_test_rewrite', true), '') <> 'yes' then
    raise exception 'FISCAL_TEST_REWRITE_FORBIDDEN' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('historical-fiscal-sif-rewrite', 0));
  lock table public.fiscal_local_records, public.tickets, public.ticket_lines, public.sales,
    public.sale_payments, public.fiscal_subjects, public.fiscal_sif_installations,
    public.fiscal_invoices, public.offline_event_log, public.venues,
    public.cash_registers, public.devices in share row exclusive mode;

  -- Bootstrap missing tenant settings before rebuilding their historical records.
  -- Preserve configurations already saved in Staging; no transport origin is required.
  insert into public.fiscal_pos_bridge_settings
    (tenant_id, bridge_url, producer_name, producer_nif, system_id, system_version)
  select tenant.id, null, 'Alteil Solutions, S.L.', 'B12345678', 'TK', '1.0.0'
  from public.tenants tenant
  on conflict (tenant_id) do nothing;

  -- Active boxes start at C1 within each venue. Archived boxes follow them and
  -- keep distinct codes when their historical tickets also need reconstruction.
  -- UUID breaks ties when multiple boxes share the same creation timestamp.
  create temporary table _fiscal_register_codes on commit drop as
  select register.tenant_id, register.venue_id, register.id as cash_register_id,
    'C' || row_number() over (
      partition by register.tenant_id, register.venue_id
      order by case when register.is_active then 0 else 1 end, register.created_at, register.id
    )::text as register_code
  from public.cash_registers register;

  -- Reserve codes also for active boxes without tickets so first PWA activation
  -- on the other box cannot skip or consume its logical code.
  update public.cash_registers register set fiscal_code=(
    select installation.register_code from public.fiscal_sif_installations installation
    where installation.tenant_id=register.tenant_id and installation.cash_register_id=register.id
    order by installation.created_at desc,installation.id desc limit 1
  ) where register.fiscal_code is null;
  update public.cash_registers register set fiscal_code=codes.register_code
  from _fiscal_register_codes codes where register.id=codes.cash_register_id
    and register.tenant_id=codes.tenant_id and register.fiscal_code is null;

  create temporary table _fiscal_stage
    (like public.fiscal_local_records including defaults) on commit drop;
  create temporary table _fiscal_series_stage (
    tenant_id uuid not null, fiscal_subject_id uuid not null, installation_id uuid not null,
    venue_id uuid not null, cash_register_id uuid not null, device_id uuid not null,
    document_kind text not null, exercise integer not null, series text not null,
    last_number bigint not null,
    primary key (tenant_id,fiscal_subject_id,installation_id,document_kind,exercise)
  ) on commit drop;

  for t in
    select ticket.*
    from public.tickets ticket
    where ticket.status in ('paid','void')
    order by ticket.local_created_at, ticket.id
  loop
    if t.ticket_number is null or t.ticket_number::bigint < 1 or t.device_id is null then
      raise exception 'FISCAL_SOURCE_INVALID ticket=%', t.id;
    end if;

    select venue.timezone into timezone_name from public.venues venue where venue.id=t.venue_id;
    timezone_name := coalesce(timezone_name, 'Europe/Madrid');

    select venue.legal_name,
      upper(regexp_replace(coalesce(venue.tax_id,''),'[^A-Za-z0-9]','','g'))
      into subject_name, subject_nif
    from public.venues venue
    where venue.tenant_id=t.tenant_id
    order by venue.created_at, venue.id limit 1;
    if nullif(btrim(coalesce(subject_name,'')),'') is null or subject_nif !~ '^[A-Z0-9]{9}$'
      or exists (select 1 from public.venues venue where venue.tenant_id=t.tenant_id
        and nullif(upper(regexp_replace(coalesce(venue.tax_id,''),'[^A-Za-z0-9]','','g')),'') is not null
        and upper(regexp_replace(venue.tax_id,'[^A-Za-z0-9]','','g'))<>subject_nif) then
      raise exception 'FISCAL_ISSUER_IDENTITY_AMBIGUOUS tenant=%',t.tenant_id;
    end if;

    select count(*) into source_count from public.fiscal_subjects fs
      where fs.tenant_id=t.tenant_id
        and upper(regexp_replace(fs.nif,'[^A-Za-z0-9]','','g'))=subject_nif;
    if source_count=0 and not exists (select 1 from public.fiscal_subjects fs where fs.tenant_id=t.tenant_id) then
      insert into public.fiscal_subjects(tenant_id,legal_name,nif)
      values(t.tenant_id,btrim(subject_name),subject_nif);
      source_count:=1;
    end if;
    if source_count<>1 then raise exception 'FISCAL_SUBJECT_AMBIGUOUS ticket=%',t.id; end if;
    select * into subject_row from public.fiscal_subjects fs where fs.tenant_id=t.tenant_id
      and upper(regexp_replace(fs.nif,'[^A-Za-z0-9]','','g'))=subject_nif;

    select count(*) into source_count from public.fiscal_sif_installations installation
      where installation.tenant_id=t.tenant_id and installation.fiscal_subject_id=subject_row.id
        and installation.venue_id=t.venue_id and installation.cash_register_id=t.cash_register_id
        and installation.device_id=t.device_id and installation.retired_at is null;
    if source_count=0 then
      if exists (select 1 from public.fiscal_sif_installations installation
        where installation.tenant_id=t.tenant_id and installation.retired_at is null
          and (installation.cash_register_id=t.cash_register_id or installation.device_id=t.device_id)) then
        raise exception 'FISCAL_INSTALLATION_SCOPE_CONFLICT ticket=%',t.id;
      end if;
      select coalesce(venue.fiscal_code, left(upper(regexp_replace(
        translate(btrim(venue.name), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'),
        '[^A-Za-z]', '', 'g')), 3)) into venue_code_value
      from public.venues venue where venue.tenant_id=t.tenant_id and venue.id=t.venue_id;
      if venue_code_value is null or venue_code_value !~ '^[A-Z0-9]{1,8}$' then
        raise exception 'FISCAL_VENUE_CODE_INVALID venue=%',t.venue_id;
      end if;
      if exists (select 1 from public.venues venue where venue.tenant_id=t.tenant_id
        and venue.id<>t.venue_id and venue.fiscal_code=venue_code_value) then
        raise exception 'FISCAL_VENUE_CODE_COLLISION venue=% code=%',t.venue_id,venue_code_value;
      end if;
      update public.venues set fiscal_code=venue_code_value
      where tenant_id=t.tenant_id and id=t.venue_id and fiscal_code is null;
      select register.fiscal_code into register_code_value from public.cash_registers register
      where register.tenant_id=t.tenant_id and register.venue_id=t.venue_id
        and register.id=t.cash_register_id;
      select coalesce(max(installation.installation_sequence), count(*), 0)::integer + 1
        into installation_sequence_value from public.fiscal_sif_installations installation
        where installation.tenant_id=t.tenant_id and installation.cash_register_id=t.cash_register_id;
      insert into public.fiscal_sif_installations (
        tenant_id,fiscal_subject_id,venue_id,cash_register_id,device_id,
        installation_number,venue_code,register_code,installation_code,mode,installation_sequence,series_version
      ) values (
        t.tenant_id,subject_row.id,t.venue_id,t.cash_register_id,t.device_id,
        venue_code_value||'-'||register_code_value||'-'||installation_sequence_value::text,venue_code_value,register_code_value,
        'I'||upper(right(replace(t.device_id::text,'-',''),7)),'production',installation_sequence_value,2
      );
      source_count:=1;
    end if;
    if source_count<>1 then raise exception 'FISCAL_INSTALLATION_AMBIGUOUS ticket=%',t.id; end if;
    select * into installation_row from public.fiscal_sif_installations installation
      where installation.tenant_id=t.tenant_id and installation.fiscal_subject_id=subject_row.id
        and installation.venue_id=t.venue_id and installation.cash_register_id=t.cash_register_id
        and installation.device_id=t.device_id and installation.retired_at is null;

    select count(*) into source_count from public.fiscal_pos_bridge_settings setting where setting.tenant_id=t.tenant_id;
    if source_count<>1 then raise exception 'FISCAL_SYSTEM_SETTINGS_AMBIGUOUS tenant=%',t.tenant_id; end if;
    select * into settings_row from public.fiscal_pos_bridge_settings setting where setting.tenant_id=t.tenant_id;
    if nullif(btrim(settings_row.producer_name),'') is null or settings_row.producer_nif !~ '^[A-Z0-9]{9}$'
      or settings_row.system_id !~ '^[A-Z0-9]{2}$' or nullif(settings_row.system_version,'') is null then
      raise exception 'FISCAL_SYSTEM_SETTINGS_INVALID tenant=%',t.tenant_id;
    end if;

    sale_id_value:=null; sale_row:=null; payment_id_value:=null; offline_payload:='{}'::jsonb;
    if t.status='paid' then
      select count(*) into source_count from public.sales sale where sale.tenant_id=t.tenant_id and sale.ticket_id=t.id;
      if source_count<>1 then raise exception 'FISCAL_SALE_AMBIGUOUS ticket=%',t.id; end if;
      select * into sale_row from public.sales sale where sale.tenant_id=t.tenant_id and sale.ticket_id=t.id;
      if sale_row.venue_id<>t.venue_id
        or sale_row.cash_register_id<>t.cash_register_id or sale_row.total_cents<>t.total_cents then
        raise exception 'FISCAL_SALE_SCOPE_INVALID ticket=%',t.id;
      end if;
      sale_id_value:=sale_row.id;
      select count(*) into source_count from public.sale_payments payment where payment.tenant_id=t.tenant_id and payment.sale_id=sale_id_value;
      if source_count>1 then raise exception 'FISCAL_PAYMENT_AMBIGUOUS ticket=%',t.id; end if;
      select * into payment_row from public.sale_payments payment where payment.tenant_id=t.tenant_id and payment.sale_id=sale_id_value;
      payment_id_value:=payment_row.id;
    else
      select count(*) into source_count from public.offline_event_log event
        where event.tenant_id=t.tenant_id and event.event_kind='sale_created'
          and coalesce(event.payload->'ticket'->>'id',event.payload->>'ticketId')=t.id::text;
      if source_count<>1 then raise exception 'FISCAL_VOID_SALE_SOURCE_AMBIGUOUS ticket=%',t.id; end if;
      select * into event_row from public.offline_event_log event
        where event.tenant_id=t.tenant_id and event.event_kind='sale_created'
          and coalesce(event.payload->'ticket'->>'id',event.payload->>'ticketId')=t.id::text;
      offline_payload:=event_row.payload;
      sale_id_value:=coalesce(offline_payload->'sale'->>'id',offline_payload->>'saleId')::uuid;
      if sale_id_value is null then raise exception 'FISCAL_VOID_SALE_SOURCE_INVALID ticket=%',t.id; end if;
    end if;

    select count(*) into source_count from public.fiscal_invoices fi where fi.tenant_id=t.tenant_id and fi.ticket_id=t.id;
    if source_count>1 then raise exception 'FISCAL_INVOICE_AMBIGUOUS ticket=%',t.id; end if;
    select * into invoice_row from public.fiscal_invoices fi where fi.tenant_id=t.tenant_id and fi.ticket_id=t.id;
    if invoice_row.id is not null and invoice_row.provider not in ('verifactu','ticketbai') then
      raise exception 'FISCAL_INVOICE_SOURCE_INVALID ticket=%',t.id;
    end if;
    invoice_id_value:=md5(t.id::text||':sif-invoice')::uuid;
    invoice_type:=case when invoice_row.id is not null then case when invoice_row.invoice_type='normal' then 'F1' else 'F2' end
      when t.is_invoice then 'F1' else 'F2' end;
    document_kind_value:=case when invoice_type='F1' then 'complete' else 'simplified' end;
    exercise_value:=extract(year from coalesce(invoice_row.issued_at,t.local_created_at) at time zone timezone_name)::integer;
    -- Compatible both before and after the PWA-identity expand. Keep legacy
    -- identities unchanged; a sequenced installation includes its own segment.
    series_name:=installation_row.venue_code||'-'||installation_row.register_code||
      case when (to_jsonb(installation_row)->>'series_version')::integer=2
        then '-'||(to_jsonb(installation_row)->>'installation_sequence') else '' end||'-'||exercise_value||
      case when document_kind_value='complete' then '-F' else '-S' end;
    insert into _fiscal_series_stage(tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,device_id,
      document_kind,exercise,series,last_number)
    values(t.tenant_id,subject_row.id,installation_row.id,t.venue_id,t.cash_register_id,t.device_id,
      document_kind_value,exercise_value,series_name,1)
    on conflict(tenant_id,fiscal_subject_id,installation_id,document_kind,exercise)
    do update set last_number=_fiscal_series_stage.last_number+1
    returning last_number into number_value;
    number_text:=case when (to_jsonb(installation_row)->>'series_version')::integer=2 then '/' else '' end||number_value::text;
    if nullif(btrim(series_name),'') is null or number_value<1 then raise exception 'FISCAL_NUMBER_INVALID ticket=%',t.id; end if;
    issue_date_text:=to_char(coalesce(invoice_row.issue_date,(t.local_created_at at time zone timezone_name)::date),'DD-MM-YYYY');

    select count(*) into line_count from public.ticket_lines line where line.tenant_id=t.tenant_id and line.ticket_id=t.id;
    lines_complete:=line_count>0 and not exists(select 1 from public.ticket_lines line where line.tenant_id=t.tenant_id and line.ticket_id=t.id
      and (line.tax_rate not in (4,10,21) or line.tax_rate is null or line.taxable_base_cents is null
        or line.tax_amount_cents is null or line.net_total_cents is null
        or line.taxable_base_cents+line.tax_amount_cents<>line.net_total_cents));
    details:=null; invoice_lines:='[]'::jsonb;
    if lines_complete then
      select jsonb_agg(jsonb_build_object('rate',grouped.tax_rate,'baseCents',grouped.base_cents,'taxCents',grouped.tax_cents) order by grouped.tax_rate)
      into details from (select line.tax_rate,sum(line.taxable_base_cents)::bigint base_cents,sum(line.tax_amount_cents)::bigint tax_cents
        from public.ticket_lines line where line.tenant_id=t.tenant_id and line.ticket_id=t.id group by line.tax_rate) grouped;
      select jsonb_agg(jsonb_build_object('description',concat_ws(' — ',line.product_name,nullif(line.variant_name,'')),
        'grossCents',coalesce(line.gross_before_discount_cents,line.line_total_cents),'discountCents',line.discount_amount_cents,
        'baseCents',line.taxable_base_cents,'taxCents',line.tax_amount_cents,'taxRate',to_char(line.tax_rate,'FM990.00')) order by line.id)
      into invoice_lines from public.ticket_lines line where line.tenant_id=t.tenant_id and line.ticket_id=t.id;
    elsif jsonb_typeof(invoice_row.document_data->'taxBreakdown')='array' and jsonb_array_length(invoice_row.document_data->'taxBreakdown')>0 then
      if exists(select 1 from jsonb_array_elements(invoice_row.document_data->'taxBreakdown') item
        where item->>'rate' !~ '^(4|10|21)([.]0+)?$' or item->>'baseCents' !~ '^[0-9]+$' or item->>'taxCents' !~ '^[0-9]+$') then
        raise exception 'FISCAL_TAX_SOURCE_INVALID ticket=%',t.id;
      end if;
      select jsonb_agg(jsonb_build_object('rate',grouped.rate,'baseCents',grouped.base_cents,'taxCents',grouped.tax_cents) order by grouped.rate)
      into details from (select (item->>'rate')::numeric rate,sum((item->>'baseCents')::bigint)::bigint base_cents,
        sum((item->>'taxCents')::bigint)::bigint tax_cents from jsonb_array_elements(invoice_row.document_data->'taxBreakdown') item group by (item->>'rate')::numeric) grouped;
    elsif jsonb_typeof(invoice_row.request_payload->'lineas')='array' and jsonb_array_length(invoice_row.request_payload->'lineas')>0 then
      if exists(select 1 from jsonb_array_elements(invoice_row.request_payload->'lineas') item
        where coalesce(item->>'tipo_impositivo',item->>'TipoImpositivo') !~ '^(4|10|21)([.]0+)?$'
          or coalesce(item->>'base_imponible',item->>'BaseImponibleOimporteNoSujeto') !~ '^[0-9]{1,12}[.][0-9]{2}$'
          or coalesce(item->>'cuota_repercutida',item->>'CuotaRepercutida') !~ '^[0-9]{1,12}[.][0-9]{2}$') then
        raise exception 'FISCAL_TAX_SOURCE_INVALID ticket=%',t.id;
      end if;
      select jsonb_agg(jsonb_build_object('rate',grouped.rate,'baseCents',grouped.base_cents,'taxCents',grouped.tax_cents) order by grouped.rate)
      into details from (select coalesce(item->>'tipo_impositivo',item->>'TipoImpositivo')::numeric rate,
        sum(split_part(coalesce(item->>'base_imponible',item->>'BaseImponibleOimporteNoSujeto'),'.',1)::bigint*100+split_part(coalesce(item->>'base_imponible',item->>'BaseImponibleOimporteNoSujeto'),'.',2)::bigint)::bigint base_cents,
        sum(split_part(coalesce(item->>'cuota_repercutida',item->>'CuotaRepercutida'),'.',1)::bigint*100+split_part(coalesce(item->>'cuota_repercutida',item->>'CuotaRepercutida'),'.',2)::bigint)::bigint tax_cents
        from jsonb_array_elements(invoice_row.request_payload->'lineas') item group by coalesce(item->>'tipo_impositivo',item->>'TipoImpositivo')::numeric) grouped;
    elsif t.status='void' and jsonb_typeof(offline_payload->'lines')='array' then
      if exists(select 1 from jsonb_array_elements(offline_payload->'lines') item where item->'fiscalSnapshot' is null) then
        raise exception 'FISCAL_TAX_SOURCE_MISSING ticket=%',t.id;
      end if;
      select jsonb_agg(jsonb_build_object('rate',grouped.rate,'baseCents',grouped.base_cents,'taxCents',grouped.tax_cents) order by grouped.rate)
      into details from (select (item->'fiscalSnapshot'->>'taxRate')::numeric rate,
        sum((item->'fiscalSnapshot'->>'taxableBaseCents')::bigint)::bigint base_cents,
        sum((item->'fiscalSnapshot'->>'taxAmountCents')::bigint)::bigint tax_cents
        from jsonb_array_elements(offline_payload->'lines') item group by (item->'fiscalSnapshot'->>'taxRate')::numeric) grouped;
    else raise exception 'FISCAL_TAX_SOURCE_MISSING ticket=%',t.id;
    end if;
    select sum((item->>'baseCents')::bigint+(item->>'taxCents')::bigint),sum((item->>'taxCents')::bigint)
      into total_cents,tax_cents from jsonb_array_elements(details) item;
    if total_cents<>t.total_cents then raise exception 'FISCAL_TOTAL_MISMATCH ticket=%',t.id; end if;

    recipient:=null; recipient_name:=null; recipient_nif:=null;
    if invoice_type='F1' then
      recipient:=coalesce(nullif(invoice_row.document_data->'recipient','null'::jsonb),nullif(t.customer_snapshot,'null'::jsonb));
      recipient_name:=coalesce(nullif(btrim(recipient->>'legalName'),''),nullif(btrim(recipient->>'name'),''),nullif(btrim(recipient->>'nombre'),''));
      recipient_nif:=upper(regexp_replace(coalesce(recipient->>'taxId',recipient->>'nif',''),'[^A-Za-z0-9]','','g'));
      if recipient_name is null or recipient_nif !~ '^[A-Z0-9]{9}$' then raise exception 'FISCAL_RECIPIENT_INVALID ticket=%',t.id; end if;
    end if;

    select * into prior from _fiscal_stage staged where staged.installation_id=installation_row.id order by staged.chain_position desc limit 1;
    position_value:=coalesce(prior.chain_position,0)+1; previous_hash:=prior.hash;
    previous_identity:=case when prior.id is null then null else jsonb_build_object(
      'issuerNif',coalesce(prior.canonical_record->'RegistroAlta'->'IDFactura'->>'IDEmisorFactura',prior.canonical_record->'RegistroAnulacion'->'IDFactura'->>'IDEmisorFacturaAnulada'),
      'seriesAndNumber',coalesce(prior.canonical_record->'RegistroAlta'->'IDFactura'->>'NumSerieFactura',prior.canonical_record->'RegistroAnulacion'->'IDFactura'->>'NumSerieFacturaAnulada'),
      'issueDate',coalesce(prior.canonical_record->'RegistroAlta'->'IDFactura'->>'FechaExpedicionFactura',prior.canonical_record->'RegistroAnulacion'->'IDFactura'->>'FechaExpedicionFacturaAnulada'),
      'hash',prior.hash) end;
    generated_at:=greatest(coalesce(invoice_row.issued_at,t.local_created_at),coalesce(prior.generated_at+interval '1 second','-infinity'::timestamptz));
    perform set_config('TimeZone',timezone_name,true);
    generated_text:=to_char(generated_at,'YYYY-MM-DD"T"HH24:MI:SS')||case when to_char(generated_at,'OF')~'^[+-][0-9]{2}$' then to_char(generated_at,'OF')||':00' else to_char(generated_at,'OF') end;
    issued_text:=to_char(coalesce(invoice_row.issued_at,t.local_created_at),'YYYY-MM-DD"T"HH24:MI:SS')||case when to_char(coalesce(invoice_row.issued_at,t.local_created_at),'OF')~'^[+-][0-9]{2}$' then to_char(coalesce(invoice_row.issued_at,t.local_created_at),'OF')||':00' else to_char(coalesce(invoice_row.issued_at,t.local_created_at),'OF') end;
    system_json:=jsonb_build_object('NombreRazon',settings_row.producer_name,'NIF',settings_row.producer_nif,
      'NombreSistemaInformatico','Tickit','IdSistemaInformatico',settings_row.system_id,'Version',settings_row.system_version,
      'NumeroInstalacion',installation_row.installation_number,'TipoUsoPosibleSoloVerifactu','S','TipoUsoPosibleMultiOT','N','IndicadorMultiplesOT','N');
    select jsonb_agg(jsonb_build_object('Impuesto','01','ClaveRegimen','01','CalificacionOperacion','S1','TipoImpositivo',to_char((item->>'rate')::numeric,'FM990.00'),
      'BaseImponibleOimporteNoSujeto',to_char((item->>'baseCents')::numeric/100,'FM999999990.00'),'CuotaRepercutida',to_char((item->>'taxCents')::numeric/100,'FM999999990.00')) order by (item->>'rate')::numeric)
      into details from jsonb_array_elements(details) item;
    canonical_inner:=jsonb_build_object('IDVersion','1.0','IDFactura',jsonb_build_object('IDEmisorFactura',subject_nif,
      'NumSerieFactura',series_name||number_text,'FechaExpedicionFactura',issue_date_text),'NombreRazonEmisor',subject_row.legal_name,
      'TipoFactura',invoice_type,'DescripcionOperacion',coalesce(nullif(invoice_row.document_data->>'descripcion',''),'Venta de bienes y servicios'),
      'Desglose',jsonb_build_object('DetalleDesglose',details),'CuotaTotal',to_char(tax_cents::numeric/100,'FM999999990.00'),
      'ImporteTotal',to_char(total_cents::numeric/100,'FM999999990.00'),'Encadenamiento',case when previous_identity is null then jsonb_build_object('PrimerRegistro','S') else jsonb_build_object('RegistroAnterior',jsonb_build_object('IDEmisorFactura',previous_identity->>'issuerNif','NumSerieFactura',previous_identity->>'seriesAndNumber','FechaExpedicionFactura',previous_identity->>'issueDate','Huella',previous_hash)) end,
      'SistemaInformatico',system_json,'FechaHoraHusoGenRegistro',generated_text,'TipoHuella','01');
    if invoice_type='F1' then canonical_inner:=canonical_inner||jsonb_build_object('Destinatarios',jsonb_build_object('IDDestinatario',jsonb_build_array(jsonb_build_object('NombreRazon',recipient_name,'NIF',recipient_nif)))); end if;
    hash_source:='IDEmisorFactura='||subject_nif||'&NumSerieFactura='||series_name||number_text||'&FechaExpedicionFactura='||issue_date_text||'&TipoFactura='||invoice_type||'&CuotaTotal='||(canonical_inner->>'CuotaTotal')||'&ImporteTotal='||(canonical_inner->>'ImporteTotal')||'&Huella='||coalesce(previous_hash,'')||'&FechaHoraHusoGenRegistro='||generated_text;
    hash_value:=upper(encode(extensions.digest(convert_to(hash_source,'UTF8'),'sha256'),'hex'));
    canonical:=jsonb_build_object('RegistroAlta',jsonb_set(canonical_inner,'{Huella}',to_jsonb(hash_value)));
    record_id_value:=md5(t.id::text||':alta')::uuid;
    previous_json:=previous_identity;
    envelope:=jsonb_build_object('idempotencyKey',record_id_value,'environment','production','tenantId',t.tenant_id,
      'fiscalSubjectId',subject_row.id,'issuerNif',subject_nif,'venueId',t.venue_id,'cashRegisterId',t.cash_register_id,
      'installationId',installation_row.id,'deviceId',t.device_id,'invoiceId',invoice_id_value,'chainPosition',position_value,
      'previous',previous_json,'hash',hash_value,'generatedAt',generated_text,'canonicalSchema','aeat-registro-v1','canonicalRecord',canonical);
    invoice_snapshot:=jsonb_build_object('issuerName',subject_row.legal_name,'issuerNif',subject_nif,'series',series_name,'number',number_value,
      'issuerAddress',coalesce((select venue.address from public.venues venue where venue.id=t.venue_id),''),
      'issuedAt',issued_text,'qrUrl','https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif='||subject_nif||'&numserie='||replace(series_name||number_text,' ','%20')||'&fecha='||issue_date_text||'&importe='||(canonical_inner->>'ImporteTotal'),
      'ticketId',t.id,'saleId',sale_id_value,'paymentId',payment_id_value,'lines',coalesce(invoice_lines,'[]'::jsonb),
      'recipient',case when invoice_type='F1' then jsonb_build_object('name',recipient_name,'nif',recipient_nif) else null end,
      'totalCents',total_cents,'taxCents',tax_cents,'transmissionMode','local-only');
    select jsonb_build_object('ticket',to_jsonb(t),'sale',case when t.status='void' then coalesce(offline_payload->'sale',jsonb_build_object('id',sale_id_value)) else to_jsonb(sale_row) end,
      'lines',(select coalesce(jsonb_agg(to_jsonb(line) order by line.id),'[]'::jsonb) from public.ticket_lines line where line.tenant_id=t.tenant_id and line.ticket_id=t.id)) into economic;
    insert into _fiscal_stage(id,tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,invoice_id,ticket_id,sale_id,client_event_id,rpc_result,record_kind,chain_position,previous_hash,hash,canonical_schema,canonical_record,record_envelope,invoice_snapshot,economic_snapshot,generated_at,idempotency_key)
    values(record_id_value,t.tenant_id,subject_row.id,installation_row.id,t.venue_id,t.cash_register_id,invoice_id_value,t.id,
      case when t.status='paid' then sale_id_value else null end,null,jsonb_build_object('paymentId',payment_id_value),'alta',position_value,previous_hash,hash_value,
      'aeat-registro-v1',canonical,envelope,invoice_snapshot,economic,generated_at,record_id_value);

    if t.status='void' then
      select * into event_row from public.offline_event_log event where event.tenant_id=t.tenant_id and event.event_kind='sale_voided'
        and event.payload->>'ticketId'=t.id::text order by event.created_at desc limit 1;
      void_reason:=coalesce(nullif(event_row.payload->>'reason',''),'Anulación histórica de desarrollo');
      void_at:=greatest(coalesce(event_row.created_at,t.updated_at),generated_at+interval '1 second');
      generated_text:=to_char(void_at,'YYYY-MM-DD"T"HH24:MI:SS')||case when to_char(void_at,'OF')~'^[+-][0-9]{2}$' then to_char(void_at,'OF')||':00' else to_char(void_at,'OF') end;
      position_value:=position_value+1; previous_hash:=hash_value;
      canonical_inner:=jsonb_build_object('IDVersion','1.0','IDFactura',jsonb_build_object('IDEmisorFacturaAnulada',subject_nif,
        'NumSerieFacturaAnulada',series_name||number_text,'FechaExpedicionFacturaAnulada',issue_date_text),
        'Encadenamiento',jsonb_build_object('RegistroAnterior',jsonb_build_object('IDEmisorFactura',subject_nif,'NumSerieFactura',series_name||number_text,'FechaExpedicionFactura',issue_date_text,'Huella',previous_hash)),
        'SistemaInformatico',system_json,'FechaHoraHusoGenRegistro',generated_text,'TipoHuella','01');
      hash_source:='IDEmisorFacturaAnulada='||subject_nif||'&NumSerieFacturaAnulada='||series_name||number_text||'&FechaExpedicionFacturaAnulada='||issue_date_text||'&Huella='||previous_hash||'&FechaHoraHusoGenRegistro='||generated_text;
      hash_value:=upper(encode(extensions.digest(convert_to(hash_source,'UTF8'),'sha256'),'hex'));
      canonical:=jsonb_build_object('RegistroAnulacion',jsonb_set(canonical_inner,'{Huella}',to_jsonb(hash_value)));
      record_id_value:=md5(t.id::text||':anulacion')::uuid;
      previous_json:=jsonb_build_object('issuerNif',subject_nif,'seriesAndNumber',series_name||number_text,'issueDate',issue_date_text,'hash',previous_hash);
      envelope:=jsonb_build_object('idempotencyKey',record_id_value,'environment','production','tenantId',t.tenant_id,
        'fiscalSubjectId',subject_row.id,'issuerNif',subject_nif,'venueId',t.venue_id,'cashRegisterId',t.cash_register_id,
        'installationId',installation_row.id,'deviceId',t.device_id,'invoiceId',invoice_id_value,'chainPosition',position_value,
        'previous',previous_json,'hash',hash_value,'generatedAt',generated_text,'canonicalSchema','aeat-registro-v1','canonicalRecord',canonical);
      insert into _fiscal_stage(id,tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,invoice_id,ticket_id,sale_id,client_event_id,rpc_result,record_kind,chain_position,previous_hash,hash,canonical_schema,canonical_record,record_envelope,invoice_snapshot,economic_snapshot,generated_at,idempotency_key)
      values(record_id_value,t.tenant_id,subject_row.id,installation_row.id,t.venue_id,t.cash_register_id,invoice_id_value,t.id,null,null,null,
        'anulacion',position_value,previous_hash,hash_value,'aeat-registro-v1',canonical,envelope,invoice_snapshot,
        economic||jsonb_build_object('annulmentReason',void_reason),void_at,record_id_value);
    end if;
  end loop;

  alter table public.fiscal_local_records disable trigger user;
  alter table public.fiscal_local_series disable trigger fiscal_local_series_identity;
  delete from public.fiscal_local_records;
  delete from public.fiscal_local_series;
  insert into public.fiscal_local_records(id,tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,invoice_id,ticket_id,sale_id,client_event_id,rpc_result,record_kind,chain_position,previous_hash,hash,canonical_schema,canonical_record,record_envelope,invoice_snapshot,economic_snapshot,generated_at,idempotency_key)
  select staged.id,staged.tenant_id,staged.fiscal_subject_id,staged.installation_id,staged.venue_id,staged.cash_register_id,
    staged.invoice_id,staged.ticket_id,staged.sale_id,staged.client_event_id,staged.rpc_result,staged.record_kind,
    staged.chain_position,staged.previous_hash,staged.hash,staged.canonical_schema,staged.canonical_record,
    staged.record_envelope,staged.invoice_snapshot,staged.economic_snapshot,staged.generated_at,staged.idempotency_key
  from _fiscal_stage staged order by staged.installation_id,staged.chain_position;
  get diagnostics staged_count=row_count;
  insert into public.fiscal_local_series(tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,
    device_id,document_kind,exercise,series,last_number)
  select series_stage.tenant_id,series_stage.fiscal_subject_id,series_stage.installation_id,series_stage.venue_id,
    series_stage.cash_register_id,series_stage.device_id,series_stage.document_kind,series_stage.exercise,
    series_stage.series,series_stage.last_number
  from _fiscal_series_stage series_stage;
  alter table public.fiscal_local_records enable trigger user;
  alter table public.fiscal_local_series enable trigger fiscal_local_series_identity;
  return jsonb_build_object('rebuilt',staged_count,'rebuiltRecords',staged_count,'mode','development-full-history-rebuild');
exception when others then
  alter table public.fiscal_local_records enable trigger user;
  alter table public.fiscal_local_series enable trigger fiscal_local_series_identity;
  raise;
end;
$$;

revoke all on function public.rewrite_historical_fiscal_test_data() from public, anon, authenticated;
select set_config('app.allow_fiscal_test_rewrite','yes',true);
select public.rewrite_historical_fiscal_test_data();
drop function public.rewrite_historical_fiscal_test_data();

-- The local SIF ledger is now authoritative; remove the retired provider ledger.
drop trigger if exists queue_fiscal_invoice_after_sale on public.sales;
drop trigger if exists protect_fiscal_ticket_update on public.tickets;
drop trigger if exists protect_fiscal_ticket_lines on public.ticket_lines;
drop function if exists public.queue_fiscal_invoice_for_sale();
drop function if exists public.protect_issued_fiscal_ticket();
drop function if exists public.finalize_ticket_void(uuid,uuid,uuid);
drop table public.fiscal_invoice_events;
-- The singular accounting export is already superseded by get_accounting_tickets_export.
drop function if exists public.get_accounting_ticket_export(uuid,date,date,uuid);
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Rebinds the accounting export to the local fiscal ledger before retiring the legacy invoice table, preserving its signature, result contract and permissions.
create or replace function public.get_accounting_tickets_export(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_product_query text default null,
  p_category_query text default null,
  p_discount_filter text default 'all'
) returns table (
  ticket_id uuid,
  ticket_number bigint,
  local_created_at timestamptz,
  venue_name text,
  cash_register_name text,
  status text,
  total_cents bigint,
  discount_cents bigint,
  payment_cash_cents bigint,
  payment_card_cents bigint,
  payment_other_cents bigint,
  tax_breakdown jsonb,
  is_invoice boolean,
  invoice_series text,
  invoice_number text,
  invoice_type text,
  customer_name text,
  customer_tax_id text,
  tip_cents bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or not public.user_has_tenant_access(p_tenant_id)
    or not exists (
      select 1 from public.venues venue
      where venue.id = p_venue_id and venue.tenant_id = p_tenant_id and venue.is_active
    )
    or not (
      public.user_is_tenant_admin(p_tenant_id)
      or public.user_has_tenant_role(p_tenant_id, array['owner'::text])
      or (
        public.user_has_tenant_role(p_tenant_id, array['manager'::text])
        and exists (
          select 1 from public.manager_venue_assignments assignment
          where assignment.tenant_id = p_tenant_id and assignment.manager_user_id = auth.uid() and assignment.venue_id = p_venue_id
        )
      )
    ) then
    raise exception 'El usuario no tiene acceso al negocio o local' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'El rango temporal no es válido';
  end if;

  return query
  with selected_tickets as (
    select ticket_rows.*
    from public.tickets ticket_rows
    where ticket_rows.tenant_id = p_tenant_id
      and ticket_rows.venue_id = p_venue_id
      and ticket_rows.local_created_at >= p_from
      and ticket_rows.local_created_at < p_to
      and (coalesce(p_discount_filter, 'all') = 'all'
        or (p_discount_filter = 'with' and coalesce(ticket_rows.discount_amount_cents, 0) > 0)
        or (p_discount_filter = 'without' and coalesce(ticket_rows.discount_amount_cents, 0) = 0)
        or (p_discount_filter like 'id:%' and ticket_rows.discount_id::text = substr(p_discount_filter, 4)))
      and (coalesce(btrim(p_product_query), '') = '' or exists (
        select 1 from public.ticket_lines line_rows
        where line_rows.ticket_id = ticket_rows.id
          and public.crm_normalize_search_text(line_rows.product_name) like '%' || public.crm_normalize_search_text(btrim(p_product_query)) || '%'
      ))
      and (coalesce(btrim(p_category_query), '') = '' or exists (
        select 1 from public.ticket_lines line_rows
        where line_rows.ticket_id = ticket_rows.id
          and public.crm_normalize_search_text(coalesce(line_rows.category_name_snapshot, 'Sin categoría')) like '%' || public.crm_normalize_search_text(btrim(p_category_query)) || '%'
      ))
  ),
  line_taxes as (
    select ticket_rows.id as ticket_id, line_rows.tax_rate,
      sum(coalesce(line_rows.taxable_base_cents, line_rows.net_total_cents, line_rows.line_total_cents))::bigint as base_cents,
      sum(coalesce(line_rows.tax_amount_cents, 0))::bigint as tax_cents
    from selected_tickets ticket_rows
    join public.ticket_lines line_rows on line_rows.ticket_id = ticket_rows.id
    group by ticket_rows.id, line_rows.tax_rate
  ),
  ticket_taxes as (
    select tax_rows.ticket_id,
      jsonb_agg(jsonb_build_object('rate', tax_rows.tax_rate, 'baseCents', tax_rows.base_cents, 'taxCents', tax_rows.tax_cents) order by tax_rows.tax_rate nulls last) as tax_breakdown
    from line_taxes tax_rows group by tax_rows.ticket_id
  ),
  ticket_payments as (
    select sale_rows.ticket_id,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) = 'cash'), 0)::bigint as cash_cents,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) = 'card'), 0)::bigint as card_cents,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) not in ('cash', 'card')), 0)::bigint as other_cents
    from public.sales sale_rows
    left join public.sale_payments payment_rows on payment_rows.sale_id = sale_rows.id
    where sale_rows.tenant_id = p_tenant_id and sale_rows.venue_id = p_venue_id
    group by sale_rows.ticket_id
  )
  select ticket_rows.id, ticket_rows.ticket_number, ticket_rows.local_created_at, venue_rows.name, register_rows.name,
    ticket_rows.status, ticket_rows.total_cents::bigint, coalesce(ticket_rows.discount_amount_cents, 0)::bigint,
    coalesce(ticket_payments.cash_cents, 0), coalesce(ticket_payments.card_cents, 0), coalesce(ticket_payments.other_cents, 0),
    coalesce(ticket_taxes.tax_breakdown, '[]'::jsonb), coalesce(invoice_rows.is_invoice, coalesce(ticket_rows.is_invoice, false)),
    coalesce(invoice_rows.invoice_series, ticket_rows.invoice_series), coalesce(invoice_rows.invoice_number, ticket_rows.invoice_number), invoice_rows.invoice_type,
    coalesce(invoice_rows.recipient_name, ticket_rows.customer_snapshot ->> 'legalName', ticket_rows.customer_snapshot ->> 'name'),
    coalesce(invoice_rows.recipient_nif, ticket_rows.customer_snapshot ->> 'taxId', ticket_rows.customer_snapshot ->> 'nif'), 0::bigint
  from selected_tickets ticket_rows
  join public.venues venue_rows on venue_rows.id = ticket_rows.venue_id
  join public.cash_registers register_rows on register_rows.id = ticket_rows.cash_register_id
  left join ticket_taxes on ticket_taxes.ticket_id = ticket_rows.id
  left join ticket_payments on ticket_payments.ticket_id = ticket_rows.id
  left join lateral (
    select
      case
        when fiscal_rows.aeat_type = 'F1' then 'normal'
        when fiscal_rows.aeat_type = 'F2' then 'simplified'
        when fiscal_rows.aeat_type like 'R%' then 'corrective'
        else null
      end as invoice_type,
      coalesce(fiscal_rows.aeat_type in ('F1', 'R1'), jsonb_typeof(fiscal_rows.invoice_snapshot -> 'recipient') = 'object') as is_invoice,
      fiscal_rows.invoice_snapshot ->> 'series' as invoice_series,
      fiscal_rows.invoice_snapshot ->> 'number' as invoice_number,
      nullif(btrim(coalesce(fiscal_rows.invoice_snapshot -> 'recipient' ->> 'name', '')), '') as recipient_name,
      nullif(btrim(coalesce(fiscal_rows.invoice_snapshot -> 'recipient' ->> 'nif', '')), '') as recipient_nif
    from (
      select local_rows.invoice_snapshot, coalesce(
        local_rows.canonical_record #>> '{RegistroAlta,TipoFactura}',
        local_rows.invoice_snapshot ->> 'invoiceType',
        local_rows.invoice_snapshot ->> 'tipoFactura',
        local_rows.invoice_snapshot ->> 'TipoFactura'
      ) as aeat_type
      from public.fiscal_local_records local_rows
      where local_rows.tenant_id = ticket_rows.tenant_id
        and local_rows.venue_id = ticket_rows.venue_id
        and local_rows.ticket_id = ticket_rows.id
        and local_rows.record_kind = 'alta'
      order by local_rows.generated_at desc, local_rows.chain_position desc, local_rows.id desc
      limit 1
    ) fiscal_rows
  ) invoice_rows on true
  order by ticket_rows.local_created_at asc, ticket_rows.ticket_number asc, ticket_rows.id asc;
end;
$$;

revoke all on function public.get_accounting_tickets_export(uuid, uuid, timestamptz, timestamptz, text, text, text) from public, anon;
grant execute on function public.get_accounting_tickets_export(uuid, uuid, timestamptz, timestamptz, text, text, text) to authenticated, service_role;

drop table public.fiscal_invoices cascade;
