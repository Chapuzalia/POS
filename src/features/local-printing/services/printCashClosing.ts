import { sileo } from 'sileo'
import type { CashClosingRecord, TenantContext } from '../../../types/index.ts'
import { getPrintAgentErrorMessage } from '../api/PrintAgentError.ts'
import { usePrintAgentStore } from '../store/usePrintAgentStore.ts'
import { mapCashClosingToPrintRequest } from './cashClosingPrintMapper.ts'
import { loadSelectedPrinterLayout } from './selectedPrinterLayout.ts'
import { resolvePrintTemplate } from '../../print-templates/service.ts'

export async function printCashClosing(input: {
  closing: CashClosingRecord
  context: TenantContext
  isReprint?: boolean
  copyNumber?: number
}) {
  const state = usePrintAgentStore.getState()
  if (!state.token) throw new Error('Servidor de impresión no configurado.')
  const { printer, layout } = await loadSelectedPrinterLayout()
  const template = await resolvePrintTemplate(input.context, 'cash_closure')
  const payload = mapCashClosingToPrintRequest({
    closing: input.closing,
    establishment: {
      name: input.context.venueName,
      address: input.context.venueAddress,
      legalName: input.context.venueLegalName,
      taxId: input.context.venueTaxId,
      timezone: input.context.venueTimeZone,
    },
    printerId: printer.id,
    printerLayout: layout,
    settings: state.preferences,
    isReprint: input.isReprint,
    copyNumber: input.copyNumber,
    template: template.definition,
  })
  try {
    const job = await state.printTicket(payload)
    sileo.success({ title: input.isReprint ? 'Copia del cierre impresa correctamente.' : 'Cierre de caja impreso correctamente.' })
    return { job, requestId: payload.requestId, printerId: printer.id }
  } catch (error) {
    sileo.warning({
      title: input.isReprint ? 'Error al reimprimir el cierre' : 'El cierre se ha guardado, pero no se ha podido imprimir.',
      description: getPrintAgentErrorMessage(error),
    })
    throw error
  }
}
