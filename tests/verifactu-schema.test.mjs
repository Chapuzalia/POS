import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../supabase/migrations/20260928120000_prepare_local_verifactu_scope.sql', import.meta.url), 'utf8')
const saleMigration = await readFile(new URL('../supabase/migrations/20260928130000_sync_local_verifactu_sale.sql', import.meta.url), 'utf8')
const tenantA = '11111111-1111-4111-8111-111111111111'
const tenantB = '22222222-2222-4222-8222-222222222222'
const venueA = '33333333-3333-4333-8333-333333333333'
const deviceA = '44444444-4444-4444-8444-444444444444'
const registerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const subjectA = '55555555-5555-4555-8555-555555555555'
const installationA = '66666666-6666-4666-8666-666666666666'

test('preparatory fiscal schema isolates issuers, preserves installation identities and records', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon;
    create role authenticated;
    create table public.tenants (id uuid primary key);
    create table public.venues (id uuid primary key, tenant_id uuid not null);
    create table public.devices (id uuid primary key, tenant_id uuid not null, venue_id uuid not null);
    create table public.cash_registers (id uuid primary key, tenant_id uuid not null, venue_id uuid not null);
    create table public.tickets (id uuid primary key);
    create table public.sales (id uuid primary key);
    create function public.user_is_tenant_admin(uuid) returns boolean language sql as $$ select true $$;
    create function public.user_has_venue_access(uuid, uuid) returns boolean language sql as $$ select true $$;
    insert into public.tenants values ('${tenantA}'), ('${tenantB}');
    insert into public.venues values ('${venueA}', '${tenantA}');
    insert into public.devices values ('${deviceA}', '${tenantA}', '${venueA}');
    insert into public.cash_registers values ('${registerA}', '${tenantA}', '${venueA}');
  `)
  await db.exec(migration)
  await db.exec(saleMigration)
  await db.exec(`insert into public.fiscal_subjects(id, tenant_id, legal_name, nif) values
    ('${subjectA}', '${tenantA}', 'Ejemplo SA', '89890001K');`)
  await assert.rejects(db.exec(`insert into public.fiscal_sif_installations
    (tenant_id, fiscal_subject_id, venue_id, cash_register_id, device_id, installation_number, venue_code, register_code, installation_code)
    values ('${tenantB}', '${subjectA}', '${venueA}', '${registerA}', '${deviceA}', 'I-1', 'L1', 'C1', 'I1');`), /foreign key|scope mismatch/i)

  await db.exec(`insert into public.fiscal_sif_installations
    (id, tenant_id, fiscal_subject_id, venue_id, cash_register_id, device_id, installation_number, venue_code, register_code, installation_code)
    values ('${installationA}', '${tenantA}', '${subjectA}', '${venueA}', '${registerA}', '${deviceA}', 'I-1', 'L1', 'C1', 'I1');`)
  await assert.rejects(db.exec(`insert into public.fiscal_sif_installations
    (tenant_id, fiscal_subject_id, venue_id, cash_register_id, device_id, installation_number, venue_code, register_code, installation_code)
    values ('${tenantA}', '${subjectA}', '${venueA}', '${registerA}', '${deviceA}', 'I-2', 'L1', 'C1', 'I2');`), /unique/i)
  await db.exec(`update public.fiscal_sif_installations set retired_at = now() where id = '${installationA}';`)
  await db.exec(`insert into public.fiscal_sif_installations
    (tenant_id, fiscal_subject_id, venue_id, cash_register_id, device_id, installation_number, venue_code, register_code, installation_code)
    values ('${tenantA}', '${subjectA}', '${venueA}', '${registerA}', '${deviceA}', 'I-2', 'L1', 'C1', 'I2');`)
  await assert.rejects(db.exec(`delete from public.fiscal_sif_installations where id = '${installationA}';`), /cannot be deleted/i)

  await db.exec(`insert into public.fiscal_local_series
    (tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, device_id, document_kind, exercise, series)
    values ('${tenantA}', '${subjectA}', '${installationA}', '${venueA}', '${registerA}', '${deviceA}', 'simplified', 2026, 'L1-C1-S-2026');`)
  await assert.rejects(db.exec(`insert into public.fiscal_local_series
    (tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, device_id, document_kind, exercise, series)
    values ('${tenantA}', '${subjectA}', '${installationA}', '${venueA}', '${registerA}', '${deviceA}', 'complete', 2026, 'L1-C1-S-2026');`), /unique/i)
  await assert.rejects(db.exec(`update public.fiscal_local_series set last_number = -1;`), /counter cannot be rewritten/i)

  const recordId = '77777777-7777-4777-8777-777777777777'
  await db.exec(`insert into public.fiscal_local_records
    (id, tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, invoice_id,
     record_kind, chain_position, hash, canonical_schema, canonical_record, record_envelope, invoice_snapshot, generated_at, idempotency_key)
    values ('${recordId}', '${tenantA}', '${subjectA}', '${installationA}', '${venueA}', '${registerA}',
      '88888888-8888-4888-8888-888888888888', 'alta', 1,
      '${'A'.repeat(64)}', 'aeat-registro-v1', '{"RegistroAlta":{}}', '{}', '{}', now(),
      '99999999-9999-4999-8999-999999999999');`)
  await db.exec(`insert into public.fiscal_local_records
    (id, tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, invoice_id,
     record_kind, chain_position, previous_hash, hash, canonical_schema, canonical_record, record_envelope, invoice_snapshot, generated_at, idempotency_key)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${tenantA}', '${subjectA}', '${installationA}', '${venueA}', '${registerA}',
      '12121212-1212-4212-8212-121212121212', 'alta', 2, '${'A'.repeat(64)}',
      '${'B'.repeat(64)}', 'aeat-registro-v1', '{"RegistroAlta":{"Subsanacion":"S"}}', '{}', '{}', now(),
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');`)
  await assert.rejects(db.exec(`insert into public.fiscal_local_records
    (id, tenant_id, fiscal_subject_id, installation_id, venue_id, cash_register_id, invoice_id,
     record_kind, chain_position, hash, canonical_schema, canonical_record, record_envelope, invoice_snapshot, generated_at, idempotency_key)
    values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${tenantA}', '${subjectA}', '${installationA}', '${venueA}', '${registerA}',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'alta', 2,
      '${'C'.repeat(64)}', 'aeat-registro-v1', '{}', '{}', '{}', now(),
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');`), /unique/i)
  await assert.rejects(db.exec(`update public.fiscal_local_records set hash = '${'B'.repeat(64)}' where id = '${recordId}';`), /append-only/i)
  await assert.rejects(db.exec(`delete from public.fiscal_local_records where id = '${recordId}';`), /append-only/i)
})
