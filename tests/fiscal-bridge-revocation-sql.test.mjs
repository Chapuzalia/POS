import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const migration = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8')
const fix = migration('20261011202440_bridge_installation_revocation')
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [tenant, venue, device, register, user, admin] = Array.from({ length: 6 }, (_, i) => uuid(i + 1))

test('revocation migration is an additive, reviewed expansion', () => assert.deepEqual(analyzeMigration(fix), []))

test('server-only revocation is scoped, idempotent, retires emission, preserves pending history and requires a new identity', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    grant usage on schema auth to authenticated, anon, service_role;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create table tenants(id uuid primary key);
    create table tenant_memberships(tenant_id uuid,user_id uuid,role text,is_active boolean);
    create table venues(id uuid primary key,tenant_id uuid,timezone text);
    create table devices(id uuid primary key,tenant_id uuid,venue_id uuid,is_active boolean default true,can_take_payments boolean default true);
    create table cash_registers(id uuid primary key,tenant_id uuid,venue_id uuid,is_active boolean default true);
    create table tickets(id uuid primary key);
    create table sales(id uuid primary key,tenant_id uuid,local_created_at timestamptz);
    create function user_is_superadmin() returns boolean language sql stable as $$ select auth.uid()='${admin}'::uuid $$;
    create function user_is_tenant_admin(uuid) returns boolean language sql stable as $$ select auth.uid()='${user}'::uuid and $1='${tenant}'::uuid $$;
    create function user_has_venue_access(uuid,uuid) returns boolean language sql stable as $$ select public.user_is_tenant_admin($1) and $2='${venue}'::uuid $$;
    create function user_has_device_access(uuid,uuid,uuid) returns boolean language sql stable as $$ select public.user_has_venue_access($1,$2) and $3='${device}'::uuid $$;
    insert into tenants values('${tenant}');
    insert into venues values('${venue}','${tenant}','Europe/Madrid');
    insert into devices values('${device}','${tenant}','${venue}',true,true);
    insert into cash_registers values('${register}','${tenant}','${venue}',true);
    insert into auth.users values('${user}'),('${admin}');
    insert into tenant_memberships values('${tenant}','${user}','owner',true);
    select set_config('test.uid','${user}',false);
  `)
  for (const name of [
    '20260928120000_prepare_local_verifactu_scope', '20260929190000_simplify_sif_series_identity',
    '20261002191101_pwa_fiscal_installation_identity', '20260928160000_fiscal_pos_bridge_settings',
    '20260929150000_allow_local_fiscal_without_bridge', '20260929180000_add_aeat_environment_setting',
    '20261003140000_add_ticket_qr_print_setting', '20261010184559_bridge_installation_provisioning',
    '20261011183718_verifactu_activation_requests', '20261011191816_preserve_ticket_installations_without_verifactu',
  ]) for (const part of migration(name).split(/(create (?:unique )?index concurrently[^;]+;)/i)) if (part.trim()) await db.exec(part)
  await db.exec(fix)
  await db.query('select save_fiscal_pwa_setup($1,$2,$3,$4)', [tenant, 'Bar SL', 'B12345678', [{ venueId: venue, venueCode: 'NIC' }]])
  const activate = async (request = crypto.randomUUID(), expected = null, recover = false) => (await db.query('select activate_pwa_fiscal_installation($1,$2,$3,$4,$5,$6,$7) as id', [tenant, venue, register, device, request, expected, recover])).rows[0].id
  const local = await activate()
  await db.query('select request_verifactu_activation($1)', [tenant])
  await db.query("select set_config('test.uid',$1,false)", [admin])
  await db.query('select configure_verifactu_integration($1,$2,$3,$4,$5,$6,true)', [tenant, 'https://bridge.example/', 'Productor SL', 'B12345678', 'TK', '1.0'])
  await db.query("select set_config('test.uid',$1,false)", [user])
  const activationRequest = crypto.randomUUID()
  const id = await activate(activationRequest)
  const installation = (await db.query('select * from fiscal_sif_installations where id=$1', [id])).rows[0]
  const boundary = new Date(Date.now() - 500).toISOString()
  const insertRecord = async (position, when) => db.query(`insert into fiscal_local_records(id,tenant_id,fiscal_subject_id,installation_id,venue_id,cash_register_id,invoice_id,record_kind,chain_position,hash,canonical_schema,canonical_record,record_envelope,invoice_snapshot,generated_at,idempotency_key)
    values($1,$2,$3,$4,$5,$6,$1,'alta',$7,$8,'aeat-registro-v1',$9,'{}','{}',$10,$11)`,
    [crypto.randomUUID(), tenant, installation.fiscal_subject_id, id, venue, register, position, 'A'.repeat(64), { RegistroAlta: { TipoFactura: 'F2', SistemaInformatico: { NumeroInstalacion: installation.installation_number }, FechaHoraHusoGenRegistro: when } }, when, crypto.randomUUID()])
  await insertRecord(1, new Date(Date.parse(boundary) - 10000).toISOString())
  const original = (await db.query('select * from fiscal_local_records')).rows
  const revoke = (installationId = id, deviceId = device, url = 'https://bridge.example/', reason = 'Cambio de caja') => db.query('select fiscal_bridge_revoke_installation($1,$2,$3,$4,$5) as result', [installationId, deviceId, url, reason, boundary])
  await db.exec('set role authenticated')
  await assert.rejects(revoke(), /permission denied/)
  await db.exec('set role anon')
  await assert.rejects(revoke(), /permission denied/)
  await db.exec('set role service_role')
  for (const args of [[local], [id, uuid(99)], [id, device, 'https://wrong.example/']]) await assert.rejects(revoke(...args), /FISCAL_BRIDGE_REVOCATION_FORBIDDEN/)
  const result = (await revoke()).rows[0].result
  assert.equal(result.installationId, id)
  assert.equal(Date.parse(result.revokedAt), Date.parse(boundary))
  assert.deepEqual((await revoke(id, device, 'https://bridge.example/', 'Otro motivo')).rows[0].result, result)
  await db.exec('reset role')
  const retired = (await db.query('select * from fiscal_sif_installations where id=$1', [id])).rows[0]
  assert.equal(new Date(retired.retired_at).getTime(), Date.parse(boundary))
  assert.equal(retired.bridge_revocation_reason, 'Cambio de caja')
  assert.deepEqual((await db.query('select * from fiscal_local_records')).rows, original)
  assert.equal((await db.query('select is_active from devices where id=$1', [device])).rows[0].is_active, true, 'the terminal can own a subsequent installation')
  await insertRecord(2, new Date(Date.parse(boundary) - 5000).toISOString())
  await assert.rejects(insertRecord(3, boundary), /FISCAL_INSTALLATION_RETIRED/)
  await assert.rejects(activate(activationRequest), /ALREADY_RETIRED/)
  await assert.rejects(activate(crypto.randomUUID(), null, true), /TEST_RECOVERY_FORBIDDEN/)
  await db.exec('set role authenticated')
  const status = params => db.query('select pos_fiscal_installation_revocation($1,$2,$3,$4,$5) as value', params)
  assert.deepEqual((await status([tenant, venue, register, device, id])).rows[0].value, result)
  assert.equal((await status([uuid(99), venue, register, device, id])).rows[0].value, null)
  assert.equal((await status([tenant, venue, register, uuid(99), id])).rows[0].value, null)
  await db.exec('reset role')
  const next = await activate()
  assert.notEqual(next, id)
  const replacement = (await db.query('select * from fiscal_sif_installations where id=$1', [next])).rows[0]
  assert.equal(replacement.installation_sequence, installation.installation_sequence + 1)
  assert.equal(replacement.bridge_requested, true)
  assert.equal(replacement.bridge_revoked_at, null)
  assert.ok((await db.query('select 1 from fiscal_bridge_requests where installation_id=$1', [next])).rows.length)
})
