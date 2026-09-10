import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

// Execute the real store actions with isolated storage/network dependencies.
async function loadStore(kind, request) {
  const name = kind === 'payment' ? 'useCashlogyStore' : 'useCashlogyManagementStore'
  const source = await readFile(new URL(`../src/features/local-printing/cashlogy/${name}.ts`, import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, '').replace(/^export\s+/gm, '')
  const intent = { requestId: 'request-1', transactionId: null, chargeRequestedAt: '2026-09-10', amountCents: 600 }
  const dependencies = {
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
    }),
    usePrintAgentStore: { getState: () => ({ baseUrl: 'https://agent.local', token: 'token' }) },
    loadCashlogyIntent: () => intent,
    loadCashlogyManagementIntent: () => intent,
    saveCashlogyIntent: () => {},
    saveCashlogyManagementIntent: () => {},
    cashlogyAcknowledgements: () => ({ contains: () => false, flush: async () => {} }),
    getBlockingCashlogyTransactionId: () => null,
    cashlogyActiveStatuses: new Set(['waiting_for_cash']),
    cashlogyManagementActiveStatuses: new Set(['accepting']),
    getCompletedStackerCollection: () => null,
    reportOperationError: () => {},
    toCashlogyError: (error) => error,
    AbortController,
  }
  return runInNewContext(`${code}\n${name}`, dependencies)
}

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
}
