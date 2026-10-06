import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {PGlite} from '@electric-sql/pglite'
import {analyzeMigration} from '../scripts/check-migrations.mjs'

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8')
const migration=read('../supabase/migrations/20261005225011_tickit_assist.sql')
const tenant='11111111-1111-4111-8111-111111111111',venue='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333',owner='44444444-4444-4444-8444-444444444444',manager='55555555-5555-4555-8555-555555555555',cashier='66666666-6666-4666-8666-666666666666'

test('Assist migration is an additive safe-production migration',()=>assert.deepEqual(analyzeMigration(migration),[]))
async function database(t){
  const db=new PGlite();t.after(()=>db.close())
  await db.exec(read('./helpers/pos-read-snapshot-fixture.sql'))
  await db.exec(`
    create role service_role; create table auth.users(id uuid primary key);
    create table tenants(id uuid primary key,name text,slug text,max_venues integer,max_devices integer,is_active boolean default true,updated_at timestamptz);
    alter table venues add constraint venues_scope_unique unique(id,tenant_id);
    alter table venues add column is_active boolean default true;
    create table devices(id uuid,tenant_id uuid,is_active boolean);
    create table platform_features(key text primary key,name text,description text,is_core boolean,is_active boolean,enabled_by_default boolean,sort_order integer);
    create table tenant_feature_assignments(tenant_id uuid,feature_key text,primary key(tenant_id,feature_key));
    create table tenant_memberships(tenant_id uuid,user_id uuid,role text,is_active boolean);
    create table manager_venue_assignments(tenant_id uuid,venue_id uuid,manager_user_id uuid);
    create table device_user_assignments(tenant_id uuid,venue_id uuid,user_id uuid);
    create function user_has_venue_access(uuid,uuid) returns boolean language sql security definer as $$select exists(select 1 from public.device_user_assignments where tenant_id=$1 and venue_id=$2 and user_id=auth.uid())$$;
    create function user_is_tenant_admin(uuid) returns boolean language sql security definer as $$select exists(select 1 from public.tenant_memberships where tenant_id=$1 and user_id=auth.uid() and role in ('owner','manager') and is_active)$$;
    create function tenant_addon_enabled(uuid,text) returns boolean language sql security definer as $$select exists(select 1 from public.tenant_feature_assignments where tenant_id=$1 and feature_key=$2)$$;
    alter table production_line_allocations add column quantity numeric;
    alter table production_line_allocations add column cancelled_quantity numeric;
    alter table production_line_allocations add column created_at timestamptz;
    alter table production_line_allocations add column updated_at timestamptz;
    alter table production_line_allocations add column batch_id uuid;
    create table production_batches(id uuid,created_at timestamptz);
    grant usage on schema auth to authenticated; grant select,update on venues to authenticated;
    grant select on orders,order_lines,dining_areas,restaurant_tables,order_tables,restaurant_order_equal_splits,reservations,reservation_tables,production_line_allocations,production_batches,cash_sessions to authenticated;
    insert into tenants(id,name,slug,max_venues,max_devices) values('${tenant}','Tenant','tenant',5,5),('${other}','Other','other',5,5);
    insert into venues(id,tenant_id,timezone) values('${venue}','${tenant}','Europe/Madrid'),('${other}','${tenant}','Europe/Madrid');
    insert into auth.users values('${owner}'),('${manager}'),('${cashier}');
    insert into tenant_memberships values('${tenant}','${owner}','owner',true),('${tenant}','${manager}','manager',true),('${tenant}','${cashier}','cashier',true);
    insert into manager_venue_assignments values('${tenant}','${venue}','${manager}');
    insert into device_user_assignments values('${tenant}','${venue}','${cashier}');
  `)
  await db.exec(migration)
  // Match production's trusted-only tenant configuration RPC.
  await db.exec(`revoke all on function update_platform_tenant_config(uuid,text,text,integer,integer,text[]) from public,authenticated,anon;grant execute on function update_platform_tenant_config(uuid,text,text,integer,integer,text[]) to service_role;`)
  return db
}
const login=(db,user)=>db.exec(`reset role;set role authenticated;set test.uid='${user}';`)
const event=()=>({key:'unattended_table:group',kind:'unattended_table',entityId:'group',severity:'ATTENTION',startedAt:new Date().toISOString(),endedAt:null,state:'active',metrics:{minutes:15},expiresAt:new Date(Date.now()+86400000).toISOString()})
const record=(db,events)=>db.query('select record_tickit_assist_events($1,$2,$3::jsonb)',[tenant,venue,JSON.stringify(events)])

test('activation defaults, scoped config permissions, persistence RLS and remote disable',async t=>{
  const db=await database(t)
  const config=async()=> (await db.query('select tickit_assist_enabled($1,$2) as enabled',[tenant,venue])).rows[0].enabled
  await login(db,owner);assert.equal(await config(),false)
  await assert.rejects(db.query('select set_tickit_assist_venue($1,true,$2)',[venue,'normal']),/ASSIST_CONFIG_FORBIDDEN/)
  await db.exec(`reset role;insert into tenant_feature_assignments values('${tenant}','tickit_assist');`)
  await login(db,manager);assert.equal(await config(),false)
  await db.query('select set_tickit_assist_venue($1,true,$2)',[venue,'high'])
  assert.equal(await config(),true)
  await assert.rejects(db.query('select set_tickit_assist_venue($1,true,$2)',[other,'normal']),/ASSIST_CONFIG_FORBIDDEN/)
  await assert.rejects(db.query('update venues set tickit_assist_enabled=true where id=$1',[other]),/ASSIST_CONFIG_FORBIDDEN/)
  await assert.rejects(db.query('select update_platform_tenant_config($1,$2,$3,5,5,$4)',[tenant,'Tenant','tenant',['tickit_assist']]),/permission denied/)
  await login(db,cashier)
  await assert.rejects(db.query('select set_tickit_assist_venue($1,false,$2)',[venue,'normal']),/ASSIST_CONFIG_FORBIDDEN/)
  const e=event();await record(db,[e]);await record(db,[e]);await record(db,[{...e,feedback:'not_a_problem'}])
  assert.equal((await db.query('select * from tickit_assist_situations')).rows.length,1)
  assert.equal((await db.query('select * from tickit_assist_feedback')).rows.length,1)
  await record(db,[{...e,state:'resolved',endedAt:new Date().toISOString(),feedback:'not_a_problem'}])
  assert.ok((await db.query('select ended_at from tickit_assist_situations')).rows[0].ended_at)
  await db.exec(`reset role;delete from tenant_feature_assignments;`)
  await login(db,cashier);assert.equal(await config(),false)
  assert.equal((await db.query('select * from tickit_assist_situations')).rows.length,0)
  await assert.rejects(record(db,[event()]),/ASSIST_DISABLED/)
  await db.exec(`reset role;insert into tenant_feature_assignments values('${tenant}','tickit_assist');`)
  await login(db,cashier);assert.equal(await config(),true)
  await login(db,owner);await db.query('select set_tickit_assist_venue($1,false,$2)',[venue,'normal']);assert.equal(await config(),false)
  await assert.rejects(record(db,[event()]),/ASSIST_DISABLED/)
  await db.exec('reset role;set role anon')
  await assert.rejects(record(db,[event()]),/permission denied/)
})

test('map piggybacks configuration without history queries and gates operational allocation fields',async t=>{
  const db=await database(t)
  await login(db,owner)
  const load=async()=> (await db.query('select pos_restaurant_map($1,$2) as snapshot',[tenant,venue])).rows[0].snapshot
  const disabled=await load();assert.equal(disabled.assistConfiguration.tenantEnabled,false);assert.equal(disabled.assistConfiguration.venueEnabled,false)
  await db.exec(`reset role;insert into tenant_feature_assignments values('${tenant}','tickit_assist');`)
  await login(db,owner);await db.query('select set_tickit_assist_venue($1,true,$2)',[venue,'low'])
  const enabled=await load();assert.equal(enabled.assistConfiguration.tenantEnabled,true);assert.equal(enabled.assistConfiguration.venueEnabled,true);assert.equal(enabled.assistConfiguration.sensitivity,'low')
  assert.ok(enabled.observedAt);assert.deepEqual(enabled.orders,[])
  await db.exec(`reset role;insert into orders(id,tenant_id,venue_id,status) select gen_random_uuid(),'${tenant}','${venue}','paid' from generate_series(1,10000);`)
  await login(db,owner)
  const withHistory=await load();assert.deepEqual(withHistory.orders,enabled.orders);assert.deepEqual(withHistory.lines,enabled.lines);assert.deepEqual(withHistory.allocations,enabled.allocations)
})

test('N-1 tenant updates preserve Assist, new clients can explicitly disable it',async t=>{
  const db=await database(t)
  await db.exec(`insert into tenant_feature_assignments values('${tenant}','tickit_assist');set role service_role;`)
  const update=keys=>db.query('select update_platform_tenant_config($1,$2,$3,5,5,$4)',[tenant,'Tenant','tenant',keys])
  await update(['__addon_catalog_v2'])
  await db.exec('reset role')
  assert.equal((await db.query("select * from tenant_feature_assignments where feature_key='tickit_assist'")).rows.length,1)
  await db.exec('set role service_role');await update(['__addon_catalog_v2','__assist_catalog_v1']);await db.exec('reset role')
  assert.equal((await db.query("select * from tenant_feature_assignments where feature_key='tickit_assist'")).rows.length,0)
})
