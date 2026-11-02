import {
  clearSaleLedger, clearSessionTickets, getCachedCashSession, getCachedCatalog,
  getCachedProductSalesStats, getOfflineQueue, getSaleLedger, saveCachedCashSession, saveCachedCatalog,
  saveCachedProductSalesStats, saveSaleLedger,
} from '../../../lib/offlineStore'
import { loadLocalSessionSales, loadPendingLocalSaleIds } from '../../cash-registers/services/localSessionTickets.ts'
import { pendingLedgerChanges, reconcileCashLedger } from '../../cash-registers/services/cashLedgerReconciliation'
import {
  loadOpenCashSession,
  loadPosCatalogFromSupabase,
  loadProductSalesStatsFromSupabase,
  loadSalesLedgerFromSupabase,
  mergeLedgers,
} from '../../../services/posService'
import type { CashSession, ProductSalesStat, SaleRecord, TenantContext } from '../../../types'
import type { CatalogData, PosCatalogState } from '../../catalog/domain/types'
import { isBackofficeUser } from '../../../app/app-permissions'
import { hasTenantAddon, hasTenantCapability } from '../../platform/tenantFeatureAccess'

export type TenantState = Omit<PosCatalogState, 'catalog'> & {
  catalog: CatalogData | null
  cashSession: CashSession | null
  productSalesStats: ProductSalesStat[]
  salesLedger: SaleRecord[]
}

const emptyCatalogState = {
  catalog: null,
  discountSchedule: { dayChangeTime: null, timeZone: 'Europe/Madrid' },
  discounts: [],
  manualDiscountEnabled: false,
  manualDiscountRequiresPin: false,
}

export function loadCachedTenantState(context: TenantContext): TenantState {
  return {
    ...(getCachedCatalog(context) ?? emptyCatalogState),
    cashSession: getCachedCashSession(context),
    productSalesStats: getCachedProductSalesStats(context.tenantId),
    salesLedger: getSaleLedger(context),
  }
}

export async function loadTenantState(context: TenantContext): Promise<TenantState> {
  if (isBackofficeUser(context) || context.deviceMode === 'kds') {
    return {
      ...emptyCatalogState,
      cashSession: null,
      productSalesStats: [],
      salesLedger: [],
    }
  }
  const [posCatalog, cashSession, productSalesStats] = await Promise.all([
    loadPosCatalogFromSupabase(context),
    loadOpenCashSession(context),
    loadProductSalesStatsFromSupabase(context),
  ])
  let salesLedger: SaleRecord[] = []
  if (cashSession) {
    const readLocalLedger = async () => mergeLedgers(await loadLocalSessionSales(context, cashSession), getSaleLedger(context))
    const baseline = await readLocalLedger()
    const pending = pendingLedgerChanges(getOfflineQueue(), context.tenantId)
    const [remote, pendingLocalIds] = await Promise.all([
      loadSalesLedgerFromSupabase(context, cashSession.id), loadPendingLocalSaleIds(context, cashSession),
    ])
    const current = await readLocalLedger()
    const latestPending = pendingLedgerChanges(getOfflineQueue(), context.tenantId)
    for (const id of [...latestPending.changed, ...pendingLocalIds]) pending.changed.add(id)
    for (const id of latestPending.voided) pending.voided.add(id)
    salesLedger = reconcileCashLedger(remote, baseline, current, pending)
  }
  const state: TenantState = {
    catalog: posCatalog.catalog,
    discountSchedule: posCatalog.discountSchedule,
    discounts: hasTenantAddon(context, 'promotions') ? posCatalog.discounts : [],
    manualDiscountEnabled: hasTenantCapability(context, 'manual_discounts') && posCatalog.manualDiscountEnabled,
    manualDiscountRequiresPin: hasTenantAddon(context, 'promotions') && posCatalog.manualDiscountRequiresPin,
    cashSession,
    productSalesStats,
    salesLedger,
  }
  return state
}

export function saveTenantState(context: TenantContext, state: TenantState) {
  if (state.catalog) saveCachedCatalog(context, {
    catalog: state.catalog, discounts: state.discounts,
    manualDiscountEnabled: state.manualDiscountEnabled,
    manualDiscountRequiresPin: state.manualDiscountRequiresPin,
    discountSchedule: state.discountSchedule,
  })
  saveCachedProductSalesStats(context.tenantId, state.productSalesStats)
  const previousSession = getCachedCashSession(context)
  saveCachedCashSession(context, state.cashSession)
  if (state.cashSession) saveSaleLedger(context, state.salesLedger)
  else {
    clearSaleLedger(context)
    if (previousSession) clearSessionTickets(context, previousSession.id)
  }
}
