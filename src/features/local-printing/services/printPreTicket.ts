import type { AppliedDiscount, CashSession, Customer, TenantContext, TicketLine } from '../../../types'
import type { PrintJob } from '../types'
import { buildPreTicketPayload } from '../../quick-sale/services/salePayload'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import { loadSelectedPrinterLayout } from './selectedPrinterLayout'
import { mapSaleToPrintRequest } from './ticketPrintMapper'

type PreTicketInput = {
  cashSession: CashSession
  context: TenantContext
  discount: AppliedDiscount | null
  invoiceCustomer?: Customer | null
  lines: TicketLine[]
}

let activePreTicketPrint: Promise<PrintJob> | null = null

async function executePreTicketPrint(input: PreTicketInput) {
  if (input.lines.length === 0) throw new Error('Añade productos antes de imprimir el pre-ticket.')
  const state = usePrintAgentStore.getState()
  if (!state.token) throw new Error('No hay ninguna impresora configurada.')
  const { printer, layout } = await loadSelectedPrinterLayout()
  const preview = buildPreTicketPayload(input.context, input.cashSession, input.lines, input.discount, input.invoiceCustomer)
  const request = mapSaleToPrintRequest({
    sale: preview,
    establishment: {
      name: input.context.venueName,
      address: input.context.venueAddress,
      legalName: input.context.venueLegalName,
      taxId: input.context.venueTaxId,
      timezone: input.context.venueTimeZone,
      cashRegisterName: input.cashSession.cashRegisterName,
      employeeName: input.context.userName,
    },
    printerId: printer.id,
    printerLayout: layout,
    footer: state.preferences.footer,
    cut: state.preferences.cut,
    isPreTicket: true,
  })
  return state.printTicket(request)
}

export async function printPreTicket(input: PreTicketInput) {
  if (activePreTicketPrint) return activePreTicketPrint
  const task = executePreTicketPrint(input)
  activePreTicketPrint = task
  try {
    return await task
  } finally {
    if (activePreTicketPrint === task) activePreTicketPrint = null
  }
}
