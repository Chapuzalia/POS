-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

create function public.sync_local_fiscal_ticket_annulment(
  p_event_id uuid, p_record jsonb, p_invoice jsonb, p_reason text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_installation public.fiscal_sif_installations%rowtype;
  v_subject public.fiscal_subjects%rowtype;
  v_original public.fiscal_local_records%rowtype;
  v_prior public.fiscal_local_records%rowtype;
  v_existing public.fiscal_local_records%rowtype;
  v_ticket public.tickets%rowtype;
  v_idempotency uuid := (p_record ->> 'idempotencyKey')::uuid;
  v_ticket_id uuid := (p_invoice ->> 'ticketId')::uuid;
  v_position bigint := (p_record ->> 'chainPosition')::bigint;
  v_hash text := p_record ->> 'hash';
  v_previous_hash text := p_record -> 'previous' ->> 'hash';
  v_invoice_id uuid := (p_record ->> 'invoiceId')::uuid;
  v_record jsonb := p_record -> 'canonicalRecord' -> 'RegistroAnulacion';
begin
  if auth.uid() is null or p_event_id is null or nullif(trim(p_reason), '') is null
    or jsonb_typeof(p_record) <> 'object' or jsonb_typeof(p_invoice) <> 'object'
    or jsonb_typeof(v_record) <> 'object' then
    raise exception 'LOCAL_FISCAL_BAD_REQUEST' using errcode = '22023';
  end if;
  select * into v_existing from public.fiscal_local_records
    where idempotency_key = v_idempotency;
  if v_existing.id is not null then
    if v_existing.record_envelope is distinct from p_record or v_existing.invoice_snapshot is distinct from p_invoice then
      raise exception 'LOCAL_FISCAL_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return;
  end if;
  select * into v_installation from public.fiscal_sif_installations
    where id = (p_record ->> 'installationId')::uuid for update;
  if v_installation.id is null or v_installation.mode <> 'production' or v_installation.retired_at is not null
    or not public.user_has_device_access(v_installation.tenant_id, v_installation.venue_id, v_installation.device_id)
    or (p_record ->> 'tenantId')::uuid <> v_installation.tenant_id
    or p_record ->> 'fiscalSubjectId' <> v_installation.fiscal_subject_id::text
    or p_record ->> 'venueId' <> v_installation.venue_id::text
    or p_record ->> 'cashRegisterId' <> v_installation.cash_register_id::text
    or p_record ->> 'deviceId' <> v_installation.device_id::text
    or p_record ->> 'environment' <> 'production'
    or coalesce((p_record -> 'lease' ->> 'fencingToken')::bigint, 0) < 1 then
    raise exception 'LOCAL_FISCAL_INSTALLATION_FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_subject from public.fiscal_subjects
    where id = v_installation.fiscal_subject_id and tenant_id = v_installation.tenant_id;
  select * into v_original from public.fiscal_local_records
    where tenant_id = v_installation.tenant_id and ticket_id = v_ticket_id and record_kind = 'alta';
  select * into v_ticket from public.tickets
    where id = v_ticket_id and tenant_id = v_installation.tenant_id for update;
  if v_subject.id is null or v_original.id is null or v_ticket.id is null or v_ticket.status <> 'paid'
    or v_original.installation_id <> v_installation.id or v_original.invoice_id <> v_invoice_id
    or v_hash !~ '^[0-9A-F]{64}$'
    or v_record -> 'IDFactura' ->> 'IDEmisorFacturaAnulada' <> v_subject.nif
    or v_record -> 'IDFactura' ->> 'NumSerieFacturaAnulada' <> p_invoice ->> 'series' || '/' || p_invoice ->> 'number'
    or v_record ->> 'FechaHoraHusoGenRegistro' <> p_record ->> 'generatedAt' then
    raise exception 'LOCAL_FISCAL_ANNULMENT_MISMATCH' using errcode = '22023';
  end if;
  select * into v_prior from public.fiscal_local_records
    where tenant_id = v_installation.tenant_id and fiscal_subject_id = v_installation.fiscal_subject_id
      and installation_id = v_installation.id order by chain_position desc limit 1;
  if v_prior.id is null or v_position <> v_prior.chain_position + 1 or v_previous_hash is distinct from v_prior.hash
    or p_record -> 'previous' ->> 'issuerNif' is distinct from coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'IDEmisorFactura', v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'IDEmisorFacturaAnulada')
    or p_record -> 'previous' ->> 'seriesAndNumber' is distinct from coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'NumSerieFactura', v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'NumSerieFacturaAnulada')
    or p_record -> 'previous' ->> 'issueDate' is distinct from coalesce(v_prior.canonical_record -> 'RegistroAlta' -> 'IDFactura' ->> 'FechaExpedicionFactura', v_prior.canonical_record -> 'RegistroAnulacion' -> 'IDFactura' ->> 'FechaExpedicionFacturaAnulada') then
    raise exception 'LOCAL_FISCAL_CHAIN_CONFLICT' using errcode = '23505';
  end if;
  perform set_config('app.local_fiscal_annulment', 'yes', true);
  insert into public.fiscal_local_records (
    id, tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, invoice_id, ticket_id,
    sale_id, client_event_id, record_kind, chain_position, previous_hash, hash, canonical_schema,
    canonical_record, record_envelope, invoice_snapshot, economic_snapshot, generated_at, idempotency_key
  ) values (
    v_idempotency, v_installation.tenant_id, v_subject.id, v_installation.id, v_installation.venue_id,
    v_installation.cash_register_id, v_invoice_id, v_ticket_id, v_original.sale_id, p_event_id, 'anulacion',
    v_position, v_previous_hash, v_hash, 'aeat-registro-v1', p_record -> 'canonicalRecord', p_record,
    p_invoice, jsonb_build_object('reason', p_reason), (p_record ->> 'generatedAt')::timestamptz, v_idempotency
  );
  update public.tickets set status = 'void' where id = v_ticket.id and tenant_id = v_ticket.tenant_id;
end;
$$;

update public.fiscal_integration_settings set enabled = false where enabled;

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE preserves the trigger function signature and only permits the status transition made by the new atomic local-annulment RPC.
create or replace function public.guard_issued_local_fiscal_sale() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if tg_table_name = 'tickets' then
      if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.ticket_id = old.id) then
        raise exception 'LOCAL_FISCAL_SALE_IMMUTABLE' using errcode = '55000';
      end if;
    elsif tg_table_name = 'sales' then
      if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.sale_id = old.id) then
        raise exception 'LOCAL_FISCAL_SALE_IMMUTABLE' using errcode = '55000';
      end if;
    elsif tg_table_name = 'sale_payments' then
      if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.sale_id = old.sale_id) then
        raise exception 'LOCAL_FISCAL_SALE_IMMUTABLE' using errcode = '55000';
      end if;
    end if;
    return old;
  end if;
  if tg_table_name = 'tickets' then
    if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.ticket_id = old.id)
      and ((new.status is distinct from old.status and coalesce(current_setting('app.local_fiscal_annulment', true), '') <> 'yes')
      or new.invoice_series is distinct from old.invoice_series
      or new.invoice_number is distinct from old.invoice_number
      or new.invoice_issued_at is distinct from old.invoice_issued_at
      or new.customer_snapshot is distinct from old.customer_snapshot) then
      raise exception 'LOCAL_FISCAL_INVOICE_IMMUTABLE' using errcode = '55000';
    end if;
  elsif tg_table_name = 'sales' then
    if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.sale_id = old.id)
      and (new.total_cents is distinct from old.total_cents
      or new.payment_method is distinct from old.payment_method
      or new.ticket_id is distinct from old.ticket_id) then
      raise exception 'LOCAL_FISCAL_SALE_IMMUTABLE' using errcode = '55000';
    end if;
  elsif tg_table_name = 'sale_payments' then
    if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.sale_id = old.sale_id)
      and (new.method is distinct from old.method or new.amount_cents is distinct from old.amount_cents) then
      raise exception 'LOCAL_FISCAL_PAYMENT_IMMUTABLE' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_local_fiscal_ticket_annulment(uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.sync_local_fiscal_ticket_annulment(uuid, jsonb, jsonb, text) to authenticated;

