-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Preparatory catalogue only. No production issuance or migration of legacy invoices.
create table public.fiscal_subjects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  legal_name text not null check (length(trim(legal_name)) > 0),
  nif text not null check (length(trim(nif)) between 8 and 16),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, nif)
);

create table public.fiscal_sif_installations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  fiscal_subject_id uuid not null,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_register_id uuid not null references public.cash_registers(id) on delete restrict,
  device_id uuid not null references public.devices(id) on delete restrict,
  installation_number text not null check (length(trim(installation_number)) > 0),
  venue_code text not null check (venue_code ~ '^[A-Z0-9]{1,8}$'),
  register_code text not null check (register_code ~ '^[A-Z0-9]{1,8}$'),
  installation_code text not null check (installation_code ~ '^[A-Z0-9]{1,8}$'),
  mode text not null default 'disabled' check (mode in ('disabled', 'test', 'production')),
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, fiscal_subject_id) references public.fiscal_subjects(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  unique (tenant_id, fiscal_subject_id, installation_number),
  unique (tenant_id, fiscal_subject_id, installation_code)
);

create unique index fiscal_sif_one_active_installation_per_device_idx
  on public.fiscal_sif_installations (tenant_id, device_id)
  where retired_at is null;
create unique index fiscal_sif_one_active_installation_per_register_idx
  on public.fiscal_sif_installations (tenant_id, cash_register_id)
  where retired_at is null;

create table public.fiscal_local_series (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  fiscal_subject_id uuid not null,
  installation_id uuid not null,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_register_id uuid not null references public.cash_registers(id) on delete restrict,
  device_id uuid not null references public.devices(id) on delete restrict,
  document_kind text not null check (document_kind in ('simplified', 'complete', 'corrective')),
  exercise integer not null check (exercise between 2024 and 9999),
  series text not null check (length(trim(series)) between 1 and 40),
  last_number bigint not null default 0 check (last_number >= 0),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, fiscal_subject_id) references public.fiscal_subjects(tenant_id, id) on delete restrict,
  foreign key (tenant_id, installation_id) references public.fiscal_sif_installations(tenant_id, id) on delete restrict,
  unique (tenant_id, fiscal_subject_id, series),
  unique (tenant_id, fiscal_subject_id, installation_id, document_kind, exercise)
);
create index fiscal_local_series_register_idx
  on public.fiscal_local_series (tenant_id, fiscal_subject_id, cash_register_id);

-- No client may insert a record here until a reviewed atomic publication path exists.
create table public.fiscal_local_records (
  id uuid primary key,
  tenant_id uuid not null,
  fiscal_subject_id uuid not null,
  installation_id uuid not null,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_register_id uuid not null references public.cash_registers(id) on delete restrict,
  invoice_id uuid not null,
  ticket_id uuid references public.tickets(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  client_event_id uuid,
  rpc_result jsonb,
  record_kind text not null check (record_kind in ('alta', 'anulacion')),
  chain_position bigint not null check (chain_position > 0),
  previous_hash text,
  hash text not null check (hash ~ '^[0-9A-F]{64}$'),
  canonical_schema text not null,
  canonical_record jsonb not null,
  record_envelope jsonb not null,
  invoice_snapshot jsonb not null,
  economic_snapshot jsonb,
  generated_at timestamptz not null,
  idempotency_key uuid not null unique,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, fiscal_subject_id) references public.fiscal_subjects(tenant_id, id) on delete restrict,
  foreign key (tenant_id, installation_id) references public.fiscal_sif_installations(tenant_id, id) on delete restrict,
  unique (tenant_id, fiscal_subject_id, installation_id, chain_position)
);

create index fiscal_local_records_scope_time_idx
  on public.fiscal_local_records (tenant_id, fiscal_subject_id, venue_id, cash_register_id, generated_at desc);
create unique index fiscal_local_one_alta_per_ticket_idx
  on public.fiscal_local_records (tenant_id, ticket_id) where record_kind = 'alta' and ticket_id is not null;
create unique index fiscal_local_one_alta_per_sale_idx
  on public.fiscal_local_records (tenant_id, sale_id) where record_kind = 'alta' and sale_id is not null;
create unique index fiscal_local_one_alta_per_invoice_idx
  on public.fiscal_local_records (tenant_id, invoice_id) where record_kind = 'alta';
create unique index fiscal_local_client_event_idx
  on public.fiscal_local_records (tenant_id, client_event_id) where client_event_id is not null;

create function public.fiscal_local_validate_scope() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'fiscal_sif_installations' then
    if not exists (select 1 from public.venues v where v.id = new.venue_id and v.tenant_id = new.tenant_id)
       or not exists (select 1 from public.devices d where d.id = new.device_id and d.venue_id = new.venue_id and d.tenant_id = new.tenant_id)
       or not exists (select 1 from public.cash_registers r where r.id = new.cash_register_id and r.venue_id = new.venue_id and r.tenant_id = new.tenant_id) then
      raise exception 'Fiscal installation scope mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'fiscal_local_series' then
    if not exists (select 1 from public.fiscal_sif_installations i
      where i.id = new.installation_id and i.tenant_id = new.tenant_id
        and i.fiscal_subject_id = new.fiscal_subject_id and i.venue_id = new.venue_id
        and i.cash_register_id = new.cash_register_id and i.device_id = new.device_id) then
      raise exception 'Fiscal series scope mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'fiscal_local_records' then
    if not exists (select 1 from public.fiscal_sif_installations i
      where i.id = new.installation_id and i.tenant_id = new.tenant_id
        and i.fiscal_subject_id = new.fiscal_subject_id and i.venue_id = new.venue_id
        and i.cash_register_id = new.cash_register_id) then
      raise exception 'Fiscal record scope mismatch' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger fiscal_sif_installations_scope before insert or update on public.fiscal_sif_installations
for each row execute function public.fiscal_local_validate_scope();
create trigger fiscal_local_series_scope before insert or update on public.fiscal_local_series
for each row execute function public.fiscal_local_validate_scope();
create trigger fiscal_local_records_scope before insert on public.fiscal_local_records
for each row execute function public.fiscal_local_validate_scope();

create function public.fiscal_sif_installation_identity_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Fiscal installation identities cannot be deleted' using errcode = '55000';
  end if;
  if (new.tenant_id, new.fiscal_subject_id, new.venue_id, new.cash_register_id, new.device_id, new.installation_number,
      new.venue_code, new.register_code, new.installation_code)
     is distinct from
     (old.tenant_id, old.fiscal_subject_id, old.venue_id, old.cash_register_id, old.device_id, old.installation_number,
      old.venue_code, old.register_code, old.installation_code)
     or (old.retired_at is not null and new.retired_at is distinct from old.retired_at) then
    raise exception 'Fiscal installation identity cannot be reused or rewritten' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger fiscal_sif_installation_identity before update or delete on public.fiscal_sif_installations
for each row execute function public.fiscal_sif_installation_identity_guard();

create function public.fiscal_local_series_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Fiscal series cannot be deleted' using errcode = '55000';
  end if;
  if (new.tenant_id, new.fiscal_subject_id, new.installation_id, new.venue_id, new.cash_register_id, new.device_id, new.document_kind, new.exercise, new.series)
     is distinct from
     (old.tenant_id, old.fiscal_subject_id, old.installation_id, old.venue_id, old.cash_register_id, old.device_id, old.document_kind, old.exercise, old.series)
     or new.last_number < old.last_number then
    raise exception 'Fiscal series identity or counter cannot be rewritten' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger fiscal_local_series_identity before update or delete on public.fiscal_local_series
for each row execute function public.fiscal_local_series_guard();

create function public.fiscal_local_record_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Fiscal records are append-only' using errcode = '55000';
end;
$$;
create trigger fiscal_local_records_no_rewrite before update or delete on public.fiscal_local_records
for each row execute function public.fiscal_local_record_immutable();

alter table public.fiscal_subjects enable row level security;
alter table public.fiscal_sif_installations enable row level security;
alter table public.fiscal_local_series enable row level security;
alter table public.fiscal_local_records enable row level security;

create policy fiscal_subjects_read on public.fiscal_subjects for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or exists (
  select 1 from public.fiscal_sif_installations i
  where i.tenant_id = fiscal_subjects.tenant_id and i.fiscal_subject_id = fiscal_subjects.id
    and public.user_has_venue_access(i.tenant_id, i.venue_id)
));
create policy fiscal_sif_installations_read on public.fiscal_sif_installations for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy fiscal_local_series_read on public.fiscal_local_series for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy fiscal_local_records_read on public.fiscal_local_records for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

-- No INSERT/UPDATE/DELETE RLS policies exist for browser roles.
grant select on public.fiscal_subjects, public.fiscal_sif_installations, public.fiscal_local_series, public.fiscal_local_records to authenticated;
