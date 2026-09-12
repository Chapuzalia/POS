import assert from 'node:assert/strict'
import test from 'node:test'

import { createRestaurantControllerHarness as paymentHarness, flush } from './helpers/restaurant-controller-harness.mjs'

test('el cobro libera la comanda antes de esperar mapa, sincronización e impresión', async () => {
  const harness = paymentHarness()
  const controller = harness.render()
  const payment = controller.completePayment('card', null)
  await flush()

  assert.equal(harness.calls.close, 1)
  assert.equal(harness.calls.replaced.at(-1), null)
  assert.equal(harness.calls.setMap.at(-1).tables[0].status, 'free')
  assert.equal(harness.render().posView.type, 'table_map')
  assert.equal(harness.calls.prints, 1)
  assert.deepEqual(harness.calls.busy, [true])

  harness.mapRefresh.resolve({ areas: [{ id: 'area' }], tables: [] })
  harness.queueSync.resolve()
  harness.print.resolve()
  await payment
  assert.deepEqual(harness.calls.busy, [true, false])
})

test('un reintento mientras siguen las tareas auxiliares no duplica el cobro', async () => {
  const harness = paymentHarness()
  const controller = harness.render()
  const first = controller.completePayment('card', null)
  await flush()
  await controller.completePayment('card', null)

  assert.equal(harness.calls.close, 1)
  harness.mapRefresh.resolve({ areas: [], tables: [] })
  harness.queueSync.resolve()
  harness.print.resolve()
  await first
  assert.equal(harness.calls.close, 1)
})

test('solo Cashlogy consulta pendientes antes de cobrar y conserva la comanda si los encuentra', async () => {
  const cashlogy = paymentHarness({ cashlogyConfigured: true, pendingUnits: 2 })
  await cashlogy.render().completePayment('cash', null)
  assert.equal(cashlogy.calls.pendingChecks, 1)
  assert.equal(cashlogy.calls.close, 0)
  assert.equal(cashlogy.render().pendingPayment.pendingUnits, 2)

  const card = paymentHarness({ cashlogyConfigured: true })
  const payment = card.render().completePayment('card', null)
  await flush()
  assert.equal(card.calls.pendingChecks, 0)
  card.mapRefresh.resolve({ areas: [], tables: [] })
  card.queueSync.resolve()
  card.print.resolve()
  await payment
})
