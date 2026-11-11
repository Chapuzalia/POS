import { useEffect } from 'react'
import type { TenantContext } from '../../../types'
import { isBackofficeUser } from '../../../app/app-permissions'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import { isEmbeddedPrintAgent, waitForEmbeddedPrintAgent } from '../embedded/embeddedPrintAgent'

/** Configures the local print agent whenever the terminal identity changes. */
export function usePrintAgentScope(context: TenantContext | null) {
  const tenantId = context?.tenantId ?? null
  const establishmentId = context?.venueId ?? null
  const terminalId = context?.deviceId ?? null
  const disabled = !context || isBackofficeUser(context)
  useEffect(() => {
    if (disabled || !tenantId || !establishmentId || !terminalId) return undefined
    const abortController = new AbortController()
    const store = usePrintAgentStore.getState()
    store.configureScope({ tenantId, establishmentId, terminalId })
    void (async () => {
      if (isEmbeddedPrintAgent) {
        // En la app nativa el agente arranca con la app: se reconfigura con su URL/token al estar listo.
        try { await waitForEmbeddedPrintAgent() } catch { /* checkConnection reflejará el fallo */ }
        if (abortController.signal.aborted) return
        usePrintAgentStore.getState().configureScope({ tenantId, establishmentId, terminalId })
      }
      if (await usePrintAgentStore.getState().checkConnection(abortController.signal)) {
        const configured = usePrintAgentStore.getState()
        if (configured.token) await Promise.allSettled([
          configured.loadServerInfo(abortController.signal),
          configured.loadPrinters(abortController.signal),
        ])
      }
    })()
    return () => abortController.abort()
  }, [disabled, establishmentId, tenantId, terminalId])
}
