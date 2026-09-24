-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.fiscal_invoices
  add column if not exists integration_provider text
    check (integration_provider is null or integration_provider in ('verifacti', 'odoo')),
  add column if not exists fiscal_number text,
  add column if not exists qr_payload text;

create table public.fiscal_entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  display_name text not null default 'Fiscal entity',
  legal_name text not null,
  tax_id text not null,
  integration_provider text not null check (integration_provider in ('verifacti', 'odoo')),
  tax_system text not null check (tax_system in ('verifactu', 'ticketbai')),
  environment text not null default 'test' check (environment in ('test', 'production')),
  legacy_settings_id uuid unique references public.fiscal_integration_settings(tenant_id) on delete set null,
  provider_entity_ref text,
  bridge_url text,
  bridge_secret_ciphertext text,
  enabled boolean not null default true,
  automatic_submission boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, display_name),
  unique (tenant_id, id),
  check (integration_provider <> 'odoo' or tax_system = 'verifactu'),
  check (integration_provider <> 'odoo' or (nullif(btrim(provider_entity_ref), '') is not null and nullif(btrim(bridge_url), '') is not null and bridge_secret_ciphertext is not null))
);

create table public.fiscal_entity_venues (
  fiscal_entity_id uuid not null references public.fiscal_entities(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (fiscal_entity_id, venue_id),
  unique (tenant_id, venue_id),
  foreign key (tenant_id, fiscal_entity_id) references public.fiscal_entities(tenant_id, id) deferrable initially immediate
);

create table public.fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  fiscal_entity_id uuid not null references public.fiscal_entities(id) on delete restrict,
  ticket_id uuid references public.tickets(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  integration_provider text not null check (integration_provider in ('verifacti', 'odoo')),
  tax_system text not null check (tax_system in ('verifactu', 'ticketbai')),
  document_kind text not null check (document_kind in ('simplified', 'full', 'corrective')),
  status text not null default 'pending' check (status in ('pending', 'generated', 'accepted', 'accepted_with_errors', 'rejected', 'cancelled', 'error')),
  series text not null,
  number text not null,
  issue_date date not null default current_date,
  operation_date date,
  expected_total_cents bigint not null check (expected_total_cents >= 0),
  returned_total_cents bigint check (returned_total_cents is null or returned_total_cents >= 0),
  discrepancy_cents bigint generated always as (case when returned_total_cents is null then null else returned_total_cents - expected_total_cents end) stored,
  commercial_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(commercial_snapshot) = 'object'),
  provider_fiscal_number text,
  provider_fiscal_type text,
  provider_fiscal_date date,
  provider_qr text,
  provider_url text,
  provider_external_id text,
  error_code text,
  error_message text,
  legacy_fiscal_invoice_id uuid references public.fiscal_invoices(id) on delete set null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, fiscal_entity_id, series, number, issue_date),
  foreign key (tenant_id, fiscal_entity_id) references public.fiscal_entities(tenant_id, id) deferrable initially immediate
);

create index fiscal_documents_tenant_status_idx on public.fiscal_documents (tenant_id, status, created_at desc);
create index fiscal_documents_venue_idx on public.fiscal_documents (tenant_id, venue_id, created_at desc);
create index fiscal_documents_entity_idx on public.fiscal_documents (fiscal_entity_id, status, created_at desc);

create table public.fiscal_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  fiscal_entity_id uuid not null references public.fiscal_entities(id) on delete restrict,
  fiscal_document_id uuid not null references public.fiscal_documents(id) on delete cascade,
  operation text not null check (operation in ('create', 'cancel')),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'completed', 'failed')),
  idempotency_key text not null,
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  claimed_by text,
  last_error text,
  incident_code text,
  -- Backend-only encrypted/reference material. Never grant this table to browser roles.
  raw_request jsonb,
  raw_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, fiscal_entity_id) references public.fiscal_entities(tenant_id, id) deferrable initially immediate
);
create index fiscal_outbox_claim_idx on public.fiscal_outbox (status, available_at, lease_expires_at);
create index fiscal_outbox_incident_idx on public.fiscal_outbox (tenant_id, venue_id, incident_code, created_at desc);

-- Legacy settings remain the credential source; entity rows only retain a reference.
insert into public.fiscal_entities (tenant_id, display_name, legal_name, tax_id, integration_provider, tax_system, environment, legacy_settings_id, enabled)
select s.tenant_id, 'Legacy fiscal entity', coalesce(nullif(btrim(v.legal_name), ''), t.name), coalesce(nullif(btrim(v.tax_id), ''), 'PENDING'), 'verifacti', s.provider, s.environment, s.tenant_id, s.enabled
from public.fiscal_integration_settings s
join public.tenants t on t.id = s.tenant_id
left join lateral (select legal_name, tax_id from public.venues where tenant_id = s.tenant_id order by sort_order, id limit 1) v on true
where s.enabled
on conflict (legacy_settings_id) do nothing;

insert into public.fiscal_entity_venues (fiscal_entity_id, tenant_id, venue_id)
select e.id, v.tenant_id, v.id
from public.fiscal_entities e
join public.venues v on v.tenant_id = e.tenant_id
where e.legacy_settings_id is not null
on conflict (tenant_id, venue_id) do nothing;

create or replace function public.resolve_fiscal_entity_for_venue(p_tenant_id uuid, p_venue_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select ev.fiscal_entity_id into strict v_id from public.fiscal_entity_venues ev join public.fiscal_entities e on e.id = ev.fiscal_entity_id
  where ev.tenant_id = p_tenant_id and ev.venue_id = p_venue_id and e.enabled;
  return v_id;
exception when no_data_found then return null;
end; $$;

create or replace function public.fiscal_outbox_claim_document(p_document_id uuid, p_worker_id text, p_lease_seconds integer default 60)
returns public.fiscal_outbox language plpgsql security definer set search_path = '' as $$
declare r public.fiscal_outbox;
begin
  if auth.role() <> 'service_role' then raise exception 'FISCAL_OUTBOX_SERVICE_ONLY' using errcode = '42501'; end if;
  update public.fiscal_outbox set status = 'claimed', claimed_by = p_worker_id,
    lease_expires_at = now() + make_interval(secs => greatest(1, p_lease_seconds)), attempts = attempts + 1, updated_at = now()
  where fiscal_document_id = p_document_id
    and ((status = 'pending' and available_at <= now()) or (status = 'failed' and available_at <= now()) or (status = 'claimed' and lease_expires_at < now()))
  returning * into r;
  return r;
end; $$;

create or replace function public.fiscal_outbox_enqueue(p_document_id uuid, p_operation text, p_idempotency_key text, p_tenant_id uuid, p_venue_id uuid, p_entity_id uuid)
returns public.fiscal_outbox language plpgsql security definer set search_path = '' as $$
declare r public.fiscal_outbox;
begin
  if auth.role() <> 'service_role' then raise exception 'FISCAL_OUTBOX_SERVICE_ONLY' using errcode = '42501'; end if;
  insert into public.fiscal_outbox (tenant_id, venue_id, fiscal_entity_id, fiscal_document_id, operation, idempotency_key)
  values (p_tenant_id, p_venue_id, p_entity_id, p_document_id, p_operation, p_idempotency_key)
  on conflict (tenant_id, idempotency_key) do update set updated_at = now()
  returning * into r;
  return r;
end; $$;

create or replace function public.fiscal_outbox_claim(p_worker_id text, p_lease_seconds integer default 60)
returns setof public.fiscal_outbox language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'FISCAL_OUTBOX_SERVICE_ONLY' using errcode = '42501'; end if;
  return query
  update public.fiscal_outbox o set status = 'claimed', claimed_by = p_worker_id, lease_expires_at = now() + make_interval(secs => greatest(1, p_lease_seconds)), attempts = o.attempts + 1, updated_at = now()
  where o.id in (select x.id from public.fiscal_outbox x where (x.status = 'pending' and x.available_at <= now()) or (x.status = 'claimed' and x.lease_expires_at < now()) order by x.created_at for update skip locked limit 1)
  returning o.*;
end; $$;

create or replace function public.fiscal_outbox_complete(p_outbox_id uuid, p_worker_id text, p_response jsonb default null)
returns public.fiscal_outbox language plpgsql security definer set search_path = '' as $$
declare r public.fiscal_outbox;
begin
  if auth.role() <> 'service_role' then raise exception 'FISCAL_OUTBOX_SERVICE_ONLY' using errcode = '42501'; end if;
  update public.fiscal_outbox set status = 'completed', raw_response = p_response, lease_expires_at = null, claimed_by = null, updated_at = now() where id = p_outbox_id and status = 'claimed' and claimed_by = p_worker_id returning * into r;
  if r.id is null then raise exception 'FISCAL_OUTBOX_LEASE_INVALID' using errcode = '40001'; end if; return r;
end; $$;

create or replace function public.fiscal_outbox_fail(p_outbox_id uuid, p_worker_id text, p_error text, p_retry_at timestamptz default null, p_incident_code text default null)
returns public.fiscal_outbox language plpgsql security definer set search_path = '' as $$
declare r public.fiscal_outbox;
begin
  if auth.role() <> 'service_role' then raise exception 'FISCAL_OUTBOX_SERVICE_ONLY' using errcode = '42501'; end if;
  update public.fiscal_outbox set status = 'failed', last_error = left(p_error, 500), incident_code = p_incident_code, available_at = coalesce(p_retry_at, now()), lease_expires_at = null, claimed_by = null, updated_at = now() where id = p_outbox_id and status = 'claimed' and claimed_by = p_worker_id returning * into r;
  if r.id is null then raise exception 'FISCAL_OUTBOX_LEASE_INVALID' using errcode = '40001'; end if; return r;
end; $$;

create or replace function public.fiscal_complete_operation(
  p_outbox_id uuid, p_worker_id text, p_status text, p_provider_external_id text,
  p_fiscal_number text, p_fiscal_type text, p_fiscal_date date, p_returned_total_cents bigint, p_provider_qr text,
  p_provider_url text, p_response jsonb default null
) returns public.fiscal_documents language plpgsql security definer set search_path = '' as $$
declare o public.fiscal_outbox%rowtype; d public.fiscal_documents%rowtype; legacy_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'FISCAL_OUTBOX_SERVICE_ONLY' using errcode = '42501'; end if;
  if p_status not in ('pending', 'generated', 'accepted', 'accepted_with_errors', 'rejected', 'cancelled', 'error') then
    raise exception 'FISCAL_STATUS_INVALID' using errcode = '22023';
  end if;
  select * into o from public.fiscal_outbox where id = p_outbox_id and status = 'claimed' and claimed_by = p_worker_id for update;
  if o.id is null then raise exception 'FISCAL_OUTBOX_LEASE_INVALID' using errcode = '40001'; end if;
  select * into d from public.fiscal_documents where id = o.fiscal_document_id for update;
  if p_returned_total_cents is not null and p_returned_total_cents <> d.expected_total_cents then
    raise exception 'FISCAL_TOTAL_DISCREPANCY' using errcode = '22000';
  end if;
  update public.fiscal_documents set status = p_status, provider_external_id = coalesce(p_provider_external_id, provider_external_id),
     provider_fiscal_number = coalesce(p_fiscal_number, provider_fiscal_number), provider_fiscal_type = coalesce(p_fiscal_type, provider_fiscal_type),
     provider_fiscal_date = coalesce(p_fiscal_date, provider_fiscal_date), returned_total_cents = coalesce(p_returned_total_cents, returned_total_cents),
     provider_qr = coalesce(p_provider_qr, provider_qr), provider_url = coalesce(p_provider_url, provider_url), updated_at = now()

  where id = d.id returning * into d;
  legacy_status := case when p_status = 'generated' then 'pending' else p_status end;
  if d.legacy_fiscal_invoice_id is not null then
    update public.fiscal_invoices set status = legacy_status, pending_operation = case when p_status in ('accepted','accepted_with_errors','rejected','cancelled') then 'none' else pending_operation end,
      integration_provider = d.integration_provider, external_uuid = coalesce(p_provider_external_id, external_uuid),
      external_code = coalesce(p_fiscal_number, external_code), fiscal_number = coalesce(p_fiscal_number, fiscal_number),
      qr_payload = coalesce(p_provider_qr, qr_payload), verification_url = coalesce(p_provider_url, verification_url), response_payload = p_response,
      error_code = null, error_message = null, next_retry_at = null, sent_at = coalesce(sent_at, now()),
      confirmed_at = case when p_status in ('accepted','accepted_with_errors') then coalesce(confirmed_at, now()) else confirmed_at end,
      cancelled_at = case when p_status = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end, updated_at = now()
    where id = d.legacy_fiscal_invoice_id;
  end if;
  update public.fiscal_outbox set status = case when p_status in ('pending','generated') then 'pending' else 'completed' end,
    raw_response = p_response, available_at = case when p_status in ('pending','generated') then now() + interval '5 minutes' else available_at end,
    lease_expires_at = null, claimed_by = null, last_error = null, incident_code = null, updated_at = now() where id = o.id;
  return d;
end; $$;

create or replace function public.fiscal_fail_operation(
  p_outbox_id uuid, p_worker_id text, p_error_code text, p_safe_error text,
  p_retry_at timestamptz default null, p_incident_code text default null
) returns public.fiscal_documents language plpgsql security definer set search_path = '' as $$
declare o public.fiscal_outbox%rowtype; d public.fiscal_documents%rowtype; retryable boolean := p_retry_at is not null;
begin
  if auth.role() <> 'service_role' then raise exception 'FISCAL_OUTBOX_SERVICE_ONLY' using errcode = '42501'; end if;
  select * into o from public.fiscal_outbox where id = p_outbox_id and status = 'claimed' and claimed_by = p_worker_id for update;
  if o.id is null then raise exception 'FISCAL_OUTBOX_LEASE_INVALID' using errcode = '40001'; end if;
  update public.fiscal_documents set status = 'error', error_code = p_error_code, error_message = left(p_safe_error, 500), updated_at = now() where id = o.fiscal_document_id returning * into d;
  update public.fiscal_outbox set status = 'failed', last_error = left(p_safe_error, 500), incident_code = p_incident_code,
    available_at = coalesce(p_retry_at, available_at), lease_expires_at = null, claimed_by = null, updated_at = now() where id = o.id;
  if d.legacy_fiscal_invoice_id is not null then
    update public.fiscal_invoices set status = 'error', error_code = p_error_code, error_message = left(p_safe_error, 500),
      next_retry_at = p_retry_at, updated_at = now() where id = d.legacy_fiscal_invoice_id;
  end if;
  return d;
end; $$;

-- Keep old clients working while routing new work through the resolved entity.
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE preserves the trigger signature and N-1 behavior while adding the provider-neutral projection.
create or replace function public.queue_fiscal_invoice_for_sale() returns trigger language plpgsql security definer set search_path = '' as $$
declare t public.tickets%rowtype; s public.fiscal_integration_settings%rowtype; e public.fiscal_entities%rowtype; d public.fiscal_documents%rowtype; d_id uuid; l_id uuid; kind text; provider text; snapshot jsonb; total bigint;
begin
  select * into t from public.tickets where id = new.ticket_id and tenant_id = new.tenant_id;
  if t.id is null or t.status <> 'paid' then return new; end if;
  e.id := public.resolve_fiscal_entity_for_venue(new.tenant_id, new.venue_id);
  if e.id is null then select * into s from public.fiscal_integration_settings where tenant_id = new.tenant_id and enabled; if s.tenant_id is null then return new; end if; select * into e from public.fiscal_entities where legacy_settings_id = s.tenant_id; end if;
  select * into e from public.fiscal_entities where id = e.id;
  if e.id is null then return new; end if;
  provider := e.tax_system; kind := case when t.is_invoice then 'full' else 'simplified' end;
  snapshot := jsonb_build_object('ticket', to_jsonb(t), 'lines', coalesce((select jsonb_agg(to_jsonb(x)) from public.ticket_lines x where x.ticket_id = t.id), '[]'::jsonb));
  total := coalesce(t.total_cents, 0);
  insert into public.fiscal_documents (tenant_id, venue_id, fiscal_entity_id, ticket_id, sale_id, integration_provider, tax_system, document_kind, series, number, issue_date, operation_date, expected_total_cents, commercial_snapshot, idempotency_key)
  values (new.tenant_id, new.venue_id, e.id, t.id, new.id, e.integration_provider, e.tax_system, kind, case when t.is_invoice then t.invoice_series else 'POS' end, case when t.is_invoice then t.invoice_number else public.next_fiscal_invoice_number(new.tenant_id, 'POS')::text end, current_date, t.local_created_at::date, total, snapshot, new.tenant_id::text || ':' || t.id::text || ':create')
  on conflict (tenant_id, idempotency_key) do nothing returning id into d_id;
  if d_id is not null then
    select * into d from public.fiscal_documents where id = d_id;
    insert into public.fiscal_outbox (tenant_id, venue_id, fiscal_entity_id, fiscal_document_id, operation, idempotency_key) values (new.tenant_id, new.venue_id, e.id, d_id, 'create', new.tenant_id::text || ':' || t.id::text || ':create') on conflict do nothing;
    insert into public.fiscal_invoices (tenant_id, venue_id, ticket_id, sale_id, provider, environment, invoice_type, series, number, issue_date, operation_date, document_data, status, pending_operation, idempotency_key)
    select new.tenant_id, new.venue_id, t.id, new.id, provider, e.environment, case when kind = 'full' then 'normal' else kind end, d.series, d.number, d.issue_date, d.operation_date, jsonb_build_object('fiscal_document_id', d.id, 'snapshot', snapshot), 'pending', 'create', d.idempotency_key from public.fiscal_documents d where d.id = d_id on conflict (tenant_id, ticket_id) do nothing
    returning id into l_id;
    if l_id is null then select id into l_id from public.fiscal_invoices where tenant_id = new.tenant_id and ticket_id = t.id; end if;
    update public.fiscal_invoices set integration_provider = e.integration_provider where id = l_id;
    update public.fiscal_documents set legacy_fiscal_invoice_id = l_id where id = d_id;
  end if;
  return new;
end; $$;

alter table public.fiscal_entities enable row level security;
alter table public.fiscal_entity_venues enable row level security;
alter table public.fiscal_documents enable row level security;
alter table public.fiscal_outbox enable row level security;
create policy fiscal_entities_select on public.fiscal_entities for select to authenticated using (public.user_is_tenant_admin(tenant_id));
create policy fiscal_entity_venues_select on public.fiscal_entity_venues for select to authenticated using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy fiscal_documents_select on public.fiscal_documents for select to authenticated using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy fiscal_outbox_select on public.fiscal_outbox for select to authenticated using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

create view public.fiscal_entities_safe with (security_invoker = true) as select id, tenant_id, display_name, legal_name, tax_id, integration_provider, tax_system, environment, enabled, automatic_submission, provider_entity_ref, created_at, updated_at from public.fiscal_entities;
  create view public.fiscal_documents_safe with (security_invoker = true) as select id, tenant_id, venue_id, fiscal_entity_id, ticket_id, sale_id, integration_provider, tax_system, document_kind, status, series, number, issue_date, operation_date, expected_total_cents, returned_total_cents, discrepancy_cents, provider_fiscal_number, provider_fiscal_type, provider_fiscal_date, provider_qr, provider_url, provider_external_id, error_code, error_message, created_at, updated_at from public.fiscal_documents;

create view public.fiscal_outbox_incidents_safe with (security_invoker = true) as select id, tenant_id, venue_id, fiscal_entity_id, fiscal_document_id, operation, status, idempotency_key, attempts, available_at, lease_expires_at, claimed_by, last_error, incident_code, created_at, updated_at from public.fiscal_outbox where incident_code is not null or status = 'failed';

revoke all on public.fiscal_entities, public.fiscal_entity_venues, public.fiscal_documents, public.fiscal_outbox from anon, authenticated;
grant select on public.fiscal_entities_safe, public.fiscal_documents_safe, public.fiscal_outbox_incidents_safe to authenticated;
grant select (id, tenant_id, display_name, legal_name, tax_id, integration_provider, tax_system, environment, enabled, automatic_submission, provider_entity_ref, created_at, updated_at) on public.fiscal_entities to authenticated;
grant select (id, tenant_id, venue_id, fiscal_entity_id, ticket_id, sale_id, integration_provider, tax_system, document_kind, status, series, number, issue_date, operation_date, expected_total_cents, returned_total_cents, discrepancy_cents, provider_fiscal_number, provider_fiscal_type, provider_fiscal_date, provider_qr, provider_url, provider_external_id, error_code, error_message, created_at, updated_at) on public.fiscal_documents to authenticated;
grant select on public.fiscal_outbox_incidents_safe to authenticated;
revoke all on function public.resolve_fiscal_entity_for_venue(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fiscal_outbox_enqueue(uuid, text, text, uuid, uuid, uuid), public.fiscal_outbox_claim(text, integer), public.fiscal_outbox_claim_document(uuid, text, integer), public.fiscal_outbox_complete(uuid, text, jsonb), public.fiscal_outbox_fail(uuid, text, text, timestamptz, text), public.fiscal_complete_operation(uuid, text, text, text, text, text, date, bigint, text, text, jsonb), public.fiscal_fail_operation(uuid, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.fiscal_outbox_enqueue(uuid, text, text, uuid, uuid, uuid), public.fiscal_outbox_claim(text, integer), public.fiscal_outbox_claim_document(uuid, text, integer), public.fiscal_outbox_complete(uuid, text, jsonb), public.fiscal_outbox_fail(uuid, text, text, timestamptz, text), public.fiscal_complete_operation(uuid, text, text, text, text, text, date, bigint, text, text, jsonb), public.fiscal_fail_operation(uuid, text, text, text, timestamptz, text) to service_role;
