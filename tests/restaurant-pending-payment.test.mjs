import assert from 'node:assert/strict'
import test from 'node:test'
import { createRestaurantControllerHarness, deferred, flush } from './helpers/restaurant-controller-harness.mjs'

const unservedOrder = {
  order: { id: 'order', revision: 1, status: 'open' },
  lines: [{ id: 'line', productId: 'product', variantId: 'variant', unitPriceCents: 600, quantity: 2, servedQuantity: 1 }],
  tables: [{ id: 'table', areaId: 'area', isVirtual: false }],
}

test('known pending items show confirmation before busy, network reads, fiscal preparation or payment', async () => {
  const h = createRestaurantControllerHarness({ currentOrder: unservedOrder, fiscalMode: 'production' })
  await h.render().completePayment('card', null)
  const controller = h.render()
  assert.deepEqual({ ...controller.pendingPayment }, { method: 'card', receivedCents: null, pendingUnits: 1 })
  assert.equal(controller.paymentProcessing, false)
  assert.deepEqual(h.calls.busy, [])
  assert.equal(h.calls.pendingChecks, 0)
  assert.equal(h.calls.close, 0)
  assert.deepEqual(h.calls.fiscalPreflights, [])
  assert.deepEqual(h.calls.fiscalIssues, [])
  assert.deepEqual(h.calls.cashlogySettlements, [])
})

test('cash warns immediately before opening or starting a cash payment, and dismissing does not charge', () => {
  const h = createRestaurantControllerHarness({ currentOrder: unservedOrder })
  assert.equal(h.render().requestPendingPaymentConfirmation('cash', null), true)
  assert.equal(h.render().pendingPayment.method, 'cash')
  h.render().setPendingPayment(null)
  assert.equal(h.render().pendingPayment, null)
  assert.equal(h.calls.close, 0)
  assert.deepEqual(h.calls.cashlogySettlements, [])
})

test('server pending validation remains before processing when another terminal changed the comanda', async () => {
  const validation = deferred()
  const h = createRestaurantControllerHarness({ fiscalMode: 'production', tableService: {
    loadRestaurantOrderPendingUnits: () => validation.promise,
  } })
  const payment = h.render().completePayment('card', null)
  await flush()
  assert.equal(h.render().paymentProcessing, false)
  assert.deepEqual(h.calls.fiscalPreflights, [])
  validation.resolve({ detail: unservedOrder, pendingUnits: 1 })
  await payment
  assert.equal(h.render().pendingPayment.pendingUnits, 1)
  assert.equal(h.render().paymentProcessing, false)
  assert.equal(h.calls.close, 0)
  assert.deepEqual(h.calls.fiscalIssues, [])
})

test('confirmed pending payment proceeds once; processing resets after economic confirmation', async () => {
  const rpc = deferred()
  const h = createRestaurantControllerHarness({ currentOrder: unservedOrder, tableService: {
    closeRestaurantOrder: () => { h.calls.close++; return rpc.promise },
  } })
  await h.render().completePayment('card', null)
  const payment = h.render().completePayment('card', null, true)
  await flush()
  assert.equal(h.render().paymentProcessing, true)
  await h.render().completePayment('card', null, true)
  assert.equal(h.calls.close, 1)
  rpc.resolve({ requiresConfirmation: false, ticketId: 'ticket', saleId: 'sale', totalCents: 1200 })
  await payment
  assert.equal(h.render().paymentProcessing, false)
  assert.equal(h.render().pendingPayment, null)
  h.print.resolve(); h.queueSync.resolve(); h.mapRefresh.resolve({ areas: [], tables: [] })
  await flush()
})
