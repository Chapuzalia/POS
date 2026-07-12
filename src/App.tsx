import { useEffect, useState } from 'react'
import { AppHeader } from './components/layout/AppHeader'
import { CashPaymentModal, CloseCashModal, ConfigModal, ProductDialog, SessionTicketsModal } from './components/modals'
import { CatalogPanel, OpenCashPanel, PaymentPanel, TicketPanel } from './components/pos'
import { CrmPage } from './components/crm/CrmPage'
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

type ProductDialogState = {
  allowFormatSelection: boolean
  product: Product
  saleFormat: SaleFormat
}

type AppRoute = 'pos' | 'crm'

const themes = themesData as ThemeDefinition[]
const defaultThemeId = themes[0]?.id ?? 'hero-minimal'

function getAppRoute(): AppRoute {
  return window.location.pathname.replace(/\/+$/, '') === '/crm' ? 'crm' : 'pos'
}

function isCrmAdministrator(context: TenantContext) {
  return context.role === 'owner' || context.role === 'admin'
}

async function loadTenantState(activeContext: TenantContext) {
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
    pendingCount,
    rejectedSaleEvent,
    refreshPendingCount,
    syncPendingEvents,
  } = useOfflineSync(isOnline)
  const [context, setContext] = useState<TenantContext | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [cashSession, setCashSession] = useState<CashSession | null>(null)
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
  const [route, setRoute] = useState<AppRoute>(() => getAppRoute())
  const cashSummary = summarizeSales(cashSession?.openingFloatCents ?? 0, salesLedger)

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

    const requiredRoute: AppRoute = isCrmAdministrator(context) ? 'crm' : 'pos'

    if (route !== requiredRoute) {
      window.history.replaceState(null, '', requiredRoute === 'crm' ? '/crm' : '/')
      setRoute(requiredRoute)
    }
  }, [context, route])

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
        if (!isCrmAdministrator(restoredContext)) {
          await syncPendingEvents()
        }
        const restoredState = await loadTenantState(restoredContext)

        if (!cancelled) {
          applyTenantState(restoredContext, restoredState)
        }
      } catch (restoreError) {
        if (!cancelled) {
          clearActiveState()
          if (restoreError instanceof TenantSessionError) {
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
    if (!context || !isOnline || isCrmAdministrator(context)) {
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
    const previousSession = getCachedCashSession(nextContext)

    setContext(nextContext)
    saveCachedContext(nextContext)
    setCatalog(state.catalog)
    saveCachedCatalog(nextContext.tenantId, state.catalog)
    setProductSalesStats(state.productSalesStats)
    saveCachedProductSalesStats(nextContext.tenantId, state.productSalesStats)
    setCashSession(state.cashSession)
    saveCachedCashSession(nextContext, state.cashSession)
    setTicketLines(isCrmAdministrator(nextContext) ? [] : getCachedTicket(nextContext))
    setSalesLedger(state.salesLedger)

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

    try {
      const nextContext = await loginTenant(input)
      if (!isCrmAdministrator(nextContext)) {
        await syncPendingEvents()
      }
      const nextState = await loadTenantState(nextContext)
      applyTenantState(nextContext, nextState)
    } catch (loginError) {
      setError(getReadableError(loginError))
    } finally {
      setIsBusy(false)
      setIsLoading(false)
    }
  }

  async function enterOffline() {
    const cachedContext = getCachedContext()

    if (!cachedContext) {
      return
    }

    setIsBusy(true)
    setError(null)

    try {
      if (isCrmAdministrator(cachedContext)) {
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

  function handleOpenCash(openingFloatCents: number) {
    if (!context) {
      return
    }

    const session: CashSession = {
      id: createId(),
      tenantId: context.tenantId,
      venueId: context.venueId,
      deviceId: context.deviceId,
      userId: context.userId,
      openedAt: nowIso(),
      openingFloatCents,
      status: 'open',
    }

    persistCashSession(session)
    persistLedger([])
    persistSessionTickets([])
    saveSessionTickets(context, session.id, [])
    enqueueOfflineEvent({
      id: createId(),
      kind: 'cash_opened',
      tenantId: context.tenantId,
      createdAt: nowIso(),
      attempts: 0,
      payload: { session },
    })
    refreshPendingCount()
    void syncPendingEvents()
  }

  function addTicketLine(product: Product, variant: ProductVariant, modifiers: TicketLineModifier[]) {
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

  function completePayment(paymentMethod: PaymentMethod, receivedCents: number | null) {
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

  function handleCloseCash(payload: CashClosedPayload) {
    if (!context) {
      return
    }

    enqueueOfflineEvent({
      id: createId(),
      kind: 'cash_closed',
      tenantId: context.tenantId,
      createdAt: payload.closedAt,
      attempts: 0,
      payload,
    })
    persistCashSession(null)
    persistTicket([])
    setSalesLedger([])
    clearSaleLedger(context)
    clearSessionTickets(context, payload.sessionId)
    setSessionTickets([])
    setCloseCashOpen(false)
    refreshPendingCount()
    void syncPendingEvents()
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
        cachedContext={getCachedContext()}
        error={error}
        isBusy={isBusy}
        isOnline={isOnline}
        onLogin={handleLogin}
        onOfflineEnter={enterOffline}
      />
    )
  }

  const canSell = Boolean(cashSession && ticketLines.length > 0 && !isBusy)

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

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <AppHeader
        cashSession={cashSession}
        isLoading={isLoading}
        isOnline={isOnline}
        onCloseCash={() => setCloseCashOpen(true)}
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

      <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 gap-4 overflow-hidden p-4 max-lg:flex-col">
        <section className="flex min-h-0 w-[35%] min-w-[360px] flex-col gap-4 max-lg:w-full max-lg:min-w-0">
          <TicketPanel
            isBusy={isBusy}
            lines={ticketLines}
            onClear={() => persistTicket([])}
            onDecrement={(lineId) => updateLineQuantity(lineId, -1)}
            onIncrement={(lineId) => updateLineQuantity(lineId, 1)}
            onRemove={(lineId) => persistTicket(ticketLines.filter((line) => line.id !== lineId))}
          />
          <PaymentPanel disabled={!canSell} feedback={paidFeedback} onPayment={handlePayment} />
        </section>

        {cashSession ? (
          <CatalogPanel
            catalog={catalog}
            catalogStartTab={catalogStartTab}
            disabled={isBusy}
            onSelectProduct={handleSelectProduct}
            productSalesStats={productSalesStats}
          />
        ) : (
          <OpenCashPanel disabled={!context || isBusy} isBusy={isBusy} onOpen={handleOpenCash} />
        )}
      </main>

      {cashPaymentOpen ? (
        <CashPaymentModal
          isBusy={isBusy}
          onCancel={() => setCashPaymentOpen(false)}
          onConfirm={(receivedCents) => {
            setCashPaymentOpen(false)
            completePayment('cash', receivedCents)
          }}
          totalCents={getTicketTotal(ticketLines)}
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
          onClose={() => setConfigOpen(false)}
          onCatalogStartTabChange={updateCatalogStartTab}
          onLogout={handleLogout}
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
