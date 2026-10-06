import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

// Execute the real store actions with isolated storage/network dependencies.
async function loadStore(kind, request, options = {}) {
  const name = kind === 'payment' ? 'useCashlogyStore' : 'useCashlogyManagementStore'
  const source = await readFile(new URL(`../src/features/local-printing/cashlogy/${name}.ts`, import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, '').replace(/^export\s+/gm, '')
  const intent = { requestId: 'request-1', transactionId: null, chargeRequestedAt: '2026-09-10', amountCents: 600 }
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
    usePrintAgentStore: { getState: () => ({ baseUrl: 'https://agent.local', token: 'token', cashlogyConfigured: true,
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
    toCashlogyError: (error) => error,
    AbortController,
    AbortSignal,
  }
  return runInNewContext(`${code}\n${name}`, dependencies)
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

test('management: background refresh skips a missing intent until an operator reviews it', async () => {
  const source = await readFile(new URL('../src/features/local-printing/cashlogy/useCashlogyScope.ts', import.meta.url), 'utf8')
  assert.match(source, /management\.intent\s*&&\s*!management\.missingIntent/)
})

for (const kind of ['payment', 'management']) {
  test(`${kind}: restored intent and repeated outages stay hidden, backend result opens modal`, async () => {
    let respond
    const store = await loadStore(kind, () => new Promise((resolve, reject) => { respond = { resolve, reject } }))
    store.getState().configureScope({ tenantId: 't', establishmentId: 'v', terminalId: 'd' })
    assert.equal(store.getState().modalOpen, false)
    for (let retry = 0; retry < 2; retry++) {
      const pending = store.getState().recover()
      assert.equal(store.getState().modalOpen, false)
      respond.reject(new Error('Backend offline'))
      await assert.rejects(pending, /Backend offline/)
      assert.equal(store.getState().modalOpen, false)
      assert.equal(store.getState().intent.requestId, 'request-1')
    }
    const pending = store.getState().recover()
    assert.equal(store.getState().modalOpen, false)
    const result = { id: 'operation-1', requestId: 'request-1', status: 'completed', type: 'refill' }
    respond.resolve(kind === 'payment' ? { transaction: result } : { operation: result })
    await pending
    assert.equal(store.getState().modalOpen, true)
    assert.equal(store.getState()[kind === 'payment' ? 'transaction' : 'operation'].id, 'operation-1')
  })

  test(`${kind}: a failed manual recovery keeps the user-opened modal visible`, async () => {
    const store = await loadStore(kind, async () => { throw new Error('Backend offline') })
    store.getState().configureScope({ tenantId: 't', establishmentId: 'v', terminalId: 'd' })
    store.getState()[kind === 'payment' ? 'show' : 'open']()
    await assert.rejects(store.getState().recover(), /Backend offline/)
    assert.equal(store.getState().modalOpen, true)
  })

  for (const status of ['unknown', 'needs_attention']) {
    test(`${kind}: ${status} remains pending and is never resent automatically`, async () => {
      let requests = 0
      const result = { id: 'operation-1', requestId: 'request-1', status, type: 'refill' }
      const store = await loadStore(kind, async () => {
        requests += 1
        return kind === 'payment' ? { transaction: result } : { operation: result }
      })
      store.getState().configureScope({ tenantId: 't', establishmentId: 'v', terminalId: 'd' })

      if (kind === 'payment') await assert.rejects(store.getState().recover())
      else await store.getState().recover()

      const key = kind === 'payment' ? 'transaction' : 'operation'
      assert.equal(requests, 1)
      assert.equal(store.getState()[key].status, status)
      assert.equal(store.getState().modalOpen, true)
      assert.equal(store.getState().intent.requestId, 'request-1')

      if (kind === 'payment') store.getState().discardForRetry()
      else store.getState().clearResolved()
      assert.equal(requests, 1)
      assert.equal(store.getState().intent.requestId, 'request-1')
    })
  }
}

const paymentScope = { tenantId: 't', establishmentId: 'v', terminalId: 'd' }
const absentPayment = () => Object.assign(new Error('Transaction missing'), { status: 404 })
const completedPayment = { id: 'tx-new', requestId: 'request-new', status: 'completed', requestedAmountCents: 600 }

test('payment: health preserves an interrupted-start error and cancel releases the ticket without a backend charge', async () => {
  let requests = 0
  const store = await loadStore('payment', async () => { requests++; throw absentPayment() })
  store.getState().configureScope(paymentScope)
  store.setState({ intent: { ...store.getState().intent, chargeRequestedAt: null }, error: new Error('Interrupted'), modalOpen: true })
  await store.getState().checkHealth()
  assert.equal(store.getState().error.message, 'Interrupted')
  await store.getState().cancel()
  assert.equal(store.getState().intent, null)
  assert.equal(store.getState().modalOpen, false)
  assert.equal(store.getState().isCancelling, false)
  assert.equal(requests, 0)
})

test('payment: a confirmed 404 is exposed separately and does not keep retrying in the background', async () => {
  const store = await loadStore('payment', async () => { throw absentPayment() })
  store.getState().configureScope(paymentScope)
  await assert.rejects(store.getState().recover(), (error) => error.code === 'CASHLOGY_TRANSACTION_NOT_FOUND')
  assert.equal(store.getState().missingTransaction, true)
  assert.equal(store.getState().isRecovering, false)
  assert.ok(store.getState().intent)
  const source = await readFile(new URL('../src/features/local-printing/cashlogy/useCashlogyScope.ts', import.meta.url), 'utf8')
  assert.match(source, /!payment\.missingTransaction/)
})

test('payment: cancelling an absent operation checks health and releases only the local intent', async () => {
  let checks = 0
  const store = await loadStore('payment', async () => { throw absentPayment() }, {
    getCashlogyHealth: async () => { checks++; return { activeTransaction: null } },
    client: { cancelCashlogyTransaction: async () => assert.fail('Cannot cancel a nonexistent transaction') },
  })
  store.getState().configureScope(paymentScope)
  await store.getState().cancel()
  assert.equal(checks, 1)
  assert.equal(store.getState().intent, null)
  assert.equal(store.getState().modalOpen, false)
})

test('payment: timeout is not absence and cancellation retains the unresolved charge', async () => {
  const store = await loadStore('payment', async () => { throw new Error('Backend offline') })
  store.getState().configureScope(paymentScope)
  await assert.rejects(store.getState().cancel(), /Backend offline/)
  assert.ok(store.getState().intent)
  assert.equal(store.getState().missingTransaction, false)
  assert.equal(store.getState().isCancelling, false)
})

test('payment: active cancellation waits for the agent result then closes the modal and unlocks the ticket', async () => {
  const active = { id: 'tx', requestId: 'request-1', status: 'waiting_for_cash' }
  const cancelled = { ...active, status: 'cancelled' }
  let cancellations = 0
  const store = await loadStore('payment', async () => ({ transaction: active }), {
    client: { cancelCashlogyTransaction: async (id) => { assert.equal(id, active.id); cancellations++; return { transaction: cancelled } } },
  })
  store.getState().configureScope(paymentScope)
  store.setState({ transaction: active, modalOpen: true })
  await store.getState().cancel()
  assert.equal(cancellations, 1)
  assert.equal(store.getState().intent, null)
  assert.equal(store.getState().modalOpen, false)
})

test('payment: missing retry creates a new charge directly and never calls recover for a nonexistent operation', async () => {
  let charges = 0
  const store = await loadStore('payment', async () => { throw absentPayment() }, { client: {
    recoverCashlogyTransaction: async () => assert.fail('Cannot recover a nonexistent operation'),
    getCashlogyLevels: async () => ({ levels: [] }),
    createCashlogyCharge: async (payload) => { charges++; assert.equal(payload.requestId, 'request-new'); assert.equal(payload.amountCents, 600); assert.equal(payload.saleId, 'sale-original'); return { transaction: completedPayment } },
  } })
  store.getState().configureScope(paymentScope)
  store.setState({ intent: { ...store.getState().intent, saleId: 'sale-original' }, missingTransaction: true })
  assert.equal((await store.getState().retryPayment(true)).status, 'completed')
  assert.equal(charges, 1)
  assert.equal(store.getState().intent.requestId, 'request-new')
})

test('payment: known unknown retry recovers then closes the reviewed operation before sending a new charge', async () => {
  const calls = []
  const previous = { id: 'tx-old', requestId: 'request-1', status: 'unknown' }
  let queued
  const store = await loadStore('payment', async () => { calls.push('lookup'); return { transaction: previous } }, {
    acknowledgements: { contains: () => false, add: (id, reviewed) => { queued = [id, reviewed] }, flush: async (acknowledge) => { if (queued) { await acknowledge(...queued); queued = null } } },
    client: {
      recoverCashlogyTransaction: async (id) => { assert.equal(id, previous.id); calls.push('recover'); return { transaction: previous } },
      acknowledgeCashlogyTransaction: async (id, reviewed) => { assert.equal(id, previous.id); assert.equal(reviewed, true); calls.push('close') },
      getCashlogyLevels: async () => ({ levels: [] }),
      createCashlogyCharge: async () => { calls.push('charge'); return { transaction: completedPayment } },
    },
  })
  store.getState().configureScope(paymentScope)
  store.setState({ transaction: previous })
  await store.getState().retryPayment(true)
  assert.deepEqual(calls, ['lookup', 'recover', 'close', 'charge'])
})

test('payment: a retry that discovers the original completed charge does not charge again', async () => {
  const original = { ...completedPayment, id: 'tx-original', requestId: 'request-1' }
  const store = await loadStore('payment', async () => ({ transaction: original }), { client: {
    recoverCashlogyTransaction: async () => ({ transaction: original }),
    createCashlogyCharge: async () => assert.fail('Must not charge a confirmed payment twice'),
  } })
  store.getState().configureScope(paymentScope)
  const result = await store.getState().retryPayment(true)
  assert.equal(result.id, original.id)
  assert.equal(store.getState().intent.requestId, 'request-1')
})

test('payment: a late recovery response cannot reopen an operation cancelled while recovery was pending', async () => {
  let respond
  let lookups = 0
  const store = await loadStore('payment', async () => {
    lookups++
    if (lookups === 1) return new Promise((resolve) => { respond = resolve })
    throw absentPayment()
  })
  store.getState().configureScope(paymentScope)
  store.getState().show()
  const recovery = store.getState().recover()
  const rejection = assert.rejects(recovery, (error) => error.code === 'CASHLOGY_OPERATION_CANCELLED')
  await store.getState().cancel()
  respond({ transaction: completedPayment })
  await rejection
  assert.equal(store.getState().intent, null)
  assert.equal(store.getState().transaction, null)
  assert.equal(store.getState().modalOpen, false)
})

test('payment: cancelling during health prevents a late start from submitting a charge', async () => {
  let respond
  const store = await loadStore('payment', async () => assert.fail('No transaction lookup expected'), {
    getCashlogyHealth: () => new Promise((resolve) => { respond = resolve }),
    client: { createCashlogyCharge: async () => assert.fail('Cancelled start must not submit a charge') },
  })
  store.getState().configureScope(paymentScope)
  store.setState({ intent: null })
  const start = store.getState().startPayment(600, 'sale')
  const rejection = assert.rejects(start, (error) => error.code === 'CASHLOGY_OPERATION_CANCELLED')
  // startPayment first awaits the persisted acknowledgement queue.
  await new Promise((resolve) => setImmediate(resolve))
  await store.getState().cancel()
  respond({ enabled: true, ok: true, sessionState: 'ready' })
  await rejection
  assert.equal(store.getState().intent, null)
  assert.equal(store.getState().modalOpen, false)
})

test('payment: cancellation timeout restores controls and retains the pending operation for another attempt', async () => {
  const active = { id: 'tx', requestId: 'request-1', status: 'processing' }
  let polls = 0
  const store = await loadStore('payment', async () => ({ transaction: active }), {
    poll: async (_get, current, options) => {
      assert.equal(options.timeoutMs, 30_000)
      if (++polls === 1) throw Object.assign(new Error('Cashlogy sigue pendiente'), { code: 'CASHLOGY_CONNECTION_TIMEOUT' })
      return { ...current, status: 'completed' }
    },
  })
  store.getState().configureScope(paymentScope)
  store.setState({ transaction: active, modalOpen: true })
  await assert.rejects(store.getState().cancel(true), /sigue pendiente/)
  assert.equal(store.getState().isCancelling, false)
  assert.equal(store.getState().isPolling, false)
  assert.equal(store.getState().modalOpen, true)
  assert.ok(store.getState().intent)
  assert.equal(store.getState().transaction.status, 'processing')
  await store.getState().cancel(true)
  assert.equal(store.getState().intent, null)
  assert.equal(store.getState().modalOpen, false)
})

test('payment: late-phase cancellation waits for the physical result after explicit review', async () => {
  const dispensing = { id: 'tx', requestId: 'request-1', status: 'dispensing_change' }
  let polls = 0
  const store = await loadStore('payment', async () => ({ transaction: dispensing }), {
    poll: async (_get, current) => { polls++; return { ...current, status: 'completed' } },
    client: { cancelCashlogyTransaction: async () => assert.fail('Must not interrupt a non-cancellable dispense') },
  })
  store.getState().configureScope(paymentScope)
  store.setState({ transaction: dispensing, modalOpen: true })
  await assert.rejects(store.getState().cancel(), /Revisa el efectivo/)
  assert.ok(store.getState().intent)
  assert.equal(polls, 0)
  await store.getState().cancel(true)
  assert.equal(polls, 1)
  assert.equal(store.getState().intent, null)
  assert.equal(store.getState().modalOpen, false)
})
