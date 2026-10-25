import assert from 'node:assert/strict'
import test from 'node:test'
import { groupKdsItems, kdsColumns } from '../src/features/production/kds-queue.ts'
import { getOrderLineProductionProgress } from '../src/features/production/order-progress.ts'

const item = (id, sentAt, state = {}) => ({ id, batchId: id, batchSequence: 1, orderId: 'order', tableName: 'Mesa 7',
  quantity: 2, readyQuantity: 0, cancelledQuantity: 0, servedQuantity: 0, acceptedAt: null, snapshot: {}, sentAt, ...state })

test('every column keeps the oldest original send above later arrivals, including after transitions', () => {
  const items = [item('new-late', '2026-10-17T12:05:00Z'), item('ready-late', '2026-10-17T12:04:00Z', { readyQuantity: 2 }),
    item('prep-late', '2026-10-17T12:03:00Z', { acceptedAt: '2026-10-17T12:08:00Z' }), item('new-old', '2026-10-17T12:02:00Z'),
    item('ready-old', '2026-10-17T12:01:00Z', { readyQuantity: 2 }), item('prep-old', '2026-10-17T12:00:00Z', { acceptedAt: '2026-10-17T12:09:00Z' })]
  const columns = () => kdsColumns.map(column => groupKdsItems(items).filter(batch => batch.column === column.id).map(batch => batch.items[0].id))
  assert.deepEqual(columns(), [['new-old', 'new-late'], ['prep-old', 'prep-late'], ['ready-old', 'ready-late']])
  items.find(item => item.id === 'prep-old').readyQuantity = 2
  assert.deepEqual(columns(), [['new-old', 'new-late'], ['prep-late'], ['prep-old', 'ready-old', 'ready-late']])
  items.find(item => item.id === 'prep-old').servedQuantity = 1
  assert.equal(columns()[2][0], 'prep-old', 'partial service keeps the completed card')
  items.find(item => item.id === 'prep-old').servedQuantity = 2
  assert.deepEqual(columns()[2], ['ready-old', 'ready-late'])
})

test('a ready dish stays in its preparing batch; cancellation and service cannot keep an empty card alive', () => {
  const ready = item('ready', '2026-10-17T12:00:00Z', { readyQuantity: 2 })
  const cooking = { ...item('cooking', '2026-10-17T12:00:00Z', { acceptedAt: '2026-10-17T12:01:00Z' }), batchId: 'ready' }
  assert.equal(groupKdsItems([ready, cooking])[0].column, 'preparing')
  assert.equal(groupKdsItems([ready, cooking])[0].items.length, 2)
  cooking.cancelledQuantity = 2
  assert.equal(groupKdsItems([ready, cooking])[0].column, 'completed')
  ready.servedQuantity = 2
  assert.equal(groupKdsItems([ready, cooking]).length, 0)
})

test('waiter sees sent, preparing, ready to serve and served, with mixed quantities kept explicit', () => {
  const line = { quantity: 4, servedQuantity: 0 }
  const entry = { quantity: 4, sentQuantity: 4, skippedQuantity: 0, unsentQuantity: 0 }
  assert.equal(getOrderLineProductionProgress(line, [entry], { readyQuantity: 0, preparingQuantity: 0 }).label, 'Enviado')
  assert.equal(getOrderLineProductionProgress(line, [entry], { readyQuantity: 0, preparingQuantity: 4 }).label, 'En preparación')
  const mixed = getOrderLineProductionProgress(line, [entry], { readyQuantity: 1, preparingQuantity: 2 })
  assert.deepEqual(mixed, { unsent: 0, ready: 1, preparing: 2, sent: 1, label: 'Listo para servir' })
  assert.equal(getOrderLineProductionProgress({ quantity: 4, servedQuantity: 4 }, [entry], { readyQuantity: 0 }).label, 'Servido')
  assert.equal(getOrderLineProductionProgress(line, [], undefined).label, 'Pendiente', 'unrouted products must not appear sent')
})
