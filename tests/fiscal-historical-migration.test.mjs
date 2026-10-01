import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

/**
 * Executable specification for the *total* historical fiscal reconstruction performed by
 * `supabase/migrations/20260930120000_rewrite_historical_fiscal_test_data.sql`.
 *
 * The migration is never modified here. It is installed verbatim and driven through
 * `public.rewrite_historical_fiscal_test_data()` against a PGlite schema that is faithful
 * (columns, defaults, NOT NULL, unique/FK constraints, roles) to the schema the previous
 * migrations produce, so that every assertion below describes an externally observable
 * contract of the reconstruction.
 *
 * Contract sources (read-only references, never edited by this suite):
 *  - src/features/fiscal/local/canonical.ts    -> strict key sets of RegistroAlta / RegistroAnulacion
 *  - src/features/fiscal/local/verifactu.ts    -> identity + Huella field vocabulary
 *  - src/features/fiscal/local/bridgeClient.ts -> BridgeRecord / BridgeInvoiceSnapshot envelope contracts
 *  - supabase/migrations/20260928120000_*      -> fiscal_local_records / _series / installations DDL
 *  - supabase/migrations/20260930140000_*      -> stored record_envelope / invoice_snapshot shape
 *
 * Out of scope on purpose: recomputing the AEAT Huella pre-image from `verifactu.ts`
 * (`aeatHashSource`); this suite only pins the Huella format and its cross-linkage.
 */

const migrationSql = await fs.readFile(
  new URL('../supabase/migrations/20260930120000_rewrite_historical_fiscal_test_data.sql', import.meta.url),
  'utf8',
)

/** Install only the routine; every case drives the invocation explicitly. */
const installSql = migrationSql.replace(/\nselect set_config\('app\.allow_fiscal_test_rewrite'[\s\S]*$/, '\n')

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** canonical.ts: `alta` — every key required for a non-rectificative F1/F2. */
const ALTA_KEYS = [
  'IDVersion', 'IDFactura', 'NombreRazonEmisor', 'TipoFactura', 'DescripcionOperacion',
  'Desglose', 'CuotaTotal', 'ImporteTotal', 'Encadenamiento', 'SistemaInformatico',
  'FechaHoraHusoGenRegistro', 'TipoHuella', 'Huella',
]
/** canonical.ts: `annulment` — exactly these seven keys, and never a `Motivo`. */
const ANULACION_KEYS = [
  'IDVersion', 'IDFactura', 'Encadenamiento', 'SistemaInformatico',
  'FechaHoraHusoGenRegistro', 'TipoHuella', 'Huella',
]
const IDENTITY_KEYS = ['IDEmisorFactura', 'NumSerieFactura', 'FechaExpedicionFactura']
const ANNULLED_IDENTITY_KEYS = ['IDEmisorFacturaAnulada', 'NumSerieFacturaAnulada', 'FechaExpedicionFacturaAnulada']
const PREVIOUS_KEYS = [...IDENTITY_KEYS, 'Huella']
const SYSTEM_KEYS = [
  'NombreRazon', 'NIF', 'NombreSistemaInformatico', 'IdSistemaInformatico', 'Version',
  'NumeroInstalacion', 'TipoUsoPosibleSoloVerifactu', 'TipoUsoPosibleMultiOT', 'IndicadorMultiplesOT',
]
const DETAIL_KEYS = [
  'Impuesto', 'ClaveRegimen', 'CalificacionOperacion', 'TipoImpositivo',
  'BaseImponibleOimporteNoSujeto', 'CuotaRepercutida',
]
/** bridgeClient.ts: `BridgeRecord`, minus the optional `lease`. */
const ENVELOPE_REQUIRED = [
  'idempotencyKey', 'environment', 'tenantId', 'fiscalSubjectId', 'issuerNif', 'venueId',
  'cashRegisterId', 'installationId', 'deviceId', 'invoiceId', 'chainPosition', 'previous',
  'hash', 'generatedAt', 'canonicalSchema', 'canonicalRecord',
]
/** bridgeClient.ts: `BridgeInvoiceSnapshot` as persisted by the snapshot repair migration. */
const INVOICE_SNAPSHOT_REQUIRED = [
  'issuerName', 'issuerNif', 'issuerAddress', 'series', 'number', 'issuedAt', 'qrUrl',
  'ticketId', 'saleId', 'paymentId', 'lines', 'recipient', 'totalCents', 'taxCents', 'transmissionMode',
]

// ---------------------------------------------------------------------------
// PGlite schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end
$roles$;

create schema if not exists extensions;

-- Shim for pgcrypto: AEAT Huella is SHA-256, so the digest must be 32 bytes.
create or replace function extensions.digest(data bytea, algorithm text)
returns bytea language sql immutable as $$ select sha256(data) $$;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text,
  created_at timestamptz not null default now()
);

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  name text,
  legal_name text,
  tax_id text,
  address text,
  timezone text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid references public.venues(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.cash_registers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.fiscal_subjects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  legal_name text not null,
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
  on public.fiscal_sif_installations (tenant_id, device_id) where retired_at is null;
create unique index fiscal_sif_one_active_installation_per_register_idx
  on public.fiscal_sif_installations (tenant_id, cash_register_id) where retired_at is null;

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

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  device_id uuid references public.devices(id) on delete restrict,
  cash_register_id uuid not null references public.cash_registers(id) on delete restrict,
  status text not null,
  ticket_number text,
  total_cents bigint not null,
  is_invoice boolean not null default false,
  customer_snapshot jsonb,
  local_created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ticket_id uuid references public.tickets(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_register_id uuid not null references public.cash_registers(id) on delete restrict,
  status text not null default 'paid',
  total_cents bigint not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  sale_id uuid not null references public.sales(id) on delete restrict,
  method text not null,
  amount_cents bigint not null,
  created_at timestamptz not null default now()
);

create table public.ticket_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ticket_id uuid not null references public.tickets(id) on delete restrict,
  product_name text not null,
  variant_name text,
  gross_before_discount_cents bigint,
  discount_amount_cents bigint not null default 0,
  net_total_cents bigint,
  taxable_base_cents bigint,
  tax_amount_cents bigint,
  line_total_cents bigint,
  tax_rate numeric,
  created_at timestamptz not null default now()
);

create table public.fiscal_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  venue_id uuid references public.venues(id) on delete restrict,
  ticket_id uuid references public.tickets(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  environment text not null,
  provider text not null,
  invoice_type text,
  series text,
  number text,
  issue_date date,
  issued_at timestamptz,
  document_data jsonb not null default '{}'::jsonb,
  customer_snapshot jsonb,
  request_payload jsonb,
  response_payload jsonb,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, ticket_id),
  unique (tenant_id, provider, environment, series, number, issue_date),
  check (series !~ '^\\s'),
  check (char_length(series || number) <= 60)
);

create table public.offline_event_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  event_kind text not null,
  client_event_id uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table public.fiscal_pos_bridge_settings (
  tenant_id uuid primary key references public.tenants(id) on delete restrict,
  bridge_url text not null check (bridge_url ~ '^https://[^/?#@]+/?$' and length(bridge_url) <= 255),
  producer_name text not null check (length(trim(producer_name)) between 1 and 120),
  producer_nif text not null check (producer_nif ~ '^[A-Z0-9]{9}$'),
  system_id text not null check (system_id ~ '^[A-Z0-9]{2}$'),
  system_version text not null check (length(trim(system_version)) between 1 and 40),
  aeat_environment text not null default 'production' check (aeat_environment in ('test', 'production')),
  updated_at timestamptz not null default now()
);

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

alter table public.fiscal_subjects enable row level security;
alter table public.fiscal_sif_installations enable row level security;
alter table public.fiscal_local_series enable row level security;
alter table public.fiscal_local_records enable row level security;
create policy fiscal_subjects_read on public.fiscal_subjects for select to authenticated using (true);
create policy fiscal_sif_installations_read on public.fiscal_sif_installations for select to authenticated using (true);
create policy fiscal_local_series_read on public.fiscal_local_series for select to authenticated using (true);
create policy fiscal_local_records_read on public.fiscal_local_records for select to authenticated using (true);
grant select on public.fiscal_subjects, public.fiscal_sif_installations, public.fiscal_local_series, public.fiscal_local_records to authenticated;
`

/**
 * Append-only guards from 20260928120000. Installed on demand: they are the reason the
 * neighbouring repair migrations run `alter table ... disable trigger user`, so the total
 * reconstruction has to cope with them too.
 */
const APPEND_ONLY_SQL = `
create or replace function public.fiscal_local_record_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Fiscal records are append-only' using errcode = '55000';
end;
$$;
create trigger fiscal_local_records_no_rewrite before update or delete on public.fiscal_local_records
for each row execute function public.fiscal_local_record_immutable();

create or replace function public.fiscal_local_series_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Fiscal series cannot be deleted' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger fiscal_local_series_identity before update or delete on public.fiscal_local_series
for each row execute function public.fiscal_local_series_guard();
`

// ---------------------------------------------------------------------------
// Fixture identifiers
// ---------------------------------------------------------------------------

const ID = {
  tenant: '11111111-1111-4111-8111-111111111111',
  venueA: '22222222-2222-4222-8222-222222222222',
  venueB: '33333333-3333-4333-8333-333333333333',
  deviceA: '44444444-4444-4444-8444-444444444444',
  deviceB: '55555555-5555-4555-8555-555555555555',
  registerA: '66666666-6666-4666-8666-666666666666',
  registerB: '77777777-7777-4777-8777-777777777777',
  subject: '88888888-8888-4888-8888-888888888888',
  installA: '99999999-9999-4999-8999-999999999999',
  installB: '99999999-9999-4999-8999-99999999999a',
  ticket1: 'b0000000-0000-4000-8000-000000000001',
  ticket2: 'b0000000-0000-4000-8000-000000000002',
  ticket3: 'b0000000-0000-4000-8000-000000000003',
  ticket4: 'b0000000-0000-4000-8000-000000000004',
  ticket5: 'b0000000-0000-4000-8000-000000000005',
  sale1: 'c0000000-0000-4000-8000-000000000001',
  sale2: 'c0000000-0000-4000-8000-000000000002',
  voidedSale: 'c0000000-0000-4000-8000-000000000009',
  payment1: 'd0000000-0000-4000-8000-000000000001',
  payment2: 'd0000000-0000-4000-8000-000000000002',
  fiscalInvoice: 'e0000000-0000-4000-8000-000000000001',
  line1: 'f0000000-0000-4000-8000-000000000001',
  line2: 'f0000000-0000-4000-8000-000000000002',
  line3: 'f0000000-0000-4000-8000-000000000003',
  clientEvent: 'a1000000-0000-4000-8000-000000000001',
}

const NIF = 'B12345678'
/**
 * PGlite ships without the IANA tzdata, so named zones silently degrade to UTC. `Etc/GMT-1`
 * is CET without DST — exactly Europe/Madrid across the early-March window these fixtures use —
 * and PGlite does resolve it, which keeps the canonical timestamps deterministic.
 */
const TIMEZONE = 'Etc/GMT-1'
/** Canonical series built by the migration: <venue_code>-<register_code>-<year>-S */
const SERIES = 'VEN-REG-2026-S'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function createDatabase({ appendOnly = false } = {}) {
  const db = new PGlite()
  await db.exec(SCHEMA_SQL)
  if (appendOnly) await db.exec(APPEND_ONLY_SQL)
  await db.exec(installSql)
  await db.exec(`select set_config('app.allow_fiscal_test_rewrite', 'yes', false)`)
  return db
}

async function rewrite(db) {
  const { rows } = await db.query(`select public.rewrite_historical_fiscal_test_data() as result`)
  return rows[0].result
}

async function rows(db, sql, params = []) {
  const result = await db.query(sql, params)
  return JSON.parse(JSON.stringify(result.rows))
}

async function records(db) {
  return rows(db, `select
      id::text, tenant_id::text, fiscal_subject_id::text, installation_id::text, venue_id::text,
      cash_register_id::text, invoice_id::text, ticket_id::text, sale_id::text,
      record_kind, chain_position::text, previous_hash, hash, canonical_schema,
      canonical_record, record_envelope, invoice_snapshot, economic_snapshot,
      generated_at::text, idempotency_key::text
    from public.fiscal_local_records order by installation_id, chain_position`)
}

async function economics(db) {
  return {
    tickets: await rows(db, `select row_to_json(t) as row from public.tickets t order by t.id`),
    sales: await rows(db, `select row_to_json(s) as row from public.sales s order by s.id`),
    ticketLines: await rows(db, `select row_to_json(l) as row from public.ticket_lines l order by l.id`),
    payments: await rows(db, `select row_to_json(p) as row from public.sale_payments p order by p.id`),
  }
}

async function seedBridge(db, tenantId) {
  await db.query(
    `insert into public.fiscal_pos_bridge_settings
       (tenant_id, bridge_url, producer_name, producer_nif, system_id, system_version, aeat_environment)
     values ($1, 'https://bridge.example.com/', 'Tickit', $2, '01', '1.0.0', 'test')`,
    [tenantId, NIF],
  )
}

async function seedTenant(db, tenantId, { legalName = 'Central Bar SL', taxId = NIF } = {}) {
  await db.query(`insert into public.tenants (id, name) values ($1, $2)`, [tenantId, 'Fixture'])
  await seedBridge(db, tenantId)
  await db.query(
    `insert into public.fiscal_subjects (id, tenant_id, legal_name, nif) values ($1, $2, $3, $4)`,
    [ID.subject, tenantId, legalName, taxId],
  )
  await db.query(
    `insert into public.venues (id, tenant_id, name, legal_name, tax_id, address, timezone, created_at)
     values ($1, $2, 'Principal', $3, $4, 'Calle Mayor 1', $5, '2026-01-01T08:00:00Z')`,
    [ID.venueA, tenantId, legalName, taxId, TIMEZONE],
  )
  await db.query(`insert into public.devices (id, tenant_id, venue_id) values ($1, $2, $3)`, [ID.deviceA, tenantId, ID.venueA])
  await db.query(`insert into public.cash_registers (id, tenant_id, venue_id) values ($1, $2, $3)`, [ID.registerA, tenantId, ID.venueA])
  await seedInstallation(db, {
    installationId: ID.installA, tenantId, subjectId: ID.subject, venueId: ID.venueA,
    registerId: ID.registerA, deviceId: ID.deviceA, installationNumber: '7',
  })
}

/** Every fixture always has a valid, non-null subject on the installation. */
async function seedInstallation(db, o) {
  await db.query(
    `insert into public.fiscal_sif_installations
       (id, tenant_id, fiscal_subject_id, venue_id, cash_register_id, device_id,
        installation_number, venue_code, register_code, installation_code, mode)
     values ($1, $2, $3, $4, $5, $6, $7, 'VEN', 'REG', $8, 'test')`,
    [o.installationId, o.tenantId, o.subjectId, o.venueId, o.registerId, o.deviceId, o.installationNumber, `INS${String(o.installationNumber).replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`],
  )
}

async function seedTicket(db, o) {
  await db.query(
    `insert into public.tickets
       (id, tenant_id, venue_id, device_id, cash_register_id, status, ticket_number, total_cents,
        is_invoice, customer_snapshot, local_created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10, $10)`,
    [o.ticketId, o.tenantId, o.venueId, o.deviceId, o.registerId, o.status, o.ticketNumber, o.totalCents, o.isInvoice ?? false, o.createdAt],
  )
}

async function seedSale(db, o) {
  await db.query(
    `insert into public.sales (id, tenant_id, ticket_id, venue_id, cash_register_id, total_cents)
     values ($1, $2, $3, $4, $5, $6)`,
    [o.saleId, o.tenantId, o.ticketId, o.venueId, o.registerId, o.totalCents],
  )
  await db.query(
    `insert into public.sale_payments (id, tenant_id, sale_id, method, amount_cents)
     values ($1, $2, $3, 'cash', $4)`,
    [o.paymentId, o.tenantId, o.saleId, o.totalCents],
  )
}

async function seedLine(db, o) {
  await db.query(
    `insert into public.ticket_lines
       (id, tenant_id, ticket_id, product_name, variant_name, gross_before_discount_cents,
        discount_amount_cents, net_total_cents, taxable_base_cents, tax_amount_cents,
        line_total_cents, tax_rate)
     values ($1, $2, $3, $4, null, $5, $6, $7, $8, $9, $10, $11)`,
    [
      o.lineId, o.tenantId, o.ticketId, o.productName ?? 'Cafe',
      o.grossCents, o.discountCents ?? 0,
      o.baseCents !== null && o.baseCents !== undefined && o.taxCents !== null && o.taxCents !== undefined
        ? o.baseCents + o.taxCents
        : o.netCents,
      o.baseCents, o.taxCents,
      o.lineTotalCents, o.taxRate,
    ],
  )
}

/** A structurally valid, ticketless leftover record occupying a late chain position. */
async function seedStaleRecord(db, o) {
  await db.query(
    `insert into public.fiscal_local_records
       (id, tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, invoice_id,
        ticket_id, sale_id, client_event_id, rpc_result, record_kind, chain_position, previous_hash,
        hash, canonical_schema, canonical_record, record_envelope, invoice_snapshot,
        economic_snapshot, generated_at, idempotency_key)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, gen_random_uuid(),
             null, null, null, null, 'alta', $6, null, $7, 'stale',
             '{"RegistroAlta":{"legacy":true}}'::jsonb, '{}'::jsonb, '{}'::jsonb, null, $8, gen_random_uuid())`,
    [o.tenantId, o.subjectId, o.installationId, o.venueId, o.registerId, o.chainPosition, o.hash, o.generatedAt],
  )
}

async function seedStaleSeries(db, o) {
  await db.query(
    `insert into public.fiscal_local_series
       (tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, device_id,
        document_kind, exercise, series, last_number)
     values ($1, $2, $3, $4, $5, $6, 'simplified', 2026, $7, 41)`,
    [o.tenantId, o.subjectId, o.installationId, o.venueId, o.registerId, o.deviceId, o.series],
  )
}

// ---------------------------------------------------------------------------
// Assertion helpers — every case collects all violations before failing once
// ---------------------------------------------------------------------------

function spec() {
  const violations = []
  return {
    violations,
    /** Synchronous only: every value a check needs must be read before collecting. */
    check(label, assertion) {
      try {
        assertion()
      } catch (error) {
        violations.push(`${label}: ${error.message}`)
      }
    },
    /** `registro()` is strict, so failures are collected instead of thrown. */
    safeRegistro(canonicalRecord, label) {
      try {
        return registro(canonicalRecord, label)
      } catch (error) {
        this.check(label, () => { throw error })
        return { kind: null, body: {} }
      }
    },
    done() {
      assert.deepEqual(violations, [], `\n  - ${violations.join('\n  - ')}\n`)
    },
  }
}

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label}: se esperaba un objeto jsonb`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  const missing = wanted.filter((key) => !actual.includes(key))
  const extra = actual.filter((key) => !wanted.includes(key))
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${label}: ${missing.length || extra.length ? `faltan [${missing}], sobran [${extra}]` : ''}`)
}

function hasFields(value, required, label) {
  const present = value && typeof value === 'object' ? value : {}
  const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(present, field))
  assert.deepEqual(missing, [], `${label}: campos ausentes [${missing.join(', ')}]`)
}

function aeatCents(text) {
  const match = /^(-?)(\d{1,12})\.(\d{2})$/.exec(String(text))
  assert.ok(match, `importe AEAT inválido: ${JSON.stringify(text)}`)
  return (match[1] ? -1 : 1) * (Number(match[2]) * 100 + Number(match[3]))
}

function isHuella(value) {
  return typeof value === 'string' && /^[0-9A-F]{64}$/.test(value)
}

/** canonical.ts `timestamp`. PostgreSQL's `OF` template emits ±HH and only adds ±HH:MM when
 *  the offset carries minutes, so real-world hour offsets never match this pattern. */
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/

/** The local wall clock must be the venue-local rendering of the source instant. */
function localStamp(value, expectedWallClock, label) {
  const text = String(value)
  const problems = []
  if (!CANONICAL_TIMESTAMP.test(text)) problems.push(`el desfase ${JSON.stringify(text.slice(19))} no cumple ±HH:MM de canonical.ts`)
  if (text.slice(0, 19) !== expectedWallClock) problems.push(`hora local ${text.slice(0, 19)} ≠ ${expectedWallClock}`)
  assert.deepEqual(problems, [], label)
}

/** canonical.ts `canonicalRecordSchema` is a single-key union. */
function registro(canonicalRecord, label) {
  assert.ok(canonicalRecord && typeof canonicalRecord === 'object', `${label}: canonical_record debe ser un objeto`)
  const keys = Object.keys(canonicalRecord)
  assert.equal(keys.length, 1, `${label}: se esperaba un único registro, se encontró [${keys.join(', ')}]`)
  const [kind] = keys
  assert.ok(kind === 'RegistroAlta' || kind === 'RegistroAnulacion', `${label}: registro desconocido ${kind}`)
  return { kind, body: canonicalRecord[kind] }
}

/** The historical saleId of a void must stay reachable from the stored economic snapshot. */
function historicalSaleId(snapshot) {
  const candidates = [snapshot?.saleId, snapshot?.sale?.id, typeof snapshot?.sale === 'string' ? snapshot.sale : null]
  return candidates.find((value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) ?? null
}

const SHA_A = 'a'.repeat(64).toUpperCase()
const SHA_B = 'b'.repeat(64).toUpperCase()

// ---------------------------------------------------------------------------
// (1) compiles with no tickets
// ---------------------------------------------------------------------------

test('la reconstrucción compila y no rebuilda nada cuando no hay tickets', async () => {
  const db = await createDatabase()
  await seedTenant(db, ID.tenant)

  const result = await rewrite(db)

  assert.equal(Number(result.rebuilt), 0, 'no debe reconstruirse ningún registro sin tickets')
  assert.deepEqual(await records(db), [], 'no debe haber registros fiscales')
  const [subject] = await rows(db, `select id::text, legal_name, nif from public.fiscal_subjects`)
  assert.equal(subject.id, ID.subject, 'no debe crear un sujeto nuevo cuando ya existe uno válido')
  assert.equal(subject.nif, NIF, 'no debe reescribir el NIF del sujeto existente')
  const [installation] = await rows(db, `select fiscal_subject_id::text, retired_at::text from public.fiscal_sif_installations`)
  assert.equal(installation.fiscal_subject_id, ID.subject, 'la instalación válida debe conservar su sujeto')
  assert.equal(installation.retired_at, null, 'no debe retirar la instalación activa')
})

// ---------------------------------------------------------------------------
// (2) paid without fiscal_invoice, complete line snapshot, stale record at position 9
// ---------------------------------------------------------------------------

test('un ticket paid sin fiscal_invoice se reconstruye desde el snapshot de línea y sanea el ledger', async () => {
  const db = await createDatabase()
  await seedTenant(db, ID.tenant)
  await seedTicket(db, {
    ticketId: ID.ticket1, tenantId: ID.tenant, venueId: ID.venueA, deviceId: ID.deviceA,
    registerId: ID.registerA, status: 'paid', ticketNumber: '1', totalCents: 1210,
    createdAt: '2026-03-02T10:15:00Z',
  })
  await seedSale(db, {
    saleId: ID.sale1, tenantId: ID.tenant, ticketId: ID.ticket1, venueId: ID.venueA,
    registerId: ID.registerA, totalCents: 1210, paymentId: ID.payment1,
  })
  await seedLine(db, {
    lineId: ID.line1, tenantId: ID.tenant, ticketId: ID.ticket1, grossCents: 1000,
    netCents: 1000, baseCents: 1000, taxCents: 210, lineTotalCents: 1210, taxRate: 21,
  })
  await seedStaleRecord(db, {
    tenantId: ID.tenant, subjectId: ID.subject, installationId: ID.installA, venueId: ID.venueA,
    registerId: ID.registerA, chainPosition: 9, hash: SHA_A, generatedAt: '2026-03-01T09:00:00Z',
  })
  await seedStaleSeries(db, {
    tenantId: ID.tenant, subjectId: ID.subject, installationId: ID.installA, venueId: ID.venueA,
    registerId: ID.registerA, deviceId: ID.deviceA, series: SERIES,
  })

  const before = await economics(db)
  const result = await rewrite(db)
  const after = await records(db)
  const afterEconomics = await economics(db)
  const [{ count: seriesCount }] = await rows(db, `select count(*)::int as count from public.fiscal_local_series`)

  // The same rebuild must also survive the append-only guards that prior migrations install,
  // which is why the neighbouring repair migrations run `alter table ... disable trigger user`.
  const guarded = await createDatabase({ appendOnly: true })
  await seedTenant(guarded, ID.tenant)
  await seedStaleRecord(guarded, {
    tenantId: ID.tenant, subjectId: ID.subject, installationId: ID.installA, venueId: ID.venueA,
    registerId: ID.registerA, chainPosition: 9, hash: SHA_A, generatedAt: '2026-03-01T09:00:00Z',
  })
  let guardedError = null
  try {
    await rewrite(guarded)
  } catch (error) {
    guardedError = error
  }
  await guarded.close()

  const s = spec()
  const { check, done } = s

  check('resultado', () => assert.equal(Number(result.rebuilt), 1, `rebuilt=${JSON.stringify(result.rebuilt)}`))
  check('stale eliminado', () => {
    assert.equal(after.length, 1, `se esperaban 1 registros, hay ${after.length}`)
    const stale = after.filter((row) => row.canonical_schema === 'stale' || row.ticket_id === null)
    assert.deepEqual(stale.map((row) => row.chain_position), [], 'el registro stale de posición 9 debe desaparecer')
  })
  check('alta en posición 1', () => {
    assert.equal(after[0].record_kind, 'alta')
    assert.equal(after[0].chain_position, '1')
    assert.equal(after[0].previous_hash, null, 'el primer registro no tiene hash previo')
    assert.equal(after[0].installation_id, ID.installA)
    assert.equal(after[0].ticket_id, ID.ticket1)
    assert.equal(after[0].sale_id, ID.sale1)
  })

  const { kind, body } = after.length ? s.safeRegistro(after[0].canonical_record, 'alta') : { kind: null, body: {} }
  check('tipo de registro', () => assert.equal(kind, 'RegistroAlta'))

  check('RegistroAlta keys exactas', () => exactKeys(body, ALTA_KEYS, 'RegistroAlta'))
  check('IDFactura keys exactas', () => exactKeys(body.IDFactura, IDENTITY_KEYS, 'IDFactura'))
  check('IDFactura valores', () => {
    assert.equal(body.IDFactura.IDEmisorFactura, NIF)
    assert.equal(body.IDFactura.NumSerieFactura, `${SERIES}1`)
    assert.equal(body.IDFactura.FechaExpedicionFactura, '02-03-2026')
  })
  check('importes 10.00/2.10/12.10', () => {
    const details = body.Desglose?.DetalleDesglose
    assert.ok(Array.isArray(details) && details.length === 1, `DetalleDesglose inválido: ${JSON.stringify(details)}`)
    exactKeys(details[0], DETAIL_KEYS, 'DetalleDesglose[0]')
    assert.equal(details[0].Impuesto, '01')
    assert.equal(details[0].ClaveRegimen, '01')
    assert.equal(details[0].CalificacionOperacion, 'S1')
    assert.equal(details[0].TipoImpositivo, '21.00')
    assert.equal(details[0].BaseImponibleOimporteNoSujeto, '10.00')
    assert.equal(details[0].CuotaRepercutida, '2.10')
    const base = details.reduce((sum, d) => sum + aeatCents(d.BaseImponibleOimporteNoSujeto), 0)
    const tax = details.reduce((sum, d) => sum + aeatCents(d.CuotaRepercutida), 0)
    assert.equal(aeatCents(body.CuotaTotal), tax, 'CuotaTotal debe igualar la suma de las cuotas')
    assert.equal(aeatCents(body.ImporteTotal), base + tax, 'ImporteTotal debe igualar base + cuota')
    assert.deepEqual([aeatCents(body.CuotaTotal), aeatCents(body.ImporteTotal)], [210, 1210], 'se esperaban 2.10 y 12.10')
  })
  check('Huella de 64 hex y enlazada', () => {
    assert.ok(isHuella(after[0].hash), `hash inválido: ${JSON.stringify(after[0].hash)}`)
    assert.equal(body.Huella, after[0].hash, 'Huella debe ser el hash almacenado')
  })
  check('encadenamiento', () => {
    exactKeys(body.Encadenamiento, ['PrimerRegistro'], 'Encadenamiento')
    assert.equal(body.Encadenamiento.PrimerRegistro, 'S')
  })
  check('SistemaInformatico keys exactas', () => {
    exactKeys(body.SistemaInformatico, SYSTEM_KEYS, 'SistemaInformatico')
    assert.equal(body.SistemaInformatico.NIF, NIF)
    assert.equal(body.SistemaInformatico.NombreSistemaInformatico, 'Tickit')
    assert.equal(body.SistemaInformatico.IdSistemaInformatico, '01')
    assert.equal(body.SistemaInformatico.Version, '1.0.0')
    assert.equal(body.SistemaInformatico.NumeroInstalacion, '7')
  })
  check('marca temporal', () => {
    assert.equal(body.IDVersion, '1.0')
    assert.equal(body.TipoHuella, '01')
    assert.equal(body.TipoFactura, 'F2')
    localStamp(body.FechaHoraHusoGenRegistro, '2026-03-02T11:15:00', 'FechaHoraHusoGenRegistro')
  })
  check('envelope campos requeridos', () => hasFields(after[0].record_envelope, ENVELOPE_REQUIRED, 'record_envelope'))
  check('invoice snapshot campos requeridos', () => hasFields(after[0].invoice_snapshot, INVOICE_SNAPSHOT_REQUIRED, 'invoice_snapshot'))
  check('economía intacta', () => assert.deepEqual(afterEconomics, before, 'tickets/sales/líneas/pagos no pueden cambiar'))
  check('fiscal_local_series reconstruida', () => {
    assert.equal(seriesCount, 1, 'debe quedar el contador de la nueva serie SIF')
  })
  check('rebuild con los guards append-only reales', () => {
    assert.equal(guardedError, null, `el rebuild total abortó con los guards append-only: ${guardedError?.message}`)
  })

  await db.close()
  done()
})

// ---------------------------------------------------------------------------
// (3) two paid tickets in the same installation -> independent chain positions
// ---------------------------------------------------------------------------

test('dos tickets paid de la misma instalación encadenan posiciones 1 y 2 con identidad previa exacta', async () => {
  const db = await createDatabase()
  await seedTenant(db, ID.tenant)
  await seedTicket(db, {
    ticketId: ID.ticket1, tenantId: ID.tenant, venueId: ID.venueA, deviceId: ID.deviceA,
    registerId: ID.registerA, status: 'paid', ticketNumber: '1', totalCents: 1210,
    createdAt: '2026-03-02T10:15:00Z',
  })
  await seedTicket(db, {
    ticketId: ID.ticket2, tenantId: ID.tenant, venueId: ID.venueA, deviceId: ID.deviceA,
    registerId: ID.registerA, status: 'paid', ticketNumber: '2', totalCents: 2420,
    createdAt: '2026-03-03T11:30:00Z',
  })
  for (const o of [
    { saleId: ID.sale1, paymentId: ID.payment1, lineId: ID.line1, ticketId: ID.ticket1, totalCents: 1210, base: 1000, tax: 210 },
    { saleId: ID.sale2, paymentId: ID.payment2, lineId: ID.line2, ticketId: ID.ticket2, totalCents: 2420, base: 2000, tax: 420 },
  ]) {
    await seedSale(db, {
      saleId: o.saleId, tenantId: ID.tenant, ticketId: o.ticketId, venueId: ID.venueA,
      registerId: ID.registerA, totalCents: o.totalCents, paymentId: o.paymentId,
    })
    await seedLine(db, {
      lineId: o.lineId, tenantId: ID.tenant, ticketId: o.ticketId, grossCents: o.base,
      netCents: o.base, baseCents: o.base, taxCents: o.tax, lineTotalCents: o.totalCents, taxRate: 21,
    })
  }

  const result = await rewrite(db)
  const after = await records(db)
  const s = spec()
  const { check, done } = s

  check('resultado', () => assert.equal(Number(result.rebuilt), 2, `rebuilt=${JSON.stringify(result.rebuilt)}`))
  check('posiciones 1 y 2', () => {
    assert.equal(after.length, 2, `se esperaban 2 registros, hay ${after.length}`)
    assert.deepEqual(after.map((row) => row.chain_position), ['1', '2'])
    assert.deepEqual(after.map((row) => row.ticket_id), [ID.ticket1, ID.ticket2])
  })
  check('hash previo enlazado', () => {
    assert.equal(after[0].previous_hash, null, 'la posición 1 no tiene hash previo')
    assert.equal(after[1].previous_hash, after[0].hash, 'la posición 2 encadena con el hash de la posición 1')
    assert.notEqual(after[0].hash, after[1].hash, 'cada registro tiene su propia huella')
  })

  const first = after.length === 2 ? s.safeRegistro(after[0].canonical_record, 'pos1') : { body: {} }
  const second = after.length === 2 ? s.safeRegistro(after[1].canonical_record, 'pos2') : { body: {} }
  check('identidad previa exacta', () => {
    const previous = second.body.Encadenamiento?.RegistroAnterior
    exactKeys(previous, PREVIOUS_KEYS, 'RegistroAnterior')
    assert.equal(previous.Huella, after[0].hash, 'RegistroAnterior.Huella debe ser el hash del registro anterior')
    assert.equal(previous.IDEmisorFactura, first.body.IDFactura.IDEmisorFactura, 'RegistroAnterior debe usar el emisor del registro anterior')
  })
  check('RegistroAnterior.numSerie del registro anterior', () => {
    assert.equal(
      second.body.Encadenamiento?.RegistroAnterior?.NumSerieFactura,
      first.body.IDFactura.NumSerieFactura,
      'debe ser la serie/número del registro anterior, no el propio',
    )
  })
  check('RegistroAnterior.fecha del registro anterior', () => {
    assert.equal(
      second.body.Encadenamiento?.RegistroAnterior?.FechaExpedicionFactura,
      first.body.IDFactura.FechaExpedicionFactura,
      'debe ser la fecha del registro anterior, no la propia',
    )
  })
  check('Huellas de 64 hex', () => {
    for (const [index, row] of after.entries()) {
      assert.ok(isHuella(row.hash), `pos${index + 1} hash inválido`)
      assert.equal(registro(row.canonical_record, `pos${index + 1}`).body.Huella, row.hash)
    }
  })
  check('importes por ticket', () => {
    assert.equal(aeatCents(first.body.ImporteTotal), 1210)
    assert.equal(aeatCents(second.body.ImporteTotal), 2420)
  })

  await db.close()
  done()
})

// ---------------------------------------------------------------------------
// (4) void rebuilt from DB ticket lines plus the offline sale_created / sale_voided events
// ---------------------------------------------------------------------------

test('un ticket void se reconstruye con alta y anulación encadenadas y conserva el saleId histórico', async () => {
  const db = await createDatabase()
  await seedTenant(db, ID.tenant)
  await seedTicket(db, {
    ticketId: ID.ticket3, tenantId: ID.tenant, venueId: ID.venueA, deviceId: ID.deviceA,
    registerId: ID.registerA, status: 'void', ticketNumber: '4', totalCents: 1210,
    createdAt: '2026-03-02T10:15:00Z',
  })
  await seedLine(db, {
    lineId: ID.line3, tenantId: ID.tenant, ticketId: ID.ticket3, grossCents: 1000,
    netCents: 1000, baseCents: 1000, taxCents: 210, lineTotalCents: 1210, taxRate: 21,
  })
  await db.query(
    `insert into public.offline_event_log (tenant_id, event_kind, client_event_id, payload, created_at)
     values ($1, 'sale_created', $2, $3::jsonb, '2026-03-02T10:15:00Z')`,
    [ID.tenant, ID.clientEvent, JSON.stringify({ ticketId: ID.ticket3, saleId: ID.voidedSale })],
  )
  await db.query(
    `insert into public.offline_event_log (tenant_id, event_kind, client_event_id, payload, created_at)
     values ($1, 'sale_voided', $2, $3::jsonb, '2026-03-04T12:00:00Z')`,
    [ID.tenant, ID.clientEvent, JSON.stringify({ ticketId: ID.ticket3, voidedAt: '2026-03-04T12:00:00Z' })],
  )

  const result = await rewrite(db)
  const after = await records(db)
  const s = spec()
  const { check, done } = s

  check('resultado', () => assert.equal(Number(result.rebuilt), 2, `rebuilt=${JSON.stringify(result.rebuilt)}`))
  check('alta y anulación en 1 y 2', () => {
    assert.equal(after.length, 2, `se esperaban 2 registros, hay ${after.length}`)
    assert.deepEqual(after.map((row) => row.record_kind), ['alta', 'anulacion'])
    assert.deepEqual(after.map((row) => row.chain_position), ['1', '2'])
    assert.deepEqual(after.map((row) => row.ticket_id), [ID.ticket3, ID.ticket3])
  })
  check('sale_id nulo en base de datos', () => {
    assert.equal(after[0].sale_id, null, 'el alta de un ticket anulado no puede apuntar a una venta viva')
    assert.equal(after[1].sale_id, null, 'la anulación no puede apuntar a una venta viva')
  })

  const alta = after.length === 2 ? s.safeRegistro(after[0].canonical_record, 'alta') : { body: {} }
  const anulacion = after.length === 2 ? s.safeRegistro(after[1].canonical_record, 'anulacion') : { body: {} }
  check('tipo de registro', () => {
    assert.equal(alta.kind, 'RegistroAlta')
    assert.equal(anulacion.kind, 'RegistroAnulacion')
  })
  check('RegistroAnulacion keys exactas', () => exactKeys(anulacion.body, ANULACION_KEYS, 'RegistroAnulacion'))
  check('RegistroAnulacion sin Motivo', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(anulacion.body, 'Motivo'), false, 'una anulación no declara Motivo')
  })
  check('identidad anulada', () => {
    exactKeys(anulacion.body.IDFactura, ANNULLED_IDENTITY_KEYS, 'IDFactura de la anulación')
    assert.equal(anulacion.body.IDFactura.IDEmisorFacturaAnulada, NIF)
    assert.equal(anulacion.body.IDFactura.NumSerieFacturaAnulada, `${SERIES}1`)
    assert.equal(anulacion.body.IDFactura.FechaExpedicionFacturaAnulada, '02-03-2026')
  })
  check('anulación encadenada con el alta', () => {
    const previous = anulacion.body.Encadenamiento?.RegistroAnterior
    exactKeys(previous, PREVIOUS_KEYS, 'RegistroAnterior de la anulación')
    assert.equal(previous.Huella, after[0].hash)
    assert.equal(previous.NumSerieFactura, alta.body.IDFactura.NumSerieFactura)
    assert.equal(previous.FechaExpedicionFactura, alta.body.IDFactura.FechaExpedicionFactura)
    assert.equal(after[1].previous_hash, after[0].hash, 'previous_hash debe apuntar al alta')
  })
  check('Huella de la anulación', () => {
    assert.ok(isHuella(after[1].hash), `hash inválido: ${JSON.stringify(after[1].hash)}`)
    assert.equal(anulacion.body.Huella, after[1].hash, 'el registro de anulación debe llevar su propia Huella')
    assert.notEqual(after[1].hash, after[0].hash, 'la anulación tiene su propia huella')
  })
  check('marca temporal de la anulación', () => {
    assert.equal(anulacion.body.IDVersion, '1.0')
    assert.equal(anulacion.body.TipoHuella, '01')
    localStamp(anulacion.body.FechaHoraHusoGenRegistro, '2026-03-04T13:00:00', 'FechaHoraHusoGenRegistro de la anulación')
  })
  check('snapshot con saleId histórico', () => {
    assert.equal(
      historicalSaleId(after.length === 2 ? after[1].economic_snapshot : null),
      ID.voidedSale,
      'el snapshot debe conservar el saleId histórico de la venta anulada',
    )
  })
  check('snapshot con líneas del ticket', () => {
    assert.equal(after.length === 2 ? after[0].economic_snapshot?.lines?.length : null, 1, 'el snapshot económico debe incluir las líneas del ticket')
  })

  await db.close()
  done()
})

// ---------------------------------------------------------------------------
// (5) legacy fiscal_invoice whose ticket lines carry no fiscal tax snapshot
// ---------------------------------------------------------------------------

test('un fiscal_invoice legacy migra usando request_payload.lineas cuando las líneas no tienen datos fiscales', async () => {
  const db = await createDatabase()
  await seedTenant(db, ID.tenant)
  await seedTicket(db, {
    ticketId: ID.ticket4, tenantId: ID.tenant, venueId: ID.venueA, deviceId: ID.deviceA,
    registerId: ID.registerA, status: 'paid', ticketNumber: '9', totalCents: 1210,
    createdAt: '2026-03-05T08:00:00Z',
  })
  await seedSale(db, {
    saleId: ID.sale1, tenantId: ID.tenant, ticketId: ID.ticket4, venueId: ID.venueA,
    registerId: ID.registerA, totalCents: 1210, paymentId: ID.payment1,
  })
  // Historical rows whose fiscal tax snapshot was never persisted.
  await seedLine(db, {
    lineId: ID.line1, tenantId: ID.tenant, ticketId: ID.ticket4, grossCents: 1000,
    netCents: 1000, baseCents: null, taxCents: null, lineTotalCents: 1210, taxRate: 21,
  })
  // Legacy request payload keeps the tax breakdown, using the canonical detail vocabulary.
  await db.query(
    `insert into public.fiscal_invoices
       (id, tenant_id, venue_id, ticket_id, sale_id, environment, provider, invoice_type,
        series, number, issue_date, issued_at, request_payload)
     values ($1, $2, $3, $4, $5, 'test', 'ticketbai', 'F2', 'TB2026', '0009', '2026-03-05', '2026-03-05T08:00:00Z', $6::jsonb)`,
    [
      ID.fiscalInvoice, ID.tenant, ID.venueA, ID.ticket4, ID.sale1,
      JSON.stringify({
        lineas: [{
          descripcion: 'Cafe',
          Impuesto: '01',
          ClaveRegimen: '01',
          CalificacionOperacion: 'S1',
          TipoImpositivo: '21.00',
          BaseImponibleOimporteNoSujeto: '10.00',
          CuotaRepercutida: '2.10',
        }],
      }),
    ],
  )

  const result = await rewrite(db)
  const after = await records(db)
  const s = spec()
  const { check, done } = s

  check('migrado', () => assert.equal(Number(result.rebuilt), 1, `rebuilt=${JSON.stringify(result.rebuilt)}`))
  check('registro reconstruido', () => assert.equal(after.length, 1, `se esperaba 1 registro, hay ${after.length}`))

  const { body } = after.length ? s.safeRegistro(after[0].canonical_record, 'alta') : { body: {} }
  check('identidad migrada al SIF actual', () => {
    assert.equal(body.IDFactura.NumSerieFactura, `${SERIES}1`, 'debe usar la serie y numeración SIF actual')
    assert.equal(body.IDFactura.FechaExpedicionFactura, '05-03-2026')
  })
  check('base fiscal tomada de request_payload.lineas', () => {
    const details = body.Desglose?.DetalleDesglose
    assert.ok(Array.isArray(details) && details.length === 1, `DetalleDesglose inválido: ${JSON.stringify(details)}`)
    exactKeys(details[0], DETAIL_KEYS, 'DetalleDesglose[0]')
    assert.equal(details[0].BaseImponibleOimporteNoSujeto, '10.00')
    assert.equal(details[0].CuotaRepercutida, '2.10')
    assert.equal(aeatCents(body.CuotaTotal), 210, 'CuotaTotal debe ser 2.10')
    assert.equal(aeatCents(body.ImporteTotal), 1210, 'ImporteTotal debe ser 12.10')
  })
  check('Huella de 64 hex', () => {
    assert.ok(isHuella(after[0].hash))
    assert.equal(body.Huella, after[0].hash)
  })

  await db.close()
  done()
})

// ---------------------------------------------------------------------------
// (6) missing tax source aborts and leaves the previous ledger untouched
// ---------------------------------------------------------------------------

test('sin fuente fiscal la reconstrucción aborta y deja intacto el registro stale', async () => {
  const db = await createDatabase()
  await seedTenant(db, ID.tenant)
  await seedTicket(db, {
    ticketId: ID.ticket5, tenantId: ID.tenant, venueId: ID.venueA, deviceId: ID.deviceA,
    registerId: ID.registerA, status: 'paid', ticketNumber: '7', totalCents: 1210,
    createdAt: '2026-03-06T09:00:00Z',
  })
  await seedSale(db, {
    saleId: ID.sale1, tenantId: ID.tenant, ticketId: ID.ticket5, venueId: ID.venueA,
    registerId: ID.registerA, totalCents: 1210, paymentId: ID.payment1,
  })
  // No ticket_lines at all: there is no tax source for the sale.
  await seedStaleRecord(db, {
    tenantId: ID.tenant, subjectId: ID.subject, installationId: ID.installA, venueId: ID.venueA,
    registerId: ID.registerA, chainPosition: 9, hash: SHA_B, generatedAt: '2026-03-01T09:00:00Z',
  })

  const before = await economics(db)
  await assert.rejects(() => rewrite(db), /FISCAL_TAX_SOURCE_MISSING|FISCAL_TAX_SNAPSHOT_INCOMPLETE/)

  const after = await records(db)
  assert.equal(after.length, 1, 'el abort no puede crear ni destruir registros fiscales')
  assert.equal(after[0].chain_position, '9', 'el registro stale debe conservar su posición')
  assert.equal(after[0].hash, SHA_B, 'el registro stale debe conservar su huella')
  assert.equal(after[0].canonical_schema, 'stale')
  assert.deepEqual(await economics(db), before, 'la economía no puede cambiar en un rebuild abortado')
})

// ---------------------------------------------------------------------------
// (7) two venues of one tenant sharing a NIF keep independent chains
// ---------------------------------------------------------------------------

test('dos venues del mismo tenant con el mismo NIF mantienen cadenas independientes', async () => {
  const db = await createDatabase()
  await seedTenant(db, ID.tenant)
  await db.query(
    `insert into public.venues (id, tenant_id, name, legal_name, tax_id, address, timezone, created_at)
     values ($1, $2, 'Sucursal', 'Central Bar SL', $3, 'Avenida del Norte 2', $4, '2026-01-02T08:00:00Z')`,
    [ID.venueB, ID.tenant, NIF, TIMEZONE],
  )
  await db.query(`insert into public.devices (id, tenant_id, venue_id) values ($1, $2, $3)`, [ID.deviceB, ID.tenant, ID.venueB])
  await db.query(`insert into public.cash_registers (id, tenant_id, venue_id) values ($1, $2, $3)`, [ID.registerB, ID.tenant, ID.venueB])
  await seedInstallation(db, {
    installationId: ID.installB, tenantId: ID.tenant, subjectId: ID.subject, venueId: ID.venueB,
    registerId: ID.registerB, deviceId: ID.deviceB, installationNumber: '8',
  })
  await db.query(`update public.fiscal_sif_installations set venue_code='VEN2' where id=$1`, [ID.installB])
  for (const o of [
    { ticketId: ID.ticket1, saleId: ID.sale1, paymentId: ID.payment1, lineId: ID.line1, venueId: ID.venueA, deviceId: ID.deviceA, registerId: ID.registerA, totalCents: 1210, base: 1000, tax: 210, at: '2026-03-02T10:15:00Z', number: '1' },
    { ticketId: ID.ticket2, saleId: ID.sale2, paymentId: ID.payment2, lineId: ID.line2, venueId: ID.venueB, deviceId: ID.deviceB, registerId: ID.registerB, totalCents: 1210, base: 1000, tax: 210, at: '2026-03-02T10:15:00Z', number: '2' },
  ]) {
    await seedTicket(db, {
      ticketId: o.ticketId, tenantId: ID.tenant, venueId: o.venueId, deviceId: o.deviceId,
      registerId: o.registerId, status: 'paid', ticketNumber: o.number, totalCents: o.totalCents, createdAt: o.at,
    })
    await seedSale(db, {
      saleId: o.saleId, tenantId: ID.tenant, ticketId: o.ticketId, venueId: o.venueId,
      registerId: o.registerId, totalCents: o.totalCents, paymentId: o.paymentId,
    })
    await seedLine(db, {
      lineId: o.lineId, tenantId: ID.tenant, ticketId: o.ticketId, grossCents: o.base,
      netCents: o.base, baseCents: o.base, taxCents: o.tax, lineTotalCents: o.totalCents, taxRate: 21,
    })
  }

  const result = await rewrite(db)
  const after = await records(db)
  const subjects = await rows(db, `select id::text, nif from public.fiscal_subjects`)
  const s = spec()
  const { check, done } = s

  check('resultado', () => assert.equal(Number(result.rebuilt), 2, `rebuilt=${JSON.stringify(result.rebuilt)}`))
  check('dos instalaciones distintas', () => {
    assert.equal(after.length, 2, `se esperaban 2 registros, hay ${after.length}`)
    assert.deepEqual(after.map((row) => row.installation_id).sort(), [ID.installA, ID.installB].sort())
  })
  check('cadenas independientes', () => {
    for (const row of after) {
      assert.equal(row.chain_position, '1', `${row.installation_id} debe arrancar en la posición 1`)
      assert.equal(row.previous_hash, null, `${row.installation_id} no debe heredar hash de otra instalación`)
      assert.deepEqual(
        registro(row.canonical_record, row.installation_id).body.Encadenamiento,
        { PrimerRegistro: 'S' },
        `${row.installation_id} debe abrir su propia cadena`,
      )
    }
  })
  check('un solo emisor por tenant', () => {
    assert.deepEqual(subjects, [{ id: ID.subject, nif: NIF }], 'el NIF compartido debe resolverse a un único sujeto')
    for (const row of after) assert.equal(row.fiscal_subject_id, ID.subject)
  })
  check('Huellas de 64 hex distintas por instalación', () => {
    assert.ok(after.every((row) => isHuella(row.hash)), 'cada cadena arranca con una huella de 64 hex')
    assert.notEqual(after[0].hash, after[1].hash, 'cadenas independientes no pueden compartir huella inicial')
  })

  await db.close()
  done()
})
