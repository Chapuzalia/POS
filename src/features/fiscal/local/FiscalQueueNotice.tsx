import { useEffect } from 'react'
import type { CashSession, TenantContext } from '../../../types/index.ts'
import { startFiscalEconomicSyncWhileOpen } from './economicSync.ts'
import { fiscalBridgeAccessToken, loadFiscalInstallation } from './installation.ts'
import { localFiscalMode } from './mode.ts'
import { recoverServerConfirmedFiscalChain } from './serverRecovery.ts'
import { startFiscalSyncWhileOpen } from './sync.ts'

export function FiscalQueueNotice(props: { context: TenantContext | null; cashSession: CashSession | null }) {
  const mode = localFiscalMode()
  const { context, cashSession } = props

  useEffect(() => {
    if (mode !== 'production' || !context || !cashSession) return
    let active = true
    let stopBridge: (() => void) | null = null
    let stopEconomic: (() => void) | null = null
    const refresh = async () => {
      try {
        const installation = await loadFiscalInstallation(context, cashSession)
        const scope = { tenantId: installation.tenantId, fiscalSubjectId: installation.fiscalSubjectId,
          installationId: installation.installationId }
        if (!active) return
        if (!installation.bridgeUrl && stopBridge) {
          stopBridge()
          stopBridge = null
        }
        if (!stopEconomic) {
          try { await recoverServerConfirmedFiscalChain(installation) } catch { /* Issuance remains local during an outage. */ }
          if (!active) return
          stopEconomic = startFiscalEconomicSyncWhileOpen(scope)
        }
        if (!stopBridge && installation.bridgeUrl) stopBridge = startFiscalSyncWhileOpen({ ...scope, mode: 'production',
          baseUrl: installation.bridgeUrl, getAccessToken: fiscalBridgeAccessToken })
      } catch { /* Background recovery retries on the next interval or connectivity event. */ }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15000)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', refresh)
      stopBridge?.()
      stopEconomic?.()
    }
  }, [mode, context, cashSession])

  return null
}
