import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const migration = read('../supabase/migrations/20261003195724_reduce_pos_request_redundancy.sql')
const tenant='11111111-1111-4111-8111-111111111111', venue='22222222-2222-4222-8222-222222222222', other='33333333-3333-4333-8333-333333333333'

test('grouped read RPC migration retains N-1 and satisfies deployment safety',()=>assert.deepEqual(analyzeMigration(migration),[]))

async function database(t) {
  const db=new PGlite(); t.after(()=>db.close())
  await db.exec(read('./helpers/pos-read-snapshot-fixture.sql'))
  const tables=(await db.query("select tablename from pg_tables where schemaname='public'")).rows
  for (const {tablename} of tables) {
    await db.exec(`alter table ${tablename} enable row level security; create policy tenant_scope on ${tablename} to authenticated using(tenant_id='${tenant}'); grant select on ${tablename} to authenticated;`)
  }
  await db.exec(`grant usage on schema auth to authenticated; insert into venues values('${venue}','${tenant}','Europe/Madrid'),('${other}','${other}','Europe/Madrid');`)
  await db.exec(migration)
  return db
}

test('map snapshot preserves tenant RLS, session scope and anonymous denial',async t=>{
  const db=await database(t)
  await db.exec(`insert into dining_areas(id,tenant_id,venue_id,is_active,sort_order) values('${tenant}','${tenant}','${venue}',true,1),('${other}','${other}','${other}',true,1); set role authenticated; set test.uid='${tenant}';`)
  const row=(await db.query('select pos_restaurant_map($1,$2) as snapshot',[tenant,venue])).rows[0].snapshot
  assert.equal(row.areas.length,1); assert.equal(row.layout,null)
  await assert.rejects(db.query('select pos_restaurant_map($1,$2)',[other,other]),/VENUE_NOT_AVAILABLE/)
  await assert.rejects(db.query('select pos_restaurant_map($1,$2,$3)',[tenant,venue,other]),/SESSION_NOT_AVAILABLE/)
  await db.exec('reset role; set role anon')
  await assert.rejects(db.query('select pos_restaurant_map($1,$2)',[tenant,venue]),/permission denied/)
})

test('order snapshot excludes another tenant and venue',async t=>{
  const db=await database(t)
  await db.exec(`insert into orders(id,tenant_id,venue_id,order_group_id) values('${tenant}','${tenant}','${venue}','${tenant}'),('${other}','${other}','${other}','${other}'); set role authenticated; set test.uid='${tenant}';`)
  const snapshot=(await db.query('select pos_restaurant_order($1,$2,$3) as snapshot',[tenant,venue,tenant])).rows[0].snapshot
  assert.equal(snapshot.order.id,tenant); assert.deepEqual(snapshot.lines,[])
  assert.equal((await db.query('select pos_restaurant_order($1,$2,$3) as snapshot',[other,other,other])).rows[0].snapshot,null)
  assert.equal((await db.query('select pos_restaurant_order($1,$2,$3) as snapshot',[tenant,other,tenant])).rows[0].snapshot,null)
})

test('fiscal snapshot still rejects retired or mismatched installation and returns latest head',async t=>{
  const db=await database(t)
  await db.exec(`insert into fiscal_subjects values('${tenant}','${tenant}','Emisor','89890001K'); insert into fiscal_pos_bridge_settings values('${tenant}'); insert into fiscal_sif_installations values('${tenant}','${tenant}','${venue}','${tenant}','${tenant}','${tenant}',null); insert into fiscal_local_records values('${tenant}','${tenant}','${tenant}','${tenant}',1),('${venue}','${tenant}','${tenant}','${tenant}',2); set role authenticated; set test.uid='${tenant}';`)
  const args=[tenant,venue,tenant,tenant,tenant]
  const load=async values=>(await db.query('select pos_fiscal_preparation($1,$2,$3,$4,$5) as snapshot',values)).rows[0].snapshot
  assert.equal((await load(args)).head.chain_position,2)
  assert.equal(await load([tenant,venue,tenant,other,tenant]),null)
  await db.exec(`reset role; update fiscal_sif_installations set retired_at=now(); set role authenticated;`)
  assert.equal(await load(args),null)
})
