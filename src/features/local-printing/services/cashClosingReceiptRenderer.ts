import type { CashClosingPrintDocument } from '../types.ts'
import { centerReceiptText, createSeparator, formatMoneyForReceipt, formatReceiptDate, formatReceiptRow } from './receiptFormatters.ts'

export function renderCashClosingReceipt(document: CashClosingPrintDocument, moneySymbol: 'currency' | 'code' = 'currency') {
  const width = document.paperWidth
  const money = (amountCents: number) => formatMoneyForReceipt(amountCents, {
    currency: document.currency,
    locale: document.locale,
    symbol: moneySymbol,
  })
  const row = (label: string, value: string) => formatReceiptRow({ label, value, width })
  const section = (title: string, rows: string[]) => [title.toLocaleUpperCase(document.locale), createSeparator(width), ...rows, '']
  const lines = [
    centerReceiptText(document.reportTitle.toLocaleUpperCase(document.locale), width),
    centerReceiptText(document.companyName, width),
    ...(document.copyLabel ? [centerReceiptText(document.copyLabel, width)] : []),
    '',
    row('Caja', document.registerName),
    row('Turno', document.shiftLabel),
    row('Fecha', formatReceiptDate(document.closedAt, document.timezone)),
    '',
    ...section('Resumen', [
      row('Total', money(document.summary.totalSalesCents)),
      row('Ventas', String(document.summary.salesCount)),
      '',
      row('Media por venta', money(document.summary.averageSaleCents)),
    ]),
    ...section('Pagos', [
      ...document.payments.map((payment) => row(payment.label, money(payment.amountCents))),
      ...(document.includeTotalPayments ? [row('Total pagos', money(document.payments.reduce((total, payment) => total + payment.amountCents, 0)))] : []),
    ]),
    ...section('Entradas/Salidas', [
      row('Entradas', money(document.cashMovements.entriesCents)),
      row('Salidas', money(document.cashMovements.exitsCents)),
    ]),
    ...section('Fondo de caja', [
      row('Fondo de efectivo', money(document.cashFund.openingCashFundCents)),
      row('Fondo de caja final', money(document.cashFund.finalCashFundCents)),
    ]),
    row('Diferencia efectivo', money(document.differences.cashDifferenceCents)),
    row('Diferencia tarjeta', money(document.differences.cardDifferenceCents)),
  ]
  if (document.expectedAndCounted) lines.push('',
    row('Efectivo esperado', money(document.expectedAndCounted.expectedCashCents)),
    row('Efectivo contado', money(document.expectedAndCounted.countedCashCents)),
    row('Tarjeta esperada', money(document.expectedAndCounted.expectedCardCents)),
    row('Tarjeta declarada', money(document.expectedAndCounted.countedCardCents)))
  if (document.users) lines.push('',
    ...(document.users.openedBy ? [row('Abierto por', document.users.openedBy)] : []),
    ...(document.users.closedBy ? [row('Cerrado por', document.users.closedBy)] : []))
  if (document.times) lines.push('',
    row('Inicio', formatReceiptDate(document.times.openedAt, document.timezone)),
    row('Cierre', formatReceiptDate(document.times.closedAt, document.timezone)))
  lines.push('', centerReceiptText('CIERRE COMPLETADO', width), '', '', '')
  return lines.join('\n')
}
