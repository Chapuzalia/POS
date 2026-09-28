-- migration-safety: rollback
set lock_timeout = '5s';
set statement_timeout = '5min';

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Restores the exact pre-Odoo sale trigger definition and signature.
-- Restore the sale trigger from 20260821180000_add_invoice_customers.sql before
-- removing the provider-neutral tables on which the Odoo version depends.
create or replace function public.queue_fiscal_invoice_for_sale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings_row public.fiscal_integration_settings%rowtype;
  ticket_row public.tickets%rowtype;
  invoice_id_value uuid := gen_random_uuid();
  series_value text;
  number_value text;
  invoice_type_value text;
  document_data_value jsonb;
  issue_date_value date;
  venue_timezone text;
begin
  select ticket.* into ticket_row
  from public.tickets ticket
  where ticket.tenant_id = new.tenant_id and ticket.id = new.ticket_id;
  if ticket_row.id is null or ticket_row.status <> 'paid' then return new; end if;

  select settings.* into settings_row
  from public.fiscal_integration_settings settings
  where settings.tenant_id = new.tenant_id and settings.enabled = true;
  if settings_row.tenant_id is null then return new; end if;

  select coalesce(venue.timezone, 'Europe/Madrid') into venue_timezone
  from public.venues venue where venue.id = new.venue_id;
  issue_date_value := (coalesce(ticket_row.invoice_issued_at, now()) at time zone coalesce(venue_timezone, 'Europe/Madrid'))::date;

  if ticket_row.is_invoice then
    series_value := ticket_row.invoice_series;
    number_value := ticket_row.invoice_number;
    invoice_type_value := 'normal';
    document_data_value := jsonb_build_object(
      'descripcion', 'Venta de bienes y servicios',
      'recipient', jsonb_build_object(
        'nombre', ticket_row.customer_snapshot ->> 'legalName',
        'nif', ticket_row.customer_snapshot ->> 'taxId',
        'direccion', concat_ws(', ',
          ticket_row.customer_snapshot ->> 'address',
          concat_ws(' ', ticket_row.customer_snapshot ->> 'postalCode', ticket_row.customer_snapshot ->> 'city'),
          ticket_row.customer_snapshot ->> 'province',
          ticket_row.customer_snapshot ->> 'country'
        ),
        'cp', ticket_row.customer_snapshot ->> 'postalCode'
      ),
      'customerSnapshot', ticket_row.customer_snapshot
    );
  else
    series_value := 'POS';
    number_value := public.next_fiscal_invoice_number(new.tenant_id, series_value)::text;
    invoice_type_value := 'simplified';
    document_data_value := jsonb_build_object('descripcion', 'Venta de bienes y servicios');
  end if;

  insert into public.fiscal_invoices (
    id, tenant_id, venue_id, ticket_id, sale_id, provider, environment,
    invoice_type, series, number, issue_date, operation_date,
    document_data, status, pending_operation, idempotency_key, issued_at
  ) values (
    invoice_id_value, new.tenant_id, new.venue_id, new.ticket_id, new.id,
    settings_row.provider, settings_row.environment,
    invoice_type_value, series_value, number_value, issue_date_value,
    (ticket_row.local_created_at at time zone coalesce(venue_timezone, 'Europe/Madrid'))::date,
    document_data_value, 'pending', 'create',
    new.tenant_id::text || ':' || invoice_id_value::text || ':create', now()
  ) on conflict (tenant_id, ticket_id) do nothing;

  if found then
    insert into public.fiscal_invoice_events (
      tenant_id, venue_id, fiscal_invoice_id, source, event_type, status, payload
    ) values (
      new.tenant_id, new.venue_id, invoice_id_value, 'system', 'invoice_issued', 'pending',
      jsonb_build_object('ticket_id', new.ticket_id, 'sale_id', new.id, 'automatic_submission', settings_row.automatic_submission)
    );
  end if;
  return new;
end;
$$;

-- Remove invoices linked to branch-only fiscal documents, including their
-- cascading event rows.
delete from public.fiscal_invoices as invoice
using public.fiscal_documents as document
where document.legacy_fiscal_invoice_id = invoice.id;

drop view public.fiscal_outbox_incidents_safe;
drop view public.fiscal_documents_safe;
drop view public.fiscal_entities_safe;

drop function public.superadmin_update_fiscal_entity_venues(uuid, uuid, uuid[]);
drop function public.fiscal_fail_operation(uuid, text, text, text, timestamptz, text);
drop function public.fiscal_complete_operation(uuid, text, text, text, text, text, date, bigint, text, text, jsonb);
drop function public.fiscal_outbox_fail(uuid, text, text, timestamptz, text);
drop function public.fiscal_outbox_complete(uuid, text, jsonb);
drop function public.fiscal_outbox_claim(text, integer);
drop function public.fiscal_outbox_claim_document(uuid, text, integer);
drop function public.fiscal_outbox_enqueue(uuid, text, text, uuid, uuid, uuid);
drop function public.resolve_fiscal_entity_for_venue(uuid, uuid);

drop table public.fiscal_outbox;
drop table public.fiscal_documents;
drop table public.fiscal_entity_venues;
drop table public.fiscal_entities;

drop trigger assign_ticket_operational_reference_before_insert on public.tickets;
drop trigger assign_cash_register_administrative_code_before_write on public.cash_registers;
drop trigger assign_venue_administrative_code_before_write on public.venues;
drop function public.assign_ticket_operational_reference();
drop function public.assign_cash_register_administrative_code();
drop function public.assign_venue_administrative_code();

drop table public.ticket_operational_reference_counters;
drop table public.cash_register_administrative_code_counters;
drop table public.venue_administrative_code_counters;

alter table public.tickets
  drop column operational_reference,
  drop column operational_reference_year;
alter table public.cash_registers drop column administrative_code;
alter table public.venues drop column administrative_code;
alter table public.fiscal_invoices
  drop column aeat_status,
  drop column emission_state,
  drop column qr_payload,
  drop column fiscal_number,
  drop column integration_provider;
