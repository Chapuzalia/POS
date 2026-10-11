import { useEffect, useState } from 'react'
import type { CashSession, TenantContext } from '../../../types/index.ts'
import { startFiscalEconomicSyncWhileOpen } from './economicSync.ts'
import { fiscalBridgeAccessToken } from './installation.ts'
import { FISCAL_DELIVERY_CHANGED, listLocalFiscalEntries, listLocalFiscalScopes } from './localLedger.ts'
import { localFiscalMode } from './mode.ts'
import { loadFiscalPosSettings, subscribeFiscalPosSettings } from './settings.ts'
import { startFiscalSyncWhileOpen } from './sync.ts'
import { fiscalBridgeEligible } from './bridgeEligibility.ts'

/** Synchronization is independent of permission to issue, including retired installations. */
export function useFiscalQueue({ context, cashSession }: { context: TenantContext | null; cashSession: CashSession | null }) {
  const mode = localFiscalMode()
  const scopeKey = context && cashSession ? `${context.tenantId}:${context.venueId}:${context.deviceId}:${cashSession.cashRegisterId}` : null
  const [pending, setPending] = useState<{ scopeKey: string | null; ticketIds: string[] }>({ scopeKey: null, ticketIds: [] })
  useEffect(() => {
    setPending({ scopeKey, ticketIds: [] })
    if (mode === 'disabled' || !context || !cashSession) return
    let active = true
    let running = false
    let requested = false
    let bridgeUrl: string | null = null
    const workers = new Map<string, () => void>()
    const refresh = async () => {
      if (running) { requested = true; return }
      running = true
      try {
        const scopes = await listLocalFiscalScopes(context, cashSession.cashRegisterId)
        if (!active) return
        const entries = (await Promise.all(scopes.map(scope => listLocalFiscalEntries(scope)))).flat()
        if (!active) return
        const unsent = entries.filter(entry => entry.invoice.transmissionMode === 'bridge'
          && ['LOCAL_PENDING', 'VPS_STORED', 'REQUIRES_ACTION'].includes(entry.delivery.state))
        const originals = new Map(entries.map(entry => [`${entry.invoice.issuerNif}:${entry.invoice.series}/${entry.invoice.number}`, entry.invoice.ticketId]))
        const ticketIds = [...new Set(unsent.map(entry => {
          const alta = entry.record.canonicalRecord.RegistroAlta as { FacturasRectificadas?: { IDFacturaRectificada: Array<{ IDEmisorFactura: string; NumSerieFactura: string }> } } | undefined
          const reference = alta?.FacturasRectificadas?.IDFacturaRectificada[0]
          return reference ? originals.get(`${reference.IDEmisorFactura}:${reference.NumSerieFactura}`) ?? entry.invoice.ticketId : entry.invoice.ticketId
        }))].sort()
        setPending(current => current.scopeKey === scopeKey && current.ticketIds.length === ticketIds.length
          && current.ticketIds.every((id, index) => id === ticketIds[index]) ? current : { scopeKey, ticketIds })
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
          if (workers.has(key)) continue
          if (!await fiscalBridgeEligible(scope.tenantId, scope.installationId) || !active) continue
          if (!workers.has(key)) workers.set(key, startFiscalSyncWhileOpen({ ...scope, mode: 'production', baseUrl: bridgeUrl, getAccessToken: fiscalBridgeAccessToken }))
        }
      } catch { /* Pending scopes remain durable and retry on connectivity changes. */ }
      finally { running = false; if (requested && active) { requested = false; void refresh() } }
    }
    void refresh()
    const stopSettings = subscribeFiscalPosSettings(context.tenantId, () => void refresh())
    const timer = window.setInterval(() => void refresh(), 15000)
    window.addEventListener('online', refresh)
    window.addEventListener(FISCAL_DELIVERY_CHANGED, refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false; window.clearInterval(timer)
      stopSettings()
      window.removeEventListener('online', refresh)
      window.removeEventListener(FISCAL_DELIVERY_CHANGED, refresh)
      document.removeEventListener('visibilitychange', refresh)
      for (const stop of workers.values()) stop()
    }
  }, [mode, context, cashSession, scopeKey])
  return mode !== 'disabled' && scopeKey && pending.scopeKey === scopeKey ? pending.ticketIds : []
}
