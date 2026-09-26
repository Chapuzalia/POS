-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

with venue_codes as (
  select id, tenant_id, row_number() over (partition by tenant_id order by created_at, id)::bigint as code
  from public.venues
  where administrative_code is null
), venue_updates as (
  update public.venues as venue
  set administrative_code = venue_codes.code
  from venue_codes
  where venue.id = venue_codes.id
  returning venue.tenant_id, venue.administrative_code
)
insert into public.venue_administrative_code_counters (tenant_id, last_value)
select tenant_id, max(administrative_code)
from venue_updates
group by tenant_id
on conflict (tenant_id) do update
set last_value = greatest(public.venue_administrative_code_counters.last_value, excluded.last_value),
    updated_at = now();

with register_codes as (
  select id, tenant_id, venue_id, row_number() over (partition by tenant_id, venue_id order by created_at, id)::bigint as code
  from public.cash_registers
  where administrative_code is null
), register_updates as (
  update public.cash_registers as cash_register
  set administrative_code = register_codes.code
  from register_codes
  where cash_register.id = register_codes.id
  returning cash_register.tenant_id, cash_register.venue_id, cash_register.administrative_code
)
insert into public.cash_register_administrative_code_counters (tenant_id, venue_id, last_value)
select tenant_id, venue_id, max(administrative_code)
from register_updates
group by tenant_id, venue_id
on conflict (tenant_id, venue_id) do update
set last_value = greatest(public.cash_register_administrative_code_counters.last_value, excluded.last_value),
    updated_at = now();

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserves trigger signatures while ensuring counters remain ahead of backfilled or explicitly provisioned administrative codes.
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
