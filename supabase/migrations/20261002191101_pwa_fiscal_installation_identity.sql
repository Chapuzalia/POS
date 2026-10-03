-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Keeps existing RPC signatures, legacy series and immutable history; adds PWA activation and validates both series versions and pre-retirement pending records.
set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.fiscal_sif_installations add column if not exists installation_sequence integer;
alter table public.fiscal_sif_installations add column if not exists series_version integer;
alter table public.cash_registers add column if not exists fiscal_code text;
-- Logical register codes survive every PWA replacement independently of devices.
update public.cash_registers r set fiscal_code = (
  select i.register_code from public.fiscal_sif_installations i where i.tenant_id = r.tenant_id and i.cash_register_id = r.id
  order by i.created_at desc, i.id desc limit 1
) where r.fiscal_code is null;
create unique index if not exists cash_registers_fiscal_code_idx
  on public.cash_registers (tenant_id, venue_id, fiscal_code) where fiscal_code is not null;

create function public.fiscal_pwa_register_code_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.fiscal_code is not null and new.fiscal_code is distinct from old.fiscal_code then
    raise exception 'FISCAL_REGISTER_CODE_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger fiscal_pwa_register_code_guard before update on public.cash_registers
for each row execute function public.fiscal_pwa_register_code_guard();

-- Count ALL historical installations, including retired ones, without changing their
-- NumeroInstalacion, canonical records, hashes, invoice identities or series.
with numbered as (
  select id, row_number() over (partition by tenant_id, cash_register_id order by created_at, id)::integer as seq
  from public.fiscal_sif_installations
)
update public.fiscal_sif_installations i set installation_sequence = n.seq, series_version = 1
from numbered n where i.id = n.id and i.installation_sequence is null;

alter table public.fiscal_sif_installations add constraint fiscal_pwa_sequence_positive
  check (coalesce(installation_sequence > 0 and series_version in (1, 2), false)) not valid;
create unique index if not exists fiscal_pwa_register_sequence_idx
  on public.fiscal_sif_installations (tenant_id, cash_register_id, installation_sequence);
create index if not exists fiscal_pwa_register_code_idx
  on public.fiscal_sif_installations (tenant_id, venue_id, register_code, cash_register_id);

create function public.fiscal_pwa_allocate_identity() returns trigger
language plpgsql set search_path = '' as $$
declare prior public.fiscal_sif_installations%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('fiscal-pwa:' || new.tenant_id::text || ':' || new.cash_register_id::text, 0));
  select * into prior from public.fiscal_sif_installations
    where tenant_id = new.tenant_id and cash_register_id = new.cash_register_id
    order by installation_sequence desc limit 1;
  new.installation_sequence := coalesce(prior.installation_sequence, 0) + 1;
  -- New inserts use sequenced identities, including the legacy setup RPC.
  new.series_version := coalesce(new.series_version, 2);
  if exists (select 1 from public.cash_registers where id = new.cash_register_id and tenant_id = new.tenant_id
    and fiscal_code is not null and fiscal_code <> new.register_code) then
    raise exception 'FISCAL_REGISTER_CODE_IMMUTABLE' using errcode = '55000';
  end if;
  update public.cash_registers set fiscal_code = new.register_code where id = new.cash_register_id and tenant_id = new.tenant_id and fiscal_code is null;
  if exists (select 1 from public.fiscal_sif_installations where tenant_id = new.tenant_id and venue_id = new.venue_id
    and register_code = new.register_code and cash_register_id <> new.cash_register_id) then
    raise exception 'FISCAL_REGISTER_CODE_COLLISION' using errcode = '23505';
  end if;
  if prior.id is not null and (new.venue_code, new.register_code) is distinct from (prior.venue_code, prior.register_code) then
    raise exception 'FISCAL_REGISTER_CODE_IMMUTABLE' using errcode = '55000';
  end if;
  if new.series_version = 2 then
    new.installation_number := new.venue_code || '-' || new.register_code || '-' || new.installation_sequence::text;
  end if;
  return new;
end;
$$;
create trigger fiscal_pwa_allocate_identity before insert on public.fiscal_sif_installations
for each row execute function public.fiscal_pwa_allocate_identity();

create or replace function public.fiscal_sif_installation_identity_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Fiscal installation identities cannot be deleted' using errcode = '55000'; end if;
  if (new.tenant_id, new.fiscal_subject_id, new.venue_id, new.cash_register_id, new.device_id,
      new.installation_number, new.venue_code, new.register_code, new.installation_code, new.installation_sequence, new.series_version)
    is distinct from
    (old.tenant_id, old.fiscal_subject_id, old.venue_id, old.cash_register_id, old.device_id,
      old.installation_number, old.venue_code, old.register_code, old.installation_code, old.installation_sequence, old.series_version)
    or (old.retired_at is not null and new.retired_at is distinct from old.retired_at) then
    raise exception 'Fiscal installation identity cannot be reused or rewritten' using errcode = '55000';
  end if;
  return new;
end;
$$;

create function public.fiscal_installation_series_prefix(i public.fiscal_sif_installations) returns text
language sql immutable set search_path = '' as $$
  select i.venue_code || '-' || i.register_code || case when i.series_version = 2 then '-' || i.installation_sequence::text else '' end
$$;
create function public.fiscal_series_exercise(series text) returns integer
language plpgsql immutable set search_path = '' as $$
declare parts text[] := string_to_array(series, '-');
begin
  if series is null or series !~ '^[A-Z0-9]{1,8}-[A-Z0-9]{1,8}-([1-9][0-9]*-)?[0-9]{4}-[SFR]$' then
    raise exception 'LOCAL_FISCAL_SERIES_MISMATCH' using errcode = '22023';
  end if;
  return parts[array_length(parts, 1)-1]::integer;
end;
$$;

create table public.fiscal_pwa_activation_requests (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  request_id uuid not null,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_register_id uuid not null references public.cash_registers(id) on delete restrict,
  device_id uuid not null references public.devices(id) on delete restrict,
  installation_id uuid not null,
  recover_for_testing boolean not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, request_id),
  foreign key (tenant_id, installation_id) references public.fiscal_sif_installations(tenant_id, id) on delete restrict
);
create index fiscal_pwa_requests_installation_idx on public.fiscal_pwa_activation_requests (tenant_id, installation_id);
create index fiscal_pwa_requests_venue_idx on public.fiscal_pwa_activation_requests (tenant_id, venue_id);
create index fiscal_pwa_requests_register_idx on public.fiscal_pwa_activation_requests (cash_register_id);
create index fiscal_pwa_requests_device_idx on public.fiscal_pwa_activation_requests (device_id);
alter table public.fiscal_pwa_activation_requests enable row level security;
-- Requests are only accessible through the authorized RPC; no browser DML grants or policies.

create function public.activate_pwa_fiscal_installation(
  p_tenant_id uuid, p_venue_id uuid, p_register_id uuid, p_device_id uuid,
  p_request_id uuid, p_expected_installation_id uuid, p_recover_for_testing boolean default false
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  prior public.fiscal_sif_installations%rowtype;
  historical public.fiscal_sif_installations%rowtype;
  retry public.fiscal_pwa_activation_requests%rowtype;
  subject_id uuid;
  new_id uuid := gen_random_uuid();
  venue_code text;
  register_code text;
begin
  if auth.uid() is null or p_request_id is null or p_recover_for_testing is null
    or not public.user_has_device_access(p_tenant_id, p_venue_id, p_device_id)
    or not exists (select 1 from public.cash_registers where id = p_register_id and tenant_id = p_tenant_id and venue_id = p_venue_id and is_active)
    or not exists (select 1 from public.devices where id = p_device_id and tenant_id = p_tenant_id and venue_id = p_venue_id and is_active and can_take_payments) then
    raise exception 'FISCAL_ACTIVATION_FORBIDDEN' using errcode = '42501';
  end if;
  -- Lock ordering matches CRM setup: venue first, register second; serialize concurrent confirmations.
  perform 1 from public.venues where id = p_venue_id and tenant_id = p_tenant_id for update;
  perform pg_advisory_xact_lock(hashtextextended('fiscal-pwa:' || p_tenant_id::text || ':' || p_register_id::text, 0));
  if p_recover_for_testing and not exists (select 1 from public.fiscal_pos_bridge_settings where tenant_id = p_tenant_id and aeat_environment = 'test') then
    raise exception 'FISCAL_TEST_RECOVERY_FORBIDDEN' using errcode = '42501';
  end if;
  select * into retry from public.fiscal_pwa_activation_requests where tenant_id = p_tenant_id and request_id = p_request_id;
  if retry.request_id is not null then
    if (retry.venue_id, retry.cash_register_id, retry.device_id, retry.recover_for_testing)
      is distinct from (p_venue_id, p_register_id, p_device_id, p_recover_for_testing) then
      raise exception 'FISCAL_ACTIVATION_REQUEST_CONFLICT' using errcode = '23505';
    end if;
    if not exists (select 1 from public.fiscal_sif_installations where id = retry.installation_id and retired_at is null) then
      raise exception 'FISCAL_ACTIVATION_ALREADY_RETIRED' using errcode = '55000';
    end if;
    return retry.installation_id;
  end if;
  select * into prior from public.fiscal_sif_installations
    where tenant_id = p_tenant_id and cash_register_id = p_register_id and retired_at is null for update;
  if prior.id is distinct from p_expected_installation_id then
    raise exception 'FISCAL_ACTIVATION_CONFIRMATION_STALE' using errcode = '55000';
  end if;
  if p_recover_for_testing then
    if prior.id is null or prior.device_id <> p_device_id or prior.mode <> 'production'
      or not exists (select 1 from public.fiscal_pos_bridge_settings where tenant_id = p_tenant_id and aeat_environment = 'test') then
      raise exception 'FISCAL_TEST_RECOVERY_FORBIDDEN' using errcode = '42501';
    end if;
    new_id := prior.id;
  else
    select fiscal_code into venue_code from public.venues where id = p_venue_id and tenant_id = p_tenant_id;
    select * into historical from public.fiscal_sif_installations
      where tenant_id = p_tenant_id and cash_register_id = p_register_id order by installation_sequence desc limit 1;
    subject_id := historical.fiscal_subject_id;
    if subject_id is null then
      if (select count(*) from public.fiscal_subjects where tenant_id = p_tenant_id) <> 1 then
        raise exception 'FISCAL_SUBJECT_SETUP_REQUIRED' using errcode = '55000';
      end if;
      select id into subject_id from public.fiscal_subjects where tenant_id = p_tenant_id;
    end if;
    if venue_code is null then raise exception 'FISCAL_VENUE_SETUP_REQUIRED' using errcode = '55000'; end if;
    select r.fiscal_code into register_code from public.cash_registers r where r.id = p_register_id and r.tenant_id = p_tenant_id;
    register_code := coalesce(register_code, historical.register_code);
    if register_code is null then
      select 'C' || (coalesce(max(substring(r.fiscal_code from '^C([0-9]+)$')::integer), 0) + 1)::text
        into register_code from public.cash_registers r where r.tenant_id = p_tenant_id and r.venue_id = p_venue_id;
    end if;
    -- A device active on a different register needs explicit reconciliation, not implicit retirement.
    if exists (select 1 from public.fiscal_sif_installations where tenant_id = p_tenant_id and device_id = p_device_id and retired_at is null and cash_register_id <> p_register_id) then
      raise exception 'FISCAL_DEVICE_REGISTER_CONFLICT' using errcode = '55000';
    end if;
    if prior.id is not null then update public.fiscal_sif_installations set retired_at = clock_timestamp() where id = prior.id; end if;
    insert into public.fiscal_sif_installations(id, tenant_id, fiscal_subject_id, venue_id, cash_register_id, device_id,
      installation_number, venue_code, register_code, installation_code, mode, series_version)
    values (new_id, p_tenant_id, subject_id, p_venue_id, p_register_id, p_device_id,
      'allocated-by-trigger', venue_code, register_code, upper(substr(replace(new_id::text, '-', ''), 1, 8)), 'production', 2);
  end if;
  insert into public.fiscal_pwa_activation_requests(tenant_id, request_id, venue_id, cash_register_id, device_id, installation_id, recover_for_testing)
    values (p_tenant_id, p_request_id, p_venue_id, p_register_id, p_device_id, new_id, p_recover_for_testing);
  return new_id;
end;
$$;
revoke all on function public.activate_pwa_fiscal_installation(uuid, uuid, uuid, uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.activate_pwa_fiscal_installation(uuid, uuid, uuid, uuid, uuid, uuid, boolean) to authenticated;

-- Configuration prepares logical boxes; only explicit PWA activation creates an installation.
create function public.save_fiscal_pwa_setup(p_tenant_id uuid, p_legal_name text, p_nif text, p_venues jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare item jsonb; venue_row public.venues%rowtype; register_row public.cash_registers%rowtype;
  subject_id uuid; code text; next_code integer;
begin
  if auth.uid() is null or not public.user_is_tenant_admin(p_tenant_id) then raise exception 'FISCAL_SETUP_FORBIDDEN' using errcode = '42501'; end if;
  if p_legal_name is null or btrim(p_legal_name) = '' or length(btrim(p_legal_name)) > 120 or p_nif is null or upper(btrim(p_nif)) !~ '^[A-Z0-9]{9}$'
    or p_venues is null or jsonb_typeof(p_venues) <> 'array' or jsonb_array_length(p_venues) = 0 then
    raise exception 'FISCAL_SETUP_INVALID' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fiscal-subject:' || p_tenant_id::text, 0));
  if (select count(*) from public.fiscal_subjects where tenant_id = p_tenant_id) > 1 then
    raise exception 'FISCAL_SUBJECT_SETUP_AMBIGUOUS' using errcode = '55000';
  end if;
  select id into subject_id from public.fiscal_subjects where tenant_id = p_tenant_id for update;
  if subject_id is null then insert into public.fiscal_subjects(tenant_id,legal_name,nif) values(p_tenant_id,btrim(p_legal_name),upper(btrim(p_nif)));
  else update public.fiscal_subjects set legal_name = btrim(p_legal_name), nif = upper(btrim(p_nif)) where id = subject_id; end if;
  for item in select value from jsonb_array_elements(p_venues) order by value ->> 'venueId' loop
    code := upper(btrim(item ->> 'venueCode'));
    if code is null or code !~ '^[A-Z0-9]{1,8}$' then raise exception 'FISCAL_VENUE_CODE_INVALID' using errcode = '22023'; end if;
    select * into venue_row from public.venues where id = (item ->> 'venueId')::uuid and tenant_id = p_tenant_id for update;
    if venue_row.id is null then raise exception 'FISCAL_SETUP_FORBIDDEN' using errcode = '42501'; end if;
    if venue_row.fiscal_code is not null and venue_row.fiscal_code <> code then raise exception 'FISCAL_VENUE_CODE_IMMUTABLE' using errcode = '55000'; end if;
    update public.venues set fiscal_code = code where id = venue_row.id;
    select coalesce(max(substring(fiscal_code from '^C([0-9]+)$')::integer), 0) into next_code
      from public.cash_registers where tenant_id = p_tenant_id and venue_id = venue_row.id;
    for register_row in select * from public.cash_registers where tenant_id = p_tenant_id and venue_id = venue_row.id and fiscal_code is null order by id for update loop
      next_code := next_code + 1;
      update public.cash_registers set fiscal_code = 'C' || next_code::text where id = register_row.id;
    end loop;
  end loop;
end;
$$;
revoke all on function public.save_fiscal_pwa_setup(uuid, text, text, jsonb) from public, anon;
grant execute on function public.save_fiscal_pwa_setup(uuid, text, text, jsonb) to authenticated;

-- The recorded generation timestamp is the retirement boundary for legitimate
-- offline pending records. It cannot prove physical time on a dishonest client.
create function public.fiscal_pwa_record_retirement_guard() returns trigger
language plpgsql set search_path = '' as $$
declare i public.fiscal_sif_installations%rowtype;
begin
  select * into i from public.fiscal_sif_installations where id = new.installation_id and tenant_id = new.tenant_id for update;
  if i.retired_at is not null and new.generated_at >= i.retired_at then
    raise exception 'FISCAL_INSTALLATION_RETIRED' using errcode = '55000';
  end if;
  if i.series_version = 2 and (
    coalesce(new.canonical_record -> 'RegistroAlta', new.canonical_record -> 'RegistroAnulacion') -> 'SistemaInformatico' ->> 'NumeroInstalacion' is distinct from i.installation_number
    or (coalesce(new.canonical_record -> 'RegistroAlta', new.canonical_record -> 'RegistroAnulacion') ->> 'FechaHoraHusoGenRegistro')::timestamptz is distinct from new.generated_at
  ) then
    raise exception 'LOCAL_FISCAL_INSTALLATION_IDENTITY_MISMATCH' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger fiscal_pwa_record_retirement_guard before insert on public.fiscal_local_records
for each row execute function public.fiscal_pwa_record_retirement_guard();

-- Update installed definitions (including later scope/annulment fixes) rather
-- than reinstalling obsolete versions. Every signature and grant is retained.
do $upgrade$
declare routine record; definition text;
begin
  for routine in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('sync_local_fiscal_sale_created', 'pay_restaurant_local_fiscal', 'sync_local_fiscal_ticket_annulment', 'create_ticket_refund')
  loop
    definition := pg_get_functiondef(routine.oid);
    definition := replace(definition, 'CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
    definition := replace(definition, 'split_part(v_series_name, ''-'', 3)::integer', 'public.fiscal_series_exercise(v_series_name)');
    definition := replace(definition, 'v_installation.venue_code || ''-'' || v_installation.register_code', 'public.fiscal_installation_series_prefix(v_installation)');
    definition := replace(definition, 'v_installation.retired_at is not null', '(v_installation.retired_at is not null and ((p_record ->> ''generatedAt'') is null or (p_record ->> ''generatedAt'')::timestamptz >= v_installation.retired_at))');
    execute definition;
  end loop;
end;
$upgrade$;
