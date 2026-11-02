import { lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PosBootstrap } from './application-bootstrap'
import type { useOfflineController } from '../features/offline/hooks/useOfflineController'
import { LoadingScreen, PosStartupReveal } from '../components/screens/StateScreens'
import { CashSessionGate } from '../features/cash-registers/CashSessionGate'
import { useCashSession } from '../features/cash-registers'
import { useQuickSale } from '../features/quick-sale'
import { useCashlogyManagementStore } from '../features/local-printing/cashlogy/useCashlogyManagementStore'
import { useCashlogyStore } from '../features/local-printing/cashlogy/useCashlogyStore'
import { usePrintAgentStore } from '../features/local-printing/store/usePrintAgentStore'
import type { CatalogData } from '../features/catalog/domain/types'
import { subscribeToCatalogTabChanges } from '../features/catalog/data/catalog-realtime'
import { useProductSalesStats } from '../features/quick-sale/hooks/useProductSalesStats'
import { useRestaurantController } from '../features/restaurant'
import { useReservationsController } from '../features/reservations/hooks/useReservationsController'
import { useAddProductFeedback } from '../hooks/useAddProductFeedback'
import { hasTenantCapability } from '../features/platform/tenantFeatureAccess'
import {
  getCatalogStartTab,
  getCachedTicket,
  getSessionTickets,
  saveCatalogStartTab,
  saveCachedCatalog,
} from '../lib/offlineStore'
import { loadPosCatalogFromSupabase } from '../services/posService'
import type {
  CatalogStartTab,
  Discount,
  PaymentMethod,
  TenantContext,
  ThemeDefinition,
} from '../types'
import { getReadableError } from '../utils/errors'
import { isBackofficeUser } from './app-permissions'
import { useRejectedSaleRecovery } from '../features/offline'
import { FiscalInstallationGate } from '../features/fiscal/local/FiscalInstallationGate'
import { useFiscalQueue } from '../features/fiscal/local/useFiscalQueue'

const PosPage = lazy(() => import('./PosPage').then((module) => ({ default: module.PosPage })))
export type PosRuntimeProps = {
  context: TenantContext
  bootstrap: PosBootstrap
  offline: ReturnType<typeof useOfflineController>
  isOnline: boolean
  error: string | null
  errorId: number
  onError: (message: string | null) => void
  onLogout: () => Promise<void>
  onBusyChange: (busy: boolean) => void
  themes: ThemeDefinition[]
  selectedThemeId: string
  setThemeId: (id: string) => void
}

export function PosRuntime({ context, bootstrap, offline, isOnline, error, errorId, onError, onLogout, onBusyChange, themes, selectedThemeId, setThemeId }: PosRuntimeProps) {
  const [appliedBootstrap, setAppliedBootstrap] = useState<PosBootstrap | null>(null)
  const [catalog, setCatalog] = useState<CatalogData | null>(null)
  const [discounts, setDiscounts] = useState<Discount[]>([])
  const [manualDiscountEnabled, setManualDiscountEnabled] = useState(false)
  const [manualDiscountRequiresPin, setManualDiscountRequiresPin] = useState(false)
  const [discountSchedule, setDiscountSchedule] = useState({
    dayChangeTime: null as string | null,
    timeZone: 'Europe/Madrid',
  })
  const [catalogStartTab, setCatalogStartTab] = useState<CatalogStartTab>(() => getCatalogStartTab())
  const productStats = useProductSalesStats(context, isOnline && appliedBootstrap === bootstrap)
  const productSalesStats = productStats.stats
  const [isBusy, setIsBusy] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const cashlogyPaymentActive = useCashlogyStore((state) => Boolean(
    state.intent || state.isStarting || state.isPolling || state.isCancelling,
  ))
  const cashlogyManagementActive = useCashlogyManagementStore((state) => Boolean(
    state.intent
      || state.isStarting
      || state.isPolling
      || state.isMutating
      || state.isCancelling
      || state.isRecordingStackerCollection
      || state.stackerCollectionPending,
  ))
  const localHardwareActive = usePrintAgentStore((state) => state.isPrintingTicket || state.isOpeningCashDrawer)
  const setCashError = onError
  const setSaleError = onError
  const setRestaurantError = onError
  const setGeneralError = onError
  const [mobileTicketOpen, setMobileTicketOpen] = useState(false)
  const [restaurantPaidFeedback, setRestaurantPaidFeedback] = useState<PaymentMethod | null>(null)
  const [auxiliaryOperationBusy, setAuxiliaryOperationBusy] = useState(false)
  const floatingTicketButtonRef = useRef<HTMLButtonElement>(null)
  const addFeedback = useAddProductFeedback(floatingTicketButtonRef)

  const cash = useCashSession({
    context,
    isOnline,
    onError: setCashError,
    refreshPendingCount: offline.refreshPendingCount,
    setBusy: setIsBusy,
    subtractProductSalesStats: productStats.subtract,
    onConfirmedSale: productStats.addConfirmed,
    syncPendingEvents: offline.syncPendingEvents,
  })
  const promotionsEnabled = Boolean(context && hasTenantCapability(context, 'promotions'))
  const fiscalPendingTicketIds = useFiscalQueue({
    context: context && !isBackofficeUser(context) && context.deviceMode !== 'kds' ? context : null,
    cashSession: cash.session,
  })
  const quickSale = useQuickSale({
    catalog,
    cashSession: cash.session,
    discounts,
    discountSchedule,
    context,
    isOnline,
    ledger: cash.ledger,
    onAddFeedback: addFeedback.triggerAddFeedback,
    persistLedger: cash.persistLedger,
    persistProductSalesStats: productStats.persist,
    persistTickets: cash.persistTickets,
    printSale: cash.printSale,
    onError: setSaleError,
    productSalesStats,
    refreshPendingCount: offline.refreshPendingCount,
    setMobileTicketOpen,
    syncPendingEvents: offline.syncPendingEvents,
    tickets: cash.tickets,
  })
  const closeDiscountModal = quickSale.closeDiscountModal
  const setAppliedDiscount = quickSale.setDiscount
  useEffect(() => {
    if (promotionsEnabled) return
    if (quickSale.discount?.discountId) setAppliedDiscount(null)
    closeDiscountModal()
  }, [closeDiscountModal, promotionsEnabled, quickSale.discount?.discountId, setAppliedDiscount])
  const restaurant = useRestaurantController({
    appliedDiscount: promotionsEnabled ? quickSale.discount : null,
    catalog,
    cashSession: cash.session,
    context,
    enabled: Boolean(context && context.deviceMode !== 'kds' && !isBackofficeUser(context) && hasTenantCapability(context, 'restaurant')),
    isBusy,
    isOnline,
    onAddFeedback: addFeedback.triggerAddFeedback,
    onError: setRestaurantError,
    onPaidFeedback: setRestaurantPaidFeedback,
    printSale: cash.printSale,
    refreshCashSales: (ticketId, missingTicketTitle, shouldPrint) => productStats.trackRefresh(
      () => cash.refreshConfirmedSale(ticketId, missingTicketTitle, shouldPrint),
    ),
    setAppliedDiscount: quickSale.setDiscount,
    setBusy: setIsBusy,
    setMobileTicketOpen,
    syncPendingEvents: offline.syncPendingEvents,
  })
  const reservations = useReservationsController({
    cashSession: cash.session,
    context,
    enabled: Boolean(context && context.deviceMode !== 'kds' && !isBackofficeUser(context) && hasTenantCapability(context, 'reservations') && restaurant.tablesEnabled),
    isOnline,
    operationalMap: restaurant.map,
    onError: setRestaurantError,
    onOpenOrder: async (orderId) => { await restaurant.openExistingOrder(orderId) },
    refreshOperationalMap: restaurant.reloadMap,
  })

  const setStatsRefreshBlocked = productStats.setRefreshBlocked
  useEffect(() => {
    setStatsRefreshBlocked(isBusy || offline.isSyncing || offline.pendingCount > 0 || quickSale.paymentInFlight)
  }, [isBusy, offline.isSyncing, offline.pendingCount, quickSale.paymentInFlight, setStatsRefreshBlocked])

  useRejectedSaleRecovery({
    context: appliedBootstrap === bootstrap ? context : null,
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

  const hydrateBootstrap = () => {
    const state = bootstrap.state
    setCatalog(state.catalog)
    setDiscounts(state.discounts)
    setManualDiscountEnabled(state.manualDiscountEnabled)
    setManualDiscountRequiresPin(state.manualDiscountRequiresPin)
    setDiscountSchedule(state.discountSchedule)
    productStats.hydrate(state.productSalesStats)
    quickSale.hydrate(getCachedTicket(context))
    cash.hydrate(state.cashSession, state.salesLedger, state.cashSession ? getSessionTickets(context, state.cashSession.id) : [])
    setAppliedBootstrap(bootstrap)
  }
  const hydrateRef = useRef(hydrateBootstrap)
  hydrateRef.current = hydrateBootstrap
  useLayoutEffect(() => { hydrateRef.current() }, [bootstrap])

  const refreshCatalog = useCallback(async (activeContext = context) => {
    if (!activeContext || !isOnline) return
    setIsLoading(true)
    setGeneralError(null)
    try {
      const nextCatalog = await loadPosCatalogFromSupabase(activeContext, true)
      setCatalog(nextCatalog.catalog)
      setDiscounts(nextCatalog.discounts)
      setManualDiscountEnabled(nextCatalog.manualDiscountEnabled)
      setManualDiscountRequiresPin(nextCatalog.manualDiscountRequiresPin)
      setDiscountSchedule(nextCatalog.discountSchedule)
      saveCachedCatalog(activeContext, nextCatalog)
    } catch (refreshError) {
      setGeneralError(getReadableError(refreshError, { operation: 'app.AppShell' }))
    } finally {
      setIsLoading(false)
    }
  }, [context, isOnline, setGeneralError])

  useEffect(() => {
    if (!context || !isOnline || isBackofficeUser(context)) return undefined
    let refreshTimer: number | null = null
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

  const updateBlocked = !isOnline
    || isBusy
    || quickSale.paymentInFlight
    || quickSale.cashPaymentOpen
    || offline.isSyncing
    || offline.pendingCount > 0
    || Boolean(offline.rejectedSaleEvent)
    || auxiliaryOperationBusy
    || restaurant.saveState !== 'saved'
    || Boolean(restaurant.pendingPayment)
    || restaurant.equalSplitOpen
    || reservations.isLoading
    || Boolean(reservations.editor)
    || Boolean(reservations.pendingConflictDraft)
    || cash.movementSaving
    || Boolean(cash.printingClosingId)
    || cashlogyPaymentActive
    || cashlogyManagementActive
    || localHardwareActive

  useEffect(() => {
    onBusyChange(updateBlocked || appliedBootstrap !== bootstrap)
    return () => onBusyChange(false)
  }, [appliedBootstrap, bootstrap, onBusyChange, updateBlocked])

  if (appliedBootstrap !== bootstrap || (isOnline && !restaurant.tablesConfigLoaded)) return <LoadingScreen />
  if (!cash.session && !reservations.isOpen) return <PosStartupReveal><CashSessionGate
      canOpenReservations={hasTenantCapability(context, 'restaurant') && hasTenantCapability(context, 'reservations')}
      cashClosings={cash.cashClosings}
      closingHistoryOpen={cash.closingHistoryOpen}
      completedClosing={cash.completedClosing}
      context={context}
      error={error}
      isBusy={isBusy}
      isOnline={isOnline}
      onJoin={(nextSession) => void cash.join(nextSession)}
      onCloseClosingHistory={() => cash.setClosingHistoryOpen(false)}
      onCloseCompletedClosing={() => cash.setCompletedClosing(null)}
      onLogout={() => void onLogout()}
      onOpen={cash.open}
      onOpenReservations={reservations.open}
      onOpenClosingHistory={() => void cash.openClosingHistory()}
      onPrintClosing={(closing, isReprint, confirmedNotPrinted) => void cash.printClosing(closing, isReprint ? { isReprint: true, confirmedNotPrinted } : {})}
      onRefresh={() => void cash.options.refresh(context)}
      registers={cash.options.registers}
      printingClosingId={cash.printingClosingId}
      sessions={cash.options.sessions}
    /></PosStartupReveal>
  return <PosStartupReveal><FiscalInstallationGate key={`${context.tenantId}:${context.venueId}:${context.deviceId}:${context.deviceMode}:${cash.session?.cashRegisterId}`} context={context} cashSession={cash.session} onLogout={onLogout} onBusyChange={setAuxiliaryOperationBusy}><PosPage
      fiscalPendingTicketIds={fiscalPendingTicketIds}
      addFeedback={addFeedback}
      catalog={catalog}
      discounts={discounts}
      discountSchedule={discountSchedule}
      manualDiscountEnabled={manualDiscountEnabled}
      manualDiscountRequiresPin={manualDiscountRequiresPin}
      cash={cash}
      catalogStartTab={catalogStartTab}
      context={context}
      error={error}
      errorId={errorId}
      floatingTicketButtonRef={floatingTicketButtonRef}
      isBusy={isBusy}
      isLoading={isLoading}
      isOnline={isOnline}
      mobileTicketOpen={mobileTicketOpen}
      offline={{ lastSyncError: offline.lastSyncError, pendingCount: offline.pendingCount, retry: offline.syncPendingEvents }}
      onLogout={onLogout}
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
      onUpdateBlockingOperationChange={setAuxiliaryOperationBusy}
      onUpdateCatalogStartTab={updateCatalogStartTab}
      productSalesStats={productSalesStats}
      quickSale={quickSale}
      restaurant={restaurant}
      reservations={reservations}
      restaurantPaidFeedback={restaurantPaidFeedback}
      selectedThemeId={selectedThemeId}
      setThemeId={setThemeId}
      themes={themes}
    /></FiscalInstallationGate></PosStartupReveal>

}

export default PosRuntime
