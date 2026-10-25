import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { createProductionDatabase, readProductionSql, uuid, tenant, venue, pos, kds, destination, pass, order, line, product, user } from './helpers/production-db.mjs'

const migration = readProductionSql('20261017125631_production_kds_columns_lifecycle')
test('KDS columns lifecycle is a safe additive migration', () => assert.deepEqual(analyzeMigration(migration), []))

async function setup(t) {
  const db = await createProductionDatabase(t)
  // Exercise the deployed ready RPCs, rather than replacing them with test code.
  const decimalSql = readProductionSql('20260916130100_decimal_order_production_quantities')
  for (const name of ['next_quantity_step', 'mark_production_item_ready', 'mark_production_item_quantity_ready']) {
    const routine = decimalSql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))
    assert.ok(routine, name)
    await db.exec(routine[0])
  }
  await db.exec(migration)
  const state = async () => (await db.query('select get_order_production_state($1) value', [order])).rows[0].value
  const queue = async (device = kds) => (await db.query('select get_kds_workflow_queue($1) value', [device])).rows[0].value
  const send = async (request, selection = null) => (await db.query('select send_production_batch($1,1,$2,$3,$4) value', [order, pos, request, selection])).rows[0].value
  const accept = async (batch, device = kds) => db.query('select accept_production_batch($1,$2)', [device, batch])
  const ready = async (item, quantity) => db.query('select mark_production_item_quantity_ready($1,$2,$3)', [item, quantity, kds])
  return { db, state, queue, send, accept, ready }
}

test('sent -> accepted -> partly ready -> completed -> served; later sends remain independent and FIFO', async t => {
  const { db, state, queue, send, accept, ready } = await setup(t)
  const secondLine = uuid(11)
  await db.exec(`update order_lines set quantity=2,served_quantity=0 where id='${line}';
    insert into order_lines(id,tenant_id,venue_id,order_id,product_id,product_name,quantity,served_quantity) values('${secondLine}','${tenant}','${venue}','${order}','${product}','Bravas',1.5,0);
    insert into order_line_production_passes(tenant_id,venue_id,order_line_id,component_id,pass_id,pass_name) values('${tenant}','${venue}','${secondLine}','','${pass}','Directo');`)
  const first = await send('first')
  let items = (await queue()).items
  assert.equal(items.length, 2)
  assert.ok(items.every(item => item.acceptedAt === null && item.readyQuantity === 0 && item.servedQuantity === 0))
  assert.ok((await state()).lines.every(line => line.preparingQuantity === 0 && line.readyQuantity === 0 && line.unsentQuantity === 0))
  await accept(first.batchId)
  const acceptedAt = (await queue()).items[0].acceptedAt
  await accept(first.batchId)
  assert.equal((await queue()).items[0].acceptedAt, acceptedAt, 'repeat acceptance is idempotent')
  assert.deepEqual((await state()).lines.map(line => line.preparingQuantity).sort(), [1.5, 2])
  const burger = items.find(item => item.snapshot.productName === 'Absolut')
  const side = items.find(item => item.snapshot.productName === 'Bravas')
  await ready(burger.id, 2)
  items = (await queue()).items
  assert.equal(items.length, 2, 'ready rows remain in the same in-progress card')
  assert.equal(items.find(item => item.id === burger.id).readyQuantity, 2)
  assert.equal((await state()).lines.find(row => row.lineId === line).readyQuantity, 2)
  assert.equal((await state()).lines.find(row => row.lineId === line).preparingQuantity, 0)
  await ready(side.id, 1.5)
  assert.ok((await queue()).items.every(item => item.readyQuantity + item.cancelledQuantity === item.quantity))
  assert.equal((await queue()).items.length, 2, 'completion alone never removes the order')
  await db.exec(`update order_lines set quantity=3 where id='${line}'`)
  const second = await send('later')
  assert.equal(second.sequence, 2)
  assert.equal(new Set((await queue()).items.map(item => item.batchId)).size, 2)
  await accept(second.batchId)
  await db.exec(`update order_lines set served_quantity=2 where id='${line}'`)
  items = (await queue()).items
  assert.equal(items.find(item => item.id === burger.id).servedQuantity, 2)
  assert.equal(items.find(item => item.batchId === second.batchId).servedQuantity, 0, 'serving the older send cannot dismiss the next one')
  await db.exec(`update order_lines set served_quantity=quantity where id='${secondLine}'`)
  items = (await queue()).items
  assert.equal(items.length, 1)
  assert.equal(items[0].batchId, second.batchId)
  await ready(items[0].id, 1)
  assert.equal((await queue()).items.length, 1)
  await db.exec(`update order_lines set served_quantity=quantity where id='${line}'`)
  assert.equal((await queue()).items.length, 0)
  assert.equal((await db.query('select count(*)::int n from production_items')).rows[0].n, 3, 'queue retirement keeps immutable production snapshots')
})

test('acceptance and workflow reads enforce tenant, venue, device, active destination and role', async t => {
  const { db, send, accept, queue } = await setup(t)
  const batch = await send('scoped')
  await assert.rejects(accept(batch.batchId, pos), /no puede modificar/)
  await assert.rejects(accept(uuid(90)), /no disponible/)
  await db.exec('set role anon')
  await assert.rejects(accept(batch.batchId), /permission denied/)
  await assert.rejects(queue(), /permission denied/)
  await db.exec('reset role')
  await db.exec('set role authenticated')
  await accept(batch.batchId)
  assert.equal((await queue()).items.length, 1)
  await db.exec('reset role')
  for (const [column, original] of [['tenant_id', tenant], ['venue_id', venue], ['destination_id', destination]]) {
    await db.query(`update production_items set ${column}=$1`, [uuid(99)])
    await assert.rejects(accept(batch.batchId), /no disponible/)
    assert.equal((await queue()).items.length, 0)
    await db.query(`update production_items set ${column}=$1`, [original])
  }
  await db.exec(`select set_config('test.uid','${uuid(99)}',false)`)
  await assert.rejects(accept(batch.batchId), /no puede modificar/)
  await assert.rejects(queue(), /no está activa/)
  await db.exec(`select set_config('test.uid','${user}',false); update devices set is_active=false where id='${kds}'`)
  await assert.rejects(accept(batch.batchId), /no puede modificar/)
  await db.exec(`update devices set is_active=true,production_destination_id='${uuid(99)}' where id='${kds}'`)
  await assert.rejects(accept(batch.batchId), /no puede modificar/)
  await assert.rejects(queue(), /no está activa/)
  await db.exec(`update devices set production_destination_id='${destination}' where id='${kds}'; update production_destinations set venue_id='${uuid(99)}'`)
  await assert.rejects(accept(batch.batchId), /no puede modificar/)
  await db.exec(`update production_destinations set venue_id='${venue}'; select set_config('test.production','false',false)`)
  await assert.rejects(accept(batch.batchId), /no puede modificar/)
})

test('direct service baseline, fractional menu readiness and split lineage survive the complete lifecycle', async t => {
  const { db, state, queue, send, accept, ready } = await setup(t)
  const batch = await send('after-direct-service')
  await accept(batch.batchId)
  const item = (await queue()).items[0]
  assert.equal(item.servedQuantity, 0, 'four directly served units do not consume the fifth production unit')
  await ready(item.id, 1)
  assert.equal((await state()).lines[0].readyQuantity, 1)
  await db.exec(`update order_lines set served_quantity=5 where id='${line}'`)
  assert.equal((await queue()).items.length, 0)
  const menu = uuid(30)
  const components = [{ id: 'a', productId: product, productName: 'Burger', quantity: 2 }, { id: 'b', productId: product, productName: 'Side', quantity: 1 }]
  await db.query(`insert into order_lines(id,tenant_id,venue_id,order_id,product_name,quantity,served_quantity,components) values($1,$2,$3,$4,'Menu',2,0,$5)`, [menu, tenant, venue, order, components])
  await db.exec(`insert into order_line_production_passes(tenant_id,venue_id,order_line_id,component_id,pass_id,pass_name)
    values('${tenant}','${venue}','${menu}','a','${pass}','Directo'),('${tenant}','${venue}','${menu}','b','${pass}','Directo')`)
  const menuBatch = await send('menu')
  await accept(menuBatch.batchId)
  let menuItems = (await queue()).items
  await ready(menuItems.find(item => item.snapshot.productName === 'Burger').id, 1)
  assert.equal((await state()).entries.find(entry => entry.lineId === menu && entry.componentId === 'a').readyQuantity, 0.5)
  await ready(menuItems.find(item => item.snapshot.productName === 'Burger').id, 3)
  let entries = (await state()).entries.filter(entry => entry.lineId === menu)
  assert.equal(entries.find(entry => entry.componentId === 'a').readyQuantity, 2)
  assert.equal(entries.find(entry => entry.componentId === 'b').readyQuantity, 0)
  assert.equal((await state()).lines.find(row => row.lineId === menu).readyQuantity, 0, 'a menu is ready only after all components')
  await ready(menuItems.find(item => item.snapshot.productName === 'Side').id, 2)
  assert.equal((await state()).lines.find(row => row.lineId === menu).readyQuantity, 2)
  const split = uuid(31)
  await db.query(`insert into order_lines(id,tenant_id,venue_id,order_id,product_name,quantity,served_quantity,components,split_from_line_id) values($1,$2,$3,$4,'Menu',1,0,$5,$6)`, [split, tenant, venue, order, components, menu])
  await db.query('update order_lines set quantity=1 where id=$1', [menu])
  await db.query('update order_lines set served_quantity=1 where id=$1', [split])
  menuItems = (await queue()).items
  assert.equal(menuItems.find(item => item.snapshot.productName === 'Burger').servedQuantity, 2)
  assert.equal(menuItems.find(item => item.snapshot.productName === 'Side').servedQuantity, 1)
  await db.query('update order_lines set served_quantity=1 where id=$1', [menu])
  assert.equal((await queue()).items.length, 0)
})

test('legacy ready RPC implicitly accepts a dish; cancelled dishes never block completion or revive served history', async t => {
  const { db, send, queue, ready } = await setup(t)
  await db.exec(`update order_lines set quantity=2,served_quantity=0 where id='${line}'`)
  await send('old-client')
  let item = (await queue()).items[0]
  await ready(item.id, 1)
  item = (await queue()).items[0]
  assert.ok(item.acceptedAt)
  await db.query('update production_items set cancelled_quantity=1 where id=$1', [item.id])
  await db.exec('update production_line_allocations set cancelled_quantity=1')
  assert.equal((await queue()).items[0].readyQuantity, 1)
  await db.exec(`update order_lines set quantity=1,served_quantity=1 where id='${line}'`)
  assert.equal((await queue()).items.length, 0)
})
