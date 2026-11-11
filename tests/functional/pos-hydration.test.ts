import { beforeEach, expect, it, vi } from 'vitest'
import type { OfflineEvent, ProductSalesStat, SaleRecord, TenantContext } from '../../src/types'
import { loadTenantState } from '../../src/features/session/services/loadTenantState'

const state = vi.hoisted(() => ({
  local: [] as SaleRecord[], pending: [] as OfflineEvent[], localTickets: [] as SaleRecord[],
  remote: vi.fn(),
  statsRemote: vi.fn(), cachedStats: [] as ProductSalesStat[],
}))
vi.mock('../../src/lib/offlineStore', () => ({
  getSaleLedger: () => state.local, getOfflineQueue: () => state.pending,
  getCachedCashSession: () => null, getCachedCatalog: () => null, getCachedProductSalesStats: () => state.cachedStats,
  clearSaleLedger() {}, clearSessionTickets() {}, saveCachedCashSession() {}, saveCachedCatalog() {},
  saveCachedProductSalesStats() {}, saveSaleLedger() {},
}))
vi.mock('../../src/features/cash-registers/services/localSessionTickets.ts', () => ({
  loadLocalSessionSales: async () => state.localTickets,
  loadPendingLocalSaleIds: async () => [],
}))
vi.mock('../../src/services/posService', () => ({
  loadOpenCashSession: async () => ({ id: 'session' }),
  loadPosCatalogFromSupabase: async () => ({ catalog: {}, discounts: [], discountSchedule: { dayChangeTime: null, timeZone: 'Europe/Madrid' } }),
  loadProductSalesStatsFromSupabase: () => state.statsRemote(),
  loadSalesLedgerFromSupabase: () => state.remote(),
  mergeLedgers: (local: SaleRecord[], remote: SaleRecord[]) => [...new Map([...remote, ...local].map(sale => [sale.id, sale])).values()],
}))
const context = { tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'user', role: 'cashier', deviceMode: 'checkout' } as TenantContext
const sale: SaleRecord = { id: 'sale', cashSessionId: 'session', createdAt: '2026-11-02', totalCents: 199, paymentMethod: 'card' }
beforeEach(() => {
  state.local = []; state.localTickets = []; state.pending = []; state.cachedStats = []
  state.remote.mockReset(); state.statsRemote.mockReset().mockResolvedValue([])
})

it('opens the POS with cached ranking even when product statistics time out', async () => {
  state.remote.mockResolvedValue([])
  state.cachedStats = [{ productId: 'product', quantity: 2, totalCents: 398 }]
  state.statsRemote.mockRejectedValue({ code: '57014', message: 'canceling statement due to statement timeout' })
  expect((await loadTenantState(context)).productSalesStats).toEqual(state.cachedStats)
  expect(state.statsRemote).not.toHaveBeenCalled()
})

it('opens the POS without a ranking when no cached statistics exist', async () => {
  state.remote.mockResolvedValue([])
  state.statsRemote.mockImplementation(() => new Promise(() => {}))
  expect((await loadTenantState(context)).productSalesStats).toEqual([])
  expect(state.statsRemote).not.toHaveBeenCalled()
})

it('does not resurrect a remotely removed sale from an unchanged local cache on login', async () => {
  state.local = [sale]
  state.remote.mockResolvedValue([])
  expect((await loadTenantState(context)).salesLedger).toEqual([])
})

it('retains a locally committed sale while a remote hydration read is pending', async () => {
  let finish!: (value: SaleRecord[]) => void
  state.remote.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const loading = loadTenantState(context)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  state.local = [sale]
  finish([])
  expect((await loading).salesLedger).toEqual([sale])
})
