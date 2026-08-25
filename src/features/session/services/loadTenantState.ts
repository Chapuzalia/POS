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
import { hasTenantFeature } from '../../platform/tenantFeatureAccess'

const emptyCatalogState = {
  catalog: null,
  discountSchedule: { dayChangeTime: null, timeZone: 'Europe/Madrid' },
  discounts: [],
  manualDiscountEnabled: false,
  manualDiscountRequiresPin: false,
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
  if (context.deviceMode === 'kds') {
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
    discountSchedule: posCatalog.discountSchedule,
    discounts: hasTenantFeature(context, 'discounts') ? posCatalog.discounts : [],
    manualDiscountEnabled: hasTenantFeature(context, 'discounts') && posCatalog.manualDiscountEnabled,
    manualDiscountRequiresPin: hasTenantFeature(context, 'discounts') && posCatalog.manualDiscountRequiresPin,
    cashSession,
    productSalesStats,
    salesLedger: mergeLedgers(localLedger, remoteLedger),
  }
}
