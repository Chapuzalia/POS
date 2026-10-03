import { useEffect } from 'react'
import type { CashSession, TenantContext } from '../../../types/index.ts'
import { startFiscalEconomicSyncWhileOpen } from './economicSync.ts'
import { fiscalBridgeAccessToken } from './installation.ts'
import { listLocalFiscalScopes } from './localLedger.ts'
import { localFiscalMode } from './mode.ts'
import { loadFiscalPosSettings, subscribeFiscalPosSettings } from './settings.ts'
import { startFiscalSyncWhileOpen } from './sync.ts'

/** Synchronization is independent of permission to issue, including retired installations. */
export function FiscalQueueNotice({ context, cashSession }: { context: TenantContext | null; cashSession: CashSession | null }) {
  const mode = localFiscalMode()
  useEffect(() => {
    if (mode === 'disabled' || !context || !cashSession) return
    let active = true
    let running = false
    let bridgeUrl: string | null = null
    const workers = new Map<string, () => void>()
    const refresh = async () => {
      if (running) return
      running = true
      try {
        const scopes = await listLocalFiscalScopes(context, cashSession.cashRegisterId)
        if (!active) return
        // Economic sync does not need bridge configuration or an active emission identity.
        for (const scope of scopes) {
          const key = `economic:${scope.installationId}`
          if (!workers.has(key)) workers.set(key, startFiscalEconomicSyncWhileOpen(scope))
        }
        const settings = await loadFiscalPosSettings(context.tenantId)
        if (!active) return
        if (bridgeUrl !== (settings.bridge_url || null)) {
          for (const [key, stop] of workers) if (key.startsWith('bridge:')) { stop(); workers.delete(key) }
          bridgeUrl = settings.bridge_url || null
        }
        if (bridgeUrl) for (const scope of scopes) {
          const key = `bridge:${scope.installationId}`
          if (!workers.has(key)) workers.set(key, startFiscalSyncWhileOpen({ ...scope, mode: 'production', baseUrl: bridgeUrl, getAccessToken: fiscalBridgeAccessToken }))
        }
      } catch { /* Pending scopes remain durable and retry on connectivity changes. */ }
      finally { running = false }
    }
    void refresh()
    const stopSettings = subscribeFiscalPosSettings(context.tenantId, () => void refresh())
    const timer = window.setInterval(() => void refresh(), 15000)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false; window.clearInterval(timer)
      stopSettings()
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', refresh)
      for (const stop of workers.values()) stop()
    }
  }, [mode, context, cashSession])
  return null
}
