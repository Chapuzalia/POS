import { sileo } from 'sileo'
import type { CashClosingRecord, TenantContext } from '../../../types/index.ts'
import { getPrintAgentErrorMessage } from '../api/PrintAgentError.ts'
import { usePrintAgentStore } from '../store/usePrintAgentStore.ts'
import { mapCashClosingToPrintRequest } from './cashClosingPrintMapper.ts'

export async function printCashClosing(input: {
  closing: CashClosingRecord
  context: TenantContext
  isReprint?: boolean
  copyNumber?: number
}) {
  const state = usePrintAgentStore.getState()
  const printerId = state.selectedPrinterId || state.selectedPrinter?.id
  if (!state.token) throw new Error('Servidor de impresion no configurado.')
  if (!printerId) throw new Error('No hay una impresora configurada.')
  const payload = mapCashClosingToPrintRequest({
    closing: input.closing,
    printerId,
    settings: state.preferences,
    isReprint: input.isReprint,
    copyNumber: input.copyNumber,
  })
  try {
    const job = await state.printTicket(payload)
    sileo.success({ title: input.isReprint ? 'Copia del cierre impresa correctamente.' : 'Cierre de caja impreso correctamente.' })
    return { job, requestId: payload.requestId, printerId }
  } catch (error) {
    sileo.warning({
      title: input.isReprint ? 'Error al reimprimir el cierre' : 'El cierre se ha guardado, pero no se ha podido imprimir.',
      description: getPrintAgentErrorMessage(error),
    })
    throw error
  }
}
