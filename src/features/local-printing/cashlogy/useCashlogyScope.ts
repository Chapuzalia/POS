import { useEffect } from 'react'
import type { TenantContext } from '../../../types'
import { isBackofficeUser } from '../../../app/app-permissions'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import { useCashlogyStore } from './useCashlogyStore'

export function useCashlogyScope(context: TenantContext | null) {
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
    const refresh = async () => {
      const print = usePrintAgentStore.getState()
      if (!print.cashlogyConfigured || !print.token) return
      try { await useCashlogyStore.getState().checkHealth(abortController.signal) } catch { /* se muestra en el estado */ }
      if (useCashlogyStore.getState().intent && !useCashlogyStore.getState().isPolling) {
        try { await useCashlogyStore.getState().recover(abortController.signal) } catch { /* permanece recuperable */ }
      }
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), 5000)
    return () => {
      abortController.abort()
      window.clearInterval(interval)
    }
  }, [disabled, establishmentId, tenantId, terminalId])
}
