import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRestaurantControllerHarness, flush } from './helpers/restaurant-controller-harness.mjs'

test('restaurant full checkout routes through local fiscal RPC and prints only its issued payload', async () => {
  const result = { requiresConfirmation: false, pendingUnits: 0, orderId: 'order', ticketId: 'ticket',
    saleId: 'sale', paymentId: 'payment', totalCents: 600, nextOrderId: null }
  const fiscalPayload = { ticket: { id: 'ticket', invoice: null }, sale: { id: 'sale' }, lines: [],
    localFiscal: { series: 'L1-C1-I1-2026-S', number: 1 }, fiscal: { verificationUrl: 'https://aeat.example.invalid/qr' } }
  const harness = createRestaurantControllerHarness({ fiscalMode: 'production',
    fiscalIssue: async (_context, _session, _draft, action) => {
      assert.equal(action, 'close')
      return { result, payload: fiscalPayload, entry: { id: 'record' } }
    } })
  const payment = harness.render().completePayment('card', null)
  await flush()
  harness.queueSync.resolve()
  harness.mapRefresh.resolve({ areas: [{ id: 'area' }], tables: [] })
  harness.print.resolve()
  await payment
  assert.equal(harness.calls.close, 0)
  assert.equal(harness.calls.fiscalIssues.length, 1)
  assert.equal(harness.calls.prints, 1)
  assert.equal(harness.calls.printed[0].localFiscal.number, 1)
  assert.equal(harness.calls.printed[0].fiscal.verificationUrl, fiscalPayload.fiscal.verificationUrl)
})
