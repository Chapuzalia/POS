import { useCallback, useEffect, useRef, useState } from 'react'
import { AppHeader } from './components/layout/AppHeader'
import { CashPaymentModal, CloseCashModal, ConfigModal, ProductDialog, SessionTicketsModal } from './components/modals'
import { CatalogPanel, OpenCashPanel, PaymentPanel, TicketPanel } from './components/pos'
import { CrmPage } from './components/crm/CrmPage'
import { SuperAdminPage } from './components/superadmin/SuperAdminPage'
import { LoginScreen } from './components/screens/LoginScreen'
import { LoadingScreen, MissingConfigScreen } from './components/screens/StateScreens'
import themesData from './config/themes.json'
import { createId, getLineSignature, getTicketTotal } from './lib/format'
import { getProductVariantForSaleFormat } from './lib/catalog'
import {
  clearSaleLedger,
  clearSessionTickets,
  enqueueOfflineEvent,
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
  saveCachedTicket,
  saveSaleLedger,
  saveSessionTickets,
} from './lib/offlineStore'
import { supabase, supabaseConfig } from './lib/supabase'
import { useOfflineSync } from './hooks/useOfflineSync'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { useThemeTokens } from './hooks/useThemeTokens'
import {
  TenantSessionError,
  LoginLeaseConflictError,
  buildSalePayload,
  hasValidOfflineSession,
  loadCatalogFromSupabase,
  loadOpenCashSession,
  loadProductSalesStatsFromSupabase,
  loadSalesLedgerFromSupabase,
  loadSessionTicketsFromSupabase,
  loginTenant,
  logoutTenant,
  mergeLedgers,
  restoreTenantContext,
  subscribeToCashSessionChanges,
  summarizeSales,
} from './services/posService'
import type {
  CashClosedPayload,
  CashSession,
  CashRegister,
  Catalog,
  CatalogStartTab,
  LoginInput,
  PaymentMethod,
  Product,
  ProductSalesStat,
  ProductVariant,
  SaleRecord,
  SaleFormat,
  SessionTicketRecord,
  TenantContext,
  ThemeDefinition,
  TicketLine,
  TicketLineModifier,
} from './types'
import { nowIso } from './utils/dates'
import { getReadableError } from './utils/errors'
import { heartbeatLoginLease, releaseLocalLoginLock } from './services/loginLeaseService'
import { TableMapView } from './features/tables/components/TableMapView'
import { TableOrderBar } from './features/tables/components/TableOrderBar'
import { RestaurantOrderPanel } from './features/tables/components/RestaurantOrderPanel'
import {
  closeRestaurantOrder,
  groupRestaurantTables,
  loadOpenRestaurantOrders,
  loadRestaurantMap,
  loadRestaurantOrder,
  loadRestaurantOrderPendingUnits,
  loadVenueTablesEnabled,
  markRestaurantOrderFullyServed,
  markRestaurantOrderLineFullyServed,
  markRestaurantOrderLineUnitsServed,
  moveRestaurantOrder,
  openRestaurantOrder,
  saveRestaurantOrderLines,
  subscribeToRestaurantMap,
} from './features/tables/service'
import type { PosView, RestaurantMap, RestaurantOrderDetail, RestaurantOrderSaveState } from './features/tables/types'
import { canDecreaseLineQuantity, getOrderPendingUnits, isLineRemovable } from './features/tables/service-status'
import { CashSessionGate } from './features/cash-registers/CashSessionGate'
import { closeCashRegisterSession, loadCashRegisterOptions, openCashRegisterSession, subscribeToVenueCashSessions } from './features/cash-registers/service'

type ProductDialogState = {
  allowFormatSelection: boolean
  product: Product
  saleFormat: SaleFormat
}

type PendingRestaurantPayment = { method: PaymentMethod; receivedCents: number | null; pendingUnits: number }

type AppRoute = 'pos' | 'crm' | 'superadmin'

const themes = themesData as ThemeDefinition[]
const defaultThemeId = themes[0]?.id ?? 'hero-minimal'

function getAppRoute(): AppRoute {
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path === '/superadmin') {
    return 'superadmin'
  }
  return path === '/crm' ? 'crm' : 'pos'
}

function isCrmAdministrator(context: TenantContext) {
  return context.role === 'owner' || context.role === 'admin'
}

function isSuperadmin(context: TenantContext) {
  return context.role === 'superadmin'
}

function isAdministrativeUser(context: TenantContext) {
  return isSuperadmin(context) || isCrmAdministrator(context)
}

async function loadTenantState(activeContext: TenantContext) {
  if (isSuperadmin(activeContext)) {
    return {
      catalog: null,
      cashSession: null,
      productSalesStats: [],
      salesLedger: [],
    }
  }

  if (isCrmAdministrator(activeContext)) {
    const catalog = await loadCatalogFromSupabase(activeContext)

    return {
      catalog,
      cashSession: null,
      productSalesStats: [],
      salesLedger: [],
    }
  }

  const [nextCatalog, openSession, nextProductSalesStats] = await Promise.all([
    loadCatalogFromSupabase(activeContext),
    loadOpenCashSession(activeContext),
    loadProductSalesStatsFromSupabase(activeContext),
  ])
  const localLedger = openSession ? getSaleLedger(activeContext) : []
  const remoteLedger = openSession ? await loadSalesLedgerFromSupabase(activeContext, openSession.id) : []

  return {
    catalog: nextCatalog,
    cashSession: openSession,
    productSalesStats: nextProductSalesStats,
    salesLedger: mergeLedgers(localLedger, remoteLedger),
  }
}

function App() {
  const { selectedTheme, setThemeId, themeId } = useThemeTokens(themes, defaultThemeId)
  const isOnline = useOnlineStatus()
  const {
    clearRejectedSaleEvent,
    lastSyncError,
    pendingCount,
    rejectedSaleEvent,
    refreshPendingCount,
    syncPendingEvents,
  } = useOfflineSync(isOnline)
  const [context, setContext] = useState<TenantContext | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [cashSession, setCashSession] = useState<CashSession | null>(null)
  const [cashRegisters, setCashRegisters] = useState<CashRegister[]>([])
  const [venueCashSessions, setVenueCashSessions] = useState<CashSession[]>([])
  const [ticketLines, setTicketLines] = useState<TicketLine[]>([])
  const [salesLedger, setSalesLedger] = useState<SaleRecord[]>([])
  const [sessionTickets, setSessionTickets] = useState<SessionTicketRecord[]>([])
  const [catalogStartTab, setCatalogStartTab] = useState<CatalogStartTab>(() => getCatalogStartTab())
  const [productSalesStats, setProductSalesStats] = useState<ProductSalesStat[]>([])
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cashPaymentOpen, setCashPaymentOpen] = useState(false)
  const [closeCashOpen, setCloseCashOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [ticketHistoryOpen, setTicketHistoryOpen] = useState(false)
  const [paidFeedback, setPaidFeedback] = useState<PaymentMethod | null>(null)
  const [productDialog, setProductDialog] = useState<ProductDialogState | null>(null)
  const [loginLeaseBlocked, setLoginLeaseBlocked] = useState(false)
  const [route, setRoute] = useState<AppRoute>(() => getAppRoute())
  const [tablesEnabled, setTablesEnabled] = useState(false)
  const [restaurantMap, setRestaurantMap] = useState<RestaurantMap>({ areas: [], tables: [] })
  const [restaurantOrder, setRestaurantOrder] = useState<RestaurantOrderDetail | null>(null)
  const [posView, setPosView] = useState<PosView>({ type: 'quick_sale' })
  const [moveOrderId, setMoveOrderId] = useState<string | null>(null)
  const [tablesConfigLoaded, setTablesConfigLoaded] = useState(false)
  const [restaurantSaveState, setRestaurantSaveState] = useState<RestaurantOrderSaveState>('saved')
  const [pendingRestaurantPayment, setPendingRestaurantPayment] = useState<PendingRestaurantPayment | null>(null)
  const restaurantOrderRef = useRef<RestaurantOrderDetail | null>(null)
  const restaurantEditGenerationRef = useRef(0)
  const restaurantSaveStateRef = useRef<RestaurantOrderSaveState>('saved')
  const restaurantSavePromiseRef = useRef<Promise<RestaurantOrderDetail | null> | null>(null)
  const flushRestaurantOrderDraftRef = useRef<() => Promise<RestaurantOrderDetail | null>>(async () => null)
  const posViewRef = useRef<PosView>(posView)
  const cashSummary = summarizeSales(cashSession?.openingFloatCents ?? 0, salesLedger)

  const refreshCashRegisterOptions = useCallback(async (activeContext = context) => {
    if (!activeContext || !isOnline || isAdministrativeUser(activeContext)) return
    const state = await loadCashRegisterOptions(activeContext)
    setCashRegisters(state.registers)
    setVenueCashSessions(state.sessions)
    const current = cashSession ? state.sessions.find((session) => session.id === cashSession.id) : null
    if (cashSession && !current) {
      setCashSession(null)
      saveCachedCashSession(activeContext, null)
      setCashPaymentOpen(false)
      setCloseCashOpen(false)
      setError('La caja con la que estabas trabajando se ha cerrado.')
      return
    }
    if (!cashSession) {
      const automatic = state.sessions.length === 1 ? state.sessions[0] : null
      if (automatic) {
        setCashSession(automatic)
        saveCachedCashSession(activeContext, automatic)
      }
    }
  }, [cashSession, context, isOnline])

  useEffect(() => {
    if (!context || !isOnline || isAdministrativeUser(context)) return undefined
    void refreshCashRegisterOptions(context)
    const unsubscribe = subscribeToVenueCashSessions(context, () => void refreshCashRegisterOptions(context))
    return unsubscribe
  }, [context, isOnline, cashSession?.id, refreshCashRegisterOptions])

  useEffect(() => {
    function handlePopState() {
      setRoute(getAppRoute())
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (!context) {
      return
    }

    const requiredRoute: AppRoute = isSuperadmin(context) ? 'superadmin' : isCrmAdministrator(context) ? 'crm' : 'pos'

    if (route !== requiredRoute) {
      window.history.replaceState(null, '', requiredRoute === 'superadmin' ? '/superadmin' : requiredRoute === 'crm' ? '/crm' : '/')
      setRoute(requiredRoute)
    }
  }, [context, route])

  useEffect(() => {
    if (!context || !isOnline || isAdministrativeUser(context)) {
      return undefined
    }

    let active = true
    let initialized = false
    setTablesConfigLoaded(false)
    const refreshMap = async () => {
      try {
        const enabled = await loadVenueTablesEnabled(context)
        if (!active) return
        setTablesEnabled(enabled)
        if (!enabled) {
          setPosView({ type: 'quick_sale' })
          setRestaurantMap({ areas: [], tables: [] })
          setTablesConfigLoaded(true)
          initialized = true
          return
        }
        const nextMap = await loadRestaurantMap(context)
        if (active) {
          setRestaurantMap(nextMap)
          setPosView((current) => !initialized && current.type === 'quick_sale' ? { type: 'table_map', areaId: nextMap.areas[0]?.id } : current)
          setTablesConfigLoaded(true)
          initialized = true
        }
      } catch (mapError) {
        if (active) {
          setTablesConfigLoaded(true)
          setError(getReadableError(mapError))
        }
      }
    }

    void refreshMap()
    let realtimeTimer: ReturnType<typeof window.setTimeout> | null = null
    const unsubscribe = subscribeToRestaurantMap(context, () => {
      if (realtimeTimer) window.clearTimeout(realtimeTimer)
      realtimeTimer = window.setTimeout(() => {
        void (async () => {
          await refreshMap()
          const currentView = posViewRef.current
          if (currentView.type !== 'table_order' || restaurantSaveStateRef.current !== 'saved') return
          try {
            const detail = await loadRestaurantOrder(context, currentView.orderId)
            if (!active || restaurantSaveStateRef.current !== 'saved') return
            if (detail.order.status !== 'open') {
              restaurantOrderRef.current = null
              setRestaurantOrder(null)
              updateRestaurantSaveState('saved')
              setPosView({ type: 'table_map', areaId: detail.tables[0]?.areaId })
              return
            }
            restaurantOrderRef.current = detail
            setRestaurantOrder(detail)
          } catch (orderError) {
            if (active) setError(getReadableError(orderError))
          }
        })()
      }, 250)
    })
    return () => {
      active = false
      if (realtimeTimer) window.clearTimeout(realtimeTimer)
      unsubscribe()
    }
  }, [context, isOnline])

  useEffect(() => {
    restaurantOrderRef.current = restaurantOrder
  }, [restaurantOrder])

  useEffect(() => {
    posViewRef.current = posView
  }, [posView])

  useEffect(() => {
    if (!isOnline || restaurantSaveState !== 'dirty' || !restaurantOrder) return undefined
    const timer = window.setTimeout(() => void flushRestaurantOrderDraftRef.current(), 800)
    return () => window.clearTimeout(timer)
  }, [isOnline, restaurantOrder, restaurantSaveState])

  useEffect(() => {
    if (!isOnline) return undefined
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && restaurantSaveStateRef.current === 'dirty') {
        void flushRestaurantOrderDraftRef.current()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [isOnline])

  useEffect(() => {
    if (!context || !isOnline) {
      return undefined
    }

    let active = true

    async function refreshLoginLease() {
      try {
        const ownsLease = await heartbeatLoginLease()

        if (!ownsLease && active) {
          releaseLocalLoginLock()
          clearActiveState()
          setLoginLeaseBlocked(true)
          setError('La sesion se ha cerrado porque esta cuenta se ha abierto en otro dispositivo o pestana.')
        }
      } catch {
        // Los fallos de red no deben cerrar una sesion que puede seguir trabajando offline.
      }
    }

    const intervalId = window.setInterval(() => void refreshLoginLease(), 30_000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshLoginLease()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      active = false
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [context, isOnline])

  useEffect(() => {
    if (!supabase) {
      return undefined
    }

    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        clearActiveState()
        saveCachedContext(null)
      }
    })

    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let cancelled = false

    async function restoreOnlineState() {
      if (!supabaseConfig.isReady || !isOnline) {
        setIsBootstrapping(false)
        return
      }

      const cachedContext = getCachedContext()

      if (!cachedContext) {
        setIsBootstrapping(false)
        return
      }

      setIsBusy(true)
      setIsLoading(true)
      setError(null)

      try {
        const restoredContext = await restoreTenantContext(cachedContext)
        if (!isAdministrativeUser(restoredContext)) {
          await syncPendingEvents()
        }
        const restoredState = await loadTenantState(restoredContext)

        if (!cancelled) {
          applyTenantState(restoredContext, restoredState)
        }
      } catch (restoreError) {
        if (!cancelled) {
          const leaseConflict = restoreError instanceof LoginLeaseConflictError
          clearActiveState()
          setLoginLeaseBlocked(leaseConflict)
          if (restoreError instanceof TenantSessionError && !leaseConflict) {
            saveCachedContext(null)
          }
          setError(getReadableError(restoreError))
        }
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false)
          setIsBusy(false)
          setIsLoading(false)
        }
      }
    }

    void restoreOnlineState()

    return () => {
      cancelled = true
    }
  }, [isOnline, syncPendingEvents])

  useEffect(() => {
    if (!context || !isOnline || isAdministrativeUser(context)) {
      return undefined
    }

    const activeContext = context
    let active = true
    let refreshVersion = 0

    async function refreshCashSession() {
      const requestVersion = ++refreshVersion

      try {
        const nextSession = await loadOpenCashSession(activeContext)

        if (!active || requestVersion !== refreshVersion) {
          return
        }

        const previousSession = getCachedCashSession(activeContext)

        if (nextSession?.id === previousSession?.id) {
          return
        }

        if (previousSession) {
          clearSessionTickets(activeContext, previousSession.id)
        }

        setCashSession(nextSession)
        saveCachedCashSession(activeContext, nextSession)
        setCashPaymentOpen(false)
        setCloseCashOpen(false)
        setTicketHistoryOpen(false)
        setPaidFeedback(null)

        if (!nextSession) {
          setSalesLedger([])
          clearSaleLedger(activeContext)
          setSessionTickets([])
          setError('La caja se ha cerrado desde otro dispositivo. Abre una nueva caja para continuar.')
          return
        }

        const remoteLedger = await loadSalesLedgerFromSupabase(activeContext, nextSession.id)

        if (!active || requestVersion !== refreshVersion) {
          return
        }

        setSalesLedger(remoteLedger)
        saveSaleLedger(activeContext, remoteLedger)
        setSessionTickets(getSessionTickets(activeContext, nextSession.id))
        setError(null)
      } catch (cashSessionError) {
        if (active && requestVersion === refreshVersion) {
          setError(getReadableError(cashSessionError))
        }
      }
    }

    const unsubscribe = subscribeToCashSessionChanges(activeContext, () => {
      void refreshCashSession()
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [context, isOnline])

  useEffect(() => {
    if (!context || !rejectedSaleEvent || rejectedSaleEvent.tenantId !== context.tenantId) {
      return
    }

    const rejectedSessionId = rejectedSaleEvent.payload.ticket.cashSessionId
    const restoredLines = rejectedSaleEvent.payload.lines.map((line) => ({
      id: line.id,
      modifiers: line.modifiers,
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      variantId: line.variantId,
      variantName: line.variantName,
    }))

    if (getCachedTicket(context).length === 0) {
      setTicketLines(restoredLines)
      saveCachedTicket(context, restoredLines)
    }

    if (cashSession?.id === rejectedSessionId) {
      setCashSession(null)
      saveCachedCashSession(context, null)
    }

    setSalesLedger((currentLedger) => currentLedger.filter((sale) => sale.id !== rejectedSaleEvent.payload.sale.id))
    clearSaleLedger(context)
    setSessionTickets((currentTickets) =>
      currentTickets.filter((ticket) => ticket.id !== rejectedSaleEvent.payload.sale.id),
    )
    clearSessionTickets(context, rejectedSessionId)
    setCashPaymentOpen(false)
    setCloseCashOpen(false)
    setTicketHistoryOpen(false)
    setPaidFeedback(null)
    setError('La venta no se ha registrado porque la caja estaba cerrada. El ticket se ha recuperado para cobrarlo tras abrir una caja nueva.')
    clearRejectedSaleEvent()
  }, [cashSession, clearRejectedSaleEvent, context, rejectedSaleEvent])

  function applyTenantState(
    nextContext: TenantContext,
    state: Awaited<ReturnType<typeof loadTenantState>>,
  ) {
    setContext(nextContext)
    setLoginLeaseBlocked(false)
    saveCachedContext(nextContext)
    setCatalog(state.catalog)
    setProductSalesStats(state.productSalesStats)
    setCashSession(state.cashSession)
    setTicketLines(isAdministrativeUser(nextContext) ? [] : getCachedTicket(nextContext))
    setSalesLedger(state.salesLedger)

    if (isSuperadmin(nextContext)) {
      setSessionTickets([])
      window.history.replaceState(null, '', '/superadmin')
      setRoute('superadmin')
      return
    }

    const previousSession = getCachedCashSession(nextContext)
    if (state.catalog) {
      saveCachedCatalog(nextContext.tenantId, state.catalog)
    }
    saveCachedProductSalesStats(nextContext.tenantId, state.productSalesStats)
    saveCachedCashSession(nextContext, state.cashSession)

    if (isCrmAdministrator(nextContext)) {
      setSessionTickets([])
      window.history.replaceState(null, '', '/crm')
      setRoute('crm')
      return
    }

    if (state.cashSession) {
      saveSaleLedger(nextContext, state.salesLedger)
      setSessionTickets(getSessionTickets(nextContext, state.cashSession.id))
      return
    }

    clearSaleLedger(nextContext)
    if (previousSession) {
      clearSessionTickets(nextContext, previousSession.id)
    }
    setSessionTickets([])
  }

  function clearActiveState() {
    setContext(null)
    setCatalog(null)
    setCashSession(null)
    setTicketLines([])
    setSalesLedger([])
    setSessionTickets([])
    setProductSalesStats([])
    setCashPaymentOpen(false)
    setCloseCashOpen(false)
    setConfigOpen(false)
    setTicketHistoryOpen(false)
    setProductDialog(null)
    setPendingRestaurantPayment(null)
    setTablesEnabled(false)
    setRestaurantMap({ areas: [], tables: [] })
    setRestaurantOrder(null)
    restaurantOrderRef.current = null
    restaurantEditGenerationRef.current = 0
    restaurantSavePromiseRef.current = null
    updateRestaurantSaveState('saved')
    setPosView({ type: 'quick_sale' })
    setMoveOrderId(null)
    setTablesConfigLoaded(false)
  }

  async function refreshCatalog(activeContext = context) {
    if (!activeContext || !supabaseConfig.isReady || !isOnline) {
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const nextCatalog = await loadCatalogFromSupabase(activeContext)
      const nextProductSalesStats = await loadProductSalesStatsFromSupabase(activeContext)
      setCatalog(nextCatalog)
      setProductSalesStats(nextProductSalesStats)
      saveCachedCatalog(activeContext.tenantId, nextCatalog)
      saveCachedProductSalesStats(activeContext.tenantId, nextProductSalesStats)
    } catch (loadError) {
      setError(getReadableError(loadError))
    } finally {
      setIsLoading(false)
    }
  }

  async function handleLogin(input: LoginInput) {
    setIsBusy(true)
    setIsLoading(true)
    setError(null)
    setLoginLeaseBlocked(false)

    try {
      const nextContext = await loginTenant(input)
      if (!isAdministrativeUser(nextContext)) {
        await syncPendingEvents()
      }
      const nextState = await loadTenantState(nextContext)
      applyTenantState(nextContext, nextState)
    } catch (loginError) {
      setLoginLeaseBlocked(loginError instanceof LoginLeaseConflictError)
      setError(getReadableError(loginError))
    } finally {
      setIsBusy(false)
      setIsLoading(false)
    }
  }

  async function enterOffline() {
    if (loginLeaseBlocked) {
      return
    }

    const cachedContext = getCachedContext()

    if (!cachedContext) {
      return
    }

    setIsBusy(true)
    setError(null)

    try {
      if (isAdministrativeUser(cachedContext)) {
        throw new TenantSessionError('El CRM de administracion requiere conexion.')
      }

      if (!(await hasValidOfflineSession(cachedContext))) {
        throw new TenantSessionError('La sesion ha caducado. Conecta el TPV e inicia sesion de nuevo.')
      }

      setContext(cachedContext)
      setCatalog(getCachedCatalog(cachedContext.tenantId))
      setProductSalesStats(getCachedProductSalesStats(cachedContext.tenantId))
      setCashSession(getCachedCashSession(cachedContext))
      const cachedSession = getCachedCashSession(cachedContext)
      setSessionTickets(cachedSession ? getSessionTickets(cachedContext, cachedSession.id) : [])
      setTicketLines(getCachedTicket(cachedContext))
      setSalesLedger(getSaleLedger(cachedContext))
    } catch (offlineError) {
      setError(getReadableError(offlineError))
    } finally {
      setIsBusy(false)
    }
  }

  function persistTicket(nextLines: TicketLine[]) {
    setTicketLines(nextLines)
    if (context) {
      saveCachedTicket(context, nextLines)
    }
  }

  function persistCashSession(nextSession: CashSession | null) {
    setCashSession(nextSession)
    if (context) {
      saveCachedCashSession(context, nextSession)
    }
  }

  function persistLedger(nextLedger: SaleRecord[]) {
    setSalesLedger(nextLedger)
    if (context) {
      saveSaleLedger(context, nextLedger)
    }
  }

  function persistSessionTickets(nextTickets: SessionTicketRecord[]) {
    setSessionTickets(nextTickets)
    if (context && cashSession) {
      saveSessionTickets(context, cashSession.id, nextTickets)
    }
  }

  function updateCatalogStartTab(nextStartTab: CatalogStartTab) {
    setCatalogStartTab(nextStartTab)
    saveCatalogStartTab(nextStartTab)
  }

  function persistProductSalesStats(nextStats: ProductSalesStat[]) {
    setProductSalesStats(nextStats)
    if (context) {
      saveCachedProductSalesStats(context.tenantId, nextStats)
    }
  }

  function mergeProductSalesStats(lines: TicketLine[]) {
    const statsByProduct = new Map(productSalesStats.map((stat) => [stat.productId, stat]))

    lines.forEach((line) => {
      const current = statsByProduct.get(line.productId) ?? {
        productId: line.productId,
        quantity: 0,
        totalCents: 0,
      }

      statsByProduct.set(line.productId, {
        ...current,
        quantity: current.quantity + line.quantity,
        totalCents: current.totalCents + line.unitPriceCents * line.quantity,
      })
    })

    persistProductSalesStats(
      [...statsByProduct.values()].sort(
        (a, b) => b.quantity - a.quantity || b.totalCents - a.totalCents || a.productId.localeCompare(b.productId),
      ),
    )
  }

  function subtractProductSalesStats(lines: Array<{ productId: string; quantity: number; lineTotalCents: number }>) {
    const statsByProduct = new Map(productSalesStats.map((stat) => [stat.productId, stat]))

    lines.forEach((line) => {
      const current = statsByProduct.get(line.productId)

      if (!current) {
        return
      }

      const nextQuantity = Math.max(0, current.quantity - line.quantity)
      const nextTotalCents = Math.max(0, current.totalCents - line.lineTotalCents)

      if (!nextQuantity) {
        statsByProduct.delete(line.productId)
        return
      }

      statsByProduct.set(line.productId, {
        ...current,
        quantity: nextQuantity,
        totalCents: nextTotalCents,
      })
    })

    persistProductSalesStats(
      [...statsByProduct.values()].sort(
        (a, b) => b.quantity - a.quantity || b.totalCents - a.totalCents || a.productId.localeCompare(b.productId),
      ),
    )
  }

  async function handleOpenCashRegister(registerId: string, openingFloatCents: number) {
    if (!context || !isOnline || !context.canOpenCashSession) return
    setIsBusy(true)
    setError(null)
    try {
      const session = await openCashRegisterSession(context, registerId, openingFloatCents)
      persistCashSession(session)
      persistLedger([])
      persistSessionTickets([])
      saveSessionTickets(context, session.id, [])
      await refreshCashRegisterOptions(context)
    } catch (openError) {
      setError(getReadableError(openError))
    } finally {
      setIsBusy(false)
    }
  }

  async function joinCashSession(session: CashSession) {
    if (!context || !isOnline) return
    setIsBusy(true)
    try {
      persistCashSession(session)
      const [ledger, tickets] = await Promise.all([
        loadSalesLedgerFromSupabase(context, session.id),
        loadSessionTicketsFromSupabase(context, session.id),
      ])
      persistLedger(ledger)
      persistSessionTickets(tickets)
    } catch (joinError) {
      persistCashSession(null)
      setError(getReadableError(joinError))
    } finally {
      setIsBusy(false)
    }
  }

  function handleOpenCash(openingFloatCents: number) {
    const registerId = context?.defaultCashRegisterId ?? cashRegisters.find((register) => register.isActive)?.id
    if (registerId) void handleOpenCashRegister(registerId, openingFloatCents)
  }

  async function refreshRestaurantState(orderId?: string) {
    if (!context || !isOnline) return
    const [nextMap, nextOrder] = await Promise.all([
      loadRestaurantMap(context),
      orderId ? loadRestaurantOrder(context, orderId) : Promise.resolve(null),
    ])
    setRestaurantMap(nextMap)
    if (nextOrder) {
      restaurantOrderRef.current = nextOrder
      setRestaurantOrder(nextOrder)
      updateRestaurantSaveState('saved')
    }
  }

  function updateRestaurantSaveState(nextState: RestaurantOrderSaveState) {
    restaurantSaveStateRef.current = nextState
    setRestaurantSaveState(nextState)
  }

  function updateRestaurantDraft(transform: (detail: RestaurantOrderDetail) => RestaurantOrderDetail) {
    const current = restaurantOrderRef.current
    if (!current) return
    const transformed = transform(current)
    const next = {
      ...transformed,
      totalCents: transformed.lines.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0),
    }
    restaurantOrderRef.current = next
    restaurantEditGenerationRef.current += 1
    setRestaurantOrder(next)
    updateRestaurantSaveState('dirty')
  }

  async function flushRestaurantOrderDraft(): Promise<RestaurantOrderDetail | null> {
    const currentDraft = restaurantOrderRef.current
    if (currentDraft && restaurantSaveStateRef.current === 'saved') return currentDraft
    if (!isOnline) {
      setError('La gestion de mesas requiere conexion para guardar la comanda.')
      return null
    }

    const pendingSave = restaurantSavePromiseRef.current
    if (pendingSave) {
      await pendingSave
      return restaurantSaveStateRef.current === 'dirty'
        ? flushRestaurantOrderDraft()
        : restaurantOrderRef.current
    }

    const draft = restaurantOrderRef.current
    if (!draft) return null
    if (restaurantSaveStateRef.current === 'saved') return draft
    if (restaurantSaveStateRef.current === 'error') updateRestaurantSaveState('dirty')

    const savedGeneration = restaurantEditGenerationRef.current
    updateRestaurantSaveState('saving')
    const request = (async () => {
      try {
        const result = await saveRestaurantOrderLines(draft)
        const current = restaurantOrderRef.current
        if (!current || current.order.id !== draft.order.id) return null
        const hasNewerEdits = restaurantEditGenerationRef.current !== savedGeneration
        const reconciled: RestaurantOrderDetail = {
          ...current,
          order: { ...current.order, revision: result.revision },
          lines: hasNewerEdits ? current.lines : result.lines,
          totalCents: hasNewerEdits
            ? current.lines.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0)
            : result.lines.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0),
        }
        restaurantOrderRef.current = reconciled
        setRestaurantOrder(reconciled)
        updateRestaurantSaveState(hasNewerEdits ? 'dirty' : 'saved')
        return reconciled
      } catch (saveError) {
        if ((saveError as { code?: string }).code === '40001' && context) {
          try {
            const remoteOrder = await loadRestaurantOrder(context, draft.order.id)
            restaurantOrderRef.current = remoteOrder
            setRestaurantOrder(remoteOrder)
            updateRestaurantSaveState('saved')
            setError('La comanda cambio en otro dispositivo. Se ha recargado la version mas reciente.')
          } catch (reloadError) {
            updateRestaurantSaveState('error')
            setError(getReadableError(reloadError))
          }
          return null
        }
        updateRestaurantSaveState('error')
        setError(getReadableError(saveError))
        return null
      }
    })()

    restaurantSavePromiseRef.current = request
    const result = await request
    if (restaurantSavePromiseRef.current === request) restaurantSavePromiseRef.current = null
    return result
  }

  flushRestaurantOrderDraftRef.current = flushRestaurantOrderDraft

  async function openTableOrder(tableIds: string[], guestCount: number) {
    if (!context || !context.canTakeOrders || !cashSession || !isOnline) return
    setIsBusy(true); setError(null)
    try {
      await syncPendingEvents()
      const orderId = await openRestaurantOrder({ tableIds, guestCount, cashSessionId: cashSession.id, deviceId: context.deviceId })
      await refreshRestaurantState(orderId)
      setPosView({ type: 'table_order', orderId })
    } catch (orderError) { setError(getReadableError(orderError)) } finally { setIsBusy(false) }
  }

  async function openExistingTableOrder(orderId: string) {
    if (!context || !isOnline) return
    setIsBusy(true); setError(null)
    try {
      const detail = await loadRestaurantOrder(context, orderId)
      restaurantOrderRef.current = detail
      setRestaurantOrder(detail)
      updateRestaurantSaveState('saved')
      setPosView({ type: 'table_order', orderId })
    }
    catch (orderError) { setError(getReadableError(orderError)) } finally { setIsBusy(false) }
  }

  async function returnToTableMap() {
    if (posView.type === 'table_order') {
      const saved = await flushRestaurantOrderDraft()
      if (!saved) return
    }
    try {
      const nextMap = context && isOnline ? await loadRestaurantMap(context) : restaurantMap
      setRestaurantOrder(null)
      restaurantOrderRef.current = null
      updateRestaurantSaveState('saved')
      setRestaurantMap(nextMap)
      setPosView({ type: 'table_map', areaId: nextMap.areas[0]?.id })
    } catch (mapError) {
      setError(getReadableError(mapError))
    }
  }

  async function prepareMoveTableOrder() {
    const current = restaurantOrderRef.current
    if (!current) return
    const saved = await flushRestaurantOrderDraft()
    if (!saved) return
    setMoveOrderId(saved.order.id)
    setPosView({ type: 'table_map', areaId: saved.tables[0]?.areaId })
  }

  async function groupTables(tableIds: string[], guestCount: number) {
    if (!context || !cashSession || !isOnline) return
    setIsBusy(true); setError(null)
    try {
      await syncPendingEvents()
      const orderId = await groupRestaurantTables({ tableIds, guestCount, cashSessionId: cashSession.id, deviceId: context.deviceId })
      await refreshRestaurantState(orderId)
      setPosView({ type: 'table_order', orderId })
    } catch (groupError) { setError(getReadableError(groupError)) } finally { setIsBusy(false) }
  }

  async function moveTableOrder(tableId: string) {
    if (!moveOrderId || !isOnline) return
    setIsBusy(true); setError(null)
    try {
      await moveRestaurantOrder(moveOrderId, tableId)
      await refreshRestaurantState(moveOrderId)
      setPosView({ type: 'table_order', orderId: moveOrderId })
      setMoveOrderId(null)
    } catch (moveError) { setError(getReadableError(moveError)) } finally { setIsBusy(false) }
  }

  async function completeRestaurantPayment(paymentMethod: PaymentMethod, receivedCents: number | null, forceWithPending = false) {
    if (!context || !context.canTakePayments || !cashSession || !restaurantOrderRef.current || !isOnline) return
    setIsBusy(true); setError(null)
    try {
      const savedOrder = await flushRestaurantOrderDraft()
      if (!savedOrder) return
      const pendingCheck = await loadRestaurantOrderPendingUnits(context, savedOrder.order.id)
      restaurantOrderRef.current = pendingCheck.detail
      setRestaurantOrder(pendingCheck.detail)
      updateRestaurantSaveState('saved')
      if (pendingCheck.pendingUnits > 0 && !forceWithPending) {
        setPendingRestaurantPayment({ method: paymentMethod, receivedCents, pendingUnits: pendingCheck.pendingUnits })
        return
      }
      const paymentResult = await closeRestaurantOrder(savedOrder.order.id, paymentMethod, receivedCents, forceWithPending)
      if (paymentResult.requiresConfirmation) {
        setPendingRestaurantPayment({ method: paymentMethod, receivedCents, pendingUnits: paymentResult.pendingUnits })
        return
      }
      const [nextLedger, nextStats] = await Promise.all([
        loadSalesLedgerFromSupabase(context, cashSession.id), loadProductSalesStatsFromSupabase(context),
      ])
      persistLedger(nextLedger); persistProductSalesStats(nextStats)
      setRestaurantOrder(null)
      restaurantOrderRef.current = null
      setPendingRestaurantPayment(null)
      updateRestaurantSaveState('saved')
      setPaidFeedback(paymentMethod)
      await refreshRestaurantState()
      setPosView({ type: 'table_map', areaId: restaurantMap.areas[0]?.id })
      window.setTimeout(() => setPaidFeedback(null), 500)
    } catch (paymentError) { setError(getReadableError(paymentError)) } finally { setIsBusy(false) }
  }

  async function requestCloseCash() {
    if (!context || !cashSession) return
    if (!context.canCloseCashSession) { setError('Este dispositivo no puede cerrar cajas.'); return }
    if (tablesEnabled && !isOnline) {
      setError('Con el addon de mesas activo, el cierre de caja requiere conexion para comprobar comandas abiertas.')
      return
    }
    if (isOnline) {
      try {
        const openOrders = await loadOpenRestaurantOrders(context, cashSession.id)
        if (openOrders.length) {
          const details = await Promise.all(openOrders.map((order) => loadRestaurantOrder(context, order.id)))
          setError(`No se puede cerrar la caja. Comandas abiertas: ${details.map((detail) => `${detail.tables.map((table) => table.name).join(' + ')} (${(detail.totalCents / 100).toFixed(2)} EUR, abierta ${new Date(detail.order.openedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}, ${getOrderPendingUnits(detail.lines)} por servir)`).join('; ')}`)
          return
        }
      } catch (closeCheckError) { setError(getReadableError(closeCheckError)); return }
    }
    setCloseCashOpen(true)
  }

  function addTicketLine(product: Product, variant: ProductVariant, modifiers: TicketLineModifier[]) {
    if (posView.type === 'table_order') {
      if (!isOnline) { setError('La gestion de mesas requiere conexion.'); return }
      const current = restaurantOrderRef.current
      if (!current || !context) return
      const signature = getLineSignature({ productId: product.id, variantId: variant.id, modifiers })
      const existing = current.lines.find((line) =>
        line.productId !== null
        && line.note === null
        && getLineSignature({ productId: line.productId, variantId: line.variantId ?? '', modifiers: line.modifiers }) === signature
      )
      const modifierTotal = modifiers.reduce((total, modifier) => total + modifier.priceCents, 0)
      const timestamp = nowIso()
      updateRestaurantDraft((detail) => ({
        ...detail,
        lines: existing
          ? detail.lines.map((line) => line.id === existing.id ? { ...line, quantity: line.quantity + 1, updatedAt: timestamp } : line)
          : [...detail.lines, {
              id: createId(),
              tenantId: context.tenantId,
              venueId: context.venueId,
              orderId: detail.order.id,
              productId: product.id,
              variantId: variant.id,
              productName: product.name,
              variantName: variant.name,
              unitPriceCents: variant.priceCents + modifierTotal,
              quantity: 1,
              servedQuantity: 0,
              fullyServedAt: null,
              modifiers,
              note: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            }],
      }))
      setProductDialog(null)
      return
    }
    const modifierTotal = modifiers.reduce((total, modifier) => total + modifier.priceCents, 0)
    const candidate: TicketLine = {
      id: createId(),
      productId: product.id,
      productName: product.name,
      variantId: variant.id,
      variantName: variant.name,
      unitPriceCents: variant.priceCents + modifierTotal,
      quantity: 1,
      modifiers,
    }
    const candidateSignature = getLineSignature(candidate)
    const existing = ticketLines.find((line) => getLineSignature(line) === candidateSignature)
    const nextLines = existing
      ? ticketLines.map((line) => (line.id === existing.id ? { ...line, quantity: line.quantity + 1 } : line))
      : [...ticketLines, candidate]

    persistTicket(nextLines)
    setProductDialog(null)
  }

  function handleSelectProduct(product: Product, saleFormat: SaleFormat, allowFormatSelection: boolean) {
    const firstVariant = getProductVariantForSaleFormat(product, saleFormat)

    if (!firstVariant) {
      return
    }

    const needsDialog =
      saleFormat === 'cubata' || product.modifierGroups.length > 0 || (allowFormatSelection && product.variants.length > 1)

    if (!needsDialog) {
      addTicketLine(product, firstVariant, [])
      return
    }

    setProductDialog({ allowFormatSelection, product, saleFormat })
  }

  function updateLineQuantity(lineId: string, direction: 1 | -1) {
    if (posView.type === 'table_order') {
      if (!isOnline) return
      const line = restaurantOrderRef.current?.lines.find((item) => item.id === lineId)
      if (!line) return
      if (direction === -1 && !canDecreaseLineQuantity(line)) {
        setError('No puedes reducir la cantidad por debajo de las unidades servidas.')
        return
      }
      updateRestaurantDraft((detail) => ({
        ...detail,
        lines: detail.lines
          .map((line) => line.id === lineId ? { ...line, quantity: line.quantity + direction, updatedAt: nowIso() } : line)
          .filter((line) => line.quantity > 0),
      }))
      return
    }
    const nextLines = ticketLines
      .map((line) =>
        line.id === lineId
          ? {
              ...line,
              quantity: line.quantity + direction,
            }
          : line,
      )
      .filter((line) => line.quantity > 0)

    persistTicket(nextLines)
  }

  async function runRestaurantServiceAction(action: (order: RestaurantOrderDetail) => Promise<void>) {
    if (!context || !isOnline || isBusy) return
    setIsBusy(true)
    setError(null)
    try {
      const saved = await flushRestaurantOrderDraft()
      if (!saved) return
      await action(saved)
      const detail = await loadRestaurantOrder(context, saved.order.id)
      restaurantOrderRef.current = detail
      setRestaurantOrder(detail)
      updateRestaurantSaveState('saved')
    } catch (serviceError) {
      setError(getReadableError(serviceError))
      const current = restaurantOrderRef.current
      if (current) {
        try {
          const detail = await loadRestaurantOrder(context, current.order.id)
          restaurantOrderRef.current = detail
          setRestaurantOrder(detail)
          updateRestaurantSaveState('saved')
        } catch {
          // Se mantiene el error original de la operacion.
        }
      }
    } finally {
      setIsBusy(false)
    }
  }

  function serveRestaurantLineUnit(lineId: string) {
    void runRestaurantServiceAction(async () => markRestaurantOrderLineUnitsServed(lineId, 1))
  }

  function serveRestaurantLineFully(lineId: string) {
    void runRestaurantServiceAction(async () => markRestaurantOrderLineFullyServed(lineId))
  }

  function serveRestaurantOrderFully() {
    void runRestaurantServiceAction(async (order) => markRestaurantOrderFullyServed(order.order.id))
  }

  function completePayment(paymentMethod: PaymentMethod, receivedCents: number | null) {
    if (posView.type === 'table_order') {
      void completeRestaurantPayment(paymentMethod, receivedCents)
      return
    }
    if (!context || !cashSession || ticketLines.length === 0) {
      return
    }

    const payload = buildSalePayload(context, cashSession, ticketLines, paymentMethod, receivedCents)
    const saleRecord: SaleRecord = {
      id: payload.sale.id,
      cashSessionId: cashSession.id,
      paymentMethod,
      totalCents: payload.sale.totalCents,
      createdAt: payload.sale.createdAt,
    }

    enqueueOfflineEvent({
      id: createId(),
      kind: 'sale_created',
      tenantId: context.tenantId,
      createdAt: payload.sale.createdAt,
      attempts: 0,
      payload,
    })
    persistLedger([...salesLedger, saleRecord])
    persistSessionTickets([
      {
        id: payload.sale.id,
        cashSessionId: cashSession.id,
        paymentMethod,
        totalCents: payload.sale.totalCents,
        createdAt: payload.sale.createdAt,
        status: 'active',
        payload,
      },
      ...sessionTickets,
    ])
    mergeProductSalesStats(ticketLines)
    persistTicket([])
    refreshPendingCount()
    setPaidFeedback(paymentMethod)
    window.setTimeout(() => setPaidFeedback(null), 500)
    void syncPendingEvents()
  }

  function handlePayment(paymentMethod: PaymentMethod) {
    if (paymentMethod === 'cash') {
      setCashPaymentOpen(true)
      return
    }

    completePayment(paymentMethod, null)
  }

  async function openTicketHistory() {
    if (!context || !cashSession) {
      return
    }

    if (!isOnline) {
      setError('El historico de tickets requiere conexion para consultar los datos de Supabase.')
      return
    }

    setIsBusy(true)
    setError(null)

    try {
      await syncPendingEvents()
      const remoteTickets = await loadSessionTicketsFromSupabase(context, cashSession.id)
      setSessionTickets(remoteTickets)
      saveSessionTickets(context, cashSession.id, remoteTickets)
      setTicketHistoryOpen(true)
    } catch (historyError) {
      setError(getReadableError(historyError))
    } finally {
      setIsBusy(false)
    }
  }

  function changeTicketPayment(ticket: SessionTicketRecord, paymentMethod: PaymentMethod) {
    if (!context || ticket.status !== 'active' || ticket.paymentMethod === paymentMethod) {
      return
    }

    const receivedCents = paymentMethod === 'cash' ? ticket.totalCents : null
    const changeCents = 0
    const nextTickets = sessionTickets.map((item) =>
      item.id === ticket.id
        ? {
            ...item,
            paymentMethod,
            payload: {
              ...item.payload,
              sale: {
                ...item.payload.sale,
                paymentMethod,
              },
              payment: {
                ...item.payload.payment,
                method: paymentMethod,
                receivedCents,
                changeCents,
              },
            },
          }
        : item,
    )

    persistSessionTickets(nextTickets)
    persistLedger(salesLedger.map((record) => (record.id === ticket.id ? { ...record, paymentMethod } : record)))
    enqueueOfflineEvent({
      id: createId(),
      kind: 'sale_payment_changed',
      tenantId: context.tenantId,
      createdAt: nowIso(),
      attempts: 0,
      payload: {
        saleId: ticket.payload.sale.id,
        paymentId: ticket.payload.payment.id,
        paymentMethod,
        receivedCents,
        changeCents,
      },
    })
    refreshPendingCount()
    void syncPendingEvents()
  }

  function voidSessionTicket(ticket: SessionTicketRecord) {
    if (!context || ticket.status !== 'active') {
      return
    }

    if (!window.confirm('Eliminar este ticket de la sesion?')) {
      return
    }

    persistSessionTickets(
      sessionTickets.map((item) => (item.id === ticket.id ? { ...item, status: 'voided' } : item)),
    )
    persistLedger(salesLedger.filter((record) => record.id !== ticket.id))
    subtractProductSalesStats(
      ticket.payload.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        lineTotalCents: line.lineTotalCents,
      })),
    )
    enqueueOfflineEvent({
      id: createId(),
      kind: 'sale_voided',
      tenantId: context.tenantId,
      createdAt: nowIso(),
      attempts: 0,
      payload: {
        saleId: ticket.payload.sale.id,
        ticketId: ticket.payload.ticket.id,
      },
    })
    refreshPendingCount()
    void syncPendingEvents()
  }

  async function handleCloseCash(payload: CashClosedPayload) {
    if (!context || !isOnline || !context.canCloseCashSession) return
    setIsBusy(true)
    try {
      await closeCashRegisterSession(context, payload.sessionId, payload)
    persistCashSession(null)
    persistTicket([])
    setSalesLedger([])
    clearSaleLedger(context)
    clearSessionTickets(context, payload.sessionId)
    setSessionTickets([])
    setCloseCashOpen(false)
    refreshPendingCount()
      await refreshCashRegisterOptions(context)
    } catch (closeError) {
      setError(getReadableError(closeError))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleLogout() {
    setIsBusy(true)
    setError(null)

    try {
      await logoutTenant()
    } catch (logoutError) {
      setError(getReadableError(logoutError))
    } finally {
      clearActiveState()
      saveCachedContext(null)
      setIsBusy(false)
    }
  }

  if (!selectedTheme) {
    return null
  }

  if (!supabaseConfig.isReady) {
    return <MissingConfigScreen />
  }

  if (isBootstrapping || (isLoading && !context)) {
    return <LoadingScreen />
  }

  if (!context) {
    return (
      <LoginScreen
        allowOfflineEnter={!loginLeaseBlocked}
        cachedContext={getCachedContext()}
        error={error}
        isBusy={isBusy}
        isOnline={isOnline}
        loginBlocked={loginLeaseBlocked}
        onLogin={handleLogin}
        onOfflineEnter={enterOffline}
      />
    )
  }

  const activeTicketLines: TicketLine[] = posView.type === 'table_order' && restaurantOrder
    ? restaurantOrder.lines.map((line) => ({ id: line.id, productId: line.productId ?? '', productName: line.productName, variantId: line.variantId ?? '', variantName: line.variantName, unitPriceCents: line.unitPriceCents, quantity: line.quantity, modifiers: line.modifiers }))
    : ticketLines
  const canSell = Boolean(context.canTakePayments && cashSession && activeTicketLines.length > 0 && !isBusy && (posView.type !== 'table_order' || isOnline))

  if (isSuperadmin(context)) {
    return (
      <SuperAdminPage
        context={context}
        error={error}
        isOnline={isOnline}
        onError={setError}
        onLogout={handleLogout}
      />
    )
  }

  if (isCrmAdministrator(context)) {
    return (
      <CrmPage
        catalog={catalog}
        context={context}
        error={error}
        isOnline={isOnline}
        onCatalogChanged={() => refreshCatalog(context)}
        onError={setError}
        onLogout={handleLogout}
      />
    )
  }

  if (isOnline && !tablesConfigLoaded) {
    return <LoadingScreen />
  }

  if (!cashSession) {
    return <CashSessionGate
      context={context}
      isBusy={isBusy}
      isOnline={isOnline}
      onJoin={(session) => void joinCashSession(session)}
      onLogout={() => void handleLogout()}
      onOpen={handleOpenCashRegister}
      onRefresh={() => void refreshCashRegisterOptions(context)}
      registers={cashRegisters}
      sessions={venueCashSessions}
    />
  }

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <AppHeader
        cashSession={cashSession}
        canCloseCash={context.canCloseCashSession === true}
        isLoading={isLoading}
        isOnline={isOnline}
        onCloseCash={() => void requestCloseCash()}
        onOpenConfig={() => setConfigOpen(true)}
        onOpenTicketHistory={() => void openTicketHistory()}
        onRefreshCatalog={() => void refreshCatalog()}
        pendingCount={pendingCount}
      />

      {error ? (
        <div className="mx-auto max-w-[1600px] px-4 pt-4">
          <div className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm font-semibold text-[var(--danger)]">
            {error}
          </div>
        </div>
      ) : null}

      {tablesEnabled && posView.type !== 'table_map' ? (
        <TableOrderBar
          isBusy={isBusy}
          isOnline={isOnline}
          onBack={() => void returnToTableMap()}
          onMove={() => void prepareMoveTableOrder()}
          order={posView.type === 'table_order' ? restaurantOrder : null}
          quickSale={posView.type === 'quick_sale'}
          saveState={restaurantSaveState}
        />
      ) : null}

      {tablesEnabled && posView.type === 'table_map' ? (
        <TableMapView
          canOpen={Boolean(cashSession && context.canTakeOrders)}
          canQuickSale={context.canTakePayments === true}
          isBusy={isBusy}
          isOnline={isOnline}
          map={restaurantMap}
          moveOrderId={moveOrderId}
          onAreaChange={(areaId) => setPosView({ type: 'table_map', areaId })}
          onCancelMove={() => setMoveOrderId(null)}
          onGroup={groupTables}
          onMove={moveTableOrder}
          onOpen={openTableOrder}
          onOpenOrder={(orderId) => void openExistingTableOrder(orderId)}
          onQuickSale={() => { if (context.canTakePayments) { setRestaurantOrder(null); setPosView({ type: 'quick_sale' }) } }}
          openCashPanel={!cashSession ? <OpenCashPanel disabled={!context || isBusy} isBusy={isBusy} onOpen={handleOpenCash} /> : undefined}
          selectedAreaId={posView.areaId}
        />
      ) : null}

      <main className={`mx-auto min-h-0 w-full max-w-[1600px] flex-1 gap-4 overflow-hidden p-4 max-lg:flex-col ${tablesEnabled && posView.type === 'table_map' ? 'hidden' : 'flex'}`}>
        <section className="flex min-h-0 w-[35%] min-w-[360px] flex-col gap-4 max-lg:w-full max-lg:min-w-0">
          {posView.type === 'table_order' && restaurantOrder ? <RestaurantOrderPanel
            isBusy={isBusy || !isOnline}
            onDecrement={(lineId) => updateLineQuantity(lineId, -1)}
            onIncrement={(lineId) => updateLineQuantity(lineId, 1)}
            onRemove={(lineId) => {
              const line = restaurantOrderRef.current?.lines.find((item) => item.id === lineId)
              if (!line || !isLineRemovable(line)) {
                setError('No puedes eliminar una linea con productos ya servidos.')
                return
              }
              updateRestaurantDraft((detail) => ({ ...detail, lines: detail.lines.filter((item) => item.id !== lineId) }))
            }}
            onServeAll={serveRestaurantLineFully}
            onServeAllOrder={serveRestaurantOrderFully}
            onServeOne={serveRestaurantLineUnit}
            order={restaurantOrder}
          /> : <TicketPanel
            isBusy={isBusy}
            lines={activeTicketLines}
            onClear={() => {
              if (posView.type === 'table_order') {
                updateRestaurantDraft((detail) => ({ ...detail, lines: [] }))
              } else {
                persistTicket([])
              }
            }}
            onDecrement={(lineId) => updateLineQuantity(lineId, -1)}
            onIncrement={(lineId) => updateLineQuantity(lineId, 1)}
            onRemove={(lineId) => {
              if (posView.type === 'table_order') {
                updateRestaurantDraft((detail) => ({ ...detail, lines: detail.lines.filter((line) => line.id !== lineId) }))
              } else {
                persistTicket(ticketLines.filter((line) => line.id !== lineId))
              }
            }}
          />}
          <PaymentPanel disabled={!canSell} feedback={paidFeedback} heading={posView.type === 'table_order' ? 'Cobrar todo' : undefined} onPayment={handlePayment} />
        </section>

        {cashSession ? (
          <CatalogPanel
            catalog={catalog}
            catalogStartTab={catalogStartTab}
            disabled={isBusy || (posView.type === 'table_order' && !isOnline)}
            onSelectProduct={handleSelectProduct}
            productSalesStats={productSalesStats}
          />
        ) : (
          <OpenCashPanel disabled={!context || isBusy} isBusy={isBusy} onOpen={handleOpenCash} />
        )}
      </main>

      {pendingRestaurantPayment ? <div className="table-modal-backdrop">
        <section className="table-modal" role="dialog" aria-modal="true" aria-labelledby="pending-service-title">
          <h2 id="pending-service-title">Productos pendientes</h2>
          <p>Quedan {pendingRestaurantPayment.pendingUnits} {pendingRestaurantPayment.pendingUnits === 1 ? 'producto pendiente' : 'productos pendientes'} de servir.</p>
          <div>
            <button className="table-action secondary" onClick={() => setPendingRestaurantPayment(null)} type="button">Volver a la comanda</button>
            <button className="table-action primary" onClick={() => {
              const payment = pendingRestaurantPayment
              setPendingRestaurantPayment(null)
              void completeRestaurantPayment(payment.method, payment.receivedCents, true)
            }} type="button">Cobrar igualmente</button>
          </div>
        </section>
      </div> : null}

      {cashPaymentOpen ? (
        <CashPaymentModal
          isBusy={isBusy}
          onCancel={() => setCashPaymentOpen(false)}
          onConfirm={(receivedCents) => {
            setCashPaymentOpen(false)
            completePayment('cash', receivedCents)
          }}
          totalCents={getTicketTotal(activeTicketLines)}
        />
      ) : null}

      {productDialog ? (
        <ProductDialog
          allowFormatSelection={productDialog.allowFormatSelection}
          isBusy={isBusy}
          catalog={catalog}
          key={`${productDialog.product.id}-${productDialog.saleFormat}-${productDialog.allowFormatSelection}`}
          onAdd={addTicketLine}
          onCancel={() => setProductDialog(null)}
          product={productDialog.product}
          saleFormat={productDialog.saleFormat}
        />
      ) : null}

      {closeCashOpen && cashSession ? (
        <CloseCashModal
          cashSession={cashSession}
          isBusy={isBusy}
          onCancel={() => setCloseCashOpen(false)}
          onConfirm={handleCloseCash}
          summary={cashSummary}
          userId={context.userId}
        />
      ) : null}

      {ticketHistoryOpen ? (
        <SessionTicketsModal
          isBusy={isBusy}
          onChangePayment={changeTicketPayment}
          onClose={() => setTicketHistoryOpen(false)}
          onVoidTicket={voidSessionTicket}
          tickets={sessionTickets}
        />
      ) : null}

      {configOpen ? (
        <ConfigModal
          context={context}
          catalogStartTab={catalogStartTab}
          lastSyncError={lastSyncError}
          onClose={() => setConfigOpen(false)}
          onCatalogStartTabChange={updateCatalogStartTab}
          onLogout={handleLogout}
          onRetrySync={() => void syncPendingEvents()}
          onThemeChange={setThemeId}
          pendingCount={pendingCount}
          themeId={themeId}
          themes={themes}
        />
      ) : null}
    </div>
  )
}

export default App
