import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mapCashClosingToPrintRequest } from '../src/features/local-printing/services/cashClosingPrintMapper.ts'
import { renderCashClosingReceipt } from '../src/features/local-printing/services/cashClosingReceiptRenderer.ts'
import { createSeparator, formatMoneyForReceipt, formatReceiptDate, formatReceiptRow } from '../src/features/local-printing/services/receiptFormatters.ts'
import { cashClosingPrintRequestSchema } from '../src/features/local-printing/schemas/printSchemas.ts'

const snapshot = {
  reportTitle: 'Informe ABCD1234', companyName: 'MESS', registerName: 'Barra principal', shiftLabel: 'ABCD1234',
  openedAt: '2026-07-20T20:00:00+02:00', closedAt: '2026-07-21T01:30:00+02:00',
  timezone: 'Europe/Madrid', currency: 'EUR', locale: 'es-ES', openedBy: 'David', closedBy: 'Paula',
  summary: { totalSalesCents: 100000, salesCount: 100, averageSaleCents: 1000 },
  payments: [
    { code: 'cash', label: 'Efectivo', amountCents: 75000 },
    { code: 'card', label: 'Tarjeta', amountCents: 20000 },
    { code: 'bizum', label: 'Bizum', amountCents: 5000 },
    { code: 'invitation', label: 'Invitacion', amountCents: 0 },
  ],
  cashMovements: { cashEntriesCents: 500, cashExitsCents: 200, cardCashbackCents: 300 },
  cashFund: { openingCashFundCents: 5000, finalCashFundCents: 5000 },
  expectedAndCounted: { expectedCashCents: 80300, countedCashCents: 80200, expectedCardCents: 20000, countedCardCents: 20000 },
  differences: { cashDifferenceCents: -100, cardDifferenceCents: 0 },
}

const closing = {
  id: 'closing_123', tenantId: 'tenant', venueId: 'mess', cashRegisterId: 'register',
  closedAt: snapshot.closedAt, closedBy: 'user', printSnapshot: snapshot, printStatus: 'not_requested',
  printJobId: null, printRequestId: null, printedAt: null, printErrorCode: null, printAttempts: 0, printCopies: 0,
}

const settings = {
  autoOpenCashDrawer: true, alwaysPrintTicket: true, cut: true, copies: 1, footer: '',
  printCashClosingAutomatically: true, includeExpectedAndCountedAmounts: false, includeUserNames: true,
  includeOpeningAndClosingTimes: false, includeZeroPaymentMethods: false, includeTotalPayments: true,
  cashClosingCopies: 1, cashClosingPaperWidth: 42, moneySymbol: 'currency',
}

test('mapea un cierre estructurado con ID estable y nunca abre el cajon', () => {
  const request = mapCashClosingToPrintRequest({ closing, printerId: 'main', settings })
  assert.equal(request.requestId, 'cash-closing:closing_123:original')
  assert.equal(request.documentType, 'cash-closing')
  assert.equal(request.options.openCashDrawer, false)
  assert.deepEqual(request.cashClosing.payments.map((payment) => payment.code), ['cash', 'card', 'bizum'])
  assert.equal(cashClosingPrintRequestSchema.parse(request).cashClosing.summary.salesCount, 100)
})

test('la reimpresion tiene ID propio, etiqueta COPIA y conserva el snapshot', () => {
  const request = mapCashClosingToPrintRequest({ closing, printerId: 'main', settings, isReprint: true, copyNumber: 2 })
  assert.equal(request.requestId, 'cash-closing:closing_123:copy:2')
  assert.equal(request.cashClosing.copyLabel, 'COPIA')
  assert.equal(request.cashClosing.summary.totalSalesCents, snapshot.summary.totalSalesCents)
  assert.equal(request.options.openCashDrawer, false)
})

test('renderiza pagos dinamicos, movimientos, fondos y diferencias en 80 mm', () => {
  const request = mapCashClosingToPrintRequest({ closing, printerId: 'main', settings })
  const receipt = renderCashClosingReceipt(request.cashClosing)
  assert.match(receipt, /Efectivo/)
  assert.match(receipt, /Bizum/)
  assert.match(receipt, /Entradas de efectivo/)
  assert.match(receipt, /Salidas de efectivo/)
  assert.match(receipt, /Efectivo por tarjeta/)
  assert.match(receipt, /Fondo de caja final/)
  assert.match(receipt, /Diferencia efectivo/)
  for (const line of receipt.split('\n')) assert.ok(line.length <= 42, `linea demasiado larga: ${line}`)
})

test('cierre sin ventas produce media cero y no NaN', () => {
  const empty = { ...closing, printSnapshot: { ...snapshot, summary: { totalSalesCents: 0, salesCount: 0, averageSaleCents: 0 }, payments: [] } }
  const request = mapCashClosingToPrintRequest({ closing: empty, printerId: 'main', settings })
  const receipt = renderCashClosingReceipt(request.cashClosing)
  assert.doesNotMatch(receipt, /NaN|Infinity/)
  assert.match(receipt, /0,00/)
})

test('formatea centimos, negativos, importes grandes y fecha de Madrid', () => {
  assert.match(formatMoneyForReceipt(123456789, { currency: 'EUR', locale: 'es-ES' }), /1\.234\.567,89/)
  assert.match(formatMoneyForReceipt(-2000, { currency: 'EUR', locale: 'es-ES' }), /-20,00/)
  assert.equal(formatReceiptDate('2026-07-20T23:30:00Z', 'Europe/Madrid'), '2026-07-21 01:30:00')
})

test('las filas de 58 y 80 mm no parten el importe ni superan el ancho', () => {
  for (const width of [32, 42, 48]) {
    const row = formatReceiptRow({ label: 'Una etiqueta extraordinariamente larga', value: '-1.234,56 EUR', width })
    assert.equal(row.length, width)
    assert.ok(row.endsWith('-1.234,56 EUR'))
    assert.equal(createSeparator(width).length, width)
  }
})

test('la migracion persiste snapshot, estados, auditoria y movimientos', () => {
  const sql = readFileSync(new URL('../supabase/27.cash-closing-printing-migration.sql', import.meta.url), 'utf8')
  assert.match(sql, /print_snapshot jsonb/i)
  assert.match(sql, /create table if not exists public\.cash_movements/i)
  assert.match(sql, /cash_closing\.reprinted/i)
  assert.doesNotMatch(sql, /cash.drawer|open_cash_drawer/i)
})
