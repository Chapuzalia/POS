import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import * as ledger from '../src/features/fiscal/local/localLedger.ts'
import * as durable from '../src/lib/durableSales.ts'
import { compileComponent, createCompiledHookRunner } from './helpers/component-harness.mjs'

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

for (const failure of ['lost_reply', 'local_quota']) test(`restaurant recovery preserves the exact fiscal envelope after ${failure}`, async () => {
  setup()
  let preparations = 0, economicSales = 0, requests = 0
  const receipts = new Map()
  const envelopes = []
  const deliveries = []
  const remote = { ticketId: 'remote-ticket', saleId: 'remote-sale', paymentId: 'remote-payment', totalCents: 600 }
  const service = compileComponent(source('features/fiscal/local/restaurantInvoice.ts'), {
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

test('restaurant retry after activation and a lost RPC reply preserves its legacy receipt and Cashlogy confirmation', async () => {
  setup()
  let charges = 0, attempts = 0, economicSales = 0
  const ids = []
  const parameters = []
  const results = new Map()
  let mode = 'disabled'
  const service = compileComponent(source('features/restaurant/services/payment.ts'), {
    '../../../lib/durableSales.ts': durable,
    '../../local-printing/cashlogy/useCashlogyStore.ts': {
      isCashlogyPaymentConfigured: () => true,
      settleCashlogyPaymentIfConfigured: async () => { charges++; return { id: 'cashlogy', requestId: 'cashlogy-request', requestedAmountCents: 600, saleId: 'stable-sale' } },
      getCashlogyPaymentAmounts: () => ({ receivedCents: 600, changeCents: 0 }),
    },
    '../../fiscal/local/mode.ts': { assertRealSaleAllowed() {} },
    '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode: async () => mode },
    '../../fiscal/local/posInvoice.ts': {}, '../../fiscal/local/restaurantInvoice.ts': {},
    '../../tables/service.ts': { payRestaurantIdempotent: async (_context, id, _action, params) => {
      parameters.push(params)
      ids.push(id); attempts++
      if (!results.has(id)) { results.set(id, { ticketId: 'ticket', saleId: 'sale', totalCents: 600 }); economicSales++ }
      if (attempts === 1) throw new Error('Network response lost')
      return results.get(id)
    } },
  }, { JSON })
  const input = { context, session, target: 'order', action: 'close', draft: draft(), params: { orderId: 'order', method: 'cash', allowPending: true } }
  await assert.rejects(service.payRestaurantSale(input), /response lost/)
  mode = 'production'
  // Recover without opening an order that the server may already have closed.
  const [recovered] = await service.recoverRestaurantPayments(context, session)
  assert.equal(recovered.result.saleId, 'sale')
  assert.equal(charges, 1)
  assert.equal(economicSales, 1)
  assert.equal(ids[0], ids[1])
  assert.deepEqual(parameters[1], parameters[0])
  await service.payRestaurantSale(input)
  assert.equal(attempts, 2)
})

test('invalid VAT/identity fails before Cashlogy; a corrected preflight can safely retry', async () => {
  setup()
  let charges = 0, preflights = 0
  const service = compileComponent(source('features/restaurant/services/payment.ts'), {
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

test('activation before the first restaurant DB commit fiscalizes the accepted payment only after a confirmed legacy rollback', async () => {
  setup()
  const key=`${durable.paymentScope(context,session.id)}|restaurant:close:order`
  const original=draft()
  const operation=await durable.preparePaymentOperation(key,'legacy',original,{orderId:'order',method:'cash',fiscalMode:'legacy'})
  await durable.acceptPaymentOperation(operation,original,{id:'confirmed',requestId:'request',requestedAmountCents:600})
  let legacyAttempts=0,fiscalAttempts=0
  const service=compileComponent(source('features/restaurant/services/payment.ts'),{
    '../../../lib/durableSales.ts':durable,
    '../../local-printing/cashlogy/useCashlogyStore.ts':{getCashlogyPaymentAmounts:()=>({receivedCents:600,changeCents:0}),settleCashlogyPaymentIfConfigured:assert.fail},
    '../../fiscal/local/tenantMode.ts':{resolveLocalFiscalMode:async()=> 'production'},
    '../../fiscal/local/posInvoice.ts':{},
    '../../tables/service.ts':{payRestaurantIdempotent:async()=>{legacyAttempts++;throw{code:'55000',message:'LOCAL_FISCAL_RECORD_REQUIRED'}}},
    '../../fiscal/local/restaurantInvoice.ts':{issueRestaurantInvoice:async(_context,_session,payload,_action,params)=>{
      fiscalAttempts++;assert.equal(payload.sale.id,original.sale.id);assert.equal(params.cashlogyRequestId,'request')
      return{payload:{...payload,localFiscal:{recordId:'fiscal'}},result:{ticketId:'ticket',saleId:'sale',totalCents:600}}
    }},
  },{JSON})
  const payment=await service.payRestaurantSale({context,session,target:'order',action:'close',draft:original,params:{orderId:'order',method:'cash'}})
  assert.equal(legacyAttempts,1);assert.equal(fiscalAttempts,1)
  assert.equal(payment.payload.localFiscal.recordId,'fiscal')
  assert.equal((await durable.loadPaymentOperation(key)).state,'committed')
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

test('idempotent restaurant RPC preserves scoped parameters and maps equal split rows for the next payment', async () => {
  const tableSource = source('features/tables/service.ts')
  const selected = ['function requireSupabase', 'function mapEqualSplit', 'export async function payRestaurantIdempotent']
    .map(name => tableSource.slice(tableSource.indexOf(name)).split('\n}')[0] + '\n}').join('\n')
  const rpcCalls = []
  const service = compileComponent(selected, {}, { supabase: { rpc: async (name, params) => {
    rpcCalls.push({ name, params })
    return { data: { requiresConfirmation: false, paidAmountCents: 600, split: {
      id: 'split', order_id: 'order', total_cents: 1200, part_count: 2, paid_parts: 1, paid_cents: 600,
    } }, error: null }
  } } })
  const result = await service.payRestaurantIdempotent(context, 'original-operation', 'equal_part', { splitId: 'split', method: 'card' })
  assert.equal(rpcCalls[0].name, 'pay_restaurant_idempotent')
  assert.equal(rpcCalls[0].params.p_operation_id, 'original-operation')
  assert.equal(rpcCalls[0].params.p_tenant_id, 'tenant')
  assert.equal(rpcCalls[0].params.p_venue_id, 'venue')
  assert.equal(rpcCalls[0].params.p_device_id, 'device')
  assert.equal(result.split.paidParts, 1)
  assert.equal(result.split.nextPartCents, 600)
  assert.equal(result.split.remainingParts, 1)
})
