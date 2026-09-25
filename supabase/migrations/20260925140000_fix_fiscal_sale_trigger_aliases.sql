-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserves the trigger signature and behavior while qualifying the fiscal document aliases that conflict with PL/pgSQL record variables.
create or replace function public.queue_fiscal_invoice_for_sale() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  ticket_record public.tickets%rowtype;
  settings_record public.fiscal_integration_settings%rowtype;
  entity_record public.fiscal_entities%rowtype;
  document_record public.fiscal_documents%rowtype;
  document_id_value uuid;
  legacy_invoice_id_value uuid;
  document_kind_value text;
  provider_value text;
  snapshot_value jsonb;
  total_value bigint;
begin
  select ticket.* into ticket_record from public.tickets as ticket where ticket.id = new.ticket_id and ticket.tenant_id = new.tenant_id;
  if ticket_record.id is null or ticket_record.status <> 'paid' then return new; end if;
  entity_record.id := public.resolve_fiscal_entity_for_venue(new.tenant_id, new.venue_id);
  if entity_record.id is null then
    select settings.* into settings_record from public.fiscal_integration_settings as settings where settings.tenant_id = new.tenant_id and settings.enabled;
    if settings_record.tenant_id is null then return new; end if;
    select entity.* into entity_record from public.fiscal_entities as entity where entity.legacy_settings_id = settings_record.tenant_id;
  end if;
  select entity.* into entity_record from public.fiscal_entities as entity where entity.id = entity_record.id;
  if entity_record.id is null then return new; end if;
  provider_value := entity_record.tax_system;
  document_kind_value := case when ticket_record.is_invoice then 'full' else 'simplified' end;
  snapshot_value := jsonb_build_object('ticket', to_jsonb(ticket_record), 'lines', coalesce((select jsonb_agg(to_jsonb(line_record)) from public.ticket_lines as line_record where line_record.ticket_id = ticket_record.id), '[]'::jsonb));
  total_value := coalesce(ticket_record.total_cents, 0);
  insert into public.fiscal_documents (tenant_id, venue_id, fiscal_entity_id, ticket_id, sale_id, integration_provider, tax_system, document_kind, series, number, issue_date, operation_date, expected_total_cents, commercial_snapshot, idempotency_key)
  values (new.tenant_id, new.venue_id, entity_record.id, ticket_record.id, new.id, entity_record.integration_provider, entity_record.tax_system, document_kind_value, case when ticket_record.is_invoice then ticket_record.invoice_series else 'POS' end, case when ticket_record.is_invoice then ticket_record.invoice_number else public.next_fiscal_invoice_number(new.tenant_id, 'POS')::text end, current_date, ticket_record.local_created_at::date, total_value, snapshot_value, new.tenant_id::text || ':' || ticket_record.id::text || ':create')
  on conflict (tenant_id, idempotency_key) do nothing returning id into document_id_value;
  if document_id_value is not null then
    select fiscal_document.* into document_record from public.fiscal_documents as fiscal_document where fiscal_document.id = document_id_value;
    insert into public.fiscal_outbox (tenant_id, venue_id, fiscal_entity_id, fiscal_document_id, operation, idempotency_key) values (new.tenant_id, new.venue_id, entity_record.id, document_id_value, 'create', new.tenant_id::text || ':' || ticket_record.id::text || ':create') on conflict do nothing;
    insert into public.fiscal_invoices (tenant_id, venue_id, ticket_id, sale_id, provider, environment, invoice_type, series, number, issue_date, operation_date, document_data, status, pending_operation, idempotency_key)
    select new.tenant_id, new.venue_id, ticket_record.id, new.id, provider_value, entity_record.environment, case when document_kind_value = 'full' then 'normal' else document_kind_value end, fiscal_document.series, fiscal_document.number, fiscal_document.issue_date, fiscal_document.operation_date, jsonb_build_object('fiscal_document_id', fiscal_document.id, 'snapshot', snapshot_value), 'pending', 'create', fiscal_document.idempotency_key
    from public.fiscal_documents as fiscal_document
    where fiscal_document.id = document_id_value
    on conflict (tenant_id, ticket_id) do nothing returning id into legacy_invoice_id_value;
    if legacy_invoice_id_value is null then select legacy_invoice.id into legacy_invoice_id_value from public.fiscal_invoices as legacy_invoice where legacy_invoice.tenant_id = new.tenant_id and legacy_invoice.ticket_id = ticket_record.id; end if;
    update public.fiscal_invoices as legacy_invoice set integration_provider = entity_record.integration_provider where legacy_invoice.id = legacy_invoice_id_value;
    update public.fiscal_documents as fiscal_document set legacy_fiscal_invoice_id = legacy_invoice_id_value where fiscal_document.id = document_id_value;
  end if;
  return new;
end; $$;
