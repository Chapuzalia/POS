import { getSaleLedger } from '../../../lib/offlineStore'
import {
  loadOpenCashSession,
  loadPosCatalogFromSupabase,
  loadProductSalesStatsFromSupabase,
  loadSalesLedgerFromSupabase,
  mergeLedgers,
} from '../../../services/posService'
import type { TenantContext } from '../../../types'
import { isBackofficeUser } from '../../../app/app-permissions'

const emptyCatalogState = {
  catalog: null,
  discounts: [],
  manualDiscountEnabled: false,
}

export async function loadTenantState(context: TenantContext) {
  if (isBackofficeUser(context)) {
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
  const localLedger = cashSession ? getSaleLedger(context) : []
  const remoteLedger = cashSession ? await loadSalesLedgerFromSupabase(context, cashSession.id) : []
  return {
    catalog: posCatalog.catalog,
    discounts: posCatalog.discounts,
    manualDiscountEnabled: posCatalog.manualDiscountEnabled,
    cashSession,
    productSalesStats,
    salesLedger: mergeLedgers(localLedger, remoteLedger),
  }
}
