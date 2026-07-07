import { useEffect, useState } from 'react'
import { AppHeader } from './components/layout/AppHeader'
import { CashPaymentModal, CloseCashModal, ConfigModal, ProductDialog } from './components/modals'
import { CatalogPanel, OpenCashPanel, PaymentPanel, TicketPanel } from './components/pos'
import { CrmPage } from './components/crm/CrmPage'
import { LoginScreen } from './components/screens/LoginScreen'
import { LoadingScreen, MissingConfigScreen } from './components/screens/StateScreens'
import themesData from './config/themes.json'
import { createId, getLineSignature, getTicketTotal } from './lib/format'
import { getProductVariantForSaleFormat } from './lib/catalog'
import {
  clearSaleLedger,
  enqueueOfflineEvent,
  getCachedCashSession,
  getCachedCatalog,
  getCachedContext,
  getCachedTicket,
  getSaleLedger,
  saveCachedCashSession,
  saveCachedCatalog,
  saveCachedContext,
  saveCachedTicket,
  saveSaleLedger,
} from './lib/offlineStore'
import { supabaseConfig } from './lib/supabase'
import { useOfflineSync } from './hooks/useOfflineSync'
import { useOnlineStatus } from './hooks/useOnlineStatus'
import { useThemeTokens } from './hooks/useThemeTokens'
import {
  buildSalePayload,
  loadCatalogFromSupabase,
  loadOpenCashSession,
  loadSalesLedgerFromSupabase,
  loginTenant,
  mergeLedgers,
  summarizeSales,
} from './services/posService'
import type {
  CashClosedPayload,
  CashSession,
  Catalog,
  LoginInput,
  PaymentMethod,
  Product,
  ProductVariant,
  SaleRecord,
  SaleFormat,
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

function App() {
  const { selectedTheme, setThemeId, themeId } = useThemeTokens(themes, defaultThemeId)
  const isOnline = useOnlineStatus()
  const { pendingCount, refreshPendingCount, syncPendingEvents } = useOfflineSync(isOnline)
  const [context, setContext] = useState<TenantContext | null>(() => getCachedContext())
  const [catalog, setCatalog] = useState<Catalog | null>(() => {
    const cachedContext = getCachedContext()
    return cachedContext ? getCachedCatalog(cachedContext.tenantId) : null
  })
  const [cashSession, setCashSession] = useState<CashSession | null>(() => {
    const cachedContext = getCachedContext()
    return cachedContext ? getCachedCashSession(cachedContext) : null
  })
  const [ticketLines, setTicketLines] = useState<TicketLine[]>(() => {
    const cachedContext = getCachedContext()
    return cachedContext ? getCachedTicket(cachedContext) : []
  })
  const [salesLedger, setSalesLedger] = useState<SaleRecord[]>(() => {
    const cachedContext = getCachedContext()
    return cachedContext ? getSaleLedger(cachedContext) : []
  })
  const [isBusy, setIsBusy] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cashPaymentOpen, setCashPaymentOpen] = useState(false)
  const [closeCashOpen, setCloseCashOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
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

  async function refreshCatalog(activeContext = context) {
    if (!activeContext || !supabaseConfig.isReady || !isOnline) {
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const nextCatalog = await loadCatalogFromSupabase(activeContext)
      setCatalog(nextCatalog)
      saveCachedCatalog(activeContext.tenantId, nextCatalog)
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
      setContext(nextContext)
      saveCachedContext(nextContext)

      const [nextCatalog, openSession] = await Promise.all([
        loadCatalogFromSupabase(nextContext),
        loadOpenCashSession(nextContext),
      ])
      const localLedger = getSaleLedger(nextContext)
      const remoteLedger = openSession ? await loadSalesLedgerFromSupabase(nextContext, openSession.id) : []
      const nextLedger = mergeLedgers(localLedger, remoteLedger)

      setCatalog(nextCatalog)
      saveCachedCatalog(nextContext.tenantId, nextCatalog)
      setCashSession(openSession)
      saveCachedCashSession(nextContext, openSession)
      setTicketLines(getCachedTicket(nextContext))
      setSalesLedger(nextLedger)
      saveSaleLedger(nextContext, nextLedger)
      await syncPendingEvents()
    } catch (loginError) {
      setError(getReadableError(loginError))
    } finally {
      setIsBusy(false)
      setIsLoading(false)
    }
  }

  function enterOffline() {
    const cachedContext = getCachedContext()

    if (!cachedContext) {
      return
    }

    setContext(cachedContext)
    setCatalog(getCachedCatalog(cachedContext.tenantId))
    setCashSession(getCachedCashSession(cachedContext))
    setTicketLines(getCachedTicket(cachedContext))
    setSalesLedger(getSaleLedger(cachedContext))
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
    setCloseCashOpen(false)
    refreshPendingCount()
    void syncPendingEvents()
  }

  function handleLogout() {
    setContext(null)
    setCatalog(null)
    setCashSession(null)
    setTicketLines([])
    setSalesLedger([])
    setConfigOpen(false)
    saveCachedContext(null)
  }

  function navigateToPos() {
    window.history.pushState(null, '', '/')
    setRoute('pos')
  }

  if (!selectedTheme) {
    return null
  }

  if (!supabaseConfig.isReady) {
    return <MissingConfigScreen />
  }

  if (isLoading && !context) {
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

  if (route === 'crm') {
    return (
      <CrmPage
        catalog={catalog}
        context={context}
        error={error}
        isOnline={isOnline}
        onBackToPos={navigateToPos}
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
          <CatalogPanel catalog={catalog} disabled={isBusy} onSelectProduct={handleSelectProduct} />
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

      {configOpen ? (
        <ConfigModal
          context={context}
          onClose={() => setConfigOpen(false)}
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
