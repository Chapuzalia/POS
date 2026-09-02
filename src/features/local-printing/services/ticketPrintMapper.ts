import type { SaleCreatedPayload } from '../../../types/index.ts'
import type { PrinterLayout, PrintRequest } from '../types.ts'
import { printRequestSchema } from '../schemas/printSchemas.ts'
import { shouldOpenCashDrawer } from './cashDrawerRules.ts'
import {
  buildSalePrintTemplateContext,
  type PrintEstablishment,
} from './documentLineBuilders.ts'
import { renderPrintTemplateWithFallback } from '../../print-templates/renderer.ts'
import { getSafeDefaultPrintTemplate } from '../../print-templates/defaults.ts'
import type { PrintTemplateDefinition } from '../../print-templates/types.ts'

type MapperOptions = {
  sale: SaleCreatedPayload
  establishment: PrintEstablishment
  printerId: string
  printerLayout: PrinterLayout
  footer?: string
  isReprint?: boolean
  copyNumber?: number
  isPreTicket?: boolean
  autoOpenCashDrawer?: boolean
  cashlogyConfigured?: boolean
  cut?: boolean
  template?: PrintTemplateDefinition
}

export function mapSaleToPrintRequest(options: MapperOptions): PrintRequest {
  const { sale } = options
  const isReprint = options.isReprint === true
  const isPreTicket = options.isPreTicket === true
  const copyNumber = Math.max(1, Math.trunc(options.copyNumber || 1))
  const payments = sale.payment && !isPreTicket
    ? [{ method: sale.payment.method, amountCents: sale.payment.amountCents }]
    : []
  const label = isPreTicket ? 'PRE-TICKET' : isReprint ? 'COPIA' : undefined
  const templateType = sale.ticket.invoice ? 'invoice' : 'simplified_invoice'
  const rendered = renderPrintTemplateWithFallback(
    options.template ?? getSafeDefaultPrintTemplate(templateType),
    getSafeDefaultPrintTemplate(templateType),
    buildSalePrintTemplateContext(sale, { ...options.establishment, footer: options.footer }, { label }),
    options.printerLayout,
  )
  return printRequestSchema.parse({
    requestId: isPreTicket
      ? `pre-ticket:${sale.sale.id}`
      : isReprint ? `print:${sale.sale.id}:copy:${copyNumber}` : `print:${sale.sale.id}:original`,
    printerId: options.printerId,
    force: isReprint,
    lines: rendered.lines,
    elements: rendered.elements,
    options: {
      cut: options.cut !== false,
      openCashDrawer: isPreTicket ? false : shouldOpenCashDrawer({
        payments,
        isReprint,
        settings: {
          autoOpenCashDrawer: options.autoOpenCashDrawer,
          cashlogyConfigured: options.cashlogyConfigured,
        },
      }),
      copies: 1,
    },
  })
}
