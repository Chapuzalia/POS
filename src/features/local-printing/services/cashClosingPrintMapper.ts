import type { CashClosingRecord } from '../../../types/index.ts'
import { printRequestSchema } from '../schemas/printSchemas.ts'
import type { PrintAgentPreferences, PrinterLayout, PrintRequest } from '../types.ts'
import { buildCashClosingPrintTemplateContext, type PrintEstablishment } from './documentLineBuilders.ts'
import { renderPrintTemplateWithFallback } from '../../print-templates/renderer.ts'
import { getSafeDefaultPrintTemplate } from '../../print-templates/defaults.ts'
import type { PrintTemplateDefinition } from '../../print-templates/types.ts'

type MapperOptions = {
  closing: CashClosingRecord
  establishment: PrintEstablishment
  printerId: string
  printerLayout: PrinterLayout
  settings: PrintAgentPreferences
  isReprint?: boolean
  copyNumber?: number
  template?: PrintTemplateDefinition
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
  template,
}: MapperOptions): PrintRequest {
  const templateOptions = {
    ...(isReprint ? { copyLabel: 'COPIA' as const } : {}),
    includeExpectedAndCountedAmounts: settings.includeExpectedAndCountedAmounts,
    includeOpeningAndClosingTimes: settings.includeOpeningAndClosingTimes,
    includeTotalPayments: settings.includeTotalPayments,
    includeUserNames: settings.includeUserNames,
    includeZeroPaymentMethods: settings.includeZeroPaymentMethods,
    moneySymbol: settings.moneySymbol,
  }
  const rendered = renderPrintTemplateWithFallback(
    template ?? getSafeDefaultPrintTemplate('cash_closure'),
    getSafeDefaultPrintTemplate('cash_closure'),
    buildCashClosingPrintTemplateContext(closing, establishment, templateOptions),
    printerLayout,
  )
  return printRequestSchema.parse({
    requestId: cashClosingRequestId(closing.id, isReprint, copyNumber),
    printerId,
    force: isReprint,
    lines: rendered.lines,
    elements: rendered.elements,
    options: {
      cut: settings.cut,
      openCashDrawer: false,
      copies: Math.max(1, Math.min(5, settings.cashClosingCopies)),
    },
  })
}
