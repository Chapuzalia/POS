import type { ProductSalesStat } from '../../../types'

export const PRODUCT_SALES_STATS_REFRESH_MS = 5 * 60_000

export function createProductSalesStatsRefresh(options: {
  load: () => Promise<ProductSalesStat[]>
  apply: (stats: ProductSalesStat[]) => void
  canRefresh: () => boolean
  revision: () => number
  now?: () => number
}) {
  const now = options.now ?? Date.now
  let lastAttempt = now()
  let inFlight: Promise<void> | null = null
  let active = true
  return {
    refreshIfStale(): Promise<void> {
      if (inFlight) return inFlight
      if (!active || !options.canRefresh() || now() - lastAttempt < PRODUCT_SALES_STATS_REFRESH_MS) return Promise.resolve()
      lastAttempt = now()
      const revision = options.revision()
      inFlight = Promise.resolve().then(options.load).then((stats) => {
        if (active && options.canRefresh() && options.revision() === revision) options.apply(stats)
      }).finally(() => { inFlight = null })
      return inFlight
    },
    dispose() { active = false },
  }
}
