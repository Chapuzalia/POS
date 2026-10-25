import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import * as ledger from '../src/features/fiscal/local/localLedger.ts'
import * as durable from '../src/lib/durableSales.ts'
import { compileComponent, createCompiledHookRunner } from './helpers/component-harness.mjs'
import { withConfirmedRestaurantPayments } from '../src/features/restaurant/services/paymentPayload.ts'

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
const context = { tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'cashier' }
const session = { id: 'session' }
const draft = () => ({ ticket: { id: 'draft-ticket', totalCents: 600 },
  sale: { id: 'stable-sale', tenantId: 'tenant', totalCents: 600, paymentMethod: 'cash' },
  payment: { id: 'payment', receivedCents: 600 }, lines: [{ id: 'draft-line', unitPriceCents: 600 }] })
const preparedEntry = () => ({ id: 'record', scope: 'tenant:subject:installation',
  record: { idempotencyKey: 'record', tenantId: 'tenant', fiscalSubjectId: 'subject', installationId: 'installation',
    venueId: 'venue', deviceId: 'device', environment: 'production', chainPosition: 1, previous: null, hash: 'A'.repeat(64), invoiceId: 'invoice',
    canonicalRecord: { RegistroAlta: { IDFactura: { FechaExpedicionFactura: '11-10-2026', NumSerieFactura: 'L1-C1-2026-S/1' } } } },
  invoice: { ticketId: 'draft-ticket', saleId: 'stable-sale', paymentId: 'payment', issuerNif: 'B12345678', series: 'L1-C1-2026-S', number: 1, totalCents: 600 },
  delivery: { state: 'LOCAL_PENDING', attempts: 0 } })
function setup() {
  globalThis.indexedDB = new IDBFactory()
  globalThis.window = { location: { pathname: '/pos' } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_key, _options, work) => work() } } })
}

test('a lost checkout-reservation response recovers the original prepared operation before collecting money', async () => {
  setup()
  const operations = [],phases = []
  const service = compileComponent(source('features/restaurant/services/payment.ts'), {
    './paymentPayload.ts': { withConfirmedRestaurantPayments },
    './checkout.ts': {
      prepareRestaurantCheckout: async (_context,id,_action,params) => {
        operations.push(id)
        assert.equal(params.cashSessionId,session.id)
        if (operations.length === 1) throw new Error('Reservation response lost')
        phases.push('reserved')
      },
      startRestaurantCheckout: async () => phases.push('started'),releaseRestaurantCheckout: assert.fail,
    },
    '../../../lib/durableSales.ts': durable,
    '../../local-printing/cashlogy/useCashlogyStore.ts': {
      isCashlogyPaymentConfigured: () => true,
      settleCashlogyPaymentIfConfigured: async () => { phases.push('hardware'); return null },
      getCashlogyPaymentAmounts: () => ({ receivedCents:600,changeCents:0 }),
    },
    '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode: async () => 'disabled' },
    '../../fiscal/local/posInvoice.ts': {},'../../fiscal/local/restaurantInvoice.ts': {},
    '../../tables/service.ts': { payRestaurantIdempotent: async () => ({ ticketId:'ticket',saleId:'sale',paymentId:'payment',totalCents:600 }) },
  }, { JSON })
  await assert.rejects(service.payRestaurantSale({ context,session,target:'order',action:'close',draft:draft(),params:{ orderId:'order',method:'cash' } }),/Reservation response lost/)
  assert.deepEqual(phases,[])
  const pending = await durable.loadPendingPaymentOperations(context,session.id)
  assert.equal(pending.length,1)
  assert.equal(pending[0].state,'prepared')
  const [recovered] = await service.recoverRestaurantPayments(context,session)
  assert.equal(recovered.result.saleId,'sale')
  assert.equal(operations[0],operations[1])
  assert.deepEqual(phases,['reserved','started','hardware'])
  assert.equal((await durable.loadPendingPaymentOperations(context,session.id)).length,0)
})

for (const failure of ['lost_reply', 'local_quota']) test(`restaurant recovery preserves the exact fiscal envelope after ${failure}`, async () => {
  setup()
  let preparations = 0, economicSales = 0, requests = 0
  const receipts = new Map()
  const envelopes = []
  const deliveries = []
  const remote = { ticketId: 'remote-ticket', saleId: 'remote-sale', paymentId: 'remote-payment', totalCents: 600 }
  const service = compileComponent(source('features/fiscal/local/restaurantInvoice.ts'), {
    '../../restaurant/services/paymentPayload.ts': { withConfirmedRestaurantPayments },
    './localLedger.ts': ledger,
    './installation.ts': { fiscalBridgeBaseUrl: () => 'https://bridge.example', fiscalBridgeAccessToken: async () => 'token' },
    './sync.ts': { synchronizeLocalFiscalQueue: async config => { deliveries.push(config) } },
    './posInvoice.ts': {
      issuePosInvoice: async (_context, _session, _draft, _synced, resolve) => {
        preparations++
        const entry = preparedEntry()
        entry.invoice.transmissionMode = 'bridge'
        await resolve(entry)
        throw new Error('Storage full after server commit')
      },
      printPayloadWithLocalFiscal: (payload, entry) => ({ ...payload, localFiscal: { recordId: entry.id } }),
    },
    '../../tables/service.ts': { payRestaurantLocalFiscal: async (_action, _params, record, invoice) => {
      requests++
      envelopes.push({ record: structuredClone(record), invoice: structuredClone(invoice) })
      if (!receipts.has(record.idempotencyKey)) { receipts.set(record.idempotencyKey, remote); economicSales++ }
      if (failure === 'lost_reply' && requests === 1) throw new Error('Network response lost')
      return receipts.get(record.idempotencyKey)
    } },
  })
  const params = { orderId: 'order', allowPending: true }
  await assert.rejects(service.issueRestaurantInvoice(context, session, draft(), 'close', params), /lost|Storage full/)
  assert.equal(deliveries.length, 0, 'an unconfirmed/unpersisted restaurant invoice must not be delivered')
  const recovered = await service.issueRestaurantInvoice(context, session, draft(), 'close', params)
  assert.equal(preparations, 1)
  assert.equal(economicSales, 1)
  assert.equal(requests, 2)
  assert.deepEqual(envelopes[0], envelopes[1])
  assert.equal(recovered.payload.sale.id, 'remote-sale')
  assert.equal(deliveries.length, 1, 'recovered restaurant records must be delivered immediately')
  const saved = await ledger.findLocalFiscalEntryByTicket(preparedEntry().record, 'remote-ticket')
  assert.equal(saved.id, 'record')
  assert.equal((await ledger.listLocalFiscalEconomicSales(preparedEntry().record))[0].payload.sale.id, 'remote-sale')
  await ledger.assertRestaurantPaymentsReconciled(preparedEntry().record)
})

test('an unresolved fiscal payment blocks a new fiscal issue until the original response is reconciled', async () => {
  setup()
  const db = await ledger.openLedger()
  const tx = db.transaction('restaurantPayments', 'readwrite')
  const done = ledger.transactionDone(tx)
  tx.objectStore('restaurantPayments').put({ key: 'operation', entry: preparedEntry() })
  await done; db.close()
  await assert.rejects(ledger.assertRestaurantPaymentsReconciled(preparedEntry().record), /pendiente de conciliar/)
})

test('invalid VAT/identity fails before Cashlogy; a corrected preflight can safely retry', async () => {
  setup()
  let charges = 0, preflights = 0
  const service = compileComponent(source('features/restaurant/services/payment.ts'), {
    './checkout.ts': { prepareRestaurantCheckout: async () => {}, releaseRestaurantCheckout: async () => true, startRestaurantCheckout: async () => {} },
    './paymentPayload.ts': { withConfirmedRestaurantPayments },
    '../../../lib/durableSales.ts': durable,
    '../../local-printing/cashlogy/useCashlogyStore.ts': { settleCashlogyPaymentIfConfigured: async () => { charges++; throw new Error('Reached hardware') } },
    '../../fiscal/local/mode.ts': { assertRealSaleAllowed() {} },
    '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode: async () => 'production' },
    '../../fiscal/local/posInvoice.ts': { preflightPosInvoice: async () => { preflights++; throw new Error('IVA sin resolver') } },
    '../../fiscal/local/restaurantInvoice.ts': {}, '../../tables/service.ts': {},
  }, { JSON })
  const input = { context, session, target: 'order', action: 'close', draft: draft(), params: { method: 'cash' } }
  await assert.rejects(service.payRestaurantSale(input), /IVA sin resolver/)
  await assert.rejects(service.payRestaurantSale({ ...input, draft: { ...draft(), lines: [] } }), /IVA sin resolver/)
  assert.equal(charges, 0)
  assert.equal(preflights, 2)
})

for (const state of ['accepted', 'restarted']) test(`opening a session restores a ${state} quick payment without a draft, another charge or new sale ids`, async () => {
  setup()
  const key = `${durable.paymentScope(context, session.id)}|quick-sale`
  const original = { ...draft(), sale: { ...draft().sale, createdAt: '2026-10-11T10:00:00Z' },
    ticket: { ...draft().ticket, tenantId: 'tenant' }, payment: { ...draft().payment, method: 'cash' } }
  const operation = await durable.preparePaymentOperation(key, 'old-draft', original, { sourceLineIds: ['old-line'] })
  if (state === 'accepted') await durable.acceptPaymentOperation(operation, original, { id: 'confirmed', requestId: 'request' })
  else await durable.updateCashlogyPaymentAttempt({ paymentOperationKey: key, requestId: 'new-after-restart', saleId: 'stable-sale' },
    { tenantId: 'tenant', establishmentId: 'venue', terminalId: 'device' }, { type: 'start' })
  let charges = 0, drafts = 0, prints = 0
  const errors = []
  const runner = createCompiledHookRunner(source('features/quick-sale/hooks/useQuickSalePayment.ts'), 'useQuickSalePayment', {
    '../../../lib/durableSales.ts': durable,
    '../../../lib/observability.ts': { reportOperationError() {}, operationBreadcrumb() {} },
    '../../../utils/errors.ts': { getReadableError: error => error.message },
    '../../../services/posService': {},
    '../services/salePayload': { buildSalePayload: () => { drafts++; throw new Error('New sale') } },
    '../../customers/service': {},
    '../../local-printing/cashlogy/useCashlogyStore': {
      isCashlogyPaymentConfigured: () => true, getCashlogyPaymentSaleId: transaction => transaction.saleId,
      getCashlogyPaymentAmounts: () => ({ receivedCents: 600, changeCents: 0 }), finishCashlogyPayment() {},
      settleCashlogyPaymentIfConfigured: async (amount, saleId, requestId, recovery, operationKey) => {
        if (state === 'accepted') { charges++; throw new Error('Second charge') }
        assert.equal(amount, 600)
        assert.equal(saleId, 'stable-sale')
        assert.equal(requestId, 'new-after-restart')
        assert.equal(recovery, true)
        assert.equal(operationKey, key)
        return { id: 'confirmed-new', requestId, saleId, requestedAmountCents: amount, status: 'completed' }
      },
    },
    '../../local-printing/services/earlyCashDrawer': { requestEarlyCashDrawer: () => false },
    '../../fiscal/local/mode.ts': { assertRealSaleAllowed() {} },
    '../../fiscal/local/tenantMode.ts': { assertRealSaleAllowed() {}, resolveLocalFiscalMode: async () => 'disabled' },
    '../../fiscal/local/posInvoice.ts': {}, '../../fiscal/local/economicSync.ts': {},
    '../../fiscal/local/sync.ts': {}, '../../fiscal/local/installation.ts': {},
  })
  runner.render({ context, cashSession: session, lines: [], ledger: [], tickets: [], isOnline: false,
    persistLines() {}, resetUi() {}, persistLedger() {}, persistTickets() {}, mergeProductStats() {}, refreshPendingCount() {},
    printSale: async () => { prints++ }, onError: error => errors.push(error) })
  for (let i = 0; i < 30 && (await durable.loadPaymentOperation(key)).state !== 'committed'; i++) await new Promise(setImmediate)
  await new Promise(setImmediate)
  assert.equal((await durable.loadPaymentOperation(key)).state, 'committed')
  assert.equal((await durable.loadDurableEvents())[0].payload.sale.id, 'stable-sale')
  assert.equal(charges, 0)
  assert.equal(drafts, 0)
  assert.equal(prints, 1)
  assert.ok(errors.some(error => /recuperado/.test(error)))
})
