import { useEffect, useState } from 'react'
import type { CashSession, TenantContext } from '../../../types/index.ts'
import { startFiscalEconomicSyncWhileOpen } from './economicSync.ts'
import { fiscalBridgeAccessToken, loadFiscalInstallation } from './installation.ts'
import { listLocalFiscalEntries, listPendingFiscalEconomicSales } from './localLedger.ts'
import { localFiscalMode } from './mode.ts'
import { recoverServerConfirmedFiscalChain } from './serverRecovery.ts'
import { startFiscalSyncWhileOpen, summarizeLocalFiscalQueue } from './sync.ts'

type Summary = ReturnType<typeof summarizeLocalFiscalQueue> & { economicPending: number }

export function FiscalQueueNotice(props: { context: TenantContext | null; cashSession: CashSession | null }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
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
        if (!stopEconomic) {
          await recoverServerConfirmedFiscalChain(installation)
          if (!active) return
          stopEconomic = startFiscalEconomicSyncWhileOpen(scope)
        }
        if (!stopBridge) stopBridge = startFiscalSyncWhileOpen({ ...scope, mode: 'production',
          baseUrl: installation.bridgeUrl, getAccessToken: fiscalBridgeAccessToken })
        const [entries, sales] = await Promise.all([listLocalFiscalEntries(scope), listPendingFiscalEconomicSales(scope)])
        if (active) {
          setSummary({ ...summarizeLocalFiscalQueue(entries), economicPending: sales.length })
          setError(null)
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'No se puede consultar el estado fiscal de la caja.')
      }
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

  if (mode === 'disabled') return null
  if (mode === 'test') return <div role="alert" className="border-b border-amber-700 bg-amber-100 px-4 py-3 text-sm font-semibold text-amber-950">
    VERI*FACTU PRUEBAS: los cobros reales están bloqueados. Usa únicamente datos ficticios.
  </div>
  const pending = (summary?.states.LOCAL_PENDING ?? 0) + (summary?.states.VPS_STORED ?? 0)
  return <div role="status" aria-live="polite" className="border-b border-amber-700 bg-amber-100 px-4 py-3 text-sm font-semibold text-amber-950">
    VERI*FACTU: {error ? `emisión bloqueada — ${error}`
      : !cashSession ? 'abre una caja configurada para emitir facturas.'
        : `pendientes de envío al VPS/VERI*FACTU (solo local): ${summary?.states.LOCAL_PENDING ?? 0}; en VPS pendientes de AEAT: ${summary?.states.VPS_STORED ?? 0}; aceptados: ${summary?.states.AEAT_ACCEPTED ?? 0}; aceptados con errores: ${summary?.states.AEAT_ACCEPTED_WITH_ERRORS ?? 0}; rechazados: ${summary?.states.AEAT_REJECTED ?? 0}; requieren actuación: ${summary?.states.REQUIRES_ACTION ?? 0}; ventas pendientes de Supabase: ${summary?.economicPending ?? 0}${pending ? `; pendiente más antiguo: ${summary?.oldestPendingMinutes ?? 0} min` : ''}.`}
  </div>
}
