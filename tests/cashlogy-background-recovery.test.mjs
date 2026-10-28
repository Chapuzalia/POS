import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import * as durable from '../src/lib/durableSales.ts'
import { compileComponent } from './helpers/component-harness.mjs'
import { withConfirmedRestaurantPayments } from '../src/features/restaurant/services/paymentPayload.ts'

// Execute the real store actions with isolated storage/network dependencies.
async function loadStore(kind, request, options = {}) {
  const name = kind === 'payment' ? 'useCashlogyStore' : 'useCashlogyManagementStore'
  const source = await readFile(new URL(`../src/features/local-printing/cashlogy/${name}.ts`, import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, '').replace(/^export\s+/gm, '')
  const intent = options.intent ?? { requestId: 'request-1', transactionId: null, chargeRequestedAt: '2026-09-10', amountCents: 600 }
const dependencies = {
    CashlogyError: class CashlogyError extends Error {
      constructor(options = {}) { super(options.message ?? options.code); Object.assign(this, options) }
    },
    create: (initialize) => {
      let state
      const setState = (patch) => { state = { ...state, ...patch } }
      const getState = () => state
      state = initialize(setState, getState)
      return { getState, setState }
    },
    createPrintAgentClient: () => ({
      getCashlogyTransactionByRequestId: request,
      getCashlogyCashManagementOperationByRequestId: request,
      getCashlogyHealth: options.getCashlogyHealth ?? (async () => ({ activeCashManagementOperation: null })),
      ...options.client,
    }),
    usePrintAgentStore: { getState: () => ({ baseUrl: 'https://agent.local', token: 'token', cashlogyConfigured: options.configured ?? true,
      checkCashlogyHealth: options.getCashlogyHealth ?? (async () => ({ enabled: true, ok: true, sessionState: 'ready', activeTransaction: null })) }) },
    loadCashlogyIntent: () => intent,
    loadCashlogyManagementIntent: () => kind === 'management' ? intent : null,
    saveCashlogyIntent: options.saveCashlogyIntent ?? (() => {}),
    saveCashlogyManagementIntent: options.saveCashlogyManagementIntent ?? (() => {}),
    cashlogyAcknowledgements: () => options.acknowledgements ?? ({ add() {}, contains: () => false, flush: async () => {} }),
    getBlockingCashlogyTransactionId: () => null,
    isMissingCashlogyTransaction: (error) => error.status === 404 || error.code === 'CASHLOGY_TRANSACTION_NOT_FOUND',
    isUncertainCashlogyError: () => false,
    cashlogyActiveStatuses: new Set(['queued', 'connecting', 'initializing', 'starting_acceptance', 'waiting_for_cash', 'finalizing_acceptance', 'dispensing_change', 'processing']),
    cashlogyCancellableStatuses: new Set(['waiting_for_cash']),
    pollCashlogyTransaction: options.poll ?? (async (_get, transaction) => transaction),
    cashlogyManagementActiveStatuses: new Set(['accepting']),
    getCompletedStackerCollection: () => null,
    reportOperationError: () => {},
    operationBreadcrumb: () => {},
    createCashlogyRequestId: () => 'request-new',
    updateCashlogyPaymentAttempt: options.updateCashlogyPaymentAttempt ?? (async () => {}),
    toCashlogyError: (error) => error,
    AbortController,
    AbortSignal,
  }
  return runInNewContext(`${code}\n${kind === 'payment' ? 'useCashlogyStore.settle = settleCashlogyPaymentIfConfigured;' : ''}\n${name}`, dependencies)
}

test('management: a missing saved operation stops automatic recovery and can be discarded after a fresh health check', async () => {
  const saves = []
  let healthChecks = 0
  const missing = new Error('missing')
  missing.code = 'CASHLOGY_CASH_MANAGEMENT_NOT_FOUND'
  const store = await loadStore('management', async () => { throw missing }, {
    getCashlogyHealth: async () => {
      healthChecks += 1
      return { activeCashManagementOperation: null }
    },
    saveCashlogyManagementIntent: (_scope, intent) => saves.push(intent),
  })
  store.getState().configureScope({ tenantId: 't', establishmentId: 'v', terminalId: 'd' })

  await assert.rejects(store.getState().recover(), /La operación guardada no existe/)
  assert.equal(store.getState().missingIntent, true)
  assert.equal(store.getState().intent.requestId, 'request-1')
  assert.equal(healthChecks, 1)

  await store.getState().discardMissingIntent()
  assert.equal(healthChecks, 2)
  assert.equal(store.getState().intent, null)
  assert.equal(store.getState().missingIntent, false)
  assert.match(store.getState().recoveryNotice, /operación nueva/)
  assert.deepEqual(saves, [null])
})

test('management: an active cash operation prevents discarding an orphaned local reference', async () => {
  const missing = new Error('missing')
  missing.code = 'CASHLOGY_CASH_MANAGEMENT_NOT_FOUND'
  const store = await loadStore('management', async () => { throw missing }, {
    getCashlogyHealth: async () => ({
      activeCashManagementOperation: { id: 'active-1', requestId: 'another-request', type: 'refill', status: 'accepting' },
    }),
  })
  store.getState().configureScope({ tenantId: 't', establishmentId: 'v', terminalId: 'd' })

  await assert.rejects(store.getState().recover(), /otra operación de efectivo activa/)
  await assert.rejects(store.getState().discardMissingIntent(), /otra operación de efectivo activa/)
  assert.equal(store.getState().intent.requestId, 'request-1')
  assert.equal(store.getState().missingIntent, true)
})

test('management: an intent bound to another print agent is never queried automatically', async () => {
  let requests = 0
  const store = await loadStore('management', async () => { requests += 1 })
  store.getState().configureScope({ tenantId: 't', establishmentId: 'v', terminalId: 'd' })
  store.setState({ intent: { ...store.getState().intent, agentBaseUrl: 'https://old-agent.local' } })

  await assert.rejects(store.getState().recover(), /otro agente de impresión/)
  assert.equal(requests, 0)
  assert.equal(store.getState().missingIntent, true)
})

const paymentScope = { tenantId: 't', establishmentId: 'v', terminalId: 'd' }
const absentPayment = () => Object.assign(new Error('Transaction missing'), { status: 404 })
const completedPayment = { id: 'tx-new', requestId: 'request-new', status: 'completed', requestedAmountCents: 600 }

async function journalFixture() {
  globalThis.indexedDB = new IDBFactory()
  globalThis.window = { location: { pathname: '/pos' } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_key, _options, work) => work() } } })
  const context = { tenantId: 't', venueId: 'v', deviceId: 'd', userId: 'u' }
  const session = { id: 'session' }
  const key = `${durable.paymentScope(context, session.id)}|restaurant:close:order`
  const payload = { sale: { id: 'original-sale', tenantId: 't', totalCents: 600, paymentMethod: 'cash' },
    ticket: { id: 'ticket' }, payment: { id: 'payment', receivedCents: 600 }, lines: [] }
  const operation = await durable.preparePaymentOperation(key, 'original-order', payload, { orderId: 'order', method: 'cash' })
  const intent = { requestId: 'request-1', saleId: payload.sale.id, amountCents: 600,
    paymentOperationKey: key, transactionId: null, chargeRequestedAt: '2026-10-11' }
  await durable.updateCashlogyPaymentAttempt(intent, paymentScope, { type: 'start' })
  return { context, session, key, payload, operation, intent }
}

async function restaurantRecovery(store) {
  const source = await readFile(new URL('../src/features/restaurant/services/payment.ts', import.meta.url), 'utf8')
  return compileComponent(source, {
    './checkout.ts': { prepareRestaurantCheckout: async () => {}, releaseRestaurantCheckout: async () => true, startRestaurantCheckout: async () => {} },
    './paymentPayload.ts': { withConfirmedRestaurantPayments },
    '../../../lib/durableSales.ts': durable,
    '../../local-printing/cashlogy/useCashlogyStore.ts': {
      isCashlogyPaymentConfigured: () => true, settleCashlogyPaymentIfConfigured: store.settle,
      getCashlogyPaymentAmounts: () => ({ receivedCents: 600, changeCents: 0 }),
    },
    '../../fiscal/local/mode.ts': { assertRealSaleAllowed() {} },
    '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode: async () => 'disabled' },
    '../../fiscal/local/posInvoice.ts': {}, '../../fiscal/local/restaurantInvoice.ts': {},
    '../../tables/service.ts': { payRestaurantIdempotent: async () => ({ saleId: 'remote-sale', ticketId: 'remote-ticket', paymentId: 'remote-payment' }) },
  }, { JSON })
}

for (const mode of ['before_request', 'missing', 'cancelled']) test(`payment journal: cancel ${mode} unlocks a new sale instead of leaving charging forever`, async () => {
  const fixture = await journalFixture()
  const store = await loadStore('payment', async () => { throw absentPayment() }, {
    intent: { ...fixture.intent, chargeRequestedAt: mode === 'before_request' ? null : fixture.intent.chargeRequestedAt },
    updateCashlogyPaymentAttempt: durable.updateCashlogyPaymentAttempt,
  })
  store.getState().configureScope(paymentScope)
  if (mode === 'cancelled') store.setState({ transaction: { id: 'tx', requestId: 'request-1', status: 'cancelled' } })
  await store.getState().cancel()
  assert.equal(store.getState().intent, null)
  assert.equal(await durable.loadPaymentOperation(fixture.key), undefined)
  const next = await durable.preparePaymentOperation(fixture.key, 'changed-order', { ...fixture.payload, sale: { ...fixture.payload.sale, id: 'new-sale' } })
  assert.equal(next.state, 'prepared')
  assert.equal(next.payload.sale.id, 'new-sale')
})

test('payment journal: restart saves the new request before POST and recovery after response loss queries that request without charging again', async () => {
  const fixture = await journalFixture()
  let charges = 0
  const store = await loadStore('payment', async () => { throw absentPayment() }, {
    intent: fixture.intent, updateCashlogyPaymentAttempt: durable.updateCashlogyPaymentAttempt,
    client: { getCashlogyLevels: async () => ({ levels: [] }), createCashlogyCharge: async payload => {
      charges++
      assert.equal(payload.requestId, 'request-new')
      assert.equal(payload.saleId, 'original-sale')
      assert.equal((await durable.loadPaymentOperation(fixture.key)).cashlogyRequestId, payload.requestId)
      throw new Error('Network response lost')
    } },
  })
  store.getState().configureScope(paymentScope)
  await assert.rejects(store.getState().retryPayment(true), /response lost/)
  const pending = await durable.loadPaymentOperation(fixture.key)
  assert.equal(pending.cashlogyRequestId, 'request-new')
  assert.equal(pending.eventId, fixture.operation.eventId)
  // Simulate reload with the original draft/order no longer open.
  const restored = await loadStore('payment', async requestId => {
    assert.equal(requestId, 'request-new')
    return { transaction: { ...completedPayment, saleId: 'original-sale' } }
  }, { intent: store.getState().intent, updateCashlogyPaymentAttempt: durable.updateCashlogyPaymentAttempt,
    client: { createCashlogyCharge: async () => assert.fail('Recovery must not POST') } })
  restored.getState().configureScope(paymentScope)
  const service = await restaurantRecovery(restored)
  const [recovered] = await service.recoverRestaurantPayments(fixture.context, fixture.session)
  assert.equal(recovered.transaction.requestId, 'request-new')
  assert.equal(recovered.payload.payment.cashlogyRequestId, 'request-new')
  assert.equal((await durable.loadPaymentOperation(fixture.key)).state, 'committed')
  assert.equal(charges, 1)
})

test('payment journal: cancel on a confirmed charge retains the accepted money even after the agent record is closed', async () => {
  const fixture = await journalFixture()
  const store = await loadStore('payment', async () => assert.fail('The agent record is already closed'), {
    intent: fixture.intent, updateCashlogyPaymentAttempt: durable.updateCashlogyPaymentAttempt,
  })
  store.getState().configureScope(paymentScope)
  store.setState({ transaction: { ...completedPayment, requestId: 'request-1', saleId: 'original-sale', automaticAcceptedCents: 700, returnedCents: 100 } })
  await store.getState().cancel(true)
  assert.equal(store.getState().intent, null)
  const accepted = await durable.loadPaymentOperation(fixture.key)
  assert.equal(accepted.state, 'accepted')
  assert.equal(accepted.payload.payment.receivedCents, 700)
  assert.equal(accepted.payload.payment.changeCents, 100)
  await assert.rejects(durable.preparePaymentOperation(fixture.key.replace('restaurant:close:order', 'quick-sale'), 'new', fixture.payload), /ticket ya tiene/)
  const service = await restaurantRecovery(store)
  const [recovered] = await service.recoverRestaurantPayments(fixture.context, fixture.session)
  assert.equal(recovered.payload.payment.receivedCents, 700)
  assert.equal(recovered.payload.payment.changeCents, 100)
  assert.equal((await durable.loadPaymentOperation(fixture.key)).state, 'committed')
})

test('payment journal: a timeout preserves the attempt; failure to persist a restart sends no charge and still permits cancelling before POST', async () => {
  const fixture = await journalFixture()
  const store = await loadStore('payment', async () => { throw new Error('Timeout') }, {
    intent: fixture.intent, updateCashlogyPaymentAttempt: durable.updateCashlogyPaymentAttempt,
    client: { getCashlogyLevels: async () => ({ levels: [] }), createCashlogyCharge: async () => assert.fail('Cannot charge without durable identity') },
  })
  store.getState().configureScope(paymentScope)
  await assert.rejects(store.getState().cancel(), /Timeout/)
  assert.equal((await durable.loadPaymentOperation(fixture.key)).state, 'charging')
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'paymentOperations') { this.transaction.abort(); throw new DOMException('Storage full', 'QuotaExceededError') }
    return put.apply(this, args)
  }
  try {
    store.setState({ intent: null })
    await assert.rejects(store.getState().startPayment(600, 'original-sale', undefined, 'request-new', fixture.key), /Storage full/)
  } finally { IDBObjectStore.prototype.put = put }
  assert.equal(store.getState().intent.chargeRequestedAt, null)
  await store.getState().cancel()
  assert.equal(await durable.loadPaymentOperation(fixture.key), undefined)
})

test('payment journal: cancellation is scoped and cannot erase an accepted or committed sale', async () => {
  const fixture = await journalFixture()
  const closing = { type: 'close', transaction: null, receivedCents: null, changeCents: null }
  await assert.rejects(durable.updateCashlogyPaymentAttempt(fixture.intent, { ...paymentScope, tenantId: 'other' }, closing), /identificar/)
  assert.equal((await durable.loadPaymentOperation(fixture.key)).state, 'charging')
  const accepted = await durable.acceptPaymentOperation(await durable.loadPaymentOperation(fixture.key), fixture.payload,
    { ...completedPayment, requestId: 'request-1', saleId: 'original-sale' })
  await durable.updateCashlogyPaymentAttempt(fixture.intent, paymentScope, closing)
  assert.equal((await durable.loadPaymentOperation(fixture.key)).state, 'accepted')
  await assert.rejects(durable.updateCashlogyPaymentAttempt({ ...fixture.intent, requestId: 'request-new' }, paymentScope, { type: 'start' }), /ya está aceptado/)
  // Restaurant RPCs may replace the draft sale ID with the server's sale ID.
  await durable.commitPaymentOperation(accepted, { ...fixture.payload, sale: { ...fixture.payload.sale, id: 'remote-sale' } }, false)
  await durable.updateCashlogyPaymentAttempt(fixture.intent, paymentScope, closing)
  assert.equal((await durable.loadPaymentOperation(fixture.key)).state, 'committed')
})
