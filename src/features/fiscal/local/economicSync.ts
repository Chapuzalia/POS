import { supabase } from '../../../lib/supabase.ts'
import { listLocalFiscalEntries, listPendingFiscalEconomicSales, markFiscalEconomicSaleSynced, markLocalFiscalIncidence } from './localLedger.ts'
import { isFiscalTransportFailure } from './deliveryIncidence.ts'
import type { FiscalScope } from './sync.ts'

/** Replays the original sale and its fiscal record through one Supabase RPC transaction. */
export async function synchronizeFiscalEconomicSales(scope: FiscalScope): Promise<void> {
  const client = supabase
  if (!client) throw new Error('Supabase no está disponible para sincronizar las ventas fiscales.')
  if (navigator.onLine === false) { await markLocalFiscalIncidence(scope); return }
  if (!navigator.locks?.request) throw new Error('Web Locks no está disponible para sincronizar ventas fiscales.')
  const key = `${scope.tenantId}:${scope.fiscalSubjectId}:${scope.installationId}`
  await navigator.locks.request(`tickit-fiscal-economic-sync:${key}`, { mode: 'exclusive' }, async () => {
    const [sales, records] = await Promise.all([
      listPendingFiscalEconomicSales(scope), listLocalFiscalEntries(scope),
    ])
    const byId = new Map(records.map(record => [record.id, record]))
    const ordered = sales.sort((a, b) => (byId.get(a.id)?.record.chainPosition ?? 0) - (byId.get(b.id)?.record.chainPosition ?? 0))
    for (const sale of ordered) {
      const entry = byId.get(sale.id)
      if (!entry) throw new Error('La venta pendiente no tiene su registro fiscal local.')
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(Object.assign(new Error('La sincronización económica agotó el tiempo de espera. La venta se conserva pendiente para reintentar.'), { name: 'TimeoutError' }))
        }, 20_000)
      })
      try {
        const { error } = await Promise.race([
          client.rpc('sync_local_fiscal_sale_created', {
            p_event_id: sale.eventId,
            p_payload: sale.payload,
            p_record: entry.record,
            p_invoice: { ...entry.invoice, invoiceId: entry.record.invoiceId },
          }).abortSignal(controller.signal),
          timeout,
        ])
        if (error) throw error
        await markFiscalEconomicSaleSynced(sale.id)
      } catch (error) {
        if (isFiscalTransportFailure(error)) await markLocalFiscalIncidence(scope)
        throw error
      } finally { clearTimeout(timer) }
    }
  })
}

export function startFiscalEconomicSyncWhileOpen(scope: FiscalScope): () => void {
  let stopped = false
  let running = false
  const run = () => {
    if (stopped || running || document.visibilityState === 'hidden') return
    running = true
    void synchronizeFiscalEconomicSales(scope).catch(() => { /* Pending sales stay in IndexedDB. */ })
      .finally(() => { running = false })
  }
  const timer = window.setInterval(run, 30000)
  window.addEventListener('online', run)
  document.addEventListener('visibilitychange', run)
  run()
  return () => {
    stopped = true
    window.clearInterval(timer)
    window.removeEventListener('online', run)
    document.removeEventListener('visibilitychange', run)
  }
}
