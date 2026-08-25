import { allocateNetTotalToLines } from '../../../lib/discounts.ts'
import { calculateTaxFromGross, isValidTaxRate } from '../../../lib/tax.ts'
import type { CashClosingRecord, SaleCreatedPayload } from '../../../types/index.ts'
import { getCashClosingAmounts } from '../../cash-registers/services/cashClosingAmounts.ts'
import type { PrintElement, PrinterLayout } from '../types.ts'
import {
  centerReceiptText,
  createSeparator,
  finalizeReceiptLines,
  formatMoneyForReceipt,
  formatReceiptDate,
  formatWrappedReceiptRow,
  wrapReceiptText,
} from './receiptFormatters.ts'

export type PrintEstablishment = {
  name: string
  address?: string
  legalName?: string
  taxId?: string
  timezone?: string
  currency?: string
  locale?: string
  cashRegisterName?: string
  employeeName?: string
  footer?: string
}

export type SaleTicketLineOptions = {
  label?: 'COPIA' | 'PRE-TICKET'
}

export type ClosingReportLineOptions = {
  copyLabel?: 'COPIA'
  includeExpectedAndCountedAmounts?: boolean
  includeOpeningAndClosingTimes?: boolean
  includeTotalPayments?: boolean
  includeUserNames?: boolean
  includeZeroPaymentMethods?: boolean
  moneySymbol?: 'currency' | 'code'
}

const paymentLabels: Record<string, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  invitation: 'Invitación',
  other: 'Otros',
}

function centeredWrapped(value: string, layout: PrinterLayout) {
  return wrapReceiptText(value, layout.columns, layout.characterSet)
    .map((line) => centerReceiptText(line, layout.columns, layout.characterSet))
}

function row(label: string, value: string, layout: PrinterLayout) {
  return formatWrappedReceiptRow({ label, value, width: layout.columns, characterSet: layout.characterSet })
}

function section(title: string, layout: PrinterLayout) {
  return [title.toLocaleUpperCase('es-ES'), createSeparator(layout.columns)]
}

function prefixedWrapped(value: string, firstPrefix: string, continuedPrefix: string, layout: PrinterLayout) {
  const available = Math.max(1, layout.columns - Math.max(firstPrefix.length, continuedPrefix.length))
  return wrapReceiptText(value, available, layout.characterSet)
    .map((line, index) => `${index === 0 ? firstPrefix : continuedPrefix}${line}`)
}

function formatQuantity(quantity: number, locale: string) {
  if (!Number.isFinite(quantity)) return '?'
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(quantity)
}

function saleLineName(line: SaleCreatedPayload['lines'][number]) {
  const variant = line.variantName?.trim()
  return variant && variant.toLocaleLowerCase() !== line.productName.toLocaleLowerCase()
    ? `${line.productName} ${variant}`
    : line.productName
}

function saleLineAdditions(line: SaleCreatedPayload['lines'][number]) {
  const components = (line.components ?? []).flatMap((component) => {
    const variant = component.variantName?.trim()
    const group = component.type === 'menu_component' && component.selectionGroupName
      ? `${component.selectionGroupName}: `
      : ''
    const quantity = component.quantity === 1 ? '' : `${component.quantity} x `
    const heading = `${group}${quantity}${component.productName}${variant ? ` (${variant})` : ''}`
    return [heading, ...(component.modifiers ?? []).map((modifier) => modifier.name)]
  })
  return [...components, ...line.modifiers.map((modifier) => modifier.name)].filter(Boolean)
}

export function summarizeFiscalError(value: string | null | undefined) {
  const normalized = value?.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  const sentenceEnd = normalized.search(/[.!?](?:\s|$)/)
  const firstSentence = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized
  const maxLength = 180
  return firstSentence.length <= maxLength
    ? firstSentence
    : `${firstSentence.slice(0, maxLength - 3).trimEnd()}...`
}

function fiscalBreakdown(sale: SaleCreatedPayload) {
  const complete = sale.lines.length > 0 && sale.lines.every(
    (line) => line.fiscalSnapshot && isValidTaxRate(line.fiscalSnapshot.taxRate),
  )
  if (!complete) return null
  const allocated = allocateNetTotalToLines(
    sale.lines.map((line) => line.netTotalCents ?? line.lineTotalCents),
    sale.sale.totalCents,
  )
  const byRate = new Map<number, { baseCents: number; taxCents: number }>()
  allocated.forEach((grossCents, index) => {
    const taxRate = sale.lines[index].fiscalSnapshot!.taxRate
    const calculated = calculateTaxFromGross(grossCents, taxRate)
    const current = byRate.get(taxRate) ?? { baseCents: 0, taxCents: 0 }
    byRate.set(taxRate, {
      baseCents: current.baseCents + calculated.taxableBaseCents,
      taxCents: current.taxCents + calculated.taxAmountCents,
    })
  })
  return [...byRate.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rate, totals]) => ({ rate, ...totals }))
}

export function buildSaleTicketLines(
  sale: SaleCreatedPayload,
  establishment: PrintEstablishment,
  printerLayout: PrinterLayout,
  options: SaleTicketLineOptions = {},
) {
  const locale = establishment.locale || 'es-ES'
  const currency = establishment.currency || 'EUR'
  const timezone = establishment.timezone || 'Europe/Madrid'
  const money = (amountCents: number) => formatMoneyForReceipt(amountCents, { currency, locale })
  const fiscal = fiscalBreakdown(sale)
  const taxableBaseCents = fiscal?.reduce((total, item) => total + item.baseCents, 0)
  const invoice = sale.ticket.invoice
  const invoiceLabel = invoice?.series && invoice.number ? `${invoice.series}-${invoice.number}` : null
  const isInvoicePreview = Boolean(invoice && options.label === 'PRE-TICKET')
  const lines: string[] = [
    ...centeredWrapped(establishment.name, printerLayout),
    ...(establishment.legalName ? centeredWrapped(establishment.legalName, printerLayout) : []),
    ...(establishment.taxId ? centeredWrapped(`NIF/CIF ${establishment.taxId}`, printerLayout) : []),
    ...(establishment.address ? centeredWrapped(establishment.address, printerLayout) : []),
    ...(invoice ? ['', ...centeredWrapped(isInvoicePreview ? 'FACTURA (BORRADOR)' : 'FACTURA', printerLayout)] : []),
    ...(options.label ? ['', ...centeredWrapped(options.label, printerLayout)] : []),
    '',
    ...row(invoice ? 'Factura' : 'Ticket', invoiceLabel ?? (isInvoicePreview ? 'Pendiente de numeración' : sale.ticket.id), printerLayout),
    ...row(invoice ? 'Fecha expedición' : 'Fecha', formatReceiptDate(invoice?.issuedAt ?? sale.sale.createdAt, timezone), printerLayout),
    ...(establishment.cashRegisterName ? row('Caja', establishment.cashRegisterName, printerLayout) : []),
    ...(establishment.employeeName ? row('Empleado', establishment.employeeName, printerLayout) : []),
  ]

  if (invoice) {
    lines.push('', ...section('Cliente', printerLayout))
    lines.push(...wrapReceiptText(invoice.customer.legalName, printerLayout.columns, printerLayout.characterSet))
    lines.push(...wrapReceiptText(invoice.customer.taxId, printerLayout.columns, printerLayout.characterSet))
    lines.push(...wrapReceiptText(invoice.customer.address, printerLayout.columns, printerLayout.characterSet))
    lines.push(...wrapReceiptText(`${invoice.customer.postalCode} ${invoice.customer.city}`, printerLayout.columns, printerLayout.characterSet))
    lines.push(...wrapReceiptText(invoice.customer.province, printerLayout.columns, printerLayout.characterSet))
    if (invoice.customer.country.toLocaleLowerCase('es-ES') !== 'españa') {
      lines.push(...wrapReceiptText(invoice.customer.country, printerLayout.columns, printerLayout.characterSet))
    }
  }

  lines.push('', ...section('Productos', printerLayout))

  for (const item of sale.lines) {
    lines.push(...row(
      `${formatQuantity(item.quantity, locale)} x ${saleLineName(item)}`,
      money(item.netTotalCents ?? item.lineTotalCents),
      printerLayout,
    ))
    for (const addition of saleLineAdditions(item)) {
      lines.push(...prefixedWrapped(addition, '  + ', '    ', printerLayout))
    }
    if (item.note?.trim()) {
      lines.push(...prefixedWrapped(item.note, '  Nota: ', '        ', printerLayout))
    }
  }

  lines.push('', createSeparator(printerLayout.columns))

  if (sale.ticket.discountAmountCents > 0) {
    lines.push(...row('Subtotal', money(sale.ticket.subtotalCents), printerLayout))
    lines.push(...row('Descuento', money(-sale.ticket.discountAmountCents), printerLayout))
  }
  if (taxableBaseCents !== undefined) {
    lines.push(...row('Base imponible', money(taxableBaseCents), printerLayout))
  }
  for (const tax of fiscal ?? []) {
    lines.push(...row(`IVA ${formatQuantity(tax.rate, locale)} %`, money(tax.taxCents), printerLayout))
  }
  lines.push(...row('TOTAL', money(sale.sale.totalCents), printerLayout))

  if (sale.payment && options.label !== 'PRE-TICKET') {
    lines.push('', ...section('Pago', printerLayout))
    lines.push(...row(paymentLabels[sale.payment.method] ?? sale.payment.method, money(sale.payment.amountCents), printerLayout))
    if (sale.payment.receivedCents !== null) {
      lines.push(...row('Entregado', money(sale.payment.receivedCents), printerLayout))
      lines.push(...row('Cambio', money(sale.payment.changeCents), printerLayout))
    }
  }

  if (sale.fiscal && options.label !== 'PRE-TICKET') {
    lines.push('', ...section(sale.fiscal.provider === 'ticketbai' ? 'TicketBAI' : 'VeriFactu', printerLayout))
    if (sale.fiscal.externalCode) lines.push(...wrapReceiptText(`Código: ${sale.fiscal.externalCode}`, printerLayout.columns, printerLayout.characterSet))
    if (sale.fiscal.verificationUrl) lines.push(...wrapReceiptText(sale.fiscal.verificationUrl, printerLayout.columns, printerLayout.characterSet))
    const fiscalError = summarizeFiscalError(sale.fiscal.errorMessage ?? sale.fiscal.errorCode)
    if (!sale.fiscal.verificationUrl && fiscalError) {
      lines.push(...wrapReceiptText('QR no disponible.', printerLayout.columns, printerLayout.characterSet))
      lines.push(...wrapReceiptText(`Motivo: ${fiscalError}`, printerLayout.columns, printerLayout.characterSet))
    }
  }

  if (establishment.footer?.trim()) {
    lines.push('', ...centeredWrapped(establishment.footer, printerLayout))
  }
  lines.push('', '')
  return finalizeReceiptLines(lines, printerLayout)
}

export function buildSaleTicketElements(
  sale: SaleCreatedPayload,
  printerLayout: PrinterLayout,
  lines: string[],
  options: SaleTicketLineOptions = {},
): PrintElement[] | undefined {
  const verificationUrl = sale.fiscal?.verificationUrl
  if (
    options.label === 'PRE-TICKET' ||
    sale.fiscal?.provider !== 'verifactu' ||
    !verificationUrl
  ) return undefined

  const verificationLines = wrapReceiptText(
    verificationUrl,
    printerLayout.columns,
    printerLayout.characterSet,
  )
  const fiscalSectionStart = lines.lastIndexOf('VERIFACTU')
  let verificationStart = -1
  for (
    let index = Math.max(0, fiscalSectionStart + 1);
    index <= lines.length - verificationLines.length;
    index += 1
  ) {
    if (verificationLines.every((line, offset) => lines[index + offset] === line)) {
      verificationStart = index
      break
    }
  }
  if (verificationStart < 0) return undefined

  return [
    ...lines.slice(0, verificationStart).map((value): PrintElement => ({ type: 'text', value })),
    { type: 'qr', data: verificationUrl, size: 6, errorCorrection: 'M' },
    ...lines.slice(verificationStart + verificationLines.length)
      .map((value): PrintElement => ({ type: 'text', value })),
  ]
}

export function buildClosingReportLines(
  closing: CashClosingRecord,
  establishment: PrintEstablishment,
  printerLayout: PrinterLayout,
  options: ClosingReportLineOptions = {},
) {
  const snapshot = closing.printSnapshot
  const locale = snapshot.locale || establishment.locale || 'es-ES'
  const currency = snapshot.currency || establishment.currency || 'EUR'
  const timezone = snapshot.timezone || establishment.timezone || 'Europe/Madrid'
  const money = (amountCents: number) => formatMoneyForReceipt(amountCents, {
    currency,
    locale,
    symbol: options.moneySymbol,
  })
  const amounts = getCashClosingAmounts(snapshot)
  const payments = options.includeZeroPaymentMethods
    ? snapshot.payments
    : snapshot.payments.filter((payment) => payment.amountCents !== 0)
  const lines: string[] = [
    ...centeredWrapped(snapshot.reportTitle, printerLayout),
    ...centeredWrapped(establishment.name || snapshot.companyName, printerLayout),
    ...(establishment.legalName ? centeredWrapped(establishment.legalName, printerLayout) : []),
    ...(establishment.taxId ? centeredWrapped(`NIF/CIF ${establishment.taxId}`, printerLayout) : []),
    ...(establishment.address ? centeredWrapped(establishment.address, printerLayout) : []),
    ...(options.copyLabel ? ['', ...centeredWrapped(options.copyLabel, printerLayout)] : []),
    '',
    ...row('Caja', snapshot.registerName, printerLayout),
    ...row('Turno', snapshot.shiftLabel, printerLayout),
    ...row('Cierre', formatReceiptDate(snapshot.closedAt, timezone), printerLayout),
    ...(options.includeUserNames && snapshot.closedBy ? row('Empleado', snapshot.closedBy, printerLayout) : []),
  ]

  if (options.includeOpeningAndClosingTimes) {
    lines.push(
      ...row('Apertura', formatReceiptDate(snapshot.openedAt, timezone), printerLayout),
      ...row('Cierre', formatReceiptDate(snapshot.closedAt, timezone), printerLayout),
    )
  }

  lines.push('', ...section('Resumen', printerLayout))
  lines.push(...row('Operaciones', String(snapshot.summary.salesCount), printerLayout))
  lines.push(...row('Ventas netas', money(snapshot.summary.totalSalesCents), printerLayout))
  lines.push(...row('Media por venta', money(snapshot.summary.averageSaleCents), printerLayout))

  if (payments.length) {
    lines.push('', ...section('Métodos de pago', printerLayout))
    for (const payment of payments) lines.push(...row(payment.label, money(payment.amountCents), printerLayout))
    if (options.includeTotalPayments) {
      lines.push(...row('Total pagos', money(payments.reduce((total, payment) => total + payment.amountCents, 0)), printerLayout))
    }
  }

  lines.push('', ...section('Efectivo', printerLayout))
  lines.push(...row('Fondo inicial', money(snapshot.cashFund.openingCashFundCents), printerLayout))
  lines.push(...row('Entradas', money(snapshot.cashMovements.cashEntriesCents), printerLayout))
  lines.push(...row('Salidas', money(snapshot.cashMovements.cashExitsCents), printerLayout))
  lines.push(...row('Tarjeta por efectivo', money(snapshot.cashMovements.cardCashbackCents), printerLayout))
  lines.push(...row('Efectivo esperado', money(snapshot.expectedAndCounted.expectedCashCents), printerLayout))
  if (options.includeExpectedAndCountedAmounts) {
    lines.push(...row('Efectivo contado', money(snapshot.expectedAndCounted.countedCashCents), printerLayout))
    lines.push(...row('Tarjeta esperada', money(snapshot.expectedAndCounted.expectedCardCents), printerLayout))
    lines.push(...row('Tarjeta declarada', money(snapshot.expectedAndCounted.countedCardCents), printerLayout))
  }
  lines.push(...row('Diferencia efectivo', money(snapshot.differences.cashDifferenceCents), printerLayout))
  lines.push(...row('Diferencia tarjeta', money(snapshot.differences.cardDifferenceCents), printerLayout))
  lines.push(...row('Fondo final', money(snapshot.cashFund.finalCashFundCents), printerLayout))

  lines.push('', ...section('Operativa', printerLayout))
  lines.push(...row('Efectivo facturado', money(amounts.billedCashCents), printerLayout))
  lines.push(...row('Datáfono esperado', money(amounts.cardTerminalExpectedCents), printerLayout))
  lines.push(...row(
    amounts.cashToWithdrawCents >= 0 ? 'Retirar de caja' : 'Añadir a caja',
    money(Math.abs(amounts.cashToWithdrawCents)),
    printerLayout,
  ))

  lines.push(
    '',
    ...row('ID cierre', closing.id, printerLayout),
    ...row('Generado', formatReceiptDate(closing.closedAt, timezone), printerLayout),
    '',
    ...centeredWrapped('CIERRE COMPLETADO', printerLayout),
    '',
    '',
  )
  return finalizeReceiptLines(lines, printerLayout)
}
