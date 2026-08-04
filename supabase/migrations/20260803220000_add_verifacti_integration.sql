-- Verifacti / VeriFactu / TicketBAI integration.
-- Secrets are encrypted by the Edge Function before reaching these tables.

create table public.fiscal_integration_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  enabled boolean not null default false,
  provider text not null default 'verifactu'
    check (provider in ('verifactu', 'ticketbai')),
  environment text not null default 'test'
    check (environment in ('test', 'production')),
  api_key_ciphertext text,
  management_api_key_ciphertext text,
  automatic_submission boolean not null default true,
  webhooks_enabled boolean not null default false,
  webhook_url text,
  webhook_secret_ciphertext text,
  webhook_external_id text,
  connection_status text not null default 'untested'
    check (connection_status in ('untested', 'connected', 'error')),
  connection_checked_at timestamptz,
  connection_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.fiscal_integration_settings is
  'Tenant-scoped Verifacti configuration. NIF and management API keys are encrypted, backend-only, and never selected by the browser.';

create table public.fiscal_invoice_sequences (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  series text not null,
  last_value bigint not null default 0 check (last_value >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, series),
  check (series !~ '^\s' and char_length(series) between 1 and 20)
);

create table public.fiscal_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  ticket_id uuid not null references public.tickets(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  provider text not null check (provider in ('verifactu', 'ticketbai')),
  environment text not null check (environment in ('test', 'production')),
  invoice_type text not null default 'simplified'
    check (invoice_type in ('normal', 'simplified', 'corrective')),
  series text not null,
  number text not null,
  issue_date date not null default current_date,
  operation_date date,
  document_data jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'accepted_with_errors', 'rejected', 'cancelled', 'error')),
  pending_operation text not null default 'create'
    check (pending_operation in ('create', 'cancel', 'none')),
  idempotency_key text not null,
  external_uuid text,
  external_code text,
  qr_base64 text,
  verification_url text,
  request_payload jsonb,
  response_payload jsonb,
  error_code text,
  error_message text,
  attempts integer not null default 0 check (attempts >= 0),
  next_retry_at timestamptz,
  issued_at timestamptz not null default now(),
  sent_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, ticket_id),
  unique (tenant_id, provider, environment, series, number, issue_date),
  check (series !~ '^\s'),
  check (char_length(series || number) <= 60),
  check (char_length(idempotency_key) between 1 and 255)
);

create index fiscal_invoices_tenant_status_idx
  on public.fiscal_invoices (tenant_id, status, created_at desc);
create index fiscal_invoices_retry_idx
  on public.fiscal_invoices (next_retry_at)
  where next_retry_at is not null;
create unique index fiscal_invoices_external_uuid_idx
  on public.fiscal_invoices (tenant_id, external_uuid)
  where external_uuid is not null;

create table public.fiscal_invoice_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  fiscal_invoice_id uuid not null references public.fiscal_invoices(id) on delete cascade,
  source text not null check (source in ('system', 'outbound', 'status', 'webhook', 'user')),
  event_type text not null,
  status text check (status is null or status in ('pending', 'accepted', 'accepted_with_errors', 'rejected', 'cancelled', 'error')),
  http_status integer,
  payload jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now()
);

create index fiscal_invoice_events_invoice_idx
  on public.fiscal_invoice_events (fiscal_invoice_id, created_at desc);

create table public.fiscal_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  webhook_id uuid not null,
  signature text not null,
  signature_valid boolean not null,
  payload jsonb,
  processing_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create unique index fiscal_webhook_deliveries_valid_id_idx
  on public.fiscal_webhook_deliveries (tenant_id, webhook_id)
  where signature_valid = true;

create or replace function public.next_fiscal_invoice_number(
  p_tenant_id uuid,
  p_series text
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  insert into public.fiscal_invoice_sequences (tenant_id, series, last_value)
  values (p_tenant_id, p_series, 0)
  on conflict (tenant_id, series) do nothing;

  update public.fiscal_invoice_sequences
  set last_value = last_value + 1,
      updated_at = now()
  where tenant_id = p_tenant_id and series = p_series
  returning last_value into v_number;

  return v_number;
end;
$$;

revoke all on function public.next_fiscal_invoice_number(uuid, text) from public, anon, authenticated;

create or replace function public.queue_fiscal_invoice_for_sale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.fiscal_integration_settings%rowtype;
  v_ticket public.tickets%rowtype;
  v_invoice_id uuid := gen_random_uuid();
  v_series text := 'POS';
  v_number bigint;
begin
  select * into v_ticket
  from public.tickets
  where tenant_id = new.tenant_id and id = new.ticket_id;

  if v_ticket.id is null or v_ticket.status <> 'paid' then
    return new;
  end if;

  select * into v_settings
  from public.fiscal_integration_settings
  where tenant_id = new.tenant_id and enabled = true;

  if v_settings.tenant_id is null then
    return new;
  end if;

  v_number := public.next_fiscal_invoice_number(new.tenant_id, v_series);

  insert into public.fiscal_invoices (
    id, tenant_id, venue_id, ticket_id, sale_id, provider, environment,
    invoice_type, series, number, issue_date, operation_date,
    document_data, status, pending_operation, idempotency_key, issued_at
  ) values (
    v_invoice_id, new.tenant_id, new.venue_id, new.ticket_id, new.id,
    v_settings.provider, v_settings.environment,
    'simplified', v_series, v_number::text, current_date,
    (v_ticket.local_created_at at time zone 'Europe/Madrid')::date,
    jsonb_build_object('descripcion', 'Venta de bienes y servicios'),
    'pending', 'create', new.tenant_id::text || ':' || v_invoice_id::text || ':create', now()
  ) on conflict (tenant_id, ticket_id) do nothing;

  if found then
    insert into public.fiscal_invoice_events (
      tenant_id, venue_id, fiscal_invoice_id, source, event_type, status, payload
    ) values (
      new.tenant_id, new.venue_id, v_invoice_id, 'system', 'invoice_issued', 'pending',
      jsonb_build_object('ticket_id', new.ticket_id, 'sale_id', new.id, 'automatic_submission', v_settings.automatic_submission)
    );
  end if;

  return new;
end;
$$;

create trigger queue_fiscal_invoice_after_sale
after insert on public.sales
for each row execute function public.queue_fiscal_invoice_for_sale();

create or replace function public.protect_issued_fiscal_ticket()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ticket_id uuid;
begin
  if tg_table_name = 'ticket_lines' then
    v_ticket_id := case when tg_op = 'DELETE' then old.ticket_id else new.ticket_id end;
  else
    v_ticket_id := case when tg_op = 'DELETE' then old.id else new.id end;
  end if;

  if auth.role() <> 'service_role' and exists (
    select 1 from public.fiscal_invoices fi where fi.ticket_id = v_ticket_id
  ) then
    raise exception 'FISCAL_INVOICE_IMMUTABLE: use cancelacion, subsanacion o factura rectificativa'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger protect_fiscal_ticket_update
before update or delete on public.tickets
for each row execute function public.protect_issued_fiscal_ticket();

create trigger protect_fiscal_ticket_lines
before insert or update or delete on public.ticket_lines
for each row execute function public.protect_issued_fiscal_ticket();

alter table public.fiscal_integration_settings enable row level security;
alter table public.fiscal_invoice_sequences enable row level security;
alter table public.fiscal_invoices enable row level security;
alter table public.fiscal_invoice_events enable row level security;
alter table public.fiscal_webhook_deliveries enable row level security;

create policy fiscal_invoices_select on public.fiscal_invoices
for select to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

create policy fiscal_invoice_events_select on public.fiscal_invoice_events
for select to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

revoke all on public.fiscal_integration_settings from anon, authenticated;
revoke all on public.fiscal_invoice_sequences from anon, authenticated;
revoke all on public.fiscal_webhook_deliveries from anon, authenticated;
revoke insert, update, delete on public.fiscal_invoices from anon, authenticated;
revoke insert, update, delete on public.fiscal_invoice_events from anon, authenticated;
grant select on public.fiscal_invoices, public.fiscal_invoice_events to authenticated;
