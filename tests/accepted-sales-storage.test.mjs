import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { preparePaymentOperation, acceptPaymentOperation, commitPaymentOperation, loadDurableEvents, loadDurableSessionTickets,
  paymentScope, updateDurableEvent, markPaymentCharging, loadPaymentOperation, loadPaymentOperations, markRestaurantCheckoutReserved } from '../src/lib/durableSales.ts'
import { openLedger, request, transactionDone } from '../src/features/fiscal/local/localLedger.ts'

const context = { tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'cashier' }
const payload = { ticket: { id: 'ticket', tenantId: 'tenant', venueId: 'venue', cashSessionId: 'session' },
  sale: { id: 'sale', tenantId: 'tenant', totalCents: 600, paymentMethod: 'cash', createdAt: '2026-10-11T10:00:00Z' },
  payment: { id: 'payment', amountCents: 600, cashlogyRequestId: 'request', cashlogyTransactionId: 'transaction' }, lines: [{ id: 'line', unitPriceCents: 600 }] }
async function setup() {
  globalThis.indexedDB = new IDBFactory()
  globalThis.window = { location: { pathname: '/pos' } }
  await loadDurableEvents()
  return `${paymentScope(context, 'session')}|quick-sale`
}
async function rows(store) {
  const db = await openLedger()
  try { const tx = db.transaction(store, 'readonly'); const done = transactionDone(tx); const value = await request(tx.objectStore(store).getAll()); await done; return value }
  finally { db.close() }
}

test('sale, payment and pending event survive a reload with their original ids and scoped snapshot', async () => {
  const key = await setup()
  const input = structuredClone(payload)
  const operation = await preparePaymentOperation(key, 'draft', input)
  const accepted = await acceptPaymentOperation(operation, input, { id: 'transaction' })
  await commitPaymentOperation(accepted, input, true)
  input.lines[0].unitPriceCents = 9999
  const queue = await loadDurableEvents()
  assert.equal(queue.length, 1)
  assert.equal(queue[0].payload.lines[0].unitPriceCents, 600)
  assert.equal(queue[0].payload.payment.cashlogyTransactionId, 'transaction')
  window.location.pathname = '/crm'
  assert.equal((await loadDurableEvents()).length, 0)
  await assert.rejects(updateDurableEvent(operation.eventId), /otra aplicación/)
  window.location.pathname = '/pos'
  assert.equal((await loadDurableEvents()).length, 1)
  assert.equal((await loadDurableSessionTickets(context, 'session')).length, 1)
  assert.equal((await loadDurableSessionTickets({ ...context, venueId: 'other' }, 'session')).length, 0)
  assert.equal((await loadDurableSessionTickets({ ...context, deviceId: 'other' }, 'session')).length, 0)
  const retry = await preparePaymentOperation(key, 'draft', { ...payload, sale: { ...payload.sale, id: 'new-sale' } })
  assert.equal(retry.state, 'committed')
  assert.equal(retry.payload.sale.id, 'sale')
  assert.equal(retry.eventId, operation.eventId)
})
test('quota/transaction abort rolls back all final writes and preserves the accepted charge for recovery', async () => {
  const key = await setup()
  const operation = await preparePaymentOperation(key, 'draft', payload)
  const accepted = await acceptPaymentOperation(operation, payload, { id: 'transaction' })
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'durableEvents') { this.transaction.abort(); throw new DOMException('Storage full', 'QuotaExceededError') }
    return put.apply(this, args)
  }
  try { await assert.rejects(commitPaymentOperation(accepted, payload, true), /Storage full/) }
  finally { IDBObjectStore.prototype.put = put }
  assert.equal((await rows('durableSales')).length, 0)
  assert.equal((await rows('durableEvents')).length, 0)
  assert.equal((await rows('paymentOperations'))[0].state, 'accepted')
  await assert.rejects(preparePaymentOperation(key, 'changed-ticket', payload), /pendiente/)
  await commitPaymentOperation(accepted, payload, true)
  assert.equal((await loadDurableEvents()).length, 1)
})
test('charging intent survives response/storage loss and cannot be replaced with a new charge identity', async () => {
  const key = await setup()
  const operation = await preparePaymentOperation(key, 'draft', payload)
  await markPaymentCharging(operation)
  const retry = await preparePaymentOperation(key, 'draft', { ...payload, sale: { ...payload.sale, id: 'different' } })
  assert.equal(retry.state, 'charging')
  assert.equal(retry.payload.sale.id, 'sale')
  await assert.rejects(preparePaymentOperation(key, 'other-cart', payload), /pendiente/)
  await assert.rejects(preparePaymentOperation(key.replace('quick-sale', 'restaurant:close:order'), 'other-sale', payload), /ticket ya tiene/)
})

test('an interrupted preparation can be replaced by an edited ticket before any collection or reservation', async () => {
  const key = await setup()
  const original = { ...payload, payment: { id: 'payment', amountCents: 600 } }
  const operation = await preparePaymentOperation(key, 'draft', original, { sourceLineIds: ['old-line'] })
  const edited = { ...original, sale: { ...original.sale, id: 'edited-sale', totalCents: 900 } }
  const next = await preparePaymentOperation(key, 'edited-draft', edited, { sourceLineIds: ['new-line'] })
  assert.equal(next.state, 'prepared')
  assert.equal(next.payload.sale.id, 'edited-sale')
  assert.equal(next.payload.sale.totalCents, 900)
  assert.notEqual(next.eventId, operation.eventId)
  assert.deepEqual(next.params.sourceLineIds, ['new-line'])
  assert.deepEqual(await loadPaymentOperation(key), next)
  assert.equal((await loadDurableEvents()).length, 0)
  assert.equal((await rows('durableSales')).length, 0)
})

for (const evidence of ['reservation', 'request', 'transaction', 'payment_request', 'payment_transaction', 'fiscal', 'result']) {
  test(`a prepared payment with ${evidence} evidence retains its original identity after editing the ticket`, async () => {
    const key = await setup()
    const original = { ...payload, payment: { id: 'payment', amountCents: 600 } }
    let operation = await preparePaymentOperation(key, 'draft', original)
    if (evidence === 'reservation') operation = await markRestaurantCheckoutReserved(operation)
    else {
      if (evidence === 'request') operation.cashlogyRequestId = 'request'
      if (evidence === 'transaction') operation.cashlogy = { id: 'transaction' }
      if (evidence === 'payment_request') operation.payload.payment.cashlogyRequestId = 'request'
      if (evidence === 'payment_transaction') operation.payload.payment.cashlogyTransactionId = 'transaction'
      if (evidence === 'fiscal') operation.payload.localFiscal = { recordId: 'record' }
      if (evidence === 'result') operation.result = { saleId: 'sale' }
      const db = await openLedger()
      try {
        const tx = db.transaction('paymentOperations', 'readwrite')
        const done = transactionDone(tx)
        tx.objectStore('paymentOperations').put(operation)
        await done
      } finally { db.close() }
    }
    await assert.rejects(preparePaymentOperation(key, 'edited-ticket', original), /pendiente/)
    assert.deepEqual(await loadPaymentOperation(key), operation)
  })
}
test('SQL 55000 and closed cash retain the durable queue; acknowledged retry removes only that event', async () => {
  const key = await setup()
  const operation = await preparePaymentOperation(key, 'draft', payload)
  await commitPaymentOperation(operation, payload, true)
  await updateDurableEvent(operation.eventId, '55000: original cash session closed')
  const failed = (await loadDurableEvents())[0]
  assert.equal(failed.attempts, 1)
  assert.equal(failed.payload.sale.id, 'sale')
  await updateDurableEvent(operation.eventId)
  assert.equal((await loadDurableEvents()).length, 0)
  assert.equal((await rows('durableSales')).length, 1)
})

test('paid draft lines cannot become a second charge after a cache failure or changed promotion', async () => {
  const key = await setup()
  const operation = await preparePaymentOperation(key, 'old-promotion', payload, { sourceLineIds: ['old-line'] })
  await commitPaymentOperation(operation, payload, true)
  const retry = await preparePaymentOperation(key, 'new-promotion-or-items', payload, { sourceLineIds: ['old-line', 'new-line'] })
  assert.equal(retry.state, 'committed')
  assert.equal(retry.eventId, operation.eventId)
  const next = await preparePaymentOperation(key, 'new-cart', payload, { sourceLineIds: ['new-line'] })
  assert.notEqual(next.eventId, operation.eventId)
})

for (const state of ['charging', 'accepted', 'reserved']) test(`a ${state} ticket does not block an unrelated quick sale or table payment`, async () => {
  const key = await setup()
  let original = await preparePaymentOperation(key, 'original', payload, { sourceLineIds: ['old-line'] })
  if (state === 'charging') original = await markPaymentCharging(original)
  if (state === 'accepted') original = await acceptPaymentOperation(original, payload, { id: 'transaction' })
  if (state === 'reserved') original = await markRestaurantCheckoutReserved(original)
  for (const suffix of ['quick-sale:new-sale', 'restaurant:close:other-order']) {
    const nextPayload = { ...payload, ticket: { ...payload.ticket, id: `ticket-${suffix}` }, sale: { ...payload.sale, id: `sale-${suffix}` } }
    const next = await preparePaymentOperation(`${key.split('|')[0]}|${suffix}`, suffix, nextPayload, { sourceLineIds: [suffix] })
    await commitPaymentOperation(await acceptPaymentOperation(next, nextPayload, null), nextPayload, true)
  }
  assert.deepEqual(await loadPaymentOperation(key), original)
  assert.equal((await loadDurableEvents()).length, 2)
  assert.equal((await loadPaymentOperations(context, 'session')).length, 3)
  assert.equal((await loadPaymentOperations({ ...context, venueId: 'other' }, 'session')).length, 0)
  assert.equal((await loadPaymentOperations({ ...context, deviceId: 'other' }, 'session')).length, 0)
  window.location.pathname = '/crm'
  assert.equal((await loadPaymentOperations(context, 'session')).length, 0)
})

for (const state of ['charging', 'accepted', 'committed']) test(`a new quick-sale key cannot charge lines already belonging to a ${state} ticket`, async () => {
  const key = await setup()
  let original = await preparePaymentOperation(key, 'original', payload, { sourceLineIds: ['old-line'] })
  if (state === 'charging') original = await markPaymentCharging(original)
  else original = await acceptPaymentOperation(original, payload, { id: 'transaction' })
  if (state === 'committed') {
    await commitPaymentOperation(original, payload, true)
    original = await loadPaymentOperation(key)
  }
  const retry = await preparePaymentOperation(`${key}:different-key`, 'edited-ticket',
    { ...payload, ticket: { ...payload.ticket, id: 'new-ticket' }, sale: { ...payload.sale, id: 'new-sale' } },
    { sourceLineIds: ['old-line', 'new-line'] })
  assert.deepEqual(retry, original)
  assert.equal((await loadPaymentOperations(context, 'session')).length, 1)
})
