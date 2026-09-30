-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

create table public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  original_ticket_id uuid not null references public.tickets(id) on delete restrict,
  original_sale_id uuid not null references public.sales(id) on delete restrict,
  original_cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  refund_cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  refund_method text not null check (refund_method in ('cash', 'card')),
  total_cents integer not null check (total_cents < 0),
  fiscal_series text not null check (fiscal_series ~ '^[A-Z0-9]{1,8}-[A-Z0-9]{1,8}-[0-9]{4}-R$'),
  fiscal_status text not null default 'persisted' check (fiscal_status = 'persisted'),
  fiscal_rectificative_record jsonb not null check (jsonb_typeof(fiscal_rectificative_record) = 'object'),
  idempotency_key uuid not null,
  actor_id uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table public.refund_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  refund_request_id uuid not null references public.refund_requests(id) on delete restrict deferrable initially deferred,
  original_ticket_line_id uuid not null references public.ticket_lines(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  gross_cents integer not null check (gross_cents < 0),
  discount_cents integer not null check (discount_cents <= 0),
  net_total_cents integer not null check (net_total_cents < 0 and net_total_cents = gross_cents - discount_cents),
  product_name text not null,
  variant_name text not null,
  modifiers jsonb,
  tax_rate numeric(5,2),
  taxable_base_cents integer,
  tax_amount_cents integer,
  created_at timestamptz not null default now(),
  unique (tenant_id, refund_request_id, original_ticket_line_id)
);

create table public.refund_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  refund_request_id uuid not null references public.refund_requests(id) on delete restrict deferrable initially deferred,
  method text not null check (method in ('cash', 'card')),
  amount_cents integer not null check (amount_cents < 0),
  payment_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(payment_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, refund_request_id, method)
);

create index refund_requests_original_ticket_idx on public.refund_requests (tenant_id, original_ticket_id);
create index refund_lines_original_line_idx on public.refund_lines (tenant_id, original_ticket_line_id);
create index refund_payments_request_idx on public.refund_payments (tenant_id, refund_request_id);

alter table public.fiscal_local_records add column if not exists refund_request_id uuid;
alter table public.fiscal_local_records add constraint fiscal_local_records_refund_request_fkey foreign key (refund_request_id) references public.refund_requests(id) on delete restrict not valid;
alter table public.fiscal_local_records validate constraint fiscal_local_records_refund_request_fkey;
create unique index fiscal_local_one_record_per_refund_idx on public.fiscal_local_records (tenant_id, refund_request_id) where refund_request_id is not null;

create or replace function public.create_ticket_refund(
  p_tenant_id uuid,
  p_original_ticket_id uuid,
  p_original_sale_id uuid,
  p_refund_request_id uuid,
  p_refund_cash_session_id uuid,
  p_refund_method text,
  p_lines jsonb,
  p_idempotency_key uuid,
  p_record jsonb,
  p_invoice jsonb
) returns public.refund_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.refund_requests%rowtype;
  v_ticket public.tickets%rowtype;
  v_sale public.sales%rowtype;
  v_original_session public.cash_sessions%rowtype;
  v_session public.cash_sessions%rowtype;
  v_original_fiscal public.fiscal_local_records%rowtype;
  v_installation public.fiscal_sif_installations%rowtype;
  v_subject public.fiscal_subjects%rowtype;
  v_prior public.fiscal_local_records%rowtype;
  v_series public.fiscal_local_series%rowtype;
  v_line public.ticket_lines%rowtype;
  v_item jsonb;
  v_request uuid := p_refund_request_id;
  v_record jsonb := p_record -> 'canonicalRecord' -> 'RegistroAlta';
  v_type text := v_record ->> 'TipoFactura';
  v_series_name text := p_invoice ->> 'series';
  v_number bigint := (p_invoice ->> 'number')::bigint;
  v_position bigint := (p_record ->> 'chainPosition')::bigint;
  v_previous_hash text := p_record -> 'previous' ->> 'hash';
  v_hash text := p_record ->> 'hash';
  v_user uuid := auth.uid();
  v_invoice_id uuid := (p_record ->> 'invoiceId')::uuid;
  v_timezone text;
  v_qty integer;
  v_total integer := 0;
  v_gross integer;
  v_discount integer;
  v_net integer;
  v_tax integer;
  v_base integer;
  v_used integer;
begin
  if v_user is null or not public.user_has_tenant_access(p_tenant_id) or v_request is null or p_idempotency_key is null
    or p_record is null or p_invoice is null or jsonb_typeof(p_record) <> 'object' or jsonb_typeof(p_invoice) <> 'object'
    or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or p_refund_method not in ('cash', 'card') then
    raise exception 'REFUND_BAD_REQUEST' using errcode = '22023';
  end if;
  select * into v_existing from public.refund_requests where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.fiscal_rectificative_record is distinct from p_record then raise exception 'REFUND_IDEMPOTENCY_CONFLICT' using errcode = '23505'; end if;
    return v_existing;
  end if;
  select * into v_ticket from public.tickets where id = p_original_ticket_id and tenant_id = p_tenant_id for update;
  select * into v_sale from public.sales where id = p_original_sale_id and tenant_id = p_tenant_id for update;
  if v_ticket.id is null or v_sale.id is null or v_sale.ticket_id <> v_ticket.id or v_ticket.status <> 'paid' or v_ticket.total_cents <= 0 or v_sale.total_cents <> v_ticket.total_cents then
    raise exception 'REFUND_ORIGINAL_NOT_REFUNDABLE' using errcode = '22023';
  end if;
  select * into v_original_session from public.cash_sessions where id = v_ticket.cash_session_id and tenant_id = p_tenant_id for update;
  select * into v_session from public.cash_sessions where id = p_refund_cash_session_id and tenant_id = p_tenant_id for update;
  if v_original_session.id is null or v_original_session.status <> 'open' or v_session.id is null or v_session.id <> v_original_session.id
    or v_session.status <> 'open' or v_session.venue_id <> v_ticket.venue_id or v_session.cash_register_id <> v_ticket.cash_register_id then
    raise exception 'REFUND_SESSION_MUST_BE_ORIGINAL_OPEN_SESSION' using errcode = '55000';
  end if;
  select * into v_original_fiscal from public.fiscal_local_records where tenant_id = p_tenant_id and ticket_id = v_ticket.id and record_kind = 'alta' for update;
  if v_original_fiscal.id is null or (v_original_fiscal.canonical_record -> 'RegistroAlta' ->> 'TipoFactura') not in ('F1', 'F2') then
    raise exception 'REFUND_ORIGINAL_FISCAL_RECORD_REQUIRED' using errcode = '55000';
  end if;
  if v_type not in ('R1', 'R5') or (v_type = 'R1' and v_original_fiscal.canonical_record -> 'RegistroAlta' ->> 'TipoFactura' <> 'F1')
    or (v_type = 'R5' and v_original_fiscal.canonical_record -> 'RegistroAlta' ->> 'TipoFactura' <> 'F2')
    or v_record ->> 'TipoRectificativa' <> 'I' then
    raise exception 'REFUND_RECTIFICATIVE_REFERENCE_INVALID' using errcode = '22023';
  end if;
  select * into v_installation from public.fiscal_sif_installations where id = (p_record ->> 'installationId')::uuid for update;
  select * into v_subject from public.fiscal_subjects where id = v_installation.fiscal_subject_id and tenant_id = p_tenant_id;
  if v_installation.id is null or v_installation.retired_at is not null or v_installation.mode <> 'production' or v_installation.venue_id <> v_ticket.venue_id
    or v_installation.cash_register_id <> v_session.cash_register_id or v_installation.device_id <> v_session.device_id or v_subject.id is null
    or p_record ->> 'tenantId' <> p_tenant_id::text or p_record ->> 'venueId' <> v_session.venue_id::text or p_record ->> 'cashRegisterId' <> v_session.cash_register_id::text
    or p_record ->> 'deviceId' <> v_session.device_id::text or p_record ->> 'fiscalSubjectId' <> v_subject.id::text or p_record ->> 'issuerNif' <> v_subject.nif
    or p_record ->> 'environment' <> 'production' or p_record ->> 'canonicalSchema' <> 'aeat-registro-v1' then
    raise exception 'REFUND_FISCAL_SCOPE_INVALID' using errcode = '42501';
  end if;
  select coalesce(v.timezone, 'Europe/Madrid') into v_timezone from public.venues v where v.id = v_session.venue_id and v.tenant_id = p_tenant_id;
  if v_series_name <> v_installation.venue_code || '-' || v_installation.register_code || '-' || extract(year from (p_invoice ->> 'issuedAt')::timestamptz at time zone v_timezone)::text || '-R'
    or v_number < 1 or v_hash !~ '^[0-9A-F]{64}$' or v_record ->> 'Huella' <> v_hash or (p_invoice ->> 'totalCents')::integer >= 0
    or (v_record ->> 'ImporteTotal')::numeric >= 0 or v_record ->> 'idempotencyKey' <> p_idempotency_key::text then
    raise exception 'REFUND_FISCAL_INVOICE_INVALID' using errcode = '22023';
  end if;
  select * into v_prior from public.fiscal_local_records where tenant_id = p_tenant_id and fiscal_subject_id = v_subject.id and installation_id = v_installation.id order by chain_position desc limit 1 for update;
  if v_position <> coalesce(v_prior.chain_position, 0) + 1 or (v_prior.id is null and v_previous_hash is not null) or (v_prior.id is not null and v_previous_hash is distinct from v_prior.hash) then
    raise exception 'REFUND_FISCAL_CHAIN_CONFLICT' using errcode = '23505';
  end if;
  insert into public.fiscal_local_series (tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, device_id, document_kind, exercise, series)
    values (p_tenant_id, v_subject.id, v_installation.id, v_session.venue_id, v_session.cash_register_id, v_session.device_id, 'corrective', extract(year from (p_invoice ->> 'issuedAt')::timestamptz at time zone v_timezone)::integer, v_series_name)
    on conflict (tenant_id, fiscal_subject_id, series) do nothing;
  select * into v_series from public.fiscal_local_series where tenant_id = p_tenant_id and fiscal_subject_id = v_subject.id and series = v_series_name for update;
  if v_series.installation_id <> v_installation.id or v_series.document_kind <> 'corrective' or v_series.last_number + 1 <> v_number then raise exception 'REFUND_FISCAL_COUNTER_CONFLICT' using errcode = '23505'; end if;
  for v_item in select value from jsonb_array_elements(p_lines) loop
    select * into v_line from public.ticket_lines where id = (v_item ->> 'originalTicketLineId')::uuid and tenant_id = p_tenant_id and ticket_id = v_ticket.id for update;
    v_qty := (v_item ->> 'quantity')::integer;
    select coalesce(sum(rl.quantity), 0) into v_used from public.refund_lines rl join public.refund_requests rr on rr.id = rl.refund_request_id where rr.original_ticket_id = v_ticket.id and rl.original_ticket_line_id = v_line.id;
    if v_line.id is null or v_qty < 1 or v_qty + v_used > v_line.quantity then raise exception 'REFUND_LINE_QUANTITY_INVALID' using errcode = '22023'; end if;
    v_gross := v_qty * v_line.unit_price_cents;
    v_discount := -round(coalesce(v_line.discount_amount_cents, 0)::numeric * v_qty / v_line.quantity)::integer;
    v_net := -v_gross - v_discount;
    v_tax := case when v_line.tax_amount_cents is null then null else -round(abs(v_line.tax_amount_cents)::numeric * v_qty / v_line.quantity)::integer end;
    v_base := case when v_line.taxable_base_cents is null then null else v_net - coalesce(v_tax, 0) end;
    v_total := v_total + v_net;
    insert into public.refund_lines (tenant_id, refund_request_id, original_ticket_line_id, quantity, unit_price_cents, gross_cents, discount_cents, net_total_cents, product_name, variant_name, modifiers, tax_rate, taxable_base_cents, tax_amount_cents)
      values (p_tenant_id, v_request, v_line.id, v_qty, v_line.unit_price_cents, -v_gross, v_discount, v_net, v_line.product_name, v_line.variant_name, v_line.modifiers, v_line.tax_rate, v_base, v_tax);
  end loop;
  if v_total >= 0 or (p_invoice ->> 'totalCents')::integer <> v_total then raise exception 'REFUND_TOTAL_MISMATCH' using errcode = '22023'; end if;
  insert into public.refund_requests (id, tenant_id, venue_id, original_ticket_id, original_sale_id, original_cash_session_id, refund_cash_session_id, refund_method, total_cents, fiscal_series, fiscal_rectificative_record, idempotency_key, actor_id)
    values (v_request, p_tenant_id, v_session.venue_id, v_ticket.id, v_sale.id, v_original_session.id, v_session.id, p_refund_method, v_total, v_series_name, p_record, p_idempotency_key, v_user);
  insert into public.refund_payments (tenant_id, refund_request_id, method, amount_cents, payment_snapshot)
    values (p_tenant_id, v_request, p_refund_method, v_total, jsonb_build_object('method', p_refund_method, 'amountCents', v_total));
  insert into public.fiscal_local_records (id, tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, invoice_id, ticket_id, sale_id, refund_request_id, record_kind, chain_position, previous_hash, hash, canonical_schema, canonical_record, record_envelope, invoice_snapshot, economic_snapshot, generated_at, idempotency_key)
    values (v_invoice_id, p_tenant_id, v_subject.id, v_installation.id, v_session.venue_id, v_session.cash_register_id, v_invoice_id, null, null, v_request, 'alta', v_position, v_previous_hash, v_hash, 'aeat-registro-v1', p_record -> 'canonicalRecord', p_record, p_invoice, jsonb_build_object('refundRequestId', v_request, 'originalTicketId', v_ticket.id, 'originalSaleId', v_sale.id, 'totalCents', v_total), (p_record ->> 'generatedAt')::timestamptz, p_idempotency_key);
  update public.fiscal_local_series set last_number = v_number where id = v_series.id;
  return (select r from public.refund_requests r where r.id = v_request);
end;
$$;

alter table public.refund_requests enable row level security;
alter table public.refund_lines enable row level security;
alter table public.refund_payments enable row level security;
create policy refund_requests_read on public.refund_requests for select to authenticated using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy refund_lines_read on public.refund_lines for select to authenticated using (exists (select 1 from public.refund_requests r where r.id = refund_request_id and (public.user_is_tenant_admin(r.tenant_id) or public.user_has_venue_access(r.tenant_id, r.venue_id))));
create policy refund_payments_read on public.refund_payments for select to authenticated using (exists (select 1 from public.refund_requests r where r.id = refund_request_id and (public.user_is_tenant_admin(r.tenant_id) or public.user_has_venue_access(r.tenant_id, r.venue_id))));
revoke all on function public.create_ticket_refund(uuid, uuid, uuid, uuid, uuid, text, jsonb, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.create_ticket_refund(uuid, uuid, uuid, uuid, uuid, text, jsonb, uuid, jsonb, jsonb) to authenticated;
grant select on public.refund_requests, public.refund_lines, public.refund_payments to authenticated;
