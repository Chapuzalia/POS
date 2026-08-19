import type { CashClosingRecord } from '../../../types/index.ts'
import { printRequestSchema } from '../schemas/printSchemas.ts'
import type { PrintAgentPreferences, PrinterLayout, PrintRequest } from '../types.ts'
import { buildClosingReportLines, type PrintEstablishment } from './documentLineBuilders.ts'

type MapperOptions = {
  closing: CashClosingRecord
  establishment: PrintEstablishment
  printerId: string
  printerLayout: PrinterLayout
  settings: PrintAgentPreferences
  isReprint?: boolean
  copyNumber?: number
}

export function cashClosingRequestId(closingId: string, isReprint = false, copyNumber = 0) {
  return isReprint
    ? `cash-closing:${closingId}:copy:${Math.max(1, Math.trunc(copyNumber))}`
    : `cash-closing:${closingId}:original`
}

export function mapCashClosingToPrintRequest({
  closing,
  establishment,
  printerId,
  printerLayout,
  settings,
  isReprint = false,
  copyNumber = 0,
}: MapperOptions): PrintRequest {
  return printRequestSchema.parse({
    requestId: cashClosingRequestId(closing.id, isReprint, copyNumber),
    printerId,
    force: isReprint,
    lines: buildClosingReportLines(closing, establishment, printerLayout, {
      ...(isReprint ? { copyLabel: 'COPIA' as const } : {}),
      includeExpectedAndCountedAmounts: settings.includeExpectedAndCountedAmounts,
      includeOpeningAndClosingTimes: settings.includeOpeningAndClosingTimes,
      includeTotalPayments: settings.includeTotalPayments,
      includeUserNames: settings.includeUserNames,
      includeZeroPaymentMethods: settings.includeZeroPaymentMethods,
      moneySymbol: settings.moneySymbol,
    }),
    options: {
      cut: settings.cut,
      openCashDrawer: false,
      copies: Math.max(1, Math.min(5, settings.cashClosingCopies)),
    },
  })
}
