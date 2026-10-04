import type { SaleCreatedPayload, TenantContext } from '../../../types'
import { resolvePrintTemplate } from '../../print-templates/service.ts'
import { loadFiscalPosSettings } from '../../fiscal/local/settings.ts'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import type { PrintEstablishment } from './documentLineBuilders'
import { loadSelectedPrinterLayout } from './selectedPrinterLayout'
import { mapSaleToPrintRequest } from './ticketPrintMapper'

export async function printCompletedSale(input: {
  sale: SaleCreatedPayload
  establishment: PrintEstablishment
  isReprint?: boolean
  copyNumber?: number
  context: Pick<TenantContext, 'tenantId' | 'venueId'>
  cashDrawerAlreadyRequested?: boolean
}) {
  const state = usePrintAgentStore.getState()
  const { printer, layout } = await loadSelectedPrinterLayout()
  const template = await resolvePrintTemplate(input.context, input.sale.ticket.invoice ? 'invoice' : 'simplified_invoice')
  const printQr = input.sale.fiscal?.provider === 'verifactu'
    ? await loadFiscalPosSettings(input.context.tenantId).then((settings) => settings.print_ticket_qr).catch(() => true)
    : true
  const payload = mapSaleToPrintRequest({
    ...input,
    printerId: printer.id,
    printerLayout: layout,
    footer: state.preferences.footer,
    autoOpenCashDrawer: state.preferences.autoOpenCashDrawer,
    cashlogyConfigured: state.cashlogyConfigured,
    cut: state.preferences.cut,
    template: template.definition,
    printQr,
    cashDrawerAlreadyRequested: input.cashDrawerAlreadyRequested,

  })
  return state.printTicket(payload)
}
