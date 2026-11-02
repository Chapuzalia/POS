import { useCallback, useEffect, useRef, useState } from 'react'
import { isBackofficeUser } from '../../../app/app-permissions'
import { saveCachedProductSalesStats } from '../../../lib/offlineStore'
import { loadProductSalesStatsFromSupabase } from '../../../services/posService'
import type { ProductSalesStat, SessionTicketRecord, TenantContext } from '../../../types'
import { addConfirmedProductSalesStats, removeProductSalesStats } from '../services/productSalesStats'
import { createProductSalesStatsRefresh, PRODUCT_SALES_STATS_REFRESH_MS } from '../services/productSalesStatsRefresh'

export function useProductSalesStats(context: TenantContext | null, isOnline: boolean) {
  const [stats, setStats] = useState<ProductSalesStat[]>([])
  const revision = useRef(0)
  const pending = useRef(0)
  const blocked = useRef(false)

  const hydrate = useCallback((next: ProductSalesStat[]) => {
    revision.current++
    setStats(next)
  }, [])

  const persist = useCallback((next: ProductSalesStat[]) => {
    hydrate(next)
    if (context) saveCachedProductSalesStats(context.tenantId, next)
  }, [context, hydrate])

  const subtract = useCallback((lines: Array<{ productId: string; quantity: number; lineTotalCents: number }>) => {
    persist(removeProductSalesStats(stats, lines))
  }, [persist, stats])

  const addConfirmed = useCallback((ticket: SessionTicketRecord) => {
    revision.current++
    setStats((current) => {
      const next = addConfirmedProductSalesStats(current, ticket.payload.lines)
      if (context) saveCachedProductSalesStats(context.tenantId, next)
      return next
    })
  }, [context])

  const trackRefresh = useCallback(async <T,>(work: () => Promise<T>) => {
    revision.current++
    pending.current++
    try { return await work() }
    finally { pending.current-- }
  }, [])

  const setRefreshBlocked = useCallback((value: boolean) => {
    blocked.current = value
    if (value) revision.current++
  }, [])

  useEffect(() => {
    if (!context || !isOnline || isBackofficeUser(context) || context.deviceMode === 'kds') return undefined
    const controller = createProductSalesStatsRefresh({
      load: () => loadProductSalesStatsFromSupabase(context),
      apply: (next) => {
        setStats(next)
        saveCachedProductSalesStats(context.tenantId, next)
      },
      canRefresh: () => document.visibilityState === 'visible' && !blocked.current && pending.current === 0,
      revision: () => revision.current,
    })
    const refresh = () => {
      void controller.refreshIfStale().catch(() => {
        // Keep the local ranking when the backend is temporarily unavailable.
      })
    }
    const intervalId = window.setInterval(refresh, PRODUCT_SALES_STATS_REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      controller.dispose()
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [context, isOnline])

  return { stats, hydrate, persist, subtract, addConfirmed, trackRefresh, setRefreshBlocked }
}
