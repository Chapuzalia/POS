import { getSaleLedger } from '../../../lib/offlineStore'
import {
  loadCatalogFromSupabase,
  loadOpenCashSession,
  loadProductSalesStatsFromSupabase,
  loadSalesLedgerFromSupabase,
  mergeLedgers,
} from '../../../services/posService'
import type { TenantContext } from '../../../types'
import { isCrmAdministrator, isSuperadmin } from '../../../app/app-permissions'

export async function loadTenantState(context: TenantContext) {
  if (isSuperadmin(context)) {
    return { catalog: null, cashSession: null, productSalesStats: [], salesLedger: [] }
  }
  if (isCrmAdministrator(context)) {
    return {
      catalog: null,
      cashSession: null,
      productSalesStats: [],
      salesLedger: [],
    }
  }
  const [catalog, cashSession, productSalesStats] = await Promise.all([
    loadCatalogFromSupabase(context),
    loadOpenCashSession(context),
    loadProductSalesStatsFromSupabase(context),
  ])
  const localLedger = cashSession ? getSaleLedger(context) : []
  const remoteLedger = cashSession ? await loadSalesLedgerFromSupabase(context, cashSession.id) : []
  return {
    catalog,
    cashSession,
    productSalesStats,
    salesLedger: mergeLedgers(localLedger, remoteLedger),
  }
}
