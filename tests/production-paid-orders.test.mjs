import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { createProductionDatabase, readProductionSql, uuid, tenant, venue, pos, kds, order, line } from './helpers/production-db.mjs'

const lifecycle = readProductionSql('20261017125631_production_kds_columns_lifecycle')
const paidOrders = readProductionSql('20261017153230_production_paid_orders_count_as_served')

test('payment-as-service migration is a compatible read-only production expansion', () => {
  assert.deepEqual(analyzeMigration(paidOrders), [])
  assert.doesNotMatch(paidOrders, /\b(?:update|delete from|insert into)\s+public\.(?:orders|order_lines|sales|tickets|production_items)\b/i)
})

async function setup(t) {
  const db = await createProductionDatabase(t)
  await db.exec(lifecycle)
  await db.exec(paidOrders)
  return {
    db,
    send: async request => (await db.query('select send_production_batch($1,1,$2,$3,null) value', [order, pos, request])).rows[0].value,
    queue: async () => (await db.query('select get_kds_workflow_queue($1) value', [kds])).rows[0].value,
    state: async (id = order) => (await db.query('select get_order_production_state($1) value', [id])).rows[0].value,
  }
}

for (const stage of ['new', 'preparing', 'completed']) {
  test(`confirmed payment retires a ${stage} send without a manual service action or historical rewrites`, async t => {
    const { db, send, queue, state } = await setup(t)
    const batch = await send(`paid-${stage}`)
    if (stage !== 'new') await db.query('select accept_production_batch($1,$2)', [kds, batch.batchId])
    if (stage === 'completed') {
      await db.query('update production_items set ready_quantity=quantity where batch_id=$1', [batch.batchId])
      await db.query('select production_refresh_allocation_ready($1,$2)', [batch.batchId, line])
    }
    assert.equal((await queue()).items.length, 1)
    const historicalItems = (await db.query('select * from production_items')).rows
    const historicalLines = (await db.query('select * from order_lines')).rows
    const historicalAllocations = (await db.query('select * from production_line_allocations')).rows

    await db.exec(`begin; update orders set status='paid' where id='${order}'; rollback;`)
    assert.equal((await queue()).items.length, 1, 'a rolled-back payment cannot retire kitchen work')
    await db.query("update orders set status='paid' where id=$1", [order])
    assert.equal((await queue()).items.length, 0)
    assert.equal((await state()).entries[0].unsentQuantity, 0)
    assert.equal((await state()).entries[0].readyQuantity, 0)
    assert.equal((await state()).entries[0].preparingQuantity, 0)
    assert.equal((await state()).lines[0].readyQuantity, 0)
    assert.equal((await state()).lines[0].unsentQuantity, 0)
    const progress = (await db.query('select * from production_allocation_progress($1,$2,$3)', [tenant, venue, [line]])).rows
    assert.equal(Number(progress[0].served_quantity), 1, 'the four manually served units plus payment account for the fifth unit')
    assert.deepEqual((await db.query('select * from order_lines')).rows, historicalLines)
    assert.deepEqual((await db.query('select * from production_items')).rows, historicalItems)
    assert.deepEqual((await db.query('select * from production_line_allocations')).rows, historicalAllocations)
  })
}

test('paying the source order serves only its current allocation; an unpaid split remains in KDS', async t => {
  const { db, send, queue, state } = await setup(t)
  await db.query('update order_lines set quantity=2,served_quantity=0 where id=$1', [line])
  const batch = await send('split-payment')
  await db.query('update production_items set ready_quantity=quantity where batch_id=$1', [batch.batchId])
  await db.query('select production_refresh_allocation_ready($1,$2)', [batch.batchId, line])
  const splitOrder = uuid(30)
  const splitLine = uuid(31)
  const group = uuid(32)
  await db.query('update orders set order_group_id=$1 where id=$2', [group, order])
  await db.query('insert into orders(id,tenant_id,venue_id,order_group_id) values($1,$2,$3,$4)', [splitOrder, tenant, venue, group])
  await db.query(`insert into order_lines(id,tenant_id,venue_id,order_id,product_name,quantity,served_quantity,split_from_line_id)
    select $1,tenant_id,venue_id,$2,product_name,1,0,id from order_lines where id=$3`, [splitLine, splitOrder, line])
  await db.query('update order_lines set quantity=1 where id=$1', [line])
  assert.equal((await queue()).items[0].servedQuantity, 0)

  await db.query("update orders set status='paid' where id=$1", [order])
  const remaining = (await queue()).items
  assert.equal(remaining.length, 1, 'the original source order being paid must not hide transferred work')
  assert.equal(remaining[0].servedQuantity, 1)
  assert.equal(remaining[0].quantity, 2)
  assert.equal((await state(order)).lines[0].readyQuantity, 0)
  assert.equal((await state(splitOrder)).lines[0].readyQuantity, 1)
  assert.equal((await db.query('select served_quantity::float8 n from order_lines where id=$1', [splitLine])).rows[0].n, 0)

  await db.query("update orders set status='paid' where id=$1", [splitOrder])
  assert.equal((await queue()).items.length, 0)
  assert.equal((await state(splitOrder)).lines[0].readyQuantity, 0)
})

test('partial equal payments keep the open order pending until the final payment confirms it paid', async t => {
  const { db, send, queue } = await setup(t)
  await send('equal-parts')
  await db.exec(`create table restaurant_order_equal_splits(order_id uuid, part_count integer, paid_parts integer, status text);
    insert into restaurant_order_equal_splits values('${order}',3,0,'open');`)
  for (const paidParts of [1, 2]) {
    await db.query('update restaurant_order_equal_splits set paid_parts=$1', [paidParts])
    assert.equal((await db.query('select status from orders where id=$1', [order])).rows[0].status, 'open')
    assert.equal((await queue()).items.length, 1, 'a monetary share does not identify any fully paid dishes')
  }
  // The existing equal-payment finalizer changes the order to paid only on completion.
  await db.exec(`begin;
    update restaurant_order_equal_splits set paid_parts=3,status='completed';
    update orders set status='paid' where id='${order}';
    commit;`)
  assert.equal((await queue()).items.length, 0)
})
