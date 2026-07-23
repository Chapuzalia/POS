import { useCallback, useEffect, useRef, useState } from 'react'
import { CrmPage } from '../components/crm/CrmPage'
import { SuperAdminPage } from '../components/superadmin/SuperAdminPage'
import { LoginScreen } from '../components/screens/LoginScreen'
import { LoadingScreen, MissingConfigScreen } from '../components/screens/StateScreens'
import themesData from '../config/themes.json'
import { CashSessionGate } from '../features/cash-registers/CashSessionGate'
import { useCashSession } from '../features/cash-registers'
import { useOfflineController, useRejectedSaleRecovery } from '../features/offline'
import { useQuickSale } from '../features/quick-sale'
import type { CatalogData } from '../features/catalog/domain/types'
import { subscribeToCatalogTabChanges } from '../features/catalog/data/catalog-realtime'
import { removeProductSalesStats } from '../features/quick-sale/services/productSalesStats'
import { useRestaurantController } from '../features/restaurant'
import { useLoginActivity, useTenantSession } from '../features/session'
import { loadTenantState } from '../features/session/services/loadTenantState'
import { shouldResetTenantState } from '../features/session/session-state'
import { useAddProductFeedback } from '../hooks/useAddProductFeedback'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { useThemeTokens } from '../hooks/useThemeTokens'
import {
  clearSaleLedger,
  clearSessionTickets,
  getCatalogStartTab,
  getCachedCashSession,
  getCachedCatalog,
  getCachedContext,
  getCachedProductSalesStats,
  getCachedTicket,
  getSaleLedger,
  getSessionTickets,
  saveCatalogStartTab,
  saveCachedCashSession,
  saveCachedCatalog,
  saveCachedContext,
  saveCachedProductSalesStats,
  saveSaleLedger,
} from '../lib/offlineStore'
import { supabaseConfig } from '../lib/supabase'
import { releaseLocalLoginLock } from '../services/loginLeaseService'
import {
  loadPosCatalogFromSupabase,
  loadProductSalesStatsFromSupabase,
  logoutTenant,
} from '../services/posService'
import type {
  CatalogStartTab,
  Discount,
  PaymentMethod,
  ProductSalesStat,
  TenantContext,
  ThemeDefinition,
} from '../types'
import { getReadableError } from '../utils/errors'
import { AppRouter } from './AppRouter'
import { isAdministrativeUser, isCrmAdministrator, isSuperadmin } from './app-permissions'
import { PosPage } from './PosPage'
import { useDomainErrors } from './useDomainErrors'

const themes = themesData as ThemeDefinition[]
const defaultThemeId = themes[0]?.id ?? 'hero-minimal'

export function AppShell() {
  const { selectedTheme, setThemeId, themeId } = useThemeTokens(themes, defaultThemeId)
  const isOnline = useOnlineStatus()
  const offline = useOfflineController(isOnline)
  const [context, setContext] = useState<TenantContext | null>(null)
  const [catalog, setCatalog] = useState<CatalogData | null>(null)
  const [discounts, setDiscounts] = useState<Discount[]>([])
  const [manualDiscountEnabled, setManualDiscountEnabled] = useState(false)
  const [catalogStartTab, setCatalogStartTab] = useState<CatalogStartTab>(() => getCatalogStartTab())
  const [productSalesStats, setProductSalesStats] = useState<ProductSalesStat[]>([])
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const {
    error,
    clear: clearErrors,
    setCashError,
    setGeneralError,
    setRestaurantError,
    setSaleError,
    setSessionError,
  } = useDomainErrors()
  const [loginLeaseBlocked, setLoginLeaseBlocked] = useState(false)
  const [pendingLoginContext, setPendingLoginContext] = useState<TenantContext | null>(null)
  const [mobileTicketOpen, setMobileTicketOpen] = useState(false)
  const [restaurantPaidFeedback, setRestaurantPaidFeedback] = useState<PaymentMethod | null>(null)
  const floatingTicketButtonRef = useRef<HTMLButtonElement>(null)
  const addFeedback = useAddProductFeedback(floatingTicketButtonRef)

  const persistProductSalesStats = useCallback((stats: ProductSalesStat[]) => {
    setProductSalesStats(stats)
    if (context) saveCachedProductSalesStats(context.tenantId, stats)
  }, [context])
  const subtractProductSalesStats = useCallback((
    lines: Array<{ productId: string; quantity: number; lineTotalCents: number }>,
  ) => {
    persistProductSalesStats(removeProductSalesStats(productSalesStats, lines))
  }, [persistProductSalesStats, productSalesStats])

  const cash = useCashSession({
    context,
    isOnline,
    onError: setCashError,
    refreshPendingCount: offline.refreshPendingCount,
    setBusy: setIsBusy,
    subtractProductSalesStats,
    syncPendingEvents: offline.syncPendingEvents,
  })
  const quickSale = useQuickSale({
    catalog,
    cashSession: cash.session,
    context,
    isOnline,
    ledger: cash.ledger,
    onAddFeedback: addFeedback.triggerAddFeedback,
    persistLedger: cash.persistLedger,
    persistProductSalesStats,
    persistTickets: cash.persistTickets,
    printSale: cash.printSale,
    productSalesStats,
    refreshPendingCount: offline.refreshPendingCount,
    setMobileTicketOpen,
    syncPendingEvents: offline.syncPendingEvents,
    tickets: cash.tickets,
  })
  const restaurant = useRestaurantController({
    appliedDiscount: quickSale.discount,
    catalog,
    cashSession: cash.session,
    context,
    enabled: Boolean(context && !isAdministrativeUser(context)),
    isBusy,
    isOnline,
    onAddFeedback: addFeedback.triggerAddFeedback,
    onError: setRestaurantError,
    onPaidFeedback: setRestaurantPaidFeedback,
    printSale: cash.printSale,
    refreshCashSales: cash.refreshConfirmedSale,
    refreshProductSalesStats: quickSale.refreshProductStats,
    setAppliedDiscount: quickSale.setDiscount,
    setBusy: setIsBusy,
    setMobileTicketOpen,
    syncPendingEvents: offline.syncPendingEvents,
  })

  useRejectedSaleRecovery({
    context,
    cashSession: cash.session,
    rejectedSaleEvent: offline.rejectedSaleEvent,
    clearRejectedSaleEvent: offline.clearRejectedSaleEvent,
    setCashSession: cash.setSession,
    setTicketLines: quickSale.hydrate,
    setDiscount: quickSale.setDiscount,
    setSalesLedger: cash.setLedger,
    setSessionTickets: cash.setTickets,
    resetCashUi: () => {
      quickSale.closeCashPayment()
      cash.setCloseModalOpen(false)
      cash.setHistoryOpen(false)
      setRestaurantPaidFeedback(null)
    },
    setError: setSaleError,
  })

  const clearActiveState = () => {
    setContext(null)
    setCatalog(null)
    setDiscounts([])
    setManualDiscountEnabled(false)
    setProductSalesStats([])
    setPendingLoginContext(null)
    setMobileTicketOpen(false)
    setRestaurantPaidFeedback(null)
    clearErrors()
    cash.reset()
    quickSale.reset()
    restaurant.reset()
  }
  const clearActiveStateRef = useRef(clearActiveState)
  clearActiveStateRef.current = clearActiveState
  const closeActiveLogin = useCallback(async (message: string, leaseBlocked: boolean) => {
    clearActiveStateRef.current()
    saveCachedContext(null)
    setLoginLeaseBlocked(leaseBlocked)
    setSessionError(message)
    try {
      await logoutTenant()
    } catch {
      releaseLocalLoginLock()
    }
  }, [setSessionError])
  useLoginActivity({ context, isOnline, onSessionClosed: closeActiveLogin })

  const applyTenantState = (
    nextContext: TenantContext,
    state: Awaited<ReturnType<typeof loadTenantState>>,
  ) => {
    if (shouldResetTenantState(context, nextContext)) {
      cash.reset()
      quickSale.reset()
      restaurant.reset()
    }
    setContext(nextContext)
    setLoginLeaseBlocked(false)
    saveCachedContext(nextContext)
    setCatalog(state.catalog)
    setDiscounts(state.discounts)
    setManualDiscountEnabled(state.manualDiscountEnabled)
    setProductSalesStats(state.productSalesStats)
    quickSale.hydrate(isAdministrativeUser(nextContext) ? [] : getCachedTicket(nextContext))
    const nextTickets = state.cashSession ? getSessionTickets(nextContext, state.cashSession.id) : []
    cash.hydrate(state.cashSession, state.salesLedger, nextTickets)
    if (state.catalog) saveCachedCatalog(nextContext, {
      catalog: state.catalog,
      discounts: state.discounts,
      manualDiscountEnabled: state.manualDiscountEnabled,
    })
    saveCachedProductSalesStats(nextContext.tenantId, state.productSalesStats)
    const previousSession = getCachedCashSession(nextContext)
    saveCachedCashSession(nextContext, state.cashSession)
    if (!isAdministrativeUser(nextContext) && state.cashSession) {
      saveSaleLedger(nextContext, state.salesLedger)
    } else if (!isAdministrativeUser(nextContext)) {
      clearSaleLedger(nextContext)
      if (previousSession) clearSessionTickets(nextContext, previousSession.id)
    }
  }
  const applyOfflineState = async (cachedContext: TenantContext) => {
    const cachedCatalog = getCachedCatalog(cachedContext)
    setContext(cachedContext)
    setCatalog(cachedCatalog?.catalog ?? null)
    setDiscounts(cachedCatalog?.discounts ?? [])
    setManualDiscountEnabled(cachedCatalog?.manualDiscountEnabled ?? false)
    setProductSalesStats(getCachedProductSalesStats(cachedContext.tenantId))
    const cachedSession = getCachedCashSession(cachedContext)
    cash.hydrate(
      cachedSession,
      getSaleLedger(cachedContext),
      cachedSession ? getSessionTickets(cachedContext, cachedSession.id) : [],
    )
    quickSale.hydrate(getCachedTicket(cachedContext))
  }
  const session = useTenantSession({
    isOnline,
    loginLeaseBlocked,
    pendingLoginContext,
    loadTenantState,
    applyTenantState,
    applyOfflineState,
    clearActiveState,
    syncPendingEvents: offline.syncPendingEvents,
    setError: setSessionError,
    setIsBootstrapping,
    setIsBusy,
    setIsLoading,
    setLoginLeaseBlocked,
    setPendingLoginContext,
  })

  const refreshCatalog = useCallback(async (activeContext = context) => {
    if (!activeContext || !isOnline) return
    setIsLoading(true)
    setGeneralError(null)
    try {
      const [nextCatalog, nextStats] = await Promise.all([
        loadPosCatalogFromSupabase(activeContext, true),
        loadProductSalesStatsFromSupabase(activeContext),
      ])
      setCatalog(nextCatalog.catalog)
      setDiscounts(nextCatalog.discounts)
      setManualDiscountEnabled(nextCatalog.manualDiscountEnabled)
      persistProductSalesStats(nextStats)
      saveCachedCatalog(activeContext, nextCatalog)
    } catch (refreshError) {
      setGeneralError(getReadableError(refreshError))
    } finally {
      setIsLoading(false)
    }
  }, [context, isOnline, persistProductSalesStats, setGeneralError])

  useEffect(() => {
    if (!context || !isOnline || isAdministrativeUser(context)) return undefined
    let refreshTimer: ReturnType<typeof window.setTimeout> | null = null
    const scheduleRefresh = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => void refreshCatalog(context), 200)
    }
    const unsubscribe = subscribeToCatalogTabChanges(context, scheduleRefresh)
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') scheduleRefresh()
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      unsubscribe()
    }
  }, [context, isOnline, refreshCatalog])
  const updateCatalogStartTab = (next: CatalogStartTab) => {
    setCatalogStartTab(next)
    saveCatalogStartTab(next)
  }

  if (!selectedTheme) return null
  if (!supabaseConfig.isReady) return <MissingConfigScreen />
  if (isBootstrapping || (isLoading && !context)) return <LoadingScreen />
  if (!context) return <LoginScreen
    allowOfflineEnter={!loginLeaseBlocked}
    cachedContext={getCachedContext()}
    conflictAccountName={pendingLoginContext?.userName ?? null}
    error={error}
    isBusy={isBusy}
    isOnline={isOnline}
    onCancelLoginConflict={() => void session.cancelPendingLogin()}
    onForceLoginConflict={() => void session.forceLogin()}
    onLogin={session.login}
    onOfflineEnter={session.enterOffline}
  />

  return <AppRouter context={context}>{() => {
    if (isSuperadmin(context)) return <SuperAdminPage context={context} error={error} isOnline={isOnline} onError={setGeneralError} onLogout={session.logout} />
    if (isCrmAdministrator(context)) return <CrmPage
      context={context}
      error={error}
      isOnline={isOnline}
      onCatalogChanged={(venueId) => refreshCatalog({ ...context, venueId })}
      onError={setGeneralError}
      onLogout={session.logout}
    />
    if (isOnline && !restaurant.tablesConfigLoaded) return <LoadingScreen />
    if (!cash.session) return <CashSessionGate
      cashClosings={cash.cashClosings}
      closingHistoryOpen={cash.closingHistoryOpen}
      completedClosing={cash.completedClosing}
      context={context}
      isBusy={isBusy}
      isOnline={isOnline}
      onJoin={(nextSession) => void cash.join(nextSession)}
      onCloseClosingHistory={() => cash.setClosingHistoryOpen(false)}
      onCloseCompletedClosing={() => cash.setCompletedClosing(null)}
      onLogout={() => void session.logout()}
      onOpen={cash.open}
      onOpenClosingHistory={() => void cash.openClosingHistory()}
      onPrintClosing={(closing, isReprint) => void cash.printClosing(closing, isReprint ? { isReprint: true, copyNumber: closing.printCopies + 1 } : {})}
      onRefresh={() => void cash.options.refresh(context)}
      registers={cash.options.registers}
      printingClosingId={cash.printingClosingId}
      sessions={cash.options.sessions}
    />
    return <PosPage
      addFeedback={addFeedback}
      catalog={catalog}
      discounts={discounts}
      manualDiscountEnabled={manualDiscountEnabled}
      cash={cash}
      catalogStartTab={catalogStartTab}
      context={context}
      error={error}
      floatingTicketButtonRef={floatingTicketButtonRef}
      isBusy={isBusy}
      isLoading={isLoading}
      isOnline={isOnline}
      mobileTicketOpen={mobileTicketOpen}
      offline={{ lastSyncError: offline.lastSyncError, pendingCount: offline.pendingCount, retry: offline.syncPendingEvents }}
      onLogout={session.logout}
      onRefreshCatalog={refreshCatalog}
      onSelectProduct={(item, allowVariantSelection, source) => quickSale.selectProduct(
        item,
        allowVariantSelection,
        source,
        restaurant.posView.type === 'table_order'
          ? (sellable, selection, selectedItem, sourceElement) => restaurant.addLine(sellable, selection, selectedItem, undefined, sourceElement)
          : quickSale.addLine,
      )}
      onSetError={setGeneralError}
      onSetMobileTicketOpen={setMobileTicketOpen}
      onUpdateCatalogStartTab={updateCatalogStartTab}
      productSalesStats={productSalesStats}
      quickSale={quickSale}
      restaurant={restaurant}
      restaurantPaidFeedback={restaurantPaidFeedback}
      selectedThemeId={themeId}
      setThemeId={setThemeId}
      themes={themes}
    />
  }}</AppRouter>
}

export default AppShell
