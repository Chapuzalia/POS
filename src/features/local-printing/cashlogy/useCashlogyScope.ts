import { useEffect } from 'react'
import type { TenantContext } from '../../../types'
import { isBackofficeUser } from '../../../app/app-permissions'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import { cashlogyActiveStatuses, cashlogyManagementActiveStatuses } from './cashlogyPolling'
import { useCashlogyManagementStore } from './useCashlogyManagementStore'
import { useCashlogyStore } from './useCashlogyStore'

export function useCashlogyScope(context: TenantContext | null, cashSessionId: string | null) {
  const tenantId = context?.tenantId ?? null
  const establishmentId = context?.venueId ?? null
  const terminalId = context?.deviceId ?? null
  const disabled = !context || isBackofficeUser(context)
  useEffect(() => {
    if (disabled || !tenantId || !establishmentId || !terminalId) return undefined
    const scope = { tenantId, establishmentId, terminalId }
    const abortController = new AbortController()
    const store = useCashlogyStore.getState()
    store.configureScope(scope)
    useCashlogyManagementStore.getState().configureScope(scope)
    const refresh = async () => {
      const print = usePrintAgentStore.getState()
      if (!print.cashlogyConfigured || !print.token) return
      try { await useCashlogyStore.getState().checkHealth(abortController.signal) } catch { /* se muestra en el estado */ }
      const payment = useCashlogyStore.getState()
      const paymentNeedsRecovery = payment.intent
        && payment.intent.chargeRequestedAt !== null
        && !payment.isPolling
        && !payment.isStarting
        && !payment.isCancelling
        && (!payment.transaction || cashlogyActiveStatuses.has(payment.transaction.status))
      if (paymentNeedsRecovery) {
        try { await useCashlogyStore.getState().recover(abortController.signal) } catch { /* permanece recuperable */ }
      }
      const management = useCashlogyManagementStore.getState()
      const managementNeedsRecovery = management.intent
        && !management.isPolling
        && !management.isStarting
        && !management.isMutating
        && !management.isCancelling
        && (management.stackerCollectionPending
          || !management.operation
          || (cashlogyManagementActiveStatuses.has(management.operation.status)
            && management.operation.status !== 'awaiting_dispense'))
      if (managementNeedsRecovery) {
        try { await management.recover(abortController.signal) } catch { /* permanece recuperable por requestId */ }
      }
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), 5000)
    return () => {
      abortController.abort()
      window.clearInterval(interval)
    }
  }, [disabled, establishmentId, tenantId, terminalId])

  useEffect(() => {
    useCashlogyManagementStore.getState().setCashSessionId(disabled ? null : cashSessionId)
  }, [cashSessionId, disabled, establishmentId, tenantId, terminalId])
}
