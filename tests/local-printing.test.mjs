import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPrintAgentHeaders, createPrintAgentClient } from '../src/features/local-printing/api/printAgentClient.ts'
import { PrintAgentError } from '../src/features/local-printing/api/PrintAgentError.ts'
import { normalizePrintAgentUrl } from '../src/features/local-printing/utils/normalizePrintAgentUrl.ts'
import { sanitizePrintDiagnostics } from '../src/features/local-printing/utils/sanitizePrintDiagnostics.ts'
import { getAutomaticSaleHardwareAction, shouldOpenCashDrawer } from '../src/features/local-printing/services/cashDrawerRules.ts'
import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'
import { buildSalePayload } from '../src/features/quick-sale/services/salePayload.ts'
import { pollPrintJob } from '../src/features/local-printing/services/jobPolling.ts'
import { clearPrintAgentConfig, loadPrintAgentConfig, savePrintAgentConfig } from '../src/features/local-printing/services/printAgentStorage.ts'
import { printRequestSchema } from '../src/features/local-printing/schemas/printSchemas.ts'
import {
  buildRestaurantPrintPayload,
  getEqualSplitPrintLines,
  getMovedRestaurantPrintLines,
  getRestaurantPrintSubtotal,
} from '../src/features/restaurant/services/restaurantPrintPayload.ts'

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

const twentyPercentDiscount = {
  discountId: null, name: 'Manual 20 %', type: 'manual', calculationType: 'percentage', value: 20,
  roundingIncrementCents: null, color: null,
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

test('normaliza hostnames, IPv4 e IPv6 y aplica HTTPS con el puerto 8443', () => {
  assert.equal(normalizePrintAgentUrl('tpv-printer.local'), 'https://tpv-printer.local:8443')
  assert.equal(normalizePrintAgentUrl('192.168.1.27:9443'), 'https://192.168.1.27:9443')
  assert.equal(normalizePrintAgentUrl('[2001:db8::1]'), 'https://[2001:db8::1]:8443')
  assert.equal(normalizePrintAgentUrl('https://alteil-print-mess.local:8443/'), 'https://alteil-print-mess.local:8443')
})

test('rechaza protocolos, rutas, credenciales e IPv4 malformadas', () => {
  for (const value of ['http://tpv-printer.local:8443', 'https://tpv-printer.local:8443/api', 'https://user:pass@tpv-printer.local', '999.1.1.1']) {
    assert.throws(() => normalizePrintAgentUrl(value), PrintAgentError)
  }
})

test('construye headers sin filtrar el token a la URL o al cuerpo', () => {
  assert.deepEqual(buildPrintAgentHeaders('secret', true), {
    Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer secret',
  })
  assert.equal(buildPrintAgentHeaders(null).Authorization, undefined)
})

test('distingue timeout, error de red, HTTP, token ausente y respuesta no JSON', async () => {
  const abortableFetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
  const timeoutClient = createPrintAgentClient({ baseUrl: 'https://tpv-printer.local:8443', token: 'secret', defaultTimeoutMs: 5, fetchImpl: abortableFetch })
  await assert.rejects(timeoutClient.getServerInfo(), (error) => error.code === 'TIMEOUT')

  const networkClient = createPrintAgentClient({ baseUrl: 'https://tpv-printer.local:8443', token: 'secret', fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
  await assert.rejects(networkClient.getServerInfo(), (error) => error.code === 'NETWORK_ERROR')

  const httpClient = createPrintAgentClient({ baseUrl: 'https://tpv-printer.local:8443', token: 'bad', fetchImpl: async () => new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), { status: 401 }) })
  await assert.rejects(httpClient.getServerInfo(), (error) => error.code === 'UNAUTHORIZED' && error.status === 401)

  const textClient = createPrintAgentClient({ baseUrl: 'https://tpv-printer.local:8443', token: 'secret', fetchImpl: async () => new Response('not-json', { status: 200 }) })
  await assert.rejects(textClient.getServerInfo(), (error) => error.code === 'INVALID_RESPONSE')

  const anonymous = createPrintAgentClient({ baseUrl: 'https://tpv-printer.local:8443', fetchImpl: async () => new Response('{}') })
  await assert.rejects(anonymous.getServerInfo(), (error) => error.code === 'UNAUTHORIZED')
})

test('permite cancelar una consulta mediante AbortSignal', async () => {
  const controller = new AbortController()
  const client = createPrintAgentClient({
    baseUrl: 'https://tpv-printer.local:8443', token: 'secret',
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }),
  })
  const promise = client.getServerInfo(controller.signal)
  controller.abort()
  await assert.rejects(promise, (error) => error.code === 'ABORTED')
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
  assert.deepEqual(Object.keys(printRequestSchema.parse(payload)).sort(), ['force', 'lines', 'options', 'printerId', 'requestId'])
})

test('la venta rapida imprime base sin impuestos, IVA y total con distintos tipos', () => {
  const payload = buildQuickSalePayload(
    quickSaleContext,
    quickSaleCashSession,
    [quickSaleLine('IVA 21', 1210, 21), quickSaleLine('IVA 10', 1100, 10)],
    'cash',
    2310,
    null,
  )

  assert.deepEqual(payload.lines.map((line) => line.fiscalSnapshot), [
    { taxRate: 21, grossTotalCents: 1210, taxableBaseCents: 1000, taxAmountCents: 210 },
    { taxRate: 10, grossTotalCents: 1100, taxableBaseCents: 1000, taxAmountCents: 100 },
  ])

  const request = mapSaleToPrintRequest({ sale: payload, establishment: { name: 'MESS' }, printerId: 'main', printerLayout: layout80 })
  const text = request.lines.join('\n')
  assert.match(text, /Subtotal[ ]+23,10 €/)
  assert.match(text, /Base imponible[ ]+20,00 €/)
  assert.match(text, /IVA 10 %[ ]+1,00 €/)
  assert.match(text, /IVA 21 %[ ]+2,10 €/)
  assert.match(text, /TOTAL[ ]+23,10 €/)
})

test('la venta rapida reparte el descuento y recalcula el IVA final de cada tipo', () => {
  const payload = buildQuickSalePayload(
    quickSaleContext,
    quickSaleCashSession,
    [quickSaleLine('IVA 21', 1210, 21), quickSaleLine('IVA 10', 1100, 10)],
    'card',
    null,
    twentyPercentDiscount,
  )

  assert.equal(payload.ticket.subtotalCents, 2310)
  assert.equal(payload.ticket.discountAmountCents, 462)
  assert.equal(payload.ticket.totalCents, 1848)
  assert.deepEqual(payload.lines.map((line) => line.fiscalSnapshot), [
    { taxRate: 21, grossTotalCents: 968, taxableBaseCents: 800, taxAmountCents: 168 },
    { taxRate: 10, grossTotalCents: 880, taxableBaseCents: 800, taxAmountCents: 80 },
  ])

  const request = mapSaleToPrintRequest({ sale: payload, establishment: { name: 'MESS' }, printerId: 'main', printerLayout: layout80 })
  const text = request.lines.join('\n')
  assert.match(text, /Subtotal[ ]+23,10 €/)
  assert.match(text, /Base imponible[ ]+16,00 €/)
  assert.match(text, /Descuento[ ]+-4,62 €/)
  assert.match(text, /IVA 10 %[ ]+0,80 €/)
  assert.match(text, /IVA 21 %[ ]+1,68 €/)
  assert.match(text, /TOTAL[ ]+18,48 €/)
})

test('omite todo el desglose fiscal si alguna linea de venta rapida no tiene IVA', () => {
  const payload = buildQuickSalePayload(
    { ...quickSaleContext, venueDefaultTaxRate: undefined },
    quickSaleCashSession,
    [quickSaleLine('Con IVA', 1210, 21), quickSaleLine('Sin dato fiscal', 500, null)],
    'card',
    null,
    twentyPercentDiscount,
  )
  assert.ok(payload.lines[0].fiscalSnapshot)
  assert.equal(payload.lines[1].fiscalSnapshot, null)

  const request = mapSaleToPrintRequest({ sale: payload, establishment: { name: 'MESS' }, printerId: 'main', printerLayout: layout80 })
  const text = request.lines.join('\n')
  assert.match(text, /Subtotal[ ]+17,10 €/)
  assert.match(text, /Descuento[ ]+-3,42 €/)
  assert.match(text, /TOTAL[ ]+13,68 €/)
  assert.doesNotMatch(text, /\nIVA \d/u)
})

test('la venta rapida aplica el IVA predeterminado del local a productos que lo heredan', () => {
  const payload = buildQuickSalePayload(
    quickSaleContext,
    quickSaleCashSession,
    [quickSaleLine('IVA heredado', 10000, null)],
    'card',
    null,
    null,
  )
  assert.deepEqual(payload.lines[0].fiscalSnapshot, {
    taxRate: 21,
    grossTotalCents: 10000,
    taxableBaseCents: 8264,
    taxAmountCents: 1736,
  })

  const request = mapSaleToPrintRequest({ sale: payload, establishment: { name: 'MESS' }, printerId: 'main', printerLayout: layout80 })
  const text = request.lines.join('\n')
  assert.match(text, /Subtotal[ ]+100,00 €/)
  assert.match(text, /Base imponible[ ]+82,64 €/)
  assert.match(text, /IVA 21 %[ ]+17,36 €/)
  assert.match(text, /TOTAL[ ]+100,00 €/)
})

test('la reimpresion usa COPIA, un ID de copia y nunca abre el cajon', () => {
  const payload = mapSaleToPrintRequest({ sale, establishment: { name: 'MESS' }, printerId: 'main', printerLayout: layout80, isReprint: true, copyNumber: 2, autoOpenCashDrawer: true })
  assert.equal(payload.requestId, 'print:sale_123:copy:2')
  assert.equal(payload.force, true)
  assert.ok(payload.lines.includes('                     COPIA'))
  assert.equal(payload.options.openCashDrawer, false)
})

test('la regla del cajon cubre efectivo, tarjeta, mixto y reimpresion', () => {
  const settings = { autoOpenCashDrawer: true }
  assert.equal(shouldOpenCashDrawer({ payments: [{ method: 'cash', amountCents: 100 }], settings }), true)
  assert.equal(shouldOpenCashDrawer({ payments: [{ method: 'card', amountCents: 100 }], settings }), false)
  assert.equal(shouldOpenCashDrawer({ payments: [{ method: 'card', amountCents: 80 }, { method: 'cash', amountCents: 20 }], settings }), true)
  assert.equal(shouldOpenCashDrawer({ payments: [{ method: 'cash', amountCents: 100 }], settings, isReprint: true }), false)
})

test('la preferencia de ticket decide entre imprimir, abrir cajon o no actuar', () => {
  const cash = [{ method: 'cash', amountCents: 100 }]
  const card = [{ method: 'card', amountCents: 100 }]
  assert.equal(getAutomaticSaleHardwareAction({ payments: cash, settings: { alwaysPrintTicket: true, autoOpenCashDrawer: true } }), 'print')
  assert.equal(getAutomaticSaleHardwareAction({ payments: cash, settings: { alwaysPrintTicket: false, autoOpenCashDrawer: true } }), 'open_drawer')
  assert.equal(getAutomaticSaleHardwareAction({ payments: card, settings: { alwaysPrintTicket: false, autoOpenCashDrawer: true } }), 'none')
  assert.equal(getAutomaticSaleHardwareAction({ payments: cash, settings: { alwaysPrintTicket: false, autoOpenCashDrawer: false } }), 'none')
  assert.equal(getAutomaticSaleHardwareAction({ payments: card, isReprint: true, settings: { alwaysPrintTicket: false, autoOpenCashDrawer: true } }), 'print')
})

test('la venta rapida espera el QR fiscal online y tambien intenta imprimir offline', () => {
  const source = readFileSync(new URL('../src/features/quick-sale/hooks/useQuickSalePayment.ts', import.meta.url), 'utf8')
  const syncIndex = source.indexOf('await options.syncPendingEvents()')
  const fiscalIndex = source.indexOf('await loadFiscalReceiptData(')
  const printIndex = source.indexOf('const printTask = options.printSale(printPayload)')
  assert.ok(syncIndex >= 0 && fiscalIndex > syncIndex && printIndex > fiscalIndex)
  assert.match(source, /if \(options\.isOnline\) \{[\s\S]*await options\.syncPendingEvents\(\)[\s\S]*\}\r?\n    const printTask/)
})

test('construye el ticket de mesa localmente en cuanto la RPC devuelve sus IDs', () => {
  const context = { tenantId: 'tenant', venueId: 'mess', deviceId: 'ipad', userId: 'user' }
  const cashSession = { id: 'cash', cashRegisterId: 'register' }
  const lines = [{
    id: 'order-line', tenantId: 'tenant', venueId: 'mess', orderId: 'order', productId: 'product', variantId: 'variant',
    productName: 'Brugal', variantName: 'Cubata', unitPriceCents: 900, quantity: 2, servedQuantity: 2,
    fullyServedAt: null, modifiers: [], mixerProductId: 'cola', mixer: { productId: 'cola', name: 'Coca-Cola', priceCents: 0 },
    note: null, createdAt: '2026-07-21T10:00:00Z', updatedAt: '2026-07-21T10:00:00Z',
  }]
  const selected = getMovedRestaurantPrintLines(lines, [{ lineId: 'order-line', quantity: 1 }])
  const payload = buildRestaurantPrintPayload({
    cashSession, context, createdAt: '2026-07-21T10:05:00Z', discount: null, lines: selected,
    paymentId: 'payment', paymentMethod: 'cash', receivedCents: 1000, saleId: 'sale-table', subtotalCents: 900,
    ticketId: 'ticket-table', totalCents: 900,
  })
  const request = mapSaleToPrintRequest({ sale: payload, establishment: { name: 'MESS' }, printerId: 'main', printerLayout: layout80, autoOpenCashDrawer: true })
  assert.equal(request.requestId, 'print:sale-table:original')
  assert.match(request.lines.join('\n'), /1 x Brugal Cubata/)
  assert.match(request.lines.join('\n'), /Coca-Cola/)
  assert.doesNotMatch(request.lines.join('\n'), /IVA /)
  assert.equal(request.options.openCashDrawer, true)
})

test('el reparto igual reproduce localmente la asignacion monetaria del servidor', () => {
  const base = {
    tenantId: 'tenant', venueId: 'mess', orderId: 'order', productId: 'product', variantId: 'variant',
    servedQuantity: 1, fullyServedAt: null, modifiers: [], mixerProductId: null, mixer: null, note: null,
    updatedAt: '2026-07-21T10:00:00Z',
  }
  const lines = [
    { ...base, id: 'line-a', productName: 'A', variantName: 'A', unitPriceCents: 500, quantity: 2, createdAt: '2026-07-21T10:00:00Z' },
    { ...base, id: 'line-b', productName: 'B', variantName: 'B', unitPriceCents: 1000, quantity: 1, createdAt: '2026-07-21T10:01:00Z' },
  ]
  const allocation = getEqualSplitPrintLines(lines, { totalCents: 2000, partCount: 3, paidParts: 1 })
  assert.deepEqual(allocation.map((line) => line.lineTotalCents), [333, 334])
  assert.equal(getRestaurantPrintSubtotal(allocation), 667)
})

test('el polling termina en printed y convierte una espera excesiva en unknown sin reenviar', async () => {
  let calls = 0
  const printed = await pollPrintJob({ getJob: async () => ({ id: 'job', status: ++calls > 1 ? 'printed' : 'printing' }) }, 'job', { intervalMs: 1, maxWaitMs: 50 })
  assert.equal(printed.status, 'printed')
  const unknown = await pollPrintJob({ getJob: async () => ({ id: 'job', status: 'pending' }) }, 'job', { intervalMs: 1, maxWaitMs: 3 })
  assert.equal(unknown.status, 'unknown')
})

test('persiste configuracion separada por terminal y permite borrar el token', () => {
  const values = new Map()
  const originalWindow = globalThis.window
  globalThis.window = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) } }
  const mess = { tenantId: 'tenant', establishmentId: 'mess', terminalId: 'ipad-1' }
  const loft = { tenantId: 'tenant', establishmentId: 'loft', terminalId: 'ipad-1' }
  savePrintAgentConfig(mess, { ...loadPrintAgentConfig(mess), token: 'mess-secret' })
  savePrintAgentConfig(loft, { ...loadPrintAgentConfig(loft), token: 'loft-secret' })
  assert.equal(loadPrintAgentConfig(mess).token, 'mess-secret')
  assert.equal(loadPrintAgentConfig(loft).token, 'loft-secret')
  assert.equal(loadPrintAgentConfig(mess).preferences.alwaysPrintTicket, true)
  clearPrintAgentConfig(mess)
  assert.equal(loadPrintAgentConfig(mess).token, null)
  globalThis.window = originalWindow
})

test('el informe tecnico elimina token, Authorization y datos de ticket', () => {
  const sanitized = sanitizePrintDiagnostics({ token: 'secret', Authorization: 'Bearer secret', nested: { ticket: { customerData: 'private' }, status: 'ok' } })
  assert.deepEqual(sanitized, { nested: { status: 'ok' } })
  assert.equal(JSON.stringify(sanitized).includes('secret'), false)
})
