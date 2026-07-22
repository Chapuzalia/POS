import type { PosCatalogState } from '../features/catalog/data/load-pos-catalog.ts'

import type {
  CashSession,
  CatalogStartTab,
  OfflineEvent,
  ProductSalesStat,
  SaleRecord,
  SessionTicketRecord,
  TenantContext,
  TicketLine,
} from '../types'

const prefix = 'clubpos:v1'

function hasStorage() {
  return typeof window !== 'undefined' && 'localStorage' in window
}

function readJson<T>(key: string, fallback: T): T {
  if (!hasStorage()) {
    return fallback
  }

  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson<T>(key: string, value: T) {
  if (!hasStorage()) {
    return
  }

  window.localStorage.setItem(key, JSON.stringify(value))
}

function removeKey(key: string) {
  if (!hasStorage()) {
    return
  }

  window.localStorage.removeItem(key)
}

function contextKey() {
  return `${prefix}:context`
}

function themeKey() {
  return `${prefix}:theme`
}

function catalogStartTabKey() {
  return `${prefix}:catalog-start-tab`
}

function catalogKey(context: Pick<TenantContext, 'tenantId' | 'venueId'>) {
  return `${prefix}:catalog-domain:${context.tenantId}:${context.venueId}`
}

function productSalesStatsKey(tenantId: string) {
  return `${prefix}:product-sales:${tenantId}`
}

function cashSessionKey(context: TenantContext) {
  return `${prefix}:cash:${context.tenantId}:${context.deviceId}`
}

function ticketKey(context: TenantContext) {
  return `${prefix}:ticket:${context.tenantId}:${context.deviceId}`
}

function ledgerKey(context: TenantContext) {
  return `${prefix}:ledger:${context.tenantId}:${context.deviceId}`
}

function sessionTicketsKey(context: TenantContext, cashSessionId: string) {
  return `${prefix}:session-tickets:${context.tenantId}:${context.deviceId}:${cashSessionId}`
}

function queueKey() {
  return `${prefix}:queue`
}

export function getStoredTheme(defaultThemeId: string) {
  return readJson(themeKey(), defaultThemeId)
}

export function saveStoredTheme(themeId: string) {
  writeJson(themeKey(), themeId)
}

export function getCatalogStartTab() {
  return readJson<CatalogStartTab>(catalogStartTabKey(), 'all')
}

export function saveCatalogStartTab(startTab: CatalogStartTab) {
  writeJson(catalogStartTabKey(), startTab)
}

export function getCachedContext() {
  return readJson<TenantContext | null>(contextKey(), null)
}

export function saveCachedContext(context: TenantContext | null) {
  if (context) {
    writeJson(contextKey(), context)
  } else {
    removeKey(contextKey())
  }
}

export function getCachedCatalog(context: Pick<TenantContext, 'tenantId' | 'venueId'>) {
  return readJson<PosCatalogState | null>(catalogKey(context), null)
}

export function saveCachedCatalog(context: Pick<TenantContext, 'tenantId' | 'venueId'>, state: PosCatalogState) {
  writeJson(catalogKey(context), state)
}

export function getCachedProductSalesStats(tenantId: string) {
  return readJson<ProductSalesStat[]>(productSalesStatsKey(tenantId), [])
}

export function saveCachedProductSalesStats(tenantId: string, stats: ProductSalesStat[]) {
  writeJson(productSalesStatsKey(tenantId), stats)
}

export function getCachedCashSession(context: TenantContext) {
  return readJson<CashSession | null>(cashSessionKey(context), null)
}

export function saveCachedCashSession(context: TenantContext, session: CashSession | null) {
  if (session) {
    writeJson(cashSessionKey(context), session)
  } else {
    removeKey(cashSessionKey(context))
  }
}

export function getCachedTicket(context: TenantContext) {
  return readJson<TicketLine[]>(ticketKey(context), [])
}

export function saveCachedTicket(context: TenantContext, lines: TicketLine[]) {
  writeJson(ticketKey(context), lines)
}

export function getSaleLedger(context: TenantContext) {
  return readJson<SaleRecord[]>(ledgerKey(context), [])
}

export function saveSaleLedger(context: TenantContext, records: SaleRecord[]) {
  writeJson(ledgerKey(context), records)
}

export function clearSaleLedger(context: TenantContext) {
  removeKey(ledgerKey(context))
}

export function getSessionTickets(context: TenantContext, cashSessionId: string) {
  return readJson<SessionTicketRecord[]>(sessionTicketsKey(context, cashSessionId), [])
}

export function saveSessionTickets(context: TenantContext, cashSessionId: string, tickets: SessionTicketRecord[]) {
  writeJson(sessionTicketsKey(context, cashSessionId), tickets)
}

export function clearSessionTickets(context: TenantContext, cashSessionId: string) {
  removeKey(sessionTicketsKey(context, cashSessionId))
}

export function getOfflineQueue() {
  return readJson<OfflineEvent[]>(queueKey(), [])
}

export function saveOfflineQueue(events: OfflineEvent[]) {
  writeJson(queueKey(), events)
}

export function enqueueOfflineEvent(event: OfflineEvent) {
  saveOfflineQueue([...getOfflineQueue(), event])
}

export function forgetOfflineEvent(eventId: string) {
  saveOfflineQueue(getOfflineQueue().filter((event) => event.id !== eventId))
}

export function markOfflineEventFailed(eventId: string, error: string) {
  saveOfflineQueue(
    getOfflineQueue().map((event) =>
      event.id === eventId
        ? {
            ...event,
            attempts: event.attempts + 1,
            lastError: error,
          }
        : event,
    ),
  )
}
