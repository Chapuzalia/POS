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

for (const action of ['equal_part', 'selected_items']) for (const state of ['fresh', 'accepted']) test(`a ${state} ${action} payment recovers past a confirmed fiscal envelope from the previous payment`, async () => {
  setup()
  let preparations = 0, charges = 0, requests = 0
  let loseReply = true
  const envelopes = []
  const fiscal = compileComponent(source('features/fiscal/local/restaurantInvoice.ts'), {
    '../../restaurant/services/paymentPayload.ts': { withConfirmedRestaurantPayments },
    './localLedger.ts': ledger,
    './installation.ts': { fiscalBridgeBaseUrl: () => null },
    './sync.ts': {},
    './posInvoice.ts': {
      issuePosInvoice: async (_context, _session, payload, _synced, resolve) => {
        const position = ++preparations
        const entry = preparedEntry()
        entry.id = `record-${position}`
        Object.assign(entry.record, { idempotencyKey: entry.id, chainPosition: position,
          previous: position > 1 ? { hash: String(position - 1).repeat(64) } : null,
          hash: String(position).repeat(64) })
        Object.assign(entry.invoice, { number: position, ticketId: payload.ticket.id, saleId: payload.sale.id })
        const confirmed = await resolve(entry)
        Object.assign(entry.invoice, { ticketId: confirmed.ticket.id, saleId: confirmed.sale.id })
        await ledger.reconcileLocalFiscalCopies(entry.record, context.deviceId, [{ entry, economicPayload: confirmed, eventId: entry.id }])
        return entry
      },
      printPayloadWithLocalFiscal: payload => payload,
    },
    '../../tables/service.ts': { payRestaurantLocalFiscal: async (_action, _params, record) => {
      requests++
      envelopes.push(record.idempotencyKey)
      if (record.chainPosition === 2 && loseReply) { loseReply = false; throw new Error('Response lost') }
      return { ticketId: `ticket-${record.chainPosition}`, saleId: `sale-${record.chainPosition}`, paymentId: 'payment', totalCents: 600 }
    } },
  })
  const service = compileComponent(source('features/restaurant/services/payment.ts'), {
    './checkout.ts': { prepareRestaurantCheckout: async () => {}, releaseRestaurantCheckout: async () => true, startRestaurantCheckout: async () => {} },
    './paymentPayload.ts': { withConfirmedRestaurantPayments },
    '../../../lib/durableSales.ts': durable,
    '../../local-printing/cashlogy/useCashlogyStore.ts': {
      isCashlogyPaymentConfigured: () => true,
      settleCashlogyPaymentIfConfigured: async (amount, saleId, requestId) => {
        charges++
        return { id: `cashlogy-${charges}`, saleId, requestId, requestedAmountCents: amount }
      },
      getCashlogyPaymentAmounts: () => ({ receivedCents: 600, changeCents: 0 }),
    },
    '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode: async () => 'verifactu' },
    '../../fiscal/local/posInvoice.ts': { preflightPosInvoice: async () => ({}) },
    '../../fiscal/local/restaurantInvoice.ts': fiscal,
    '../../tables/service.ts': {},
  }, { JSON })
  const params = { orderId: 'order', splitId: 'split', method: 'cash', allowPending: true }
  const input = { context, session, target: action === 'equal_part' ? 'split' : 'order', action, draft: draft(), params, sequence: 0 }
  await service.payRestaurantSale(input)
  // Old clients can leave a new accepted charge beside the previous fiscal journal.
  const key = `${durable.paymentScope(context, session.id)}|restaurant:${action}:${input.target}`
  const nextDraft = { ...draft(), sale: { ...draft().sale, id: 'next-sale' } }
  if (state === 'accepted') {
    const next = await durable.preparePaymentOperation(key, 'next-part', nextDraft, { ...params, fiscalMode: 'verifactu' })
    await durable.acceptPaymentOperation(next, nextDraft, { id: 'already-charged', requestId: 'next-request', requestedAmountCents: 600 })
    await assert.rejects(service.recoverRestaurantPayments(context, session), /Response lost/)
  } else await assert.rejects(service.payRestaurantSale({ ...input, draft: nextDraft, sequence: 1 }), /Response lost/)
  const [recovered] = await service.recoverRestaurantPayments(context, session)
  assert.equal(recovered.result.saleId, 'sale-2')
  assert.equal(charges, state === 'accepted' ? 1 : 2, 'recovery must not charge the accepted second payment again')
  assert.equal(preparations, 2)
  assert.equal(requests, 3)
  assert.deepEqual(envelopes, ['record-1', 'record-2', 'record-2'])
  assert.equal((await durable.loadPaymentOperation(key)).state, 'committed')
  assert.equal((await durable.loadPendingPaymentOperations(context, session.id)).length, 0)
  assert.equal((await durable.loadDurableSessionTickets(context, session.id)).length, 2)
  await ledger.assertRestaurantPaymentsReconciled(preparedEntry().record)
})

for (const invalid of ['unconfirmed', 'hash', 'invoice', 'tenant', 'device', 'action']) test(`a mismatched ${invalid} fiscal envelope cannot be replaced by a new payment`, async () => {
  setup()
  const entry = preparedEntry()
  const pending = { key: 'original-operation', entry, draft: draft(), action: 'selected_items', params: { orderId: 'order' } }
  if (invalid !== 'unconfirmed') {
    const confirmed = structuredClone(entry)
    if (invalid === 'hash') confirmed.record.hash = 'B'.repeat(64)
    if (invalid === 'invoice') confirmed.record.invoiceId = 'another-invoice'
    await ledger.reconcileLocalFiscalCopies(entry.record, context.deviceId, [{ entry: confirmed, economicPayload: draft(), eventId: entry.id }])
  }
  if (invalid === 'tenant') pending.entry.record.tenantId = 'other-tenant'
  if (invalid === 'device') pending.entry.record.deviceId = 'other-device'
  if (invalid === 'action') pending.action = 'close'
  const db = await ledger.openLedger()
  const tx = db.transaction('restaurantPayments', 'readwrite')
  const done = ledger.transactionDone(tx)
  tx.objectStore('restaurantPayments').put(pending)
  await done; db.close()
  const service = compileComponent(source('features/fiscal/local/restaurantInvoice.ts'), {
    '../../restaurant/services/paymentPayload.ts': { withConfirmedRestaurantPayments },
    './localLedger.ts': ledger,
    './installation.ts': {}, './sync.ts': {},
    './posInvoice.ts': { issuePosInvoice: assert.fail },
    '../../tables/service.ts': { payRestaurantLocalFiscal: assert.fail },
  })
  await assert.rejects(service.issueRestaurantInvoice(context, session,
    { ...draft(), sale: { ...draft().sale, id: 'another-sale' } }, 'selected_items', { orderId: 'order' }, null, pending.key), /no pertenece a este cobro/)
  const savedDb = await ledger.openLedger()
  const savedTx = savedDb.transaction('restaurantPayments', 'readonly')
  const savedDone = ledger.transactionDone(savedTx)
  assert.deepEqual(await ledger.request(savedTx.objectStore('restaurantPayments').get(pending.key)), pending)
  await savedDone; savedDb.close()
})

test('restaurant retry after activation and a lost RPC reply preserves its legacy receipt and Cashlogy confirmation', async () => {
  setup()
  let charges = 0, attempts = 0, economicSales = 0
  const ids = []
  const parameters = []
  const results = new Map()
  let mode = 'disabled'
  const service = compileComponent(source('features/restaurant/services/payment.ts'), {
    './checkout.ts': { prepareRestaurantCheckout: async () => {}, releaseRestaurantCheckout: async () => true, startRestaurantCheckout: async () => {} },
    './paymentPayload.ts': { withConfirmedRestaurantPayments },
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

test('activation before the first restaurant DB commit fiscalizes the accepted payment only after a confirmed legacy rollback', async () => {
  setup()
  const key=`${durable.paymentScope(context,session.id)}|restaurant:close:order`
  const original=draft()
  const operation=await durable.preparePaymentOperation(key,'legacy',original,{orderId:'order',method:'cash',fiscalMode:'legacy'})
  await durable.acceptPaymentOperation(operation,original,{id:'confirmed',requestId:'request',requestedAmountCents:600})
  let legacyAttempts=0,fiscalAttempts=0
  const service=compileComponent(source('features/restaurant/services/payment.ts'),{
    './checkout.ts': { prepareRestaurantCheckout: async () => {}, releaseRestaurantCheckout: async () => true, startRestaurantCheckout: async () => {} },
    './paymentPayload.ts': { withConfirmedRestaurantPayments },
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

for (const state of ['charging', 'accepted', 'committed']) test(`applying a ${state} restaurant charge after switching tickets recovers only its original order and replays without another charge`, async () => {
  setup()
  const key = `${durable.paymentScope(context, session.id)}|restaurant:close:old-order`
  const payload = draft()
  let operation = await durable.preparePaymentOperation(key, 'old-draft', payload, { orderId: 'old-order', method: 'cash', fiscalMode: 'legacy' })
  operation = await durable.markPaymentCharging(operation)
  const confirmed = { id: 'confirmed', saleId: payload.sale.id, requestId: operation.cashlogyRequestId, requestedAmountCents: 600, status: 'completed' }
  if (state !== 'charging') operation = await durable.acceptPaymentOperation(operation, payload, confirmed)
  const result = { ticketId: payload.ticket.id, saleId: payload.sale.id, paymentId: payload.payment.id, totalCents: 600 }
  if (state === 'committed') await durable.commitPaymentOperation(operation, payload, false, result)
  const otherPayload = { ...draft(), sale: { ...draft().sale, id: 'other-sale' }, ticket: { id: 'other-ticket' } }
  const other = await durable.preparePaymentOperation(`${durable.paymentScope(context, session.id)}|restaurant:close:new-order`, 'other', otherPayload, { orderId: 'new-order' })
  let rpcCalls = 0
  const service = compileComponent(source('features/restaurant/services/payment.ts'), {
    './paymentPayload.ts': { withConfirmedRestaurantPayments },
    './checkout.ts': { prepareRestaurantCheckout: async () => {}, startRestaurantCheckout: async () => {} },
    '../../../lib/durableSales.ts': durable,
    '../../local-printing/cashlogy/useCashlogyStore.ts': {
      isCashlogyPaymentConfigured: () => true, settleCashlogyPaymentIfConfigured: assert.fail,
      getCashlogyPaymentAmounts: () => ({ receivedCents: 600, changeCents: 0 }),
    },
    '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode: async () => 'disabled' },
    '../../fiscal/local/posInvoice.ts': {}, '../../fiscal/local/restaurantInvoice.ts': {},
    '../../tables/service.ts': { payRestaurantIdempotent: async (_context, eventId, _action, params) => {
      rpcCalls++
      assert.equal(eventId, operation.eventId)
      assert.equal(params.orderId, 'old-order')
      return result
    } },
  }, { JSON })
  for (let attempt = 0; attempt < 2; attempt++) {
    const [recovered] = await service.recoverRestaurantPayments(context, session, confirmed)
    assert.equal(recovered.result.saleId, payload.sale.id)
    assert.equal((await durable.loadPaymentOperation(key)).eventId, operation.eventId)
    assert.deepEqual(await durable.loadPaymentOperation(other.key), other)
  }
  assert.equal(rpcCalls, state === 'committed' ? 0 : 1)
})
