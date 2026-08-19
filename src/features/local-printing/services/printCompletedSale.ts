import type { SaleCreatedPayload } from '../../../types'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import type { PrintEstablishment } from './documentLineBuilders'
import { loadSelectedPrinterLayout } from './selectedPrinterLayout'
import { mapSaleToPrintRequest } from './ticketPrintMapper'

export async function printCompletedSale(input: {
  sale: SaleCreatedPayload
  establishment: PrintEstablishment
  isReprint?: boolean
  copyNumber?: number
}) {
  const state = usePrintAgentStore.getState()
  const { printer, layout } = await loadSelectedPrinterLayout()
  const payload = mapSaleToPrintRequest({
    ...input,
    printerId: printer.id,
    printerLayout: layout,
    footer: state.preferences.footer,
    autoOpenCashDrawer: state.preferences.autoOpenCashDrawer,
    cashlogyConfigured: state.cashlogyConfigured,
    cut: state.preferences.cut,
  })
  return state.printTicket(payload)
}
