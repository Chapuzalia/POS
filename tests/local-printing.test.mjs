import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildPrintAgentHeaders, createPrintAgentClient } from '../src/features/local-printing/api/printAgentClient.ts'
import { PrintAgentError } from '../src/features/local-printing/api/PrintAgentError.ts'
import { normalizePrintAgentUrl } from '../src/features/local-printing/utils/normalizePrintAgentUrl.ts'
import { sanitizePrintDiagnostics } from '../src/features/local-printing/utils/sanitizePrintDiagnostics.ts'
import { getAutomaticSaleHardwareAction, shouldOpenCashDrawer } from '../src/features/local-printing/services/cashDrawerRules.ts'
import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'
import { pollPrintJob } from '../src/features/local-printing/services/jobPolling.ts'
import { clearPrintAgentConfig, loadPrintAgentConfig, savePrintAgentConfig } from '../src/features/local-printing/services/printAgentStorage.ts'
import { printRequestSchema } from '../src/features/local-printing/schemas/printSchemas.ts'
import {
  buildRestaurantPrintPayload,
  getEqualSplitPrintLines,
  getMovedRestaurantPrintLines,
  getRestaurantPrintSubtotal,
} from '../src/features/restaurant/services/restaurantPrintPayload.ts'

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
    printerId: 'main-bar', footer: 'Gracias', autoOpenCashDrawer: true,
  })
  assert.equal(payload.requestId, 'print:sale_123:original')
  assert.equal(payload.ticket.address, 'Carrer Exemple 1, Igualada')
  assert.equal(payload.ticket.legalName, 'MESS EVENTS SL')
  assert.equal(payload.ticket.taxId, 'B12345678')
  assert.deepEqual(payload.ticket.items[0].additions, ['Coca-Cola', 'Limon'])
  assert.equal(payload.ticket.items[0].totalCents, 1800)
  assert.equal(payload.ticket.discountCents, 200)
  assert.equal(payload.ticket.amountReceivedCents, 2000)
  assert.equal(payload.ticket.changeCents, 400)
  assert.equal(payload.options.openCashDrawer, true)
  assert.equal(printRequestSchema.parse(payload).ticket.totalCents, 1600)
})

test('la reimpresion usa COPIA, un ID de copia y nunca abre el cajon', () => {
  const payload = mapSaleToPrintRequest({ sale, establishment: { name: 'MESS' }, printerId: 'main', isReprint: true, copyNumber: 2, autoOpenCashDrawer: true })
  assert.equal(payload.requestId, 'print:sale_123:copy:2')
  assert.equal(payload.ticket.copyLabel, 'COPIA')
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

test('la venta rapida inicia la impresion antes de sincronizar y tambien lo intenta offline', () => {
  const source = readFileSync(new URL('../src/features/quick-sale/hooks/useQuickSalePayment.ts', import.meta.url), 'utf8')
  const printIndex = source.indexOf('const printTask = options.printSale(payload)')
  const syncIndex = source.indexOf('void options.syncPendingEvents()')
  assert.ok(printIndex >= 0 && syncIndex > printIndex)
  assert.doesNotMatch(source, /if \(!options\.isOnline\)/)
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
  const request = mapSaleToPrintRequest({ sale: payload, establishment: { name: 'MESS' }, printerId: 'main', autoOpenCashDrawer: true })
  assert.equal(request.requestId, 'print:sale-table:original')
  assert.equal(request.ticket.items[0].quantity, 1)
  assert.deepEqual(request.ticket.items[0].additions, ['Coca-Cola'])
  assert.equal(request.ticket.taxCents, undefined)
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
