import type { AppliedDiscount, CashSession, TenantContext, TicketLine } from '../../../types'
import { buildPreTicketPayload } from '../../quick-sale/services/salePayload'
import { printRequestSchema } from '../schemas/printSchemas'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import { mapSaleToPrintRequest } from './ticketPrintMapper'

export async function printPreTicket(input: {
  cashSession: CashSession
  context: TenantContext
  discount: AppliedDiscount | null
  lines: TicketLine[]
}) {
  if (input.lines.length === 0) throw new Error('Añade productos antes de imprimir el pre-ticket.')
  const state = usePrintAgentStore.getState()
  const printerId = state.selectedPrinterId || state.selectedPrinter?.id
  if (!state.token || !printerId) throw new Error('No hay ninguna impresora configurada.')
  const preview = buildPreTicketPayload(input.context, input.cashSession, input.lines, input.discount)
  const request = mapSaleToPrintRequest({
    sale: preview,
    establishment: {
      name: input.context.venueName,
      address: input.context.venueAddress,
      legalName: input.context.venueLegalName,
      taxId: input.context.venueTaxId,
    },
    printerId,
    footer: state.preferences.footer,
    cut: state.preferences.cut,
    isPreTicket: true,
  })
  return state.printTicket(printRequestSchema.parse(request))
}
