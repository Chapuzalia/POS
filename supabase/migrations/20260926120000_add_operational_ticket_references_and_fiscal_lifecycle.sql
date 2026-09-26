-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.venues add column if not exists administrative_code bigint;
alter table public.cash_registers add column if not exists administrative_code bigint;
alter table public.tickets
  add column if not exists operational_reference text,
  add column if not exists operational_reference_year integer;

create table if not exists public.venue_administrative_code_counters (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  last_value bigint not null default 0 check (last_value >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.cash_register_administrative_code_counters (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null,
  last_value bigint not null default 0 check (last_value >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, venue_id)
);

create table if not exists public.ticket_operational_reference_counters (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_register_id uuid not null references public.cash_registers(id) on delete restrict,
  reference_year integer not null check (reference_year between 2000 and 9999),
  last_value bigint not null default 0 check (last_value >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, venue_id, cash_register_id, reference_year)
);

alter table public.venue_administrative_code_counters enable row level security;
alter table public.cash_register_administrative_code_counters enable row level security;
alter table public.ticket_operational_reference_counters enable row level security;

alter table public.venues add constraint venues_administrative_code_positive_check check (administrative_code is null or administrative_code > 0) not valid;
alter table public.cash_registers add constraint cash_registers_administrative_code_positive_check check (administrative_code is null or administrative_code > 0) not valid;
alter table public.tickets add constraint tickets_operational_reference_format_check check (operational_reference is null or operational_reference ~ '^(L[0-9]{2,}-C[0-9]{2,}-[0-9]{2}-[0-9]{6,}|V-[0-9a-f]{8}-C-[0-9a-f]{8}-[0-9]{4}-[0-9]{6,})$') not valid;
alter table public.tickets add constraint tickets_operational_reference_year_check check (operational_reference_year is null or operational_reference_year between 2000 and 9999) not valid;

create unique index venues_tenant_administrative_code_uidx on public.venues (tenant_id, administrative_code) where administrative_code is not null;
create unique index cash_registers_tenant_venue_administrative_code_uidx on public.cash_registers (tenant_id, venue_id, administrative_code) where administrative_code is not null;
create unique index tickets_tenant_operational_reference_uidx on public.tickets (tenant_id, operational_reference) where operational_reference is not null;
create index tickets_operational_reference_lookup_idx on public.tickets (tenant_id, venue_id, cash_register_id, operational_reference_year, operational_reference) where operational_reference is not null;

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Allocates immutable administrative codes and ticket references atomically while preserving existing ticket references and trigger signatures.
create or replace function public.assign_venue_administrative_code() returns trigger language plpgsql security definer set search_path = '' as $$
declare next_value bigint;
begin
  if new.administrative_code is null then
    insert into public.venue_administrative_code_counters (tenant_id, last_value) values (new.tenant_id, 1)
      on conflict (tenant_id) do update set last_value = public.venue_administrative_code_counters.last_value + 1, updated_at = now()
      returning last_value into next_value;
    new.administrative_code := next_value;
  elsif tg_op = 'INSERT' then
    insert into public.venue_administrative_code_counters (tenant_id, last_value) values (new.tenant_id, new.administrative_code)
      on conflict (tenant_id) do update set last_value = greatest(public.venue_administrative_code_counters.last_value, excluded.last_value), updated_at = now();
  elsif old.administrative_code is not null and new.administrative_code is distinct from old.administrative_code then
    raise exception 'VENUE_ADMINISTRATIVE_CODE_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end; $$;

create or replace function public.assign_cash_register_administrative_code() returns trigger language plpgsql security definer set search_path = '' as $$
declare next_value bigint;
begin
  if new.administrative_code is null then
    insert into public.cash_register_administrative_code_counters (tenant_id, venue_id, last_value) values (new.tenant_id, new.venue_id, 1)
      on conflict (tenant_id, venue_id) do update set last_value = public.cash_register_administrative_code_counters.last_value + 1, updated_at = now()
      returning last_value into next_value;
    new.administrative_code := next_value;
  elsif tg_op = 'INSERT' then
    insert into public.cash_register_administrative_code_counters (tenant_id, venue_id, last_value) values (new.tenant_id, new.venue_id, new.administrative_code)
      on conflict (tenant_id, venue_id) do update set last_value = greatest(public.cash_register_administrative_code_counters.last_value, excluded.last_value), updated_at = now();
  elsif old.administrative_code is not null and new.administrative_code is distinct from old.administrative_code then
    raise exception 'CASH_REGISTER_ADMINISTRATIVE_CODE_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end; $$;

create or replace function public.assign_ticket_operational_reference() returns trigger language plpgsql security definer set search_path = '' as $$
declare reference_year_value integer; next_value bigint; venue_timezone_value text; venue_code_value bigint; register_code_value bigint;
begin
  if tg_op = 'INSERT' then
    select v.administrative_code, coalesce(v.timezone, 'Europe/Madrid') into venue_code_value, venue_timezone_value from public.venues as v where v.id = new.venue_id and v.tenant_id = new.tenant_id;
    select r.administrative_code into register_code_value from public.cash_registers as r where r.id = new.cash_register_id and r.tenant_id = new.tenant_id and r.venue_id = new.venue_id;
    if venue_code_value is null or register_code_value is null then raise exception 'TICKET_ADMINISTRATIVE_CODES_UNAVAILABLE' using errcode = '55000'; end if;
    reference_year_value := extract(year from coalesce(new.local_created_at, now()) at time zone venue_timezone_value)::integer;
    insert into public.ticket_operational_reference_counters (tenant_id, venue_id, cash_register_id, reference_year, last_value) values (new.tenant_id, new.venue_id, new.cash_register_id, reference_year_value, 1)
      on conflict (tenant_id, venue_id, cash_register_id, reference_year) do update set last_value = public.ticket_operational_reference_counters.last_value + 1, updated_at = now() returning last_value into next_value;
    new.operational_reference_year := reference_year_value;
    new.operational_reference := format('L%s-C%s-%s-%s', lpad(venue_code_value::text, 2, '0'), lpad(register_code_value::text, 2, '0'), right(reference_year_value::text, 2), lpad(next_value::text, 6, '0'));
  elsif new.operational_reference is distinct from old.operational_reference or new.operational_reference_year is distinct from old.operational_reference_year then
    raise exception 'TICKET_OPERATIONAL_REFERENCE_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end; $$;

drop trigger if exists assign_venue_administrative_code_before_write on public.venues;
create trigger assign_venue_administrative_code_before_write before insert or update of administrative_code on public.venues for each row execute function public.assign_venue_administrative_code();
drop trigger if exists assign_cash_register_administrative_code_before_write on public.cash_registers;
create trigger assign_cash_register_administrative_code_before_write before insert or update of administrative_code on public.cash_registers for each row execute function public.assign_cash_register_administrative_code();

drop trigger if exists assign_ticket_operational_reference_before_insert on public.tickets;
create trigger assign_ticket_operational_reference_before_insert before insert or update of operational_reference, operational_reference_year on public.tickets for each row execute function public.assign_ticket_operational_reference();


alter table public.fiscal_documents add column if not exists emission_state text check (emission_state is null or emission_state in ('pending', 'issued', 'unknown', 'failed')), add column if not exists aeat_status text check (aeat_status is null or aeat_status in ('not_requested', 'pending', 'accepted', 'accepted_with_errors', 'rejected', 'cancelled', 'unknown'));
alter table public.fiscal_invoices add column if not exists emission_state text check (emission_state is null or emission_state in ('pending', 'issued', 'unknown', 'failed')), add column if not exists aeat_status text check (aeat_status is null or aeat_status in ('not_requested', 'pending', 'accepted', 'accepted_with_errors', 'rejected', 'cancelled', 'unknown'));
create index fiscal_documents_tenant_lifecycle_idx on public.fiscal_documents (tenant_id, emission_state, aeat_status, created_at desc);
create index fiscal_invoices_tenant_lifecycle_idx on public.fiscal_invoices (tenant_id, emission_state, aeat_status, created_at desc);
update public.fiscal_documents set emission_state = case when provider_external_id is not null then 'issued' when status = 'error' then 'failed' else 'pending' end, aeat_status = case when status in ('accepted', 'accepted_with_errors', 'rejected', 'cancelled') then status when provider_external_id is not null then 'pending' else 'not_requested' end where emission_state is null and aeat_status is null;
update public.fiscal_invoices set emission_state = case when external_uuid is not null then 'issued' when status = 'error' then 'failed' else 'pending' end, aeat_status = case when status in ('accepted', 'accepted_with_errors', 'rejected', 'cancelled') then status when external_uuid is not null then 'pending' else 'not_requested' end where emission_state is null and aeat_status is null;
