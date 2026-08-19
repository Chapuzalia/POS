import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createPrintAgentClient } from '../src/features/local-printing/api/printAgentClient.ts'
import { printRequestSchema } from '../src/features/local-printing/schemas/printSchemas.ts'
import { mapCashClosingToPrintRequest } from '../src/features/local-printing/services/cashClosingPrintMapper.ts'
import { buildClosingReportLines } from '../src/features/local-printing/services/documentLineBuilders.ts'
import {
  adaptTextToCharacterSet,
  centerReceiptText,
  createSeparator,
  formatMoneyForReceipt,
  formatReceiptDate,
  formatReceiptRow,
  wrapReceiptText,
} from '../src/features/local-printing/services/receiptFormatters.ts'

const snapshot = {
  reportTitle: 'Informe ABCD1234', companyName: 'MESS', registerName: 'Barra principal', shiftLabel: 'ABCD1234',
  openedAt: '2026-07-20T20:00:00+02:00', closedAt: '2026-07-21T01:30:00+02:00',
  timezone: 'Europe/Madrid', currency: 'EUR', locale: 'es-ES', openedBy: 'David', closedBy: 'Paula',
  summary: { totalSalesCents: 100000, salesCount: 100, averageSaleCents: 1000 },
  payments: [
    { code: 'cash', label: 'Efectivo', amountCents: 75000 },
    { code: 'card', label: 'Tarjeta', amountCents: 20000 },
    { code: 'bizum', label: 'Bizum', amountCents: 5000 },
    { code: 'invitation', label: 'Invitación', amountCents: 0 },
  ],
  cashMovements: { cashEntriesCents: 500, cashExitsCents: 200, cardCashbackCents: 300 },
  cashFund: { openingCashFundCents: 5000, finalCashFundCents: 5000 },
  expectedAndCounted: { expectedCashCents: 80300, countedCashCents: 80200, expectedCardCents: 20000, countedCardCents: 20000 },
  differences: { cashDifferenceCents: -100, cardDifferenceCents: 0 },
}

const closing = {
  id: 'closing_123', tenantId: 'tenant', venueId: 'mess', cashRegisterId: 'register',
  closedAt: snapshot.closedAt, closedBy: 'user', notes: '', printSnapshot: snapshot, printStatus: 'not_requested',
  printJobId: null, printRequestId: null, printedAt: null, printErrorCode: null, printAttempts: 0, printCopies: 0,
}

const establishment = { name: 'MESS', legalName: 'MESS EVENTS SL', taxId: 'B12345678', address: 'Carrer Major 1' }
const layout58 = { columns: 32, paperWidth: 58, characterSet: 'CP858' }
const layout80 = { columns: 48, paperWidth: 80, characterSet: 'CP858' }
const settings = {
  autoOpenCashDrawer: true, alwaysPrintTicket: true, cut: true, copies: 1, footer: '',
  printCashClosingAutomatically: true, includeExpectedAndCountedAmounts: true, includeUserNames: true,
  includeOpeningAndClosingTimes: true, includeZeroPaymentMethods: false, includeTotalPayments: true,
  cashClosingCopies: 1, moneySymbol: 'currency',
}

test('el cierre se compone exactamente en 32 columnas', () => {
  const lines = buildClosingReportLines(closing, establishment, layout58, settings)
  assert.deepEqual(lines, EXPECTED_32)
})

test('el cierre se compone exactamente en 48 columnas', () => {
  const lines = buildClosingReportLines(closing, establishment, layout80, settings)
  assert.deepEqual(lines, EXPECTED_48)
})

test('envía exclusivamente líneas y opciones físicas al endpoint idempotente', async () => {
  let sent
  const client = createPrintAgentClient({
    baseUrl: 'https://tpv-printer.local:8443',
    token: 'secret',
    fetchImpl: async (url, init) => {
      sent = { url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) }
      return new Response(JSON.stringify({ ok: true, status: 'printed' }))
    },
  })
  const request = mapCashClosingToPrintRequest({ closing, establishment, printerId: 'main', printerLayout: layout80, settings })
  await client.printTicket(request)
  assert.equal(new URL(sent.url).pathname, '/api/v1/print')
  assert.equal(sent.method, 'POST')
  assert.deepEqual(sent.body, request)
  assert.deepEqual(Object.keys(sent.body).sort(), ['force', 'lines', 'options', 'printerId', 'requestId'])
  for (const legacy of ['ticket', 'items', 'products', 'prices', 'subtotal', 'total', 'payments']) {
    assert.equal(legacy in sent.body, false)
  }
})

test('la copia es explícita, usa force, tiene ID propio y nunca abre el cajón', () => {
  const request = mapCashClosingToPrintRequest({ closing, establishment, printerId: 'main', printerLayout: layout80, settings, isReprint: true, copyNumber: 2 })
  assert.equal(request.requestId, 'cash-closing:closing_123:copy:2')
  assert.equal(request.force, true)
  assert.ok(request.lines.some((line) => line.trim() === 'COPIA'))
  assert.equal(request.options.openCashDrawer, false)
})

test('diferencias positivas y negativas se imprimen sin recalcular el snapshot', () => {
  const positive = {
    ...closing,
    printSnapshot: { ...snapshot, differences: { cashDifferenceCents: 125, cardDifferenceCents: -50 } },
  }
  const text = buildClosingReportLines(positive, establishment, layout80, settings).join('\n')
  assert.match(text, /Diferencia efectivo[ ]+1,25 €/)
  assert.match(text, /Diferencia tarjeta[ ]+-0,50 €/)
})

test('campos opcionales ausentes no generan undefined, null, NaN ni secciones inventadas', () => {
  const minimal = {
    ...closing,
    printSnapshot: { ...snapshot, openedBy: undefined, closedBy: undefined, payments: [], summary: { totalSalesCents: 0, salesCount: 0, averageSaleCents: 0 } },
  }
  const text = buildClosingReportLines(minimal, { name: 'MESS' }, layout58, {}).join('\n')
  assert.doesNotMatch(text, /undefined|null|NaN|Infinity|ANULACIONES|DEVOLUCIONES|PROPINAS/)
  assert.doesNotMatch(text, /MÉTODOS DE PAGO/)
})

test('helpers puros envuelven, centran, alinean, limpian controles y respetan CP858', () => {
  assert.deepEqual(wrapReceiptText('una descripción extraordinariamente larga', 16), ['una descripción', 'extraordinariame', 'nte larga'])
  assert.equal(centerReceiptText('MESS', 10), '   MESS')
  assert.equal(formatReceiptRow({ label: 'Total', value: '10,00 €', width: 16 }), 'Total    10,00 €')
  assert.equal(createSeparator(32).length, 32)
  assert.equal(adaptTextToCharacterSet('cañón ágil 10 €\n\t\x1b', 'CP858'), 'cañón ágil 10 €   ')
  assert.equal(adaptTextToCharacterSet('cañón 10 €', 'ASCII'), 'canon 10 EUR')
})

test('formatea céntimos enteros y fecha de Madrid sin NaN', () => {
  assert.equal(formatMoneyForReceipt(123456789, { currency: 'EUR', locale: 'es-ES' }), '1.234.567,89 €')
  assert.equal(formatMoneyForReceipt(-2000, { currency: 'EUR', locale: 'es-ES' }), '-20,00 €')
  assert.throws(() => formatMoneyForReceipt(10.5), /céntimos enteros/)
  assert.equal(formatReceiptDate('2026-07-20T23:30:00Z', 'Europe/Madrid'), '2026-07-21 01:30:00')
})

test('el esquema rechaza el contrato antiguo y caracteres de control', () => {
  const valid = mapCashClosingToPrintRequest({ closing, establishment, printerId: 'main', printerLayout: layout80, settings })
  assert.deepEqual(printRequestSchema.parse(valid), valid)
  assert.throws(() => printRequestSchema.parse({ ...valid, ticket: {} }))
  assert.throws(() => printRequestSchema.parse({ ...valid, lines: ['línea\ninválida'] }))
})

test('el esquema consolidado persiste snapshot, estados, auditoría y movimientos', () => {
  const sql = readFileSync(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
  assert.match(sql, /print_snapshot jsonb/i)
  assert.match(sql, /create table public\.cash_movements/i)
  assert.match(sql, /cash_closing\.reprinted/i)
  assert.doesNotMatch(sql, /cash.drawer|open_cash_drawer/i)
})

const EXPECTED_32 = [
  '        Informe ABCD1234',
  '              MESS',
  '         MESS EVENTS SL',
  '       NIF/CIF B12345678',
  '         Carrer Major 1',
  '',
  'Caja             Barra principal',
  'Turno                   ABCD1234',
  'Cierre       2026-07-21 01:30:00',
  'Empleado                   Paula',
  'Apertura     2026-07-20 20:00:00',
  'Cierre       2026-07-21 01:30:00',
  '',
  'RESUMEN',
  '--------------------------------',
  'Operaciones                  100',
  'Ventas netas           1000,00 €',
  'Media por venta          10,00 €',
  '',
  'MÉTODOS DE PAGO',
  '--------------------------------',
  'Efectivo                750,00 €',
  'Tarjeta                 200,00 €',
  'Bizum                    50,00 €',
  'Total pagos            1000,00 €',
  '',
  'EFECTIVO',
  '--------------------------------',
  'Fondo inicial            50,00 €',
  'Entradas                  5,00 €',
  'Salidas                   2,00 €',
  'Tarjeta por efectivo      3,00 €',
  'Efectivo esperado       803,00 €',
  'Efectivo contado        802,00 €',
  'Tarjeta esperada        200,00 €',
  'Tarjeta declarada       200,00 €',
  'Diferencia efectivo      -1,00 €',
  'Diferencia tarjeta        0,00 €',
  'Fondo final              50,00 €',
  '',
  'OPERATIVA',
  '--------------------------------',
  'Efectivo facturado      750,00 €',
  'Datáfono esperado       200,00 €',
  'Retirar de caja         752,00 €',
  '',
  'ID cierre            closing_123',
  'Generado     2026-07-21 01:30:00',
  '',
  '       CIERRE COMPLETADO',
  '',
  '',
]

const EXPECTED_48 = [
  '                Informe ABCD1234',
  '                      MESS',
  '                 MESS EVENTS SL',
  '               NIF/CIF B12345678',
  '                 Carrer Major 1',
  '',
  'Caja                             Barra principal',
  'Turno                                   ABCD1234',
  'Cierre                       2026-07-21 01:30:00',
  'Empleado                                   Paula',
  'Apertura                     2026-07-20 20:00:00',
  'Cierre                       2026-07-21 01:30:00',
  '',
  'RESUMEN',
  '------------------------------------------------',
  'Operaciones                                  100',
  'Ventas netas                           1000,00 €',
  'Media por venta                          10,00 €',
  '',
  'MÉTODOS DE PAGO',
  '------------------------------------------------',
  'Efectivo                                750,00 €',
  'Tarjeta                                 200,00 €',
  'Bizum                                    50,00 €',
  'Total pagos                            1000,00 €',
  '',
  'EFECTIVO',
  '------------------------------------------------',
  'Fondo inicial                            50,00 €',
  'Entradas                                  5,00 €',
  'Salidas                                   2,00 €',
  'Tarjeta por efectivo                      3,00 €',
  'Efectivo esperado                       803,00 €',
  'Efectivo contado                        802,00 €',
  'Tarjeta esperada                        200,00 €',
  'Tarjeta declarada                       200,00 €',
  'Diferencia efectivo                      -1,00 €',
  'Diferencia tarjeta                        0,00 €',
  'Fondo final                              50,00 €',
  '',
  'OPERATIVA',
  '------------------------------------------------',
  'Efectivo facturado                      750,00 €',
  'Datáfono esperado                       200,00 €',
  'Retirar de caja                         752,00 €',
  '',
  'ID cierre                            closing_123',
  'Generado                     2026-07-21 01:30:00',
  '',
  '               CIERRE COMPLETADO',
  '',
  '',
]
