-- migration-safety: expand
-- migration-safety-reviewed: CREATE TABLE, ALTER TABLE, CREATE INDEX, CREATE TRIGGER, CREATE FUNCTION
-- migration-safety-reason: Adds persistent ticket numbering and an atomic per-register allocator.
set lock_timeout = '5s';
set statement_timeout = '10min';

create table if not exists public.ticket_number_counters (
  tenant_id uuid not null,
  venue_id uuid not null,
  cash_register_id uuid not null,
  last_ticket_number bigint not null,
  primary key (tenant_id, venue_id, cash_register_id),
  constraint ticket_number_counters_last_number_check check (last_ticket_number >= 0)
);

alter table public.tickets add column if not exists ticket_number bigint;

DO $$
DECLARE
  invalid_ticket_count bigint;
BEGIN
  select count(*) into invalid_ticket_count
  from public.tickets
  where tenant_id is null or venue_id is null or cash_register_id is null or local_created_at is null or id is null;
  if invalid_ticket_count > 0 then
    raise exception 'No se puede numerar tickets con tenant, venue, caja, fecha o id nulos: %', invalid_ticket_count;
  end if;

  with numbered as (
    select id,
      row_number() over (
        partition by tenant_id, venue_id, cash_register_id
        order by local_created_at asc, id asc
      )::bigint as ticket_number
    from public.tickets
    where ticket_number is null
  )
  update public.tickets t
  set ticket_number = numbered.ticket_number
  from numbered
  where t.id = numbered.id;

  if exists (select 1 from public.tickets where ticket_number is null) then
    raise exception 'El backfill de ticket_number dejó tickets sin numerar';
  end if;

  if exists (select 1 from public.tickets where ticket_number <= 0) then
    raise exception 'El backfill generó ticket_number no positivos';
  end if;

  if exists (
    select tenant_id, venue_id, cash_register_id, ticket_number
    from public.tickets
    group by tenant_id, venue_id, cash_register_id, ticket_number
    having count(*) > 1
  ) then
    raise exception 'Se detectaron duplicados en la numeración de tickets';
  end if;
END;
$$;

create unique index if not exists tickets_tenant_venue_register_ticket_number_uidx
  on public.tickets (tenant_id, venue_id, cash_register_id, ticket_number);

create index if not exists tickets_tenant_venue_register_ticket_number_idx
  on public.tickets (tenant_id, venue_id, cash_register_id, ticket_number);

alter table public.tickets alter column ticket_number set not null;
alter table public.tickets drop constraint if exists tickets_ticket_number_positive_check;
alter table public.tickets add constraint tickets_ticket_number_positive_check check (ticket_number > 0);

insert into public.ticket_number_counters (tenant_id, venue_id, cash_register_id, last_ticket_number)
select tenant_id, venue_id, cash_register_id, max(ticket_number)
from public.tickets
group by tenant_id, venue_id, cash_register_id
on conflict (tenant_id, venue_id, cash_register_id) do update
set last_ticket_number = greatest(
  public.ticket_number_counters.last_ticket_number,
  excluded.last_ticket_number
);

create or replace function public.next_ticket_number(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_cash_register_id uuid
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_number bigint;
begin
  if p_tenant_id is null or p_venue_id is null or p_cash_register_id is null then
    raise exception 'El tenant, local y caja son obligatorios para numerar el ticket';
  end if;

  insert into public.ticket_number_counters (tenant_id, venue_id, cash_register_id, last_ticket_number)
  values (p_tenant_id, p_venue_id, p_cash_register_id, 1)
  on conflict (tenant_id, venue_id, cash_register_id) do update
    set last_ticket_number = public.ticket_number_counters.last_ticket_number + 1
  returning last_ticket_number into next_number;

  return next_number;
end;
$$;

revoke all on function public.next_ticket_number(uuid, uuid, uuid) from public, anon, authenticated;

grant execute on function public.next_ticket_number(uuid, uuid, uuid) to authenticated, service_role;

create or replace function public.assign_ticket_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.ticket_number := public.next_ticket_number(new.tenant_id, new.venue_id, new.cash_register_id);
  elsif new.ticket_number is distinct from old.ticket_number
    or new.tenant_id is distinct from old.tenant_id
    or new.venue_id is distinct from old.venue_id
    or new.cash_register_id is distinct from old.cash_register_id then
    raise exception 'TICKET_NUMBER_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function public.assign_ticket_number() from public, anon, authenticated;

drop trigger if exists assign_ticket_number_before_insert on public.tickets;
create trigger assign_ticket_number_before_insert
before insert or update of ticket_number, tenant_id, venue_id, cash_register_id on public.tickets
for each row execute function public.assign_ticket_number();

DO $$
BEGIN
  if exists (select 1 from public.tickets where ticket_number is null or ticket_number <= 0) then
    raise exception 'Validación final fallida: existen tickets sin una numeración válida';
  end if;
  if exists (
    select tenant_id, venue_id, cash_register_id, ticket_number
    from public.tickets
    group by tenant_id, venue_id, cash_register_id, ticket_number
    having count(*) > 1
  ) then
    raise exception 'Validación final fallida: existen duplicados de ticket_number';
  end if;
END;
$$;
