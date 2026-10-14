import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { fiscalSeries } from '../src/features/fiscal/local/fiscalPolicy.ts'

const sql = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const correction = sql('20261011191816_preserve_ticket_installations_without_verifactu.sql')
const tenant = '11111111-1111-4111-8111-111111111111'
const venue = '22222222-2222-4222-8222-222222222222'
const device = '33333333-3333-4333-8333-333333333333'
const register = '44444444-4444-4444-8444-444444444444'
const owner = '55555555-5555-4555-8555-555555555555'
const admin = '66666666-6666-4666-8666-666666666666'
const other = '77777777-7777-4777-8777-777777777777'

test('local numbering correction passes the production migration checker', () => {
  assert.deepEqual(analyzeMigration(correction), [])
})

async function database(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create table tenants(id uuid primary key);
    create table tenant_memberships(tenant_id uuid,user_id uuid,role text,is_active boolean);
    create table venues(id uuid primary key,tenant_id uuid,timezone text);
    create table devices(id uuid primary key,tenant_id uuid,venue_id uuid,is_active boolean default true,can_take_payments boolean default true);
    create table cash_registers(id uuid primary key,tenant_id uuid,venue_id uuid,is_active boolean default true);
    create table tickets(id uuid primary key);
    create table sales(id uuid primary key,tenant_id uuid,local_created_at timestamptz not null);
    create function user_is_superadmin() returns boolean language sql stable as $$ select auth.uid()='${admin}'::uuid $$;
    create function user_is_tenant_admin(uuid) returns boolean language sql stable as $$ select exists(select 1 from public.tenant_memberships where tenant_id=$1 and user_id=auth.uid() and is_active and role='owner') $$;
    create function user_has_venue_access(uuid,uuid) returns boolean language sql stable as $$ select public.user_is_tenant_admin($1) $$;
    create function user_has_device_access(uuid,uuid,uuid) returns boolean language sql stable as $$ select public.user_is_tenant_admin($1) and exists(select 1 from public.devices where id=$3 and tenant_id=$1 and venue_id=$2 and is_active) $$;
    insert into tenants values('${tenant}'),('${other}');
    insert into venues values('${venue}','${tenant}','Europe/Madrid');
    insert into devices values('${device}','${tenant}','${venue}');
    insert into cash_registers values('${register}','${tenant}','${venue}');
    insert into auth.users values('${owner}'),('${admin}');
    insert into tenant_memberships values('${tenant}','${owner}','owner',true),('${other}','${owner}','owner',true);
    select set_config('test.uid','${owner}',false);
  `)
  for (const name of [
    '20260928120000_prepare_local_verifactu_scope.sql',
    '20260929190000_simplify_sif_series_identity.sql',
    '20261002191101_pwa_fiscal_installation_identity.sql',
    '20260928160000_fiscal_pos_bridge_settings.sql',
    '20260929150000_allow_local_fiscal_without_bridge.sql',
    '20260929180000_add_aeat_environment_setting.sql',
    '20261003140000_add_ticket_qr_print_setting.sql',
    '20261010184559_bridge_installation_provisioning.sql',
    '20261011183718_verifactu_activation_requests.sql',
  ]) {
    // Existing concurrent index statements must run separately in PGlite.
    for (const part of sql(name).split(/(create (?:unique )?index concurrently[^;]+;)/i)) if (part.trim()) await db.exec(part)
  }
  await db.exec(correction)
  await db.query('select save_fiscal_pwa_setup($1,$2,$3,$4)',[tenant,'Bar SL','B12345678',JSON.stringify([{venueId:venue,venueCode:'DIS'}])])
  await db.exec('create trigger fiscal_local_sale_required before insert on sales for each row execute function fiscal_local_require_sale_record()')
  return db
}

const activate = async (db, {tenantId=tenant,venueId=venue,registerId=register,deviceId=device,request=crypto.randomUUID(),expected=null}={}) =>
  (await db.query('select activate_pwa_fiscal_installation($1,$2,$3,$4,$5,$6,false) as id',[tenantId,venueId,registerId,deviceId,request,expected])).rows[0].id
const configure = (db, active, url='https://bridge.example/') => db.query('select configure_verifactu_integration($1,$2,$3,$4,$5,$6,$7) as value',[tenant,url,'Productor SL','B12345678','TK','1.0',active])

test('local boxes retain installation sequences; activation retires every tenant identity and only new identities enter the bridge', async t => {
  const db = await database(t)
  const first = await activate(db)
  const firstRow = (await db.query('select * from fiscal_sif_installations where id=$1',[first])).rows[0]
  assert.equal(firstRow.installation_number,'DIS-C1-1')
  assert.equal(firstRow.bridge_requested,false)
  assert.equal(fiscalSeries({venueCode:'DIS',registerCode:'C1',installationSequence:1,exercise:2026,kind:'simplified'}),'DIS-C1-1-2026-S')
  assert.equal((await db.query('select * from fiscal_bridge_requests')).rows.length,0)
  assert.equal((await db.query('select bridge_url from fiscal_pos_bridge_settings where tenant_id=$1',[tenant])).rows[0].bridge_url,null)
  const secondVenue=crypto.randomUUID(), secondRegister=crypto.randomUUID(), secondDevice=crypto.randomUUID()
  const otherVenue=crypto.randomUUID(), otherRegister=crypto.randomUUID(), otherDevice=crypto.randomUUID()
  for (const [tenantId,venueId,registerId,deviceId] of [[tenant,secondVenue,secondRegister,secondDevice],[other,otherVenue,otherRegister,otherDevice]]) {
    await db.query('insert into venues values($1,$2,$3,null)',[venueId,tenantId,'Europe/Madrid'])
    await db.query('insert into devices values($1,$2,$3,true,true)',[deviceId,tenantId,venueId])
    await db.query('insert into cash_registers(id,tenant_id,venue_id) values($1,$2,$3)',[registerId,tenantId,venueId])
    await db.query('select save_fiscal_pwa_setup($1,$2,$3,$4)',[tenantId,'Bar SL','B12345678',JSON.stringify([{venueId,venueCode:'OTR'}])])
  }
  const second=await activate(db,{venueId:secondVenue,registerId:secondRegister,deviceId:secondDevice})
  const unrelated=await activate(db,{tenantId:other,venueId:otherVenue,registerId:otherRegister,deviceId:otherDevice})
  await db.query('select request_verifactu_activation($1)',[tenant])
  await db.query("select set_config('test.uid',$1,false)",[admin])
  await configure(db,false)
  assert.equal((await db.query('select fiscal_bridge_pending($1) as value',['https://bridge.example/'])).rows[0].value.length,0)
  await assert.rejects(configure(db,true,''),/URL/)
  assert.equal((await db.query('select count(*)::integer as n from fiscal_sif_installations where tenant_id=$1 and retired_at is null',[tenant])).rows[0].n,2)
  const enabled=(await configure(db,true)).rows[0].value
  const retired=(await db.query('select id,retired_at,retired_for_verifactu_at from fiscal_sif_installations where tenant_id=$1',[tenant])).rows
  assert.equal(retired.length,2)
  for(const row of retired) assert.equal(new Date(row.retired_at).getTime(),new Date(enabled.enabled_at).getTime())
  assert.equal((await db.query('select retired_at from fiscal_sif_installations where id=$1',[unrelated])).rows[0].retired_at,null)
  await db.query("select set_config('test.uid',$1,false)",[owner])
  assert.equal((await db.query('select pos_verifactu_retired_identity($1,$2,$3,$4,$5) as value',[tenant,venue,register,device,first])).rows[0].value,true)
  assert.equal((await db.query('select pos_verifactu_retired_identity($1,$2,$3,$4,$5) as value',[other,venue,register,device,first])).rows[0].value,false)
  assert.equal((await db.query('select pos_verifactu_retired_identity($1,$2,$3,$4,$5) as value',[tenant,venue,register,secondDevice,first])).rows[0].value,false)
  const retryId=crypto.randomUUID()
  const next=await activate(db,{request:retryId})
  assert.equal(await activate(db,{request:retryId}),next)
  const nextRow=(await db.query('select * from fiscal_sif_installations where id=$1',[next])).rows[0]
  assert.equal(nextRow.installation_number,'DIS-C1-2')
  assert.equal(nextRow.bridge_requested,true)
  await assert.rejects(db.query('update fiscal_sif_installations set bridge_requested=false where id=$1',[next]),/IMMUTABLE/)
  await db.query("select set_config('test.uid',$1,false)",[admin])
  assert.equal((await configure(db,true)).rows[0].value.enabled_at,enabled.enabled_at)
  assert.equal((await db.query('select retired_at from fiscal_sif_installations where id=$1',[next])).rows[0].retired_at,null,'repeated activation must not retire the replacement')
  const queued=(await db.query('select fiscal_bridge_pending($1) as value',['https://bridge.example/'])).rows[0].value
  assert.deepEqual(queued.map(row=>row.installation.id),[next])
  assert.equal((await db.query('select count(*)::integer as n from fiscal_sif_installations where id=any($1::uuid[])',[[first,second,unrelated]])).rows[0].n,3,'history survives retirement')
})

test('local record guard preserves old offline sales and rejects new unnumbered sales before or after Verifactu activation', async t => {
  const db=await database(t)
  await activate(db)
  await db.query('insert into sales values($1,$2,$3)',[crypto.randomUUID(),tenant,'2020-01-01T00:00:00Z'])
  await assert.rejects(db.query('insert into sales values($1,$2,$3)',[crypto.randomUUID(),tenant,'2100-01-01T00:00:00Z']),/LOCAL_FISCAL_RECORD_REQUIRED/)
  await db.exec("begin; select set_config('app.local_fiscal_sale','yes',true);")
  await db.query('insert into sales values($1,$2,$3)',[crypto.randomUUID(),tenant,'2100-01-01T00:00:00Z'])
  await db.exec('commit')
  assert.equal((await db.query('select count(*)::integer as n from sales')).rows[0].n,2)
})
