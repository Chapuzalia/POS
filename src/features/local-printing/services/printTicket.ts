import { sileo } from 'sileo'
import type { SessionTicketRecord, TenantContext } from '../../../types'
import { getPrintAgentErrorMessage } from '../api/PrintAgentError'
import { nextPrintCopyNumber } from './printAgentStorage'
import { printCompletedSale } from './printCompletedSale'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import { getAutomaticSaleHardwareAction } from './cashDrawerRules'
import { getPrintFailurePatch } from './printFailure'

type PrintTicketOptions = {
  context: TenantContext
  payload: SessionTicketRecord['payload']
  tickets: SessionTicketRecord[]
  updateTicketPrintState: (saleId: string, patch: Partial<Pick<SessionTicketRecord,
    'printStatus' | 'printJobId' | 'printRequestId' | 'printedAt' | 'printErrorCode' | 'printAttempts'>>) => void
  options?: { isReprint?: boolean; copyNumber?: number }
}

export async function printTicket({ context, payload, tickets, updateTicketPrintState, options = {} }: PrintTicketOptions) {
  const printState = usePrintAgentStore.getState()
  const requestId = options.isReprint ? `print:${payload.sale.id}:copy:${options.copyNumber || 1}` : `print:${payload.sale.id}:original`
  const payments = payload.payment ? [{ method: payload.payment.method, amountCents: payload.payment.amountCents }] : []
  const hardwareAction = getAutomaticSaleHardwareAction({
    payments,
    isReprint: options.isReprint,
    settings: printState.preferences,
  })
  if (hardwareAction !== 'print') {
    updateTicketPrintState(payload.sale.id, {
      printStatus: 'not_requested', printRequestId: null, printErrorCode: null,
    })
    if (hardwareAction === 'none') return
    if (!printState.token || !printState.selectedPrinterId) {
      sileo.warning({ title: 'Venta completada, pero no se ha podido abrir el cajon', description: 'Configura el servidor y la impresora desde Ajustes > Hardware > Impresion.' })
      return
    }
    try {
      await printState.openCashDrawer({
        requestId: `drawer:${payload.sale.id}:payment`,
        printerId: printState.selectedPrinterId,
      })
      sileo.success({ title: 'Cajon abierto' })
    } catch (error) {
      sileo.warning({ title: 'La venta se ha completado, pero el cajon no se ha podido abrir', description: getPrintAgentErrorMessage(error) })
    }
    return
  }
  if (!printState.token || !printState.selectedPrinterId) {
    updateTicketPrintState(payload.sale.id, { printStatus: 'not_requested', printRequestId: requestId })
    sileo.warning({ title: 'Venta completada sin imprimir', description: 'Configura el servidor y la impresora desde Ajustes > Hardware > Impresion.' })
    return
  }
  updateTicketPrintState(payload.sale.id, {
    printStatus: 'pending', printRequestId: requestId, printErrorCode: null,
    printAttempts: (tickets.find((ticket) => ticket.id === payload.sale.id)?.printAttempts || 0) + 1,
  })
  try {
    const job = await printCompletedSale({
      sale: payload, establishment: { name: context.venueName },
      isReprint: options.isReprint, copyNumber: options.copyNumber,
    })
    updateTicketPrintState(payload.sale.id, {
      printStatus: 'printed', printJobId: job.jobId || job.id || null,
      printRequestId: job.requestId || requestId, printedAt: job.printedAt || new Date().toISOString(), printErrorCode: null,
    })
    sileo.success({ title: options.isReprint ? 'Copia impresa correctamente' : 'Ticket impreso correctamente' })
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'PRINT_FAILED'
    updateTicketPrintState(payload.sale.id, getPrintFailurePatch(code, requestId))
    sileo.warning({ title: 'La venta se ha completado, pero el ticket no se ha podido imprimir', description: getPrintAgentErrorMessage(error) })
  }
}

export function getReprintCopyNumber(ticketId: string) {
  const scope = usePrintAgentStore.getState().scope
  if (!scope) return null
  return nextPrintCopyNumber(scope, ticketId)
}

export function mergeRemoteTicketPrintStates(localTickets: SessionTicketRecord[], remoteTickets: SessionTicketRecord[]) {
  const localById = new Map(localTickets.map((ticket) => [ticket.id, ticket]))
  return remoteTickets.map((ticket) => {
    const local = localById.get(ticket.id)
    return local ? { ...ticket, printStatus: local.printStatus, printJobId: local.printJobId, printRequestId: local.printRequestId, printedAt: local.printedAt, printErrorCode: local.printErrorCode, printAttempts: local.printAttempts } : ticket
  })
}
