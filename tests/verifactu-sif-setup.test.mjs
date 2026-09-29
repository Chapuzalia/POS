import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import {
  assertUniqueFiscalInstallationIdentities,
  defaultFiscalInstallationIdentity,
  readableFiscalSetupError,
} from '../src/features/fiscal/local/setupPolicy.ts'

const fiscalSchemaMigration = await readFile(new URL('../supabase/migrations/20260928120000_prepare_local_verifactu_scope.sql', import.meta.url), 'utf8')
const setupMigration = await readFile(new URL('../supabase/migrations/20260929130000_add_fiscal_sif_setup_rpc.sql', import.meta.url), 'utf8')
const replacementMigration = await readFile(new URL('../supabase/migrations/20260929140000_allow_controlled_fiscal_installation_replacement.sql', import.meta.url), 'utf8')

const venueId = '11111111-1111-4111-8111-111111111111'
const registerId = '22222222-2222-4222-8222-222222222222'
const firstDeviceId = '33333333-3333-4333-8333-333333333333'
const secondDeviceId = '44444444-4444-4444-8444-444444444444'

test('cada dispositivo recibe una identidad SIF visible, estable y exclusiva', () => {
  const first = defaultFiscalInstallationIdentity(venueId, registerId, firstDeviceId)
  const repeated = defaultFiscalInstallationIdentity(venueId, registerId, firstDeviceId)
  const second = defaultFiscalInstallationIdentity(venueId, '55555555-5555-4555-8555-555555555555', secondDeviceId)
  assert.deepEqual(first, repeated)
  assert.notEqual(first.installationNumber, second.installationNumber)
  assert.notEqual(first.installationCode, second.installationCode)
  assert.match(first.venueCode, /^[A-Z0-9]{1,8}$/)
  assert.match(first.registerCode, /^[A-Z0-9]{1,8}$/)
  assert.match(first.installationCode, /^[A-Z0-9]{1,8}$/)
})

test('el CRM detecta códigos, números, cajas y dispositivos repetidos antes de llamar a Supabase', () => {
  const first = { ...defaultFiscalInstallationIdentity(venueId, registerId, firstDeviceId), cashRegisterId: registerId, deviceId: firstDeviceId }
  const second = { ...defaultFiscalInstallationIdentity(venueId, '55555555-5555-4555-8555-555555555555', secondDeviceId), cashRegisterId: '55555555-5555-4555-8555-555555555555', deviceId: secondDeviceId }
  assert.doesNotThrow(() => assertUniqueFiscalInstallationIdentities([first, second]))
  assert.throws(() => assertUniqueFiscalInstallationIdentities([first, { ...second, installationCode: first.installationCode }]), error => error.name === 'UserFacingError' && /código de instalación/i.test(error.message))
  assert.throws(() => assertUniqueFiscalInstallationIdentities([first, { ...second, cashRegisterId: first.cashRegisterId }]), error => error.name === 'UserFacingError' && /caja/i.test(error.message))
})

test('una colisión histórica de PostgreSQL se presenta como una acción comprensible', () => {
  const error = readableFiscalSetupError({
    code: '23505',
    details: 'Key (tenant_id, fiscal_subject_id, installation_code)=(tenant, subject, INST1) already exists.',
    message: 'duplicate key value violates unique constraint',
  })
  assert.match(error.message, /código de instalación ya fue utilizado/i)
  assert.match(error.message, /tampoco se reutilizan/i)
  assert.equal(error.name, 'UserFacingError')
})

test('el reemplazo retira la identidad anterior y crea otra sin borrar su historial', async (t) => {
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
    insert into public.tenants values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    insert into public.venues values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    insert into public.cash_registers values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    insert into public.devices values
      ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  `)
  await db.exec(fiscalSchemaMigration)
  await db.exec(setupMigration)
  await db.exec(replacementMigration)
  const firstPayload = JSON.stringify([{ venueId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cashRegisterId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', installationNumber: 'OLD-INSTALLATION', venueCode: 'LOCAL1', registerCode: 'CAJA1', installationCode: 'OLD1' }])
  await db.query(`select public.save_fiscal_sif_setup($1::uuid, $2, $3, $4::jsonb)`, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Emisor SL', 'B12345678', firstPayload])
  const first = await db.query(`select id from public.fiscal_sif_installations where retired_at is null`)
  const oldId = first.rows[0].id
  const replacementPayload = JSON.stringify([{ replaceInstallationId: oldId, venueId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cashRegisterId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', deviceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', installationNumber: 'NEW-INSTALLATION', venueCode: 'LOCAL1', registerCode: 'CAJA1', installationCode: 'NEW1' }])
  await db.query(`select public.save_fiscal_sif_setup($1::uuid, $2, $3, $4::jsonb)`, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Emisor SL', 'B12345678', replacementPayload])
  const installations = await db.query(`select id, device_id, installation_code, retired_at is not null as retired from public.fiscal_sif_installations order by created_at, installation_code`)
  assert.equal(installations.rows.length, 2)
  assert.deepEqual(installations.rows.map(row => [row.installation_code, row.device_id, row.retired]), [
    ['OLD1', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', true],
    ['NEW1', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', false],
  ])
})
