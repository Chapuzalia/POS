import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import * as durable from '../src/lib/durableSales.ts'
import { createCompiledHookRunner } from './helpers/component-harness.mjs'

const source = readFileSync(new URL('../src/features/quick-sale/hooks/useQuickSalePayment.ts', import.meta.url), 'utf8')
const context = { tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'cashier' }
const session = { id: 'session' }
const originalPayload = {
  ticket: { id: 'old-ticket', tenantId: 'tenant' },
  sale: { id: 'old-sale', tenantId: 'tenant', totalCents: 600, paymentMethod: 'cash', createdAt: '2026-10-25T10:00:00Z' },
  payment: { id: 'old-payment', method: 'cash', receivedCents: 600 }, lines: [{ id: 'old-persisted-line' }],
}
const flush = async () => { for (let i = 0; i < 35; i++) await new Promise(setImmediate) }

for (const state of ['charging', 'accepted']) for (const legacy of [true, false]) {
  test(`a ${legacy ? 'legacy' : 'per-ticket'} ${state} payment can fail recovery while another ticket is paid and the original remains recoverable`, async () => {
    globalThis.indexedDB = new IDBFactory()
    globalThis.window = { location: { pathname: '/pos' } }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_key, _options, work) => work() } } })
    const originalKey = `${durable.paymentScope(context, session.id)}|quick-sale${legacy ? '' : ':old-sale'}`
    let original = await durable.preparePaymentOperation(originalKey, 'old-draft', originalPayload,
      { sourceLineIds: ['old-line'], fiscalMode: state === 'accepted' ? 'verifactu' : 'legacy' })
    original = state === 'accepted' ? await durable.acceptPaymentOperation(original, originalPayload, { id: 'old-transaction' })
      : await durable.markPaymentCharging(original)
    let failOriginal = true, builds = 0, recoveries = 0
    const errors = [], printed = [], cleared = [], ledgers = [], tickets = []
    const runner = createCompiledHookRunner(source, 'useQuickSalePayment', {
      '../../../lib/durableSales.ts': durable,
      '../../../lib/observability.ts': { reportOperationError() {}, operationBreadcrumb() {} },
      '../../../utils/errors.ts': { getReadableError: error => error.message },
      '../../../services/posService': {}, '../../customers/service': {},
      '../services/salePayload': { buildSalePayload: (_context, _session, lines, method) => {
        builds++
        return { ticket: { id: `new-ticket-${builds}`, tenantId: 'tenant' },
          sale: { id: `new-sale-${builds}`, tenantId: 'tenant', totalCents: 900, paymentMethod: method, createdAt: '2026-10-25T10:01:00Z' },
          payment: { id: `new-payment-${builds}`, method, receivedCents: 900 }, lines: lines.map(line => ({ ...line })) }
      } },
      '../../local-printing/cashlogy/useCashlogyStore': {
        isCashlogyPaymentConfigured: () => true, getCashlogyPaymentSaleId: tx => tx.saleId,
        getCashlogyPaymentAmounts: () => ({ receivedCents: 600, changeCents: 0 }), finishCashlogyPayment() {},
        settleCashlogyPaymentIfConfigured: async (amount, saleId, requestId, recovery, key) => {
          recoveries++
          assert.equal(recovery, true, 'only query the original charge; new tickets use card')
          assert.equal(key, originalKey)
          assert.equal(saleId, 'old-sale')
          if (failOriginal) throw new Error('Cashlogy unavailable')
          return { id: 'old-transaction', saleId, requestId, requestedAmountCents: amount, status: 'completed' }
        },
      },
      '../../local-printing/services/earlyCashDrawer': { requestEarlyCashDrawer: () => false },
      '../../fiscal/local/mode.ts': { assertRealSaleAllowed() {} },
      '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode: async () => state === 'accepted' ? 'production' : 'disabled' },
      '../../fiscal/local/posInvoice.ts': {
        preflightPosInvoice: async (_context, _session, payload) => {
          if (failOriginal && payload.sale.id === 'old-sale') throw new Error('Original fiscal preparation failed')
          return {}
        },
        issuePosInvoice: async () => ({ record: { tenantId: 'tenant', fiscalSubjectId: 'subject', installationId: 'installation' } }),
        printPayloadWithLocalFiscal: payload => payload,
      },
      '../../fiscal/local/economicSync.ts': { synchronizeFiscalEconomicSales: async () => {} },
      '../../fiscal/local/sync.ts': {}, '../../fiscal/local/installation.ts': { fiscalBridgeBaseUrl: () => '' },
    })
    const options = { context, cashSession: session, lines: [{ id: 'new-line' }], discount: null, invoiceCustomer: null,
      ledger: [], tickets: [], isOnline: false, persistLines: lines => cleared.push(lines.map(line => line.id)),
      resetUi() {}, persistLedger: rows => ledgers.push(rows.map(row => row.id)), persistTickets: rows => tickets.push(rows.map(row => row.id)),
      mergeProductStats() {}, refreshPendingCount() {},
      printSale: async payload => printed.push(payload.sale.id), onError: error => errors.push(error) }
    const pay = runner.render(options)
    await flush()
    assert.equal(builds, 0, 'background recovery uses the saved snapshot')
    assert.ok(errors.length > 0)
    assert.deepEqual(await durable.loadPaymentOperation(originalKey), original)

    await pay('card', null)
    await flush()
    assert.equal(builds, 1)
    assert.ok(printed.includes('new-sale-1'))
    assert.deepEqual(cleared, [[]])
    assert.deepEqual(await durable.loadPaymentOperation(originalKey), original)
    const paid = (await durable.loadPaymentOperations(context, session.id)).find(operation => operation.payload.sale.id === 'new-sale-1')
    assert.equal(paid.state, 'committed')
    assert.equal(paid.payload.sale.paymentMethod, 'card')

    failOriginal = false
    await pay('cash', 600, null, originalKey)
    await flush()
    assert.equal((await durable.loadPaymentOperation(originalKey)).state, 'committed')
    assert.equal((await durable.loadPaymentOperation(originalKey)).eventId, original.eventId)
    assert.equal((await durable.loadPaymentOperation(paid.key)).state, 'committed')
    assert.equal(builds, 1, 'recovering the old payment cannot build another sale from the new ticket')
    assert.equal(recoveries, state === 'charging' ? 2 : 0)
    assert.deepEqual(cleared, [[], ['new-line']], 'recovering an old sale never clears unrelated draft lines')
    assert.deepEqual([...ledgers.at(-1)], ['new-sale-1', 'old-sale'])
    assert.deepEqual([...tickets.at(-1)], ['old-sale', 'new-sale-1'])
  })
}
