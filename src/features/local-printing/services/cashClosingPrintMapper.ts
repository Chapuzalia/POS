import type { CashClosingRecord } from '../../../types/index.ts'
import type { CashClosingPrintDocument, PrintAgentPreferences, PrintRequest } from '../types.ts'
import { printRequestSchema } from '../schemas/printSchemas.ts'
import { getCashClosingReceiptDetails } from './cashClosingReceiptRenderer.ts'

type MapperOptions = {
  closing: CashClosingRecord
  printerId: string
  settings: PrintAgentPreferences
  isReprint?: boolean
  copyNumber?: number
}

export function cashClosingRequestId(closingId: string, isReprint = false, copyNumber = 0) {
  return isReprint
    ? `cash-closing:${closingId}:copy:${Math.max(1, Math.trunc(copyNumber))}`
    : `cash-closing:${closingId}:original`
}

export function mapCashClosingToPrintRequest({ closing, printerId, settings, isReprint = false, copyNumber = 0 }: MapperOptions): PrintRequest {
  const snapshot = closing.printSnapshot
  const payments = settings.includeZeroPaymentMethods
    ? snapshot.payments
    : snapshot.payments.filter((payment) => payment.amountCents !== 0)
  const document: CashClosingPrintDocument = {
    reportTitle: snapshot.reportTitle,
    companyName: snapshot.companyName,
    registerName: snapshot.registerName,
    shiftLabel: snapshot.shiftLabel,
    closedAt: snapshot.closedAt,
    timezone: snapshot.timezone,
    currency: snapshot.currency,
    locale: snapshot.locale,
    ...(isReprint ? { copyLabel: 'COPIA' } : {}),
    summary: snapshot.summary,
    payments,
    cashMovements: snapshot.cashMovements,
    cashFund: snapshot.cashFund,
    differences: snapshot.differences,
    ...(settings.includeExpectedAndCountedAmounts ? { expectedAndCounted: snapshot.expectedAndCounted } : {}),
    ...(settings.includeUserNames ? { users: { openedBy: snapshot.openedBy, closedBy: snapshot.closedBy } } : {}),
    ...(settings.includeOpeningAndClosingTimes ? { times: { openedAt: snapshot.openedAt, closedAt: snapshot.closedAt } } : {}),
    includeTotalPayments: settings.includeTotalPayments,
    paperWidth: settings.cashClosingPaperWidth,
  }
  const totalSalesCents = Math.max(0, snapshot.summary.totalSalesCents)
  const request: PrintRequest = {
    requestId: cashClosingRequestId(closing.id, isReprint, copyNumber),
    printerId,
    ticket: {
      establishmentName: snapshot.companyName,
      ticketNumber: snapshot.reportTitle,
      date: snapshot.closedAt,
      items: [{
        name: `Cierre · ${snapshot.registerName}`.slice(0, 200),
        quantity: 1,
        unitPriceCents: totalSalesCents,
        totalCents: totalSalesCents,
        additions: getCashClosingReceiptDetails(document, settings.moneySymbol),
      }],
      subtotalCents: totalSalesCents,
      totalCents: totalSalesCents,
      deferredLabel: 'CIERRE DE CAJA',
      footer: 'CIERRE COMPLETADO',
      ...(isReprint ? { copyLabel: 'COPIA' } : {}),
    },
    options: {
      cut: settings.cut,
      openCashDrawer: false,
      copies: Math.max(1, Math.min(5, settings.cashClosingCopies)),
    },
  }
  return printRequestSchema.parse(request)
}
