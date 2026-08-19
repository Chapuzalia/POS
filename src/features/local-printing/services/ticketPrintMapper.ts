import type { SaleCreatedPayload } from '../../../types/index.ts'
import type { PrinterLayout, PrintRequest } from '../types.ts'
import { printRequestSchema } from '../schemas/printSchemas.ts'
import { shouldOpenCashDrawer } from './cashDrawerRules.ts'
import { buildSaleTicketLines, type PrintEstablishment } from './documentLineBuilders.ts'

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
}

export function mapSaleToPrintRequest(options: MapperOptions): PrintRequest {
  const { sale } = options
  const isReprint = options.isReprint === true
  const isPreTicket = options.isPreTicket === true
  const copyNumber = Math.max(1, Math.trunc(options.copyNumber || 1))
  const payments = sale.payment && !isPreTicket
    ? [{ method: sale.payment.method, amountCents: sale.payment.amountCents }]
    : []
  return printRequestSchema.parse({
    requestId: isPreTicket
      ? `pre-ticket:${sale.sale.id}`
      : isReprint ? `print:${sale.sale.id}:copy:${copyNumber}` : `print:${sale.sale.id}:original`,
    printerId: options.printerId,
    force: isReprint,
    lines: buildSaleTicketLines(
      sale,
      { ...options.establishment, footer: options.footer },
      options.printerLayout,
      { label: isPreTicket ? 'PRE-TICKET' : isReprint ? 'COPIA' : undefined },
    ),
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
