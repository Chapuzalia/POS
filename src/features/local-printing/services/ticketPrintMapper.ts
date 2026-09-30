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
import { resolveSafeTemplateDefinition } from '../../print-templates/saleTemplateGuard.ts'
import type { PrintTemplateDefinition } from '../../print-templates/types.ts'

type RenderedSaleDocument = ReturnType<typeof renderPrintTemplateWithFallback>

function hasRequiredFiscalLayout(rendered: RenderedSaleDocument, sale: SaleCreatedPayload) {
  const verificationUrl = sale.fiscal?.verificationUrl
  if (!sale.localFiscal || sale.fiscal?.provider !== 'verifactu' || !verificationUrl) return true
  const qrElements = rendered.elements.filter((element) => element.type === 'qr')
  const firstVisible = rendered.elements.find((element) => element.type === 'qr' || element.value.trim())
  const hasExactQr = qrElements.length === 1 && qrElements[0].data === verificationUrl
    && qrElements[0].errorCorrection === 'M' && qrElements[0].size === 6
    && firstVisible?.type === 'qr'
  const hasLegend = rendered.elements.some((element) => element.type === 'text' && element.value.trim() === 'VERI*FACTU')
  const hasRectificationReference = !sale.localFiscal.rectifiedInvoice || (
    rendered.elements.some((element) => element.type === 'text' && element.value.includes('FACTURA RECTIFICATIVA'))
    && rendered.elements.some((element) => element.type === 'text' && element.value.includes(`${sale.localFiscal?.rectifiedInvoice?.series}/${sale.localFiscal?.rectifiedInvoice?.number}`))
  )
  return hasExactQr && hasLegend === (sale.localFiscal.verifactuLegend !== false) && hasRectificationReference
}

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
  cashDrawerAlreadyRequested?: boolean
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
  const safeTemplate = getSafeDefaultPrintTemplate(templateType)
  // Incluso una plantilla guardada con una estructura manipulada imprime la estructura legal
  // obligatoria y solo conserva el texto literal decorativo del local.
  const requestedTemplate = resolveSafeTemplateDefinition(templateType, options.template)
  let rendered = renderPrintTemplateWithFallback(
    requestedTemplate,
    safeTemplate,
    buildSalePrintTemplateContext(sale, { ...options.establishment, footer: options.footer }, { label }),
    options.printerLayout,
  )
  if (!hasRequiredFiscalLayout(rendered, sale)) {
    rendered =
      renderPrintTemplateWithFallback(
        safeTemplate,
        safeTemplate,
        buildSalePrintTemplateContext(sale, { ...options.establishment, footer: options.footer }, { label }),
        options.printerLayout,
      )
  }
  const rectifiedInvoice = sale.localFiscal?.rectifiedInvoice
  if (rectifiedInvoice) {
    const rectifiedReference = `${rectifiedInvoice.series}/${rectifiedInvoice.number}`
    const hasRectification = rendered.elements.some((element) => element.type === 'text' && element.value.includes('FACTURA RECTIFICATIVA'))
      && rendered.elements.some((element) => element.type === 'text' && element.value.includes(rectifiedReference))
    if (!hasRectification) {
      const referenceLines = [
        `FACTURA RECTIFICATIVA · Rectifica factura ${rectifiedReference}`,
        `Fecha factura original: ${rectifiedInvoice.issuedAt}`,
      ]
      rendered.elements.splice(1, 0, ...referenceLines.map((value) => ({ type: 'text' as const, value })))
      rendered.lines.splice(1, 0, ...referenceLines)
    }
  }
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
      openCashDrawer: isPreTicket || options.cashDrawerAlreadyRequested ? false : shouldOpenCashDrawer({
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
