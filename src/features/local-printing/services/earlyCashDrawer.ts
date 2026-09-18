import { reportOperationError } from '../../../lib/observability.ts'
import { sileo } from 'sileo'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import { shouldOpenCashDrawer } from './cashDrawerRules'

type Payment = { method?: string | null; amountCents?: number }

type EarlyCashDrawerInput = {
  requestId: string
  payments: Payment[]
}

const dispatchedRequestIds = new Set<string>()
const MAX_DISPATCHED_REQUEST_IDS = 200

export function requestEarlyCashDrawer({ requestId, payments }: EarlyCashDrawerInput): boolean {
  if (dispatchedRequestIds.has(requestId)) return false
  const state = usePrintAgentStore.getState()
  if (!shouldOpenCashDrawer({
    payments,
    settings: {
      autoOpenCashDrawer: state.preferences.autoOpenCashDrawer,
      cashlogyConfigured: state.cashlogyConfigured,
    },
  }) || !state.token || !state.selectedPrinterId) return false

  dispatchedRequestIds.add(requestId)
  if (dispatchedRequestIds.size > MAX_DISPATCHED_REQUEST_IDS) {
    const oldest = dispatchedRequestIds.values().next().value
    if (oldest) dispatchedRequestIds.delete(oldest)
  }
  void state.openCashDrawer({ requestId, printerId: state.selectedPrinterId }).catch((error) => {
    reportOperationError(error, { operation: 'sale.payment', integration: 'print-agent', operationId: requestId, step: 'drawer' })
    sileo.warning({ title: 'No se ha podido abrir el cajón', description: 'Comprueba la conexión con el servidor de impresión.' })
  })
  return true
}
