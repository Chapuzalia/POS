import { useEffect } from 'react'
import type { TenantContext } from '../../../types'
import { isAdministrativeUser } from '../../../app/app-permissions'
import { usePrintAgentStore } from '../store/usePrintAgentStore'

/** Configures the local print agent whenever the terminal identity changes. */
export function usePrintAgentScope(context: TenantContext | null) {
  useEffect(() => {
    if (!context || isAdministrativeUser(context) || !context.venueId || !context.deviceId) return undefined
    const abortController = new AbortController()
    const store = usePrintAgentStore.getState()
    store.configureScope({ tenantId: context.tenantId, establishmentId: context.venueId, terminalId: context.deviceId })
    void (async () => {
      if (await usePrintAgentStore.getState().checkConnection(abortController.signal)) {
        const configured = usePrintAgentStore.getState()
        if (configured.token) await Promise.allSettled([
          configured.loadServerInfo(abortController.signal),
          configured.loadPrinters(abortController.signal),
        ])
      }
    })()
    return () => abortController.abort()
  }, [context])
}
