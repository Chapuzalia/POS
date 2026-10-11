import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const sql = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8')
const fix = sql('20261011010552_allow_refund_installation_series')
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const [tenant, venue, device, register, subject, session, ticket, sale, line] = Array.from({ length: 9 }, (_, i) => id(i + 1))
const generatedAt = '2026-10-11T01:02:20.000Z'
const originalHash = 'A'.repeat(64)
const hash = 'B'.repeat(64)

// Real PostgreSQL, fiscal tables, triggers and refund RPC. Only unrelated POS
// catalogue tables/access helpers are reduced to the fields this RPC consumes.
async function database(t, legacy = false) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${device}'::uuid $$;
    create function user_has_tenant_access(uuid) returns boolean language sql as $$ select $1='${tenant}'::uuid $$;
    create function user_is_tenant_admin(uuid) returns boolean language sql as $$ select $1='${tenant}'::uuid $$;
    create function user_has_venue_access(uuid,uuid) returns boolean language sql as $$ select $1='${tenant}'::uuid and $2='${venue}'::uuid $$;
    create table tenants(id uuid primary key);
    create table venues(id uuid primary key,tenant_id uuid,timezone text,fiscal_code text);
    create table devices(id uuid primary key,tenant_id uuid,venue_id uuid,is_active boolean,can_take_payments boolean);
    create table cash_registers(id uuid primary key,tenant_id uuid,venue_id uuid,is_active boolean);
    create table cash_sessions(id uuid primary key,tenant_id uuid,venue_id uuid,cash_register_id uuid,device_id uuid,status text);
    create table tickets(id uuid primary key,tenant_id uuid,venue_id uuid,cash_register_id uuid,cash_session_id uuid,status text,total_cents integer);
    create table sales(id uuid primary key,tenant_id uuid,ticket_id uuid,total_cents integer);
    create table ticket_lines(id uuid primary key,tenant_id uuid,ticket_id uuid,quantity integer,unit_price_cents integer,discount_amount_cents integer,tax_amount_cents integer,taxable_base_cents integer,product_name text,variant_name text,modifiers jsonb,tax_rate numeric(5,2));
    create table fiscal_pos_bridge_settings(tenant_id uuid,aeat_environment text);
    insert into tenants values('${tenant}');
    insert into venues values('${venue}','${tenant}','Europe/Madrid','NIC');
    insert into devices values('${device}','${tenant}','${venue}',true,true);
    insert into cash_registers values('${register}','${tenant}','${venue}',true);
    insert into cash_sessions values('${session}','${tenant}','${venue}','${register}','${device}','open');
    insert into tickets values('${ticket}','${tenant}','${venue}','${register}','${session}','paid',2100);
    insert into sales values('${sale}','${tenant}','${ticket}',2100);
    insert into ticket_lines values('${line}','${tenant}','${ticket}',2,1050,0,364,1736,'Producto','Normal','[]',21);
  `)
  await db.exec(sql('20260928120000_prepare_local_verifactu_scope'))
  await db.exec(sql('20261001120000_add_refund_workflow_foundation'))
  await db.exec(`insert into fiscal_subjects(id,tenant_id,legal_name,nif) values('${subject}','${tenant}','Bar SL','B12345678')`)
  async function install(number) {
    await db.exec(`insert into fiscal_sif_installations(id,tenant_id,fiscal_subject_id,venue_id,cash_register_id,device_id,installation_number,venue_code,register_code,installation_code,mode)
      values('${id(10 + number)}','${tenant}','${subject}','${venue}','${register}','${device}','NIC-C1-${number}','NIC','C1','INST${number}','production')`)
  }
  if (legacy) await install(1)
  await db.exec(sql('20261002191101_pwa_fiscal_installation_identity'))
  if (!legacy) {
    for (let number = 1; number <= 3; number++) {
      await install(number)
      if (number < 3) await db.exec(`update fiscal_sif_installations set retired_at=now() where id='${id(10 + number)}'`)
    }
  }
  const installation = id(legacy ? 11 : 13)
  const series = legacy ? 'NIC-C1-2026-R' : 'NIC-C1-3-2026-R'
  const original = { RegistroAlta: { TipoFactura: 'F2', Huella: originalHash, SistemaInformatico: { NumeroInstalacion: legacy ? 'NIC-C1-1' : 'NIC-C1-3' }, FechaHoraHusoGenRegistro: generatedAt } }
  await db.query(`insert into fiscal_local_records(id,tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,invoice_id,ticket_id,sale_id,record_kind,chain_position,hash,canonical_schema,canonical_record,record_envelope,invoice_snapshot,generated_at,idempotency_key)
    values($1,$2,$3,$4,$5,$6,$1,$7,$8,'alta',1,$9,'aeat-registro-v1',$10,'{}','{}',$11,$12)`,
  [id(20), tenant, subject, installation, venue, register, ticket, sale, originalHash, original, generatedAt, id(21)])
  const record = {
    tenantId: tenant, venueId: venue, cashRegisterId: register, deviceId: device,
    fiscalSubjectId: subject, installationId: installation, issuerNif: 'B12345678',
    environment: 'production', canonicalSchema: 'aeat-registro-v1', invoiceId: id(22),
    hash, previous: { hash: originalHash }, generatedAt, chainPosition: 2,
    canonicalRecord: { RegistroAlta: { TipoFactura: 'R5', TipoRectificativa: 'I', Huella: hash, ImporteTotal: '-10.50',
      SistemaInformatico: { NumeroInstalacion: legacy ? 'NIC-C1-1' : 'NIC-C1-3' }, FechaHoraHusoGenRegistro: generatedAt } },
  }
  const invoice = { series, number: 1, issuedAt: generatedAt, totalCents: -1050 }
  async function refund({ tenantId = tenant, quantity = 1, envelope = record, document = invoice } = {}) {
    return (await db.query('select (public.create_ticket_refund($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)).*',
      [tenantId, ticket, sale, id(23), session, 'cash', [{ originalTicketLineId: line, quantity }], id(24), envelope, document])).rows[0]
  }
  return { db, refund, record, invoice, original }
}

test('real refund RPC reproduces 23514, then commits sequenced refund and fiscal record atomically', async t => {
  const { db, refund, record, original } = await database(t)
  await assert.rejects(refund(), error => error.code === '23514' && /refund_requests_fiscal_series_check/.test(error.message))
  assert.equal((await db.query('select count(*)::integer as n from refund_requests')).rows[0].n, 0)
  assert.equal((await db.query('select count(*)::integer as n from refund_lines')).rows[0].n, 0)
  assert.equal((await db.query('select count(*)::integer as n from fiscal_local_records')).rows[0].n, 1)
  const security = () => db.query(`select c.relname,c.relrowsecurity,c.relacl::text from pg_class c where c.oid in ('refund_requests'::regclass,'refund_lines'::regclass,'refund_payments'::regclass) order by c.relname`)
  const before = (await security()).rows
  const rpcBefore = (await db.query("select proacl::text,pg_get_functiondef(oid) as definition from pg_proc where proname='create_ticket_refund'")).rows
  await db.exec(fix)
  assert.deepEqual((await security()).rows, before)
  assert.deepEqual((await db.query("select proacl::text,pg_get_functiondef(oid) as definition from pg_proc where proname='create_ticket_refund'")).rows, rpcBefore)
  await db.exec('set role authenticated')
  await assert.rejects(refund({ tenantId: id(99) }), /REFUND_BAD_REQUEST/)
  await assert.rejects(refund({ quantity: 3 }), /REFUND_LINE_QUANTITY_INVALID/)
  const row = await refund()
  assert.equal(row.fiscal_series, 'NIC-C1-3-2026-R')
  assert.equal(row.total_cents, -1050)
  assert.deepEqual(row.fiscal_rectificative_record, record)
  assert.equal((await refund()).id, row.id)
  await assert.rejects(refund({ envelope: { ...record, hash: 'C'.repeat(64) } }), /REFUND_IDEMPOTENCY_CONFLICT/)
  const persisted = (await db.query('select * from fiscal_local_records where refund_request_id=$1', [row.id])).rows[0]
  assert.deepEqual(persisted.record_envelope, record)
  assert.equal(persisted.chain_position, 2)
  assert.equal(persisted.previous_hash, originalHash)
  assert.equal((await db.query('select canonical_record from fiscal_local_records where id=$1', [id(20)])).rows[0].canonical_record.RegistroAlta.Huella, original.RegistroAlta.Huella)
  assert.equal((await db.query('select count(*)::integer as n from refund_payments')).rows[0].n, 1)
  assert.equal((await db.query('select last_number from fiscal_local_series')).rows[0].last_number, 1)
})

test('legacy refunds and historical rows remain valid; malformed/new non-refund series stay rejected', async t => {
  const { db, refund } = await database(t, true)
  const old = await refund()
  await db.exec(fix)
  assert.deepEqual((await db.query('select * from refund_requests')).rows[0], old)
  const constraint = (await db.query("select convalidated from pg_constraint where conrelid='refund_requests'::regclass and conname='refund_requests_fiscal_series_check'")).rows[0]
  assert.equal(constraint.convalidated, false)
  for (const series of ['NIC-C1-3-2026-R', 'NIC-C1-12-2027-R', 'NIC-C1-2026-R']) {
    await db.query('update refund_requests set fiscal_series=$1 where id=$2', [series, old.id])
  }
  for (const series of ['NIC-C1-0-2026-R', 'NIC-C1-03-2026-R', 'NIC-C1--3-2026-R', 'NIC-C1-3-2026-S', 'NIC-C1-3-2026-F', 'NIC-C1-3-26-R', 'nic-C1-3-2026-R', 'NIC-C1-3-2026-R-extra']) {
    await assert.rejects(db.query('update refund_requests set fiscal_series=$1 where id=$2', [series, old.id]), error => error.code === '23514')
  }
  await db.exec('alter table refund_requests validate constraint refund_requests_fiscal_series_check')
})

test('production analyzer still requires review of the atomic constraint replacement', () => {
  // Compatible CHECK widening needs the repository's documented, reviewed
  // promotion exception. Do not weaken the deployment guard to hide the DROP.
  assert.deepEqual(analyzeMigration(fix), ['DROP'])
})
