import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { IDBFactory } from 'fake-indexeddb'
import * as ledger from '../src/features/fiscal/local/localLedger.ts'
import { compileComponent } from './helpers/component-harness.mjs'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const fix = read('supabase/migrations/20261012213813_confirm_restaurant_bridge_snapshot.sql')
const original = read('supabase/migrations/20261010184559_bridge_installation_provisioning.sql')
const originalRoutine = original.slice(original.indexOf('create function public.fiscal_bridge_confirm_record(')).split('$$;')[0] + '$$;'
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [tenant, venue, device, register, subject, installation, user] = Array.from({ length: 7 }, (_, i) => uuid(i + 1))

test('restaurant bridge snapshot correction is a compatible routine replacement', () => assert.deepEqual(analyzeMigration(fix), []))

test('bridge confirmation projects committed restaurant IDs for existing records without rewriting snapshots or bypassing RLS', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    grant usage on schema auth to authenticated;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create table tenants(id uuid primary key);
    create table venues(id uuid primary key,tenant_id uuid);
    create table devices(id uuid primary key,tenant_id uuid,venue_id uuid);
    create table cash_registers(id uuid primary key,tenant_id uuid,venue_id uuid);
    create table tickets(id uuid primary key);
    create table sales(id uuid primary key);
    create function user_is_tenant_admin(uuid) returns boolean language sql stable as $$ select $1::text=current_setting('test.tenant',true) $$;
    create function user_has_venue_access(uuid,uuid) returns boolean language sql stable as $$ select public.user_is_tenant_admin($1) and $2='${venue}'::uuid $$;
    create function user_has_device_access(uuid,uuid,uuid) returns boolean language sql stable as $$ select public.user_has_venue_access($1,$2) and $3::text=current_setting('test.device',true) $$;
    insert into tenants values('${tenant}');
    insert into venues values('${venue}','${tenant}');
    insert into devices values('${device}','${tenant}','${venue}');
    insert into cash_registers values('${register}','${tenant}','${venue}');
    select set_config('test.uid','${user}',false),set_config('test.tenant','${tenant}',false),set_config('test.device','${device}',false);
  `)
  await db.exec(read('supabase/migrations/20260928120000_prepare_local_verifactu_scope.sql'))
  await db.exec(`
    alter table fiscal_sif_installations add column bridge_requested boolean default true;
    alter table fiscal_sif_installations add column retired_for_verifactu_at timestamptz;
    create table tenant_verifactu_integrations(tenant_id uuid primary key,enabled_at timestamptz);
    alter table tenant_verifactu_integrations enable row level security;
    create policy integration_read on tenant_verifactu_integrations for select to authenticated using (public.user_is_tenant_admin(tenant_id));
    grant select on tenant_verifactu_integrations to authenticated;
    insert into tenant_verifactu_integrations values('${tenant}',now());
    insert into fiscal_subjects(id,tenant_id,legal_name,nif) values('${subject}','${tenant}','Bar SL','B12345678');
    insert into fiscal_sif_installations(id,tenant_id,fiscal_subject_id,venue_id,cash_register_id,device_id,installation_number,venue_code,register_code,installation_code,mode)
      values('${installation}','${tenant}','${subject}','${venue}','${register}','${device}','SIF-1','L1','C1','I1','production');
  `)
  await db.exec(originalRoutine)
  await db.exec('revoke all on function fiscal_bridge_confirm_record(uuid,uuid) from public,anon; grant execute on function fiscal_bridge_confirm_record(uuid,uuid) to authenticated')
  const invoices = []
  for (let i = 0; i < 7; i++) {
    const id = uuid(20 + i), ticketId = uuid(40 + i), saleId = uuid(60 + i)
    const paymentId = uuid(80 + i)
    const snapshot = { invoiceId: id, ticketId: uuid(100 + i), saleId: uuid(120 + i), paymentId: i === 4 ? null : uuid(140 + i),
      issuerNif: 'B12345678', series: 'L1-C1-2026-S', number: i + 1, totalCents: i === 3 || i === 4 ? 0 : 600,
      lines: [{ grossCents: 600 }], transmissionMode: 'bridge' }
    const result = i < 5 ? { ticketId, saleId, paymentId: i === 3 || i === 4 ? null : paymentId } : null
    const envelope = { idempotencyKey: id, invoiceId: id, hash: 'A'.repeat(64) }
    await db.query('insert into tickets values($1)', [ticketId])
    await db.query('insert into sales values($1)', [saleId])
    await db.query(`insert into fiscal_local_records(id,tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,invoice_id,ticket_id,sale_id,
      rpc_result,record_kind,chain_position,hash,canonical_schema,canonical_record,record_envelope,invoice_snapshot,economic_snapshot,generated_at,idempotency_key)
      values($1,$2,$3,$4,$5,$6,$1,$7,$8,$9,$10,$11,$12,'aeat-registro-v1','{}',$13,$14,$15,now(),$1)`,
    [id, tenant, subject, installation, venue, register, ticketId, saleId, result, i === 6 ? 'anulacion' : 'alta', i + 1, 'A'.repeat(64), envelope, snapshot, i === 6 ? { reason: 'Anulación' } : null])
    const expected = result ? { ...snapshot, ticketId, saleId, paymentId: i === 3 ? saleId : i === 4 ? null : paymentId } : snapshot
    invoices.push({ id, snapshot, envelope, expected })
  }
  const rowsBefore = (await db.query('select * from fiscal_local_records order by chain_position')).rows
  const confirm = async (id, installationId = installation) => (await db.query('select fiscal_bridge_confirm_record($1,$2) as value', [installationId, id])).rows[0].value
  assert.notDeepEqual((await confirm(invoices[0].id)).snapshot, invoices[0].expected, 'the deployed routine exposes draft IDs, reproducing the bridge mismatch')
  await db.exec(fix)
  await db.exec('set role authenticated')
  for (const invoice of invoices) {
    const confirmed = await confirm(invoice.id)
    assert.deepEqual(confirmed.snapshot, invoice.expected)
    assert.deepEqual(confirmed.record, invoice.envelope)
  }
  assert.equal((await confirm(invoices[6].id)).reason, 'Anulación')
  assert.equal(await confirm(invoices[0].id, uuid(999)), null)
  for (const [setting, foreign] of [['test.tenant', uuid(998)], ['test.device', uuid(997)], ['test.uid', '']]) {
    await db.query("select set_config($1,$2,false)", [setting, foreign])
    assert.equal(await confirm(invoices[0].id), null)
    await db.query("select set_config($1,$2,false)", [setting, setting === 'test.tenant' ? tenant : setting === 'test.device' ? device : user])
  }
  await db.exec('reset role; update tenant_verifactu_integrations set enabled_at=null; set role authenticated')
  assert.equal(await confirm(invoices[0].id), null, 'disabled integrations must remain blocked')
  await db.exec('reset role; update tenant_verifactu_integrations set enabled_at=now(); update fiscal_sif_installations set retired_for_verifactu_at=now(); set role authenticated')
  assert.equal(await confirm(invoices[0].id), null, 'an identity retired for Verifactu must remain blocked')
  await db.exec('reset role; update fiscal_sif_installations set retired_for_verifactu_at=null,bridge_requested=false; set role authenticated')
  assert.equal(await confirm(invoices[0].id), null, 'installations without bridge enrollment must remain blocked')
  await db.exec('reset role; update fiscal_sif_installations set bridge_requested=true; set role authenticated')
  await db.exec('set role anon')
  await assert.rejects(confirm(invoices[0].id), /permission denied/)
  await db.exec('reset role')
  assert.deepEqual((await db.query('select * from fiscal_local_records order by chain_position')).rows, rowsBefore)
  const routine = (await db.query("select prosecdef,proconfig from pg_proc where oid='public.fiscal_bridge_confirm_record(uuid,uuid)'::regprocedure")).rows[0]
  assert.equal(routine.prosecdef, false)
  assert.ok(routine.proconfig.includes('search_path=""'))
})

for (const action of ['close', 'equal_part', 'selected_items']) test(`restaurant ${action} starts bridge delivery after RPC/local confirmation without waiting for its response`, async () => {
  globalThis.indexedDB = new IDBFactory()
  globalThis.window = { location: { pathname: '/pos' } }
  const calls = []
  const draft = { ticket: { id: 'draft-ticket', totalCents: 600 }, sale: { id: 'draft-sale' }, payment: { id: 'draft-payment' }, lines: [] }
  const result = { ticketId: 'ticket', saleId: 'sale', paymentId: 'payment', totalCents: 600 }
  const entry = { id: 'record', record: { tenantId: 'tenant', fiscalSubjectId: 'subject', installationId: 'installation', invoiceId: 'invoice' }, invoice: { transmissionMode: 'bridge' } }
  const service = compileComponent(read('src/features/fiscal/local/restaurantInvoice.ts'), {
    './localLedger.ts': ledger,
    './installation.ts': { fiscalBridgeBaseUrl: () => 'https://bridge.example', fiscalBridgeAccessToken: async () => 'token' },
    './sync.ts': { synchronizeLocalFiscalQueue: config => { calls.push(['bridge', config]); return new Promise(() => {}) } },
    './posInvoice.ts': {
      issuePosInvoice: async (_context, _session, _payload, _synced, resolve) => {
        await resolve(entry)
        calls.push(['local-confirmed'])
        return entry
      },
      printPayloadWithLocalFiscal: payload => payload,
    },
    '../../tables/service.ts': { payRestaurantLocalFiscal: async () => { calls.push(['rpc-confirmed']); return result } },
  })
  const payment = await service.issueRestaurantInvoice({ tenantId: 'tenant', deviceId: 'device' }, { id: 'session' }, draft, action, {})
  assert.equal(payment.payload.sale.id, 'sale')
  assert.deepEqual(calls.map(call => call[0]), ['rpc-confirmed', 'local-confirmed', 'bridge'])
  assert.equal(calls[2][1].installationId, 'installation')
})

test('server recovery uses the confirmed sale ID for a restaurant payment without a returned payment UUID', async () => {
  const ticketId = uuid(200), saleId = uuid(201), id = uuid(202)
  const record = { idempotencyKey: id, environment: 'production', tenantId: tenant, fiscalSubjectId: subject,
    issuerNif: 'B12345678', venueId: venue, cashRegisterId: register, installationId: installation, deviceId: device,
    invoiceId: id, chainPosition: 1, hash: 'A'.repeat(64), generatedAt: '2026-10-12T12:00:00Z',
    canonicalSchema: 'aeat-registro-v1', canonicalRecord: { RegistroAlta: {} }, previous: null }
  const snapshot = { issuerName: 'Bar SL', issuerNif: 'B12345678', series: 'L1-C1-2026-S', number: 1,
    issuedAt: record.generatedAt, qrUrl: 'https://prewww2.aeat.es/qr', ticketId: uuid(203), saleId: uuid(204), paymentId: uuid(205),
    lines: [], recipient: null, totalCents: 0, taxCents: 0, transmissionMode: 'bridge' }
  const row = { id, tenant_id: tenant, fiscal_subject_id: subject, installation_id: installation, ticket_id: ticketId,
    sale_id: saleId, refund_request_id: null, record_kind: 'alta', chain_position: 1, hash: record.hash,
    record_envelope: record, invoice_snapshot: snapshot, economic_snapshot: null,
    rpc_result: { ticketId, saleId, paymentId: null } }
  const query = {
    select() { return this }, eq() { return this }, order() { return this }, limit() { return this },
    abortSignal() { return this }, gte() { return this }, range() { return this },
    maybeSingle: async () => ({ data: row, error: null }),
    then: resolve => resolve({ data: [row], error: null }),
  }
  let copy
  const service = compileComponent(read('src/features/fiscal/local/serverRecovery.ts'), {
    zod: await import('zod'),
    '../../../lib/supabase.ts': { supabase: { from: () => query } },
    './backendRead.ts': { readFiscalBackend: work => work(new AbortController().signal) },
    './localLedger.ts': {
      readLocalFiscalHead: async () => ({ entry: null }),
      reconcileLocalFiscalCopies: async (_scope, _device, copies) => { copy = copies[0]; return 1 },
    },
  })
  assert.equal(await service.recoverServerConfirmedFiscalChain({ tenantId: tenant, fiscalSubjectId: subject, installationId: installation, deviceId: device }), 1)
  assert.equal(copy.entry.invoice.ticketId, ticketId)
  assert.equal(copy.entry.invoice.saleId, saleId)
  assert.equal(copy.entry.invoice.paymentId, saleId)
  assert.deepEqual(copy.entry.record, record)
  assert.equal(snapshot.paymentId, uuid(205))
})
