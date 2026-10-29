import * as customPayments from '../src/lib/customPayments.ts'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const paymentSource = await read('src/features/quick-sale/hooks/useQuickSalePayment.ts')

const storeSource = await read('src/features/local-printing/cashlogy/useCashlogyStore.ts')
const identitySource = storeSource.match(/export function getCashlogyPaymentSaleId[\s\S]*?\n}/)[0]

function compile(source, modules, globals = {}) {
  const exports = {}
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  vm.runInNewContext(code, { exports, Error, require: (name) => {
    assert.ok(name in modules, `Missing dependency: ${name}`)
    return modules[name]
  }, ...globals })
  return exports
}

function harness({ saleId = null, lines = [{ quantity: 1 }], intentPatch = {}, busySync = false, secondaryFailure = false, fiscal = false, syncFails = false, bridgeFails = false } = {}) {
  const transaction = { id: 'tx', requestId: 'req', saleId, requestedAmountCents: 600, status: 'completed' }
  const state = { modalOpen: true, intent: { requestId: 'req', transactionId: 'tx', saleId: 'sale', amountCents: 600, ...intentPatch }, transaction }
  const calls = { events: [], errors: [], charges: 0, finishes: 0, prints: 0, economicSyncs: 0, economicConfirmed: false, bridgeSyncs: 0 }
  const store = { getState: () => state }
  const { getCashlogyPaymentSaleId } = compile(identitySource, {}, { useCashlogyStore: store })
  let releaseSync
  const sync = busySync ? new Promise((resolve) => { releaseSync = resolve }) : Promise.resolve()
  const cashlogy = {
    isCashlogyPaymentConfigured: () => true,
    getCashlogyPaymentSaleId,
    getCashlogyPaymentAmounts: () => ({ receivedCents: 600, changeCents: 0 }),
    settleCashlogyPaymentIfConfigured: async () => { calls.charges++; throw new Error('Must not charge twice') },
    finishCashlogyPayment: () => { calls.finishes++; state.intent = null; state.modalOpen = false },
  }
  let operation
  const { useQuickSalePayment: createPayment } = compile(paymentSource, {
    react: { useRef: (current) => ({ current }), useCallback: (callback) => callback, useEffect() {} },
    '../../../lib/observability.ts': { reportOperationError() {}, operationBreadcrumb() {} },
    '../../../utils/errors.ts': { getReadableError: (error) => error.message },
    '../../../lib/format': { createId: () => 'event' },
    '../../../lib/offlineStore': { enqueueOfflineEvent: (event) => calls.events.push(event) },
    '../../../lib/durableSales.ts': {
      paymentScope: () => 'scope', withPaymentLock: (_key, work) => work(),
      loadPaymentOperations: async () => operation ? [operation] : [],
      preparePaymentOperation: async (key, fingerprint, payload, params) => operation ??= { key, fingerprint, payload, params, state: 'prepared', eventId: 'event', cashlogy: null },
      acceptPaymentOperation: async (current, payload, cashlogy) => operation = { ...current, payload, cashlogy, state: 'accepted' },
      markPaymentCharging: async current => operation = { ...current, state: 'charging' },
      discardPreparedPaymentOperation: async () => { operation = undefined },
      commitPaymentOperation: async (current, payload) => { operation = { ...current, payload, state: 'committed' }; calls.events.push({ payload }) },
    },
    '../../../lib/customPayments': customPayments,
    '../services/salePayload': { buildSalePayload: (_context, _session, _lines, _method, _received, _discount, _customer, identity) => ({
      sale: { id: identity?.saleId ?? 'new-sale', totalCents: 600, createdAt: 'now', paymentMethod: _method }, ticket: { id: 'ticket' }, payment: {},
    }) },
    '../../fiscal/service': { loadFiscalReceiptData: async () => null },
    '../../customers/service': { loadTicketInvoice: async () => null },
    '../../../services/posService': { loadSessionTicketFromSupabase: async () => null },
    '../../local-printing/cashlogy/useCashlogyStore': cashlogy,
    '../../local-printing/services/earlyCashDrawer': { requestEarlyCashDrawer: () => false },
    '../../fiscal/local/mode.ts': { assertRealSaleAllowed() {} },
    '../../fiscal/local/tenantMode.ts': { assertRealSaleAllowed() {}, resolveLocalFiscalMode: async () => fiscal ? 'production' : 'disabled' },
    '../../fiscal/local/posInvoice.ts': {
      preflightPosInvoice: async () => ({}),
      issuePosInvoice: async () => {
        assert.ok(fiscal, 'production disabled')
        return { record: { tenantId: 'tenant', fiscalSubjectId: 'subject', installationId: 'installation' } }
      },
      printPayloadWithLocalFiscal: (payload) => payload,
    },
    '../../fiscal/local/economicSync.ts': { synchronizeFiscalEconomicSales: async () => {
      calls.economicSyncs++
      if (syncFails) throw new Error('Economic sync unavailable')
      await sync
      calls.economicConfirmed = true
    } },
    '../../fiscal/local/sync.ts': { synchronizeLocalFiscalQueue: async config => {
      assert.equal(calls.economicConfirmed, true, 'bridge delivery must follow economic acknowledgement')
      assert.deepEqual({ ...config, getAccessToken: undefined }, { tenantId: 'tenant', fiscalSubjectId: 'subject', installationId: 'installation', mode: 'production', baseUrl: 'https://bridge.example', getAccessToken: undefined })
      calls.bridgeSyncs++
      if (bridgeFails) throw new Error('Bridge unavailable')
    } },
    '../../fiscal/local/installation.ts': { fiscalBridgeAccessToken: async () => '', fiscalBridgeBaseUrl: () => fiscal ? 'https://bridge.example' : '' },
  })
  const pay = createPayment({ context: { tenantId: 'tenant' }, cashSession: { id: 'session' }, lines,
    ledger: [], tickets: [], isOnline: true, persistLedger() { if (secondaryFailure) throw new Error('QuotaExceeded') }, persistTickets() {}, persistLines() {},
    mergeProductStats() { if (secondaryFailure) throw new Error('Stats failed') }, resetUi() {}, refreshPendingCount() {}, syncPendingEvents: () => sync,
    printSale: async () => { calls.prints++ }, onError: (error) => calls.errors.push(error),
  })
  return { state, calls, pay, transaction, releaseSync, getCashlogyPaymentSaleId }
}

test('fiscal payment and printing finish while Supabase is pending, then bridge delivery starts immediately after acknowledgement', async () => {
  const h = harness({ fiscal: true, busySync: true })
  await h.pay('cash', null, h.transaction)
  await new Promise(setImmediate)
  assert.equal(h.calls.finishes, 1)
  assert.equal(h.calls.events.length, 1)
  assert.equal(h.calls.prints, 1)
  assert.equal(h.calls.economicSyncs, 1)
  assert.equal(h.calls.bridgeSyncs, 0)
  h.releaseSync()
  await new Promise(setImmediate)
  assert.equal(h.calls.bridgeSyncs, 1)
  assert.equal(h.calls.charges, 0)
})

for (const failure of ['economic', 'bridge']) test(`a fiscal ${failure} outage keeps the committed payment and printing without another charge`, async () => {
  const h = harness({ saleId: 'sale', fiscal: true, syncFails: failure === 'economic', bridgeFails: failure === 'bridge' })
  await h.pay('cash', null, h.transaction)
  await new Promise(setImmediate)
  assert.equal(h.calls.events.length, 1)
  assert.equal(h.calls.prints, 1)
  assert.equal(h.calls.finishes, 1)
  assert.equal(h.calls.bridgeSyncs, failure === 'bridge' ? 1 : 0)
  await h.pay('cash', null, h.transaction)
  assert.equal(h.calls.events.length, 1)
  assert.equal(h.calls.charges, 0)
})

test('cache or statistics failure after durable commit never rejects a recovered charge or charges again', async () => {
  const h = harness({ secondaryFailure: true, saleId: 'sale' })
  await h.pay('cash', null, h.transaction)
  assert.equal(h.calls.events.length, 1)
  assert.equal(h.calls.finishes, 1)
  await h.pay('cash', null, h.transaction)
  assert.equal(h.calls.events.length, 1)
  assert.equal(h.calls.charges, 0)
  assert.ok(h.calls.errors.some(error => /guardada/.test(error)))
})

test('no reutiliza la identidad de otro intento ni pierde el cobro cuando falta el ticket', async () => {
  for (const config of [{ lines: [] }, { intentPatch: { requestId: 'other' } },
    { intentPatch: { amountCents: 700 } }, { intentPatch: { transactionId: 'other' } },
    { intentPatch: { recoveredFromConflict: true } }]) {
    const h = harness(config)
    await assert.rejects(h.pay('cash', null, h.transaction), /ticket|identificable/)
    assert.equal(h.calls.events.length, 0)
    assert.equal(h.calls.charges, 0)
    assert.equal(h.calls.finishes, 0)
    assert.ok(h.state.intent)
  }
})
