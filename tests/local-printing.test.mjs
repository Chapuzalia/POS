import * as customPayments from '../src/lib/customPayments.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPrintAgentClient } from '../src/features/local-printing/api/printAgentClient.ts'

import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'

import { buildSalePayload } from '../src/features/quick-sale/services/salePayload.ts'

import { printRequestSchema } from '../src/features/local-printing/schemas/printSchemas.ts'

import { createCompiledHookRunner } from './helpers/component-harness.mjs'
import { deferred, flush } from './helpers/restaurant-controller-harness.mjs'

const layout80 = { columns: 48, paperWidth: 80, characterSet: 'CP858' }

const sale = {
  ticket: {
    id: 'ticket_123', tenantId: 'tenant', cashSessionId: 'cash', cashRegisterId: 'register', venueId: 'mess',
    deviceId: 'ipad', userId: 'user', subtotalCents: 1800, discount: null, discountAmountCents: 200,
    totalCents: 1600, createdAt: '2026-07-18T16:30:00+02:00',
  },
  lines: [{
    id: 'line_1', ticketId: 'ticket_123', tenantId: 'tenant', productId: 'brugal', variantId: 'cubata',
    productName: 'Brugal', variantName: 'Cubata', quantity: 2, unitPriceCents: 900, lineTotalCents: 1800,
    modifiers: [
      { id: 'mixer:cola', groupId: 'mixer', name: 'Coca-Cola', priceCents: 0 },
      { id: 'extra:lemon', groupId: 'extra', name: 'Limon', priceCents: 0 },
    ],
    fiscalSnapshot: { taxRate: 21, taxableBaseCents: 1488, taxAmountCents: 312, grossTotalCents: 1800 },
  }],
  sale: {
    id: 'sale_123', tenantId: 'tenant', ticketId: 'ticket_123', cashSessionId: 'cash', cashRegisterId: 'register',
    venueId: 'mess', deviceId: 'ipad', userId: 'user', totalCents: 1600, paymentMethod: 'cash', createdAt: '2026-07-18T16:30:00+02:00',
  },
  payment: { id: 'payment', tenantId: 'tenant', saleId: 'sale_123', method: 'cash', amountCents: 1600, receivedCents: 2000, changeCents: 400 },
}

const verifactuUrl = 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345678&numserie=F-2026-000123&fecha=21-08-2026&importe=16.00'

function completeInvoiceSale() {
  const invoiceSale = structuredClone(sale)
  invoiceSale.ticket.invoice = {
    customerId: 'customer_1',
    customer: {
      legalName: 'Cliente Ejemplo SL', taxId: 'B87654321', address: 'Calle Mayor 1',
      postalCode: '08700', city: 'Igualada', province: 'Barcelona', country: 'España',
      email: null, phone: null,
    },
    series: 'F-2026', number: '000123', issuedAt: '2026-08-21T18:30:00+02:00',
  }
  invoiceSale.fiscal = {
    invoiceId: 'fiscal_1', provider: 'verifactu', status: 'accepted', uuid: 'uuid_1',
    externalCode: 'VF-123', qrBase64: null, verificationUrl: verifactuUrl,
  }
  return invoiceSale
}

const quickSaleContext = { tenantId: 'tenant', venueId: 'mess', venueDefaultTaxRate: 21, deviceId: 'ipad', userId: 'user' }
const quickSaleCashSession = { id: 'cash', cashRegisterId: 'register' }

function quickSaleLine(id, unitPriceCents, vatRate) {
  return {
    id, productId: `product-${id}`, productName: id, variantId: `variant-${id}`, variantName: id,
    basePriceCents: unitPriceCents, componentDeltaCents: 0, modifierDeltaCents: 0,
    unitPriceCents, quantity: 1, modifiers: [], components: [],
    catalogSnapshot: {
      placementId: null, productType: 'standard', productId: `product-${id}`, productName: id,
      variantId: `variant-${id}`, variantName: id, basePriceCents: unitPriceCents, vatRate,
      categoryId: null, categoryName: '', catalogTabId: null, catalogTabName: '',
      saleFormatId: null, saleFormatName: id,
    },
  }
}

function buildQuickSalePayload(...args) {
  const originalWindow = globalThis.window
  globalThis.window = { ...originalWindow, crypto: globalThis.crypto }
  try {
    return buildSalePayload(...args)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
}

function quickSalePaymentHarness({ isOnline, fiscalMode = 'disabled', fiscalIssue = null, fiscalPreflight = null, printSale = null, onError = assert.fail }) {
  const sync = deferred()
  const calls = []
  const printed = []
  const earlyDrawerCalls = []
  const dispatchedRequestIds = new Set()
  const paymentInFlightChanges = []
  const earlyCashDrawerMock = {
    requestEarlyCashDrawer: ({ requestId, payments }) => {
      if (dispatchedRequestIds.has(requestId)) return false
      if (!payments.some((payment) => payment.method === 'cash')) return false
      dispatchedRequestIds.add(requestId)
      calls.push('earlyDrawer')
      earlyDrawerCalls.push(requestId)
      return true
    },
  }
  const source = readFileSync(new URL('../src/features/quick-sale/hooks/useQuickSalePayment.ts', import.meta.url), 'utf8')
  const runner = createCompiledHookRunner(source, 'useQuickSalePayment', {
    '../../../lib/observability.ts': { operationBreadcrumb() {}, reportOperationError() {} },
    '../../../utils/errors.ts': { getReadableError: (error) => error?.message ?? String(error) },
    '../../../lib/format': { createId: () => 'event-1' },
    '../../../lib/durableSales.ts': createDurableSalesHarness(enqueue => calls.push(enqueue ? 'persist' : 'persistFiscal')),
    '../../../lib/customPayments': customPayments,
    '../services/salePayload': { buildSalePayload: (...args) => buildQuickSalePayload(...args) },
    '../../fiscal/service': { loadFiscalReceiptData: async () => { calls.push('fiscal'); return { status: 'accepted', verificationUrl: 'https://verify.local' } } },
    '../../customers/service': { loadTicketInvoice: async () => null },
    '../../../services/posService': { loadSessionTicketFromSupabase: async () => null },
    '../../local-printing/cashlogy/useCashlogyStore': {
      isCashlogyPaymentConfigured: () => false,
      finishCashlogyPayment() {},
      getCashlogyPaymentAmounts: () => ({ changeCents: null, receivedCents: null }),
      getCashlogyPaymentSaleId: () => null,
      settleCashlogyPaymentIfConfigured: async () => null,
    },
    '../../local-printing/services/earlyCashDrawer': earlyCashDrawerMock,
    '../../fiscal/local/mode.ts': { assertRealSaleAllowed() {} },
    '../../fiscal/local/tenantMode.ts': { assertRealSaleAllowed() {}, resolveLocalFiscalMode: async () => fiscalMode },
    '../../fiscal/local/posInvoice.ts': { issuePosInvoice: async (...args) => {
      calls.push('issueFiscal')
      if (!fiscalIssue) throw new Error('Unexpected production fiscal issue')
      return fiscalIssue(...args)
    }, preflightPosInvoice: async (...args) => {
      calls.push('preflightFiscal')
      return fiscalPreflight ? fiscalPreflight(...args) : undefined
    },
    printPayloadWithLocalFiscal: (payload) => ({ ...payload, localFiscal: { series: 'L1-C1-I1-2026-S', number: 1 },
      fiscal: { verificationUrl: 'https://aeat.example.invalid/qr' } }) },
    '../../fiscal/local/economicSync.ts': { synchronizeFiscalEconomicSales: async () => {} },
    '../../fiscal/local/sync.ts': { synchronizeLocalFiscalQueue: async () => {} },
    '../../fiscal/local/installation.ts': { fiscalBridgeAccessToken: async () => '', fiscalBridgeBaseUrl: () => '' },
  }, { window: { crypto } })
  const options = {
    cashSession: quickSaleCashSession,
    context: quickSaleContext,
    discount: null,
    invoiceCustomer: null,
    isOnline,
    ledger: [],
    lines: [quickSaleLine('line', 600, 21)],
    mergeProductStats() {},
    onError,
    onPaymentInFlightChange: value => paymentInFlightChanges.push(value),
    persistLedger() {},
    persistLines() {},
    persistTickets() {},
    printSale: async (payload, options) => { calls.push('print'); printed.push({ ...payload, printOptions: options }); await printSale?.(payload, options) },
    refreshPendingCount() {},
    resetUi() { calls.push('reset') },
    syncPendingEvents: async () => { calls.push('sync'); await sync.promise },
    tickets: [],
  }
  return { calls, pay: runner.render(options), printed, sync, earlyDrawerCalls, paymentInFlightChanges, options, render: () => runner.render(options) }
}

test('bloquea la impresión fiscal si un agente antiguo no admite el QR estructurado', async () => {
  const payload = mapSaleToPrintRequest({
    sale: completeInvoiceSale(), establishment: { name: 'MESS' },
    printerId: 'main-bar', printerLayout: layout80,
  })
  const bodies = []
  const client = createPrintAgentClient({
    baseUrl: 'https://tpv-printer.local:8443', token: 'secret',
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return bodies.length === 1
        ? new Response(JSON.stringify({ code: 'INVALID_REQUEST' }), { status: 400 })
        : new Response(JSON.stringify({ ok: true, jobId: 'legacy-job', status: 'printed' }), { status: 200 })
    },
  })
  await assert.rejects(client.printTicket(payload), (error) => error.code === 'FISCAL_QR_UNSUPPORTED')
  assert.equal(bodies.length, 1)
  assert.ok(bodies[0].elements.some((element) => element.type === 'qr'))
})

test('mapea cubatas, extras, efectivo e importes enteros con idempotencia estable', () => {
  const payload = mapSaleToPrintRequest({
    sale, establishment: { name: 'MESS', address: 'Carrer Exemple 1, Igualada', legalName: 'MESS EVENTS SL', taxId: 'B12345678' },
    printerId: 'main-bar', printerLayout: layout80, footer: 'Gracias', autoOpenCashDrawer: true,
  })
  assert.equal(payload.requestId, 'print:sale_123:original')
  const text = payload.lines.join('\n')
  assert.match(text, /Carrer Exemple 1, Igualada/)
  assert.match(text, /MESS EVENTS SL/)
  assert.match(text, /B12345678/)
  assert.match(text, /Coca-Cola/)
  assert.match(text, /Limon/)
  assert.match(text, /Subtotal[ ]+18,00 €/)
  assert.match(text, /Base imponible[ ]+13,22 €/)
  assert.match(text, /IVA 21 %[ ]+2,78 €/)
  assert.match(text, /Descuento[ ]+-2,00 €/)
  assert.match(text, /Entregado[ ]+20,00 €/)
  assert.match(text, /Cambio[ ]+4,00 €/)
  assert.equal(payload.options.openCashDrawer, true)
  assert.deepEqual(Object.keys(printRequestSchema.parse(payload)).sort(), ['elements', 'force', 'lines', 'options', 'printerId', 'requestId'])
})

test('la reimpresion usa COPIA, un ID de copia y nunca abre el cajon', () => {
  const payload = mapSaleToPrintRequest({ sale, establishment: { name: 'MESS' }, printerId: 'main', printerLayout: layout80, isReprint: true, copyNumber: 2, autoOpenCashDrawer: true })
  assert.equal(payload.requestId, 'print:sale_123:copy:2')
  assert.equal(payload.force, true)
  assert.ok(payload.lines.some((line) => line.trim() === 'COPIA'))
  assert.equal(payload.options.openCashDrawer, false)
})

test('la venta offline guardada libera el cobro aunque la impresora no responda', async () => {
  const print = deferred()
  const harness = quickSalePaymentHarness({ isOnline: false, printSale: () => print.promise })
  await harness.pay('cash', null)
  assert.deepEqual(harness.paymentInFlightChanges, [true, false])
  assert.deepEqual(harness.calls, ['persist', 'earlyDrawer', 'reset', 'print'])
  print.resolve()
  await flush()
})

test('un fallo de impresión posterior avisa sin volver a cobrar ni encolar la venta', async () => {
  const errors = []
  const harness = quickSalePaymentHarness({ isOnline: false,
    printSale: async () => { throw new Error('Printer unavailable') }, onError: message => errors.push(message) })
  await harness.pay('card', null)
  await flush()
  assert.deepEqual(harness.paymentInFlightChanges, [true, false])
  assert.equal(harness.calls.filter(call => call === 'persist').length, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /venta está guardada/)
})

test('una sincronización tardía no guarda tickets en otra caja o tenant', async () => {
  const harness = quickSalePaymentHarness({ isOnline: true })
  const saved = []
  harness.options.persistTickets = tickets => saved.push(tickets)
  harness.options.loadPersistedTicket = async () => ({ payload: { ticket: {}, fiscal: { status: 'accepted' } } })
  await harness.render()('card', null)
  harness.options.context = { ...quickSaleContext, tenantId: 'other-tenant' }
  harness.options.cashSession = { ...quickSaleCashSession, id: 'other-cash' }
  harness.render()
  harness.sync.resolve()
  await flush()
  assert.equal(saved.length, 1)
})

test('la factura VERI*FACTU fuerza QR al principio, corrección M y leyenda aunque la plantilla fiscal sea incompleta', () => {
  const issued = structuredClone(sale)
  issued.localFiscal = { recordId: 'record-2', series: 'L1-C1-I1-2026-S', number: 4,
    issuedAt: '2026-07-18T16:31:00+02:00', documentKind: 'simplified',
    issuerName: 'Emisor histórico SL', issuerNif: 'B12345678', issuerAddress: 'Calle Uno 1',
    verifactuLegend: true }
  issued.fiscal = { invoiceId: 'invoice-2', provider: 'verifactu', status: 'pending',
    externalCode: 'L1-C1-I1-2026-S/4', qrBase64: null, verificationUrl: verifactuUrl }
  const payload = mapSaleToPrintRequest({ sale: issued, establishment: { name: 'MESS' },
    printerId: 'main-bar', printerLayout: layout80,
    template: { version: 1, blocks: [
      { id: 'venue', type: 'text', value: '{{venue.name}}' },
      { id: 'late-qr', type: 'qr', value: '{{fiscal.verification_url}}', when: 'fiscal.show_qr' },
    ] } })
  const firstVisible = payload.elements.find((element) => element.type === 'qr' || element.value.trim())
  const qr = payload.elements.find((element) => element.type === 'qr')
  assert.equal(firstVisible.type, 'qr')
  assert.deepEqual(qr, { type: 'qr', data: verifactuUrl, size: 6, errorCorrection: 'M' })
  assert.ok(payload.elements.some((element) => element.type === 'text' && element.value === 'VERI*FACTU'))
})

test('el mapper suprime openCashDrawer cuando el cajon ya fue solicitado y conserva el comportamiento normal', () => {
  const payload = buildQuickSalePayload(quickSaleContext, quickSaleCashSession, [quickSaleLine('line', 600, 21)], 'cash', null, null)
  assert.equal(mapSaleToPrintRequest({ sale: payload, establishment: { name: 'MESS' }, printerId: 'main', printerLayout: layout80, autoOpenCashDrawer: true, cashDrawerAlreadyRequested: true }).options.openCashDrawer, false)
  assert.equal(mapSaleToPrintRequest({ sale: payload, establishment: { name: 'MESS' }, printerId: 'main', printerLayout: layout80, autoOpenCashDrawer: true }).options.openCashDrawer, true)
})
import { createDurableSalesHarness } from './helpers/durable-sales-harness.mjs'
