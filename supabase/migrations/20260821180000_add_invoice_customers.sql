-- Tenant-scoped fiscal customers and full invoices issued from POS tickets.

create extension if not exists pg_trgm with schema extensions;

create or replace function public.normalize_customer_tax_id(p_tax_id text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_tax_id, ''), '[^[:alnum:]]', '', 'g'));
$$;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  legal_name text not null check (btrim(legal_name) <> ''),
  tax_id text not null check (char_length(public.normalize_customer_tax_id(tax_id)) >= 5),
  tax_id_normalized text generated always as (public.normalize_customer_tax_id(tax_id)) stored,
  address text not null check (btrim(address) <> ''),
  postal_code text not null check (btrim(postal_code) <> ''),
  city text not null check (btrim(city) <> ''),
  province text not null check (btrim(province) <> ''),
  country text not null default 'España' check (btrim(country) <> ''),
  email text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, tax_id_normalized)
);

create index customers_tenant_name_idx
  on public.customers (tenant_id, lower(legal_name) text_pattern_ops);
create index customers_tenant_name_trgm_idx
  on public.customers using gin (lower(legal_name) extensions.gin_trgm_ops);
create index customers_tenant_tax_id_idx
  on public.customers (tenant_id, tax_id_normalized text_pattern_ops);

create trigger set_customers_updated_at
before update on public.customers
for each row execute function public.set_updated_at();

alter table public.customers enable row level security;

create policy customers_select on public.customers
for select to authenticated
using (public.user_has_tenant_access(tenant_id));

create policy customers_insert on public.customers
for insert to authenticated
with check (public.user_has_tenant_access(tenant_id));

create policy customers_update on public.customers
for update to authenticated
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

grant select, insert, update on public.customers to authenticated;

create or replace function public.search_invoice_customers(
  p_tenant_id uuid,
  p_query text default '',
  p_limit integer default 20
) returns setof public.customers
language sql
stable
security definer
set search_path = ''
as $$
  select customer.*
  from public.customers customer
  where customer.tenant_id = p_tenant_id
    and public.user_has_tenant_access(customer.tenant_id)
    and (
      nullif(btrim(coalesce(p_query, '')), '') is null
      or customer.legal_name ilike '%' || btrim(p_query) || '%'
      or customer.tax_id_normalized like '%' || public.normalize_customer_tax_id(p_query) || '%'
    )
  order by
    case when customer.tax_id_normalized = public.normalize_customer_tax_id(p_query) then 0 else 1 end,
    customer.legal_name,
    customer.id
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

create or replace function public.create_invoice_customer(
  p_tenant_id uuid,
  p_customer jsonb
) returns public.customers
language plpgsql
security definer
set search_path = ''
as $$
declare
  customer_row public.customers%rowtype;
begin
  if not public.user_has_tenant_access(p_tenant_id) then
    raise exception 'No tienes acceso a este negocio' using errcode = '42501';
  end if;
  if jsonb_typeof(p_customer) is distinct from 'object'
    or nullif(btrim(p_customer ->> 'legalName'), '') is null
    or char_length(public.normalize_customer_tax_id(p_customer ->> 'taxId')) < 5
    or nullif(btrim(p_customer ->> 'address'), '') is null
    or nullif(btrim(p_customer ->> 'postalCode'), '') is null
    or nullif(btrim(p_customer ->> 'city'), '') is null
    or nullif(btrim(p_customer ->> 'province'), '') is null then
    raise exception 'Los datos fiscales obligatorios no son válidos' using errcode = '22023';
  end if;

  insert into public.customers (
    tenant_id, legal_name, tax_id, address, postal_code, city, province, country, email, phone
  ) values (
    p_tenant_id,
    btrim(p_customer ->> 'legalName'),
    upper(btrim(p_customer ->> 'taxId')),
    btrim(p_customer ->> 'address'),
    btrim(p_customer ->> 'postalCode'),
    btrim(p_customer ->> 'city'),
    btrim(p_customer ->> 'province'),
    coalesce(nullif(btrim(p_customer ->> 'country'), ''), 'España'),
    nullif(btrim(p_customer ->> 'email'), ''),
    nullif(btrim(p_customer ->> 'phone'), '')
  ) returning * into customer_row;
  return customer_row;
exception when unique_violation then
  raise exception 'CUSTOMER_TAX_ID_DUPLICATE' using errcode = '23505';
end;
$$;

revoke all on function public.search_invoice_customers(uuid, text, integer) from public;
revoke all on function public.create_invoice_customer(uuid, jsonb) from public;
grant execute on function public.search_invoice_customers(uuid, text, integer) to authenticated;
grant execute on function public.create_invoice_customer(uuid, jsonb) to authenticated;

alter table public.tickets
  add column is_invoice boolean not null default false,
  add column customer_id uuid references public.customers(id) on delete restrict,
  add column customer_snapshot jsonb,
  add column invoice_series text,
  add column invoice_number text,
  add column invoice_issued_at timestamptz;

alter table public.tickets add constraint tickets_invoice_data_check check (
  (not is_invoice and customer_id is null and customer_snapshot is null
    and invoice_series is null and invoice_number is null and invoice_issued_at is null)
  or
  (is_invoice and customer_id is not null and customer_snapshot is not null and jsonb_typeof(customer_snapshot) = 'object'
    and nullif(btrim(invoice_series), '') is not null
    and nullif(btrim(invoice_number), '') is not null
    and invoice_issued_at is not null)
);

create unique index tickets_tenant_invoice_number_idx
  on public.tickets (tenant_id, invoice_series, invoice_number)
  where is_invoice;
create index tickets_tenant_customer_idx
  on public.tickets (tenant_id, customer_id, invoice_issued_at desc)
  where is_invoice;

create or replace function public.apply_invoice_customer_to_ticket()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  customer_id_value uuid;
  customer_row public.customers%rowtype;
  venue_timezone text;
  sequence_value bigint;
begin
  customer_id_value := nullif(current_setting('app.invoice_customer_id', true), '')::uuid;
  if customer_id_value is null then return new; end if;

  select customer.* into customer_row
  from public.customers customer
  where customer.id = customer_id_value and customer.tenant_id = new.tenant_id
  for share;
  if customer_row.id is null then
    raise exception 'El cliente no pertenece al negocio del ticket' using errcode = '42501';
  end if;

  select coalesce(venue.timezone, 'Europe/Madrid') into venue_timezone
  from public.venues venue
  where venue.id = new.venue_id and venue.tenant_id = new.tenant_id;
  if venue_timezone is null then
    raise exception 'El local del ticket no está disponible';
  end if;

  new.is_invoice := true;
  new.customer_id := customer_row.id;
  new.customer_snapshot := jsonb_build_object(
    'legalName', customer_row.legal_name,
    'taxId', customer_row.tax_id,
    'address', customer_row.address,
    'postalCode', customer_row.postal_code,
    'city', customer_row.city,
    'province', customer_row.province,
    'country', customer_row.country,
    'email', customer_row.email,
    'phone', customer_row.phone
  );
  new.invoice_issued_at := coalesce(new.local_created_at, now());
  new.invoice_series := 'F-' || to_char(new.invoice_issued_at at time zone venue_timezone, 'YYYY');
  sequence_value := public.next_fiscal_invoice_number(new.tenant_id, new.invoice_series);
  new.invoice_number := lpad(sequence_value::text, 6, '0');
  return new;
end;
$$;

create trigger apply_invoice_customer_before_ticket
before insert on public.tickets
for each row execute function public.apply_invoice_customer_to_ticket();

create or replace function public.protect_ticket_invoice_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_invoice and (
    new.is_invoice is distinct from old.is_invoice
    or new.customer_id is distinct from old.customer_id
    or new.customer_snapshot is distinct from old.customer_snapshot
    or new.invoice_series is distinct from old.invoice_series
    or new.invoice_number is distinct from old.invoice_number
    or new.invoice_issued_at is distinct from old.invoice_issued_at
  ) then
    raise exception 'INVOICE_SNAPSHOT_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger protect_ticket_invoice_snapshot_before_update
before update on public.tickets
for each row execute function public.protect_ticket_invoice_snapshot();

create or replace function public.sync_invoice_sale_created(
  p_event_id uuid,
  p_payload jsonb,
  p_customer_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_id_value uuid := (p_payload -> 'ticket' ->> 'tenantId')::uuid;
begin
  if p_customer_id is null
    or p_payload -> 'ticket' -> 'invoice' ->> 'customerId' is distinct from p_customer_id::text
    or not public.user_has_tenant_access(tenant_id_value)
    or not exists (
      select 1 from public.customers customer
      where customer.id = p_customer_id and customer.tenant_id = tenant_id_value
    ) then
    raise exception 'El cliente no pertenece al negocio de la venta' using errcode = '42501';
  end if;
  perform set_config('app.invoice_customer_id', p_customer_id::text, true);
  perform public.sync_sale_created_v2(p_event_id, p_payload);
end;
$$;

create or replace function public.close_restaurant_order_with_invoice(
  p_order_id uuid,
  p_payment_method text default null,
  p_received_cents integer default null,
  p_allow_pending boolean default false,
  p_discount jsonb default null,
  p_customer_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
begin
  select selected_order.* into order_row
  from public.orders selected_order
  where selected_order.id = p_order_id;
  if order_row.id is null
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id)
    or not exists (
      select 1 from public.customers customer
      where customer.id = p_customer_id and customer.tenant_id = order_row.tenant_id
    ) then
    raise exception 'El cliente no pertenece al negocio de la comanda' using errcode = '42501';
  end if;
  perform set_config('app.invoice_customer_id', p_customer_id::text, true);
  return public.close_restaurant_order_checked_v2(
    p_order_id, p_payment_method, p_received_cents, p_allow_pending, p_discount
  );
end;
$$;

revoke all on function public.sync_invoice_sale_created(uuid, jsonb, uuid) from public;
revoke all on function public.close_restaurant_order_with_invoice(uuid, text, integer, boolean, jsonb, uuid) from public;
grant execute on function public.sync_invoice_sale_created(uuid, jsonb, uuid) to authenticated;
grant execute on function public.close_restaurant_order_with_invoice(uuid, text, integer, boolean, jsonb, uuid) to authenticated;

-- Reuse the existing fiscal submission model. Full invoices inherit the POS
-- invoice number and the immutable customer snapshot; normal tickets keep the
-- existing simplified POS series unchanged.
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
