import type { SaleCreatedPayload } from '../../../types'
import { printRequestSchema } from '../schemas/printSchemas'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import { mapSaleToPrintRequest } from './ticketPrintMapper'

export async function printCompletedSale(input: {
  sale: SaleCreatedPayload
  establishment: { name: string; address?: string }
  isReprint?: boolean
  copyNumber?: number
}) {
  const state = usePrintAgentStore.getState()
  if (!state.selectedPrinter?.id) throw new Error('No hay ninguna impresora seleccionada.')
  const payload = mapSaleToPrintRequest({
    ...input,
    printerId: state.selectedPrinter.id,
    footer: state.preferences.footer,
    autoOpenCashDrawer: state.preferences.autoOpenCashDrawer,
    cut: state.preferences.cut,
  })
  return state.printTicket(printRequestSchema.parse(payload))
}
