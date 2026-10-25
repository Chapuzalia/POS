import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { venueRestaurantDb, ids, uuid } from './helpers/venue-restaurant-db.mjs'

const migration = readFileSync(new URL('../supabase/migrations/20261025005554_restore_venue_table_layout.sql', import.meta.url), 'utf8')
async function fixture(t) {
  const h = await venueRestaurantDb()
  t.after(() => h.db.close())
  await h.db.exec(migration)
  const layout = async () => (await h.query('select get_venue_table_layout($1) as result', [ids.venue]))[0].result
  const save = async tables => {
    const current = await layout()
    return (await h.query('select save_venue_table_layout($1,$2,$3) as result', [ids.venue, current.revision, tables]))[0].result
  }
  const restore = async revision => (await h.query('select restore_venue_table_layout($1,$2) as result', [ids.venue, revision ?? (await layout()).revision]))[0].result
  return { ...h, layout, save, restore }
}

test('restore migration keeps the supported deployment contract', () => {
  assert.deepEqual(analyzeMigration(migration), [])
})

test('restore recovers permanent CRM positions across rooms while preserving temporary tables and open orders', async t => {
  const h = await fixture(t)
  const orderId = await h.open()
  await h.addLines(orderId)
  const secondArea = uuid(90), secondTable = uuid(91)
  await h.query('insert into dining_areas(id,tenant_id,venue_id,name) values($1,$2,$3,$4)', [secondArea, ids.tenant, ids.venue, 'Terraza'])
  await h.query('insert into restaurant_tables(id,tenant_id,venue_id,area_id,name,position_x,position_y,width,height) values($1,$2,$3,$4,$5,20,20,12,12)', [secondTable, ids.tenant, ids.venue, secondArea, 'Mesa 2'])
  const virtual = (await h.query("select create_virtual_restaurant_table($1,$2,null,'Temporal',2,'square') as id", [ids.sessionA, ids.deviceA]))[0].id
  const current = await h.layout()
  await h.save({ ...current.tables, [ids.table]: { positionX: 50, positionY: 30, groupId: null }, [secondTable]: { positionX: 60, positionY: 60, groupId: null }, [virtual]: { positionX: 55, positionY: 40, groupId: null } })
  const before = await h.query('select * from orders where id=$1', [orderId])
  const revision = (await h.layout()).revision
  const result = await h.restore(revision)
  assert.deepEqual(result.tables[ids.table], { positionX: 10, positionY: 10, groupId: null })
  assert.deepEqual(result.tables[secondTable], { positionX: 20, positionY: 20, groupId: null })
  assert.deepEqual(result.tables[virtual], { positionX: 55, positionY: 40, groupId: null })
  assert.equal(result.revision, revision + 1)
  assert.deepEqual(await h.query('select * from orders where id=$1', [orderId]), before)
  assert.equal((await h.query('select count(*)::integer as n from order_lines where order_id=$1', [orderId]))[0].n, 1)
  const otherCheckout = (await h.query('select get_cash_session_table_layout($1) as result', [ids.sessionB]))[0].result
  assert.deepEqual(otherCheckout.tables, result.tables)
})

test('restore rejects joined layouts and leaves the revision untouched', async t => {
  const h = await fixture(t)
  const second = uuid(92)
  await h.query('insert into restaurant_tables(id,tenant_id,venue_id,area_id,name,position_x,position_y,width,height) values($1,$2,$3,$4,$5,22,10,12,12)', [second, ids.tenant, ids.venue, ids.area, 'Mesa 2'])
  const current = await h.layout()
  const joined = await h.save({ ...current.tables, [ids.table]: { positionX: 10, positionY: 10, groupId: 'joined' }, [second]: { positionX: 22, positionY: 10, groupId: 'joined' } })
  await assert.rejects(h.restore(), /Separa todas las mesas juntadas/)
  assert.deepEqual(await h.layout(), joined)
  await h.save({ ...joined.tables, [ids.table]: { positionX: 50, positionY: 20, groupId: null }, [second]: { positionX: 22, positionY: 10, groupId: null } })
  assert.equal((await h.restore()).tables[ids.table].positionX, 10)
})

test('restore refuses an active bill linked to multiple tables even without a visual composition', async t => {
  const h = await fixture(t)
  const second = uuid(93)
  await h.query('insert into restaurant_tables(id,tenant_id,venue_id,area_id,name,position_x,position_y,width,height) values($1,$2,$3,$4,$5,40,10,12,12)', [second, ids.tenant, ids.venue, ids.area, 'Mesa 2'])
  await h.query('select open_restaurant_order($1::uuid[],2,$2,$3)', [[ids.table, second], ids.sessionA, ids.deviceA])
  assert.ok(Object.values((await h.layout()).tables).every(entry => entry.groupId === null))
  await assert.rejects(h.restore(), /Separa todas las mesas juntadas/)
})

test('stale or missing revisions cannot overwrite changes made by another checkout', async t => {
  const h = await fixture(t)
  const initial = await h.layout()
  await h.save({ ...initial.tables, [ids.table]: { positionX: 55, positionY: 25, groupId: null } })
  await assert.rejects(h.restore(initial.revision), /distribución ha cambiado/)
  await assert.rejects(h.query('select restore_venue_table_layout($1,null)', [ids.venue]), /distribución ha cambiado/)
  assert.equal((await h.layout()).tables[ids.table].positionX, 55)
})

test('authenticated callers restore through the existing writer without layout update grants; foreign venues and anonymous calls fail', async t => {
  const h = await fixture(t)
  const current = await h.layout()
  await h.save({ ...current.tables, [ids.table]: { positionX: 45, positionY: 30, groupId: null } })
  // Mirror the deployed read grants; the new RPC itself has invoker privileges.
  await h.db.exec('grant select on restaurant_tables,venues,order_tables,orders to authenticated; set role authenticated;')
  assert.equal((await h.query("select has_table_privilege(current_user,'venue_table_layouts','UPDATE') as allowed"))[0].allowed, false)
  assert.equal((await h.restore()).tables[ids.table].positionX, 10)
  await assert.rejects(h.query('select restore_venue_table_layout($1,1)', [ids.otherVenue]), /Local no disponible/)
  await h.db.exec('reset role; set role anon;')
  await assert.rejects(h.query('select restore_venue_table_layout($1,1)', [ids.venue]), /permission denied/)
})
