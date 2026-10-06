import { reportOperationError } from './observability.ts'
import type { PosCatalogState } from '../features/catalog/data/load-pos-catalog.ts'
import { appendFrozenQueueEvent, recordQueueEventFailure } from '../features/offline/services/offlineQueueState.ts'
import { getAppRoute, type AppRoute } from '../app/app-routes'
import type { AssistConfiguration, AssistSituation } from '../features/assist/types'

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
const OFFLINE_QUEUE_SCHEMA_VERSION = 1 as const

function assistKey(context: TenantContext, suffix: string) {
  return `${prefix}:assist:v1:${getAppRoute()}:${context.tenantId}:${context.venueId}:${context.deviceId}:${context.userId}:${suffix}`
}

export function getCachedAssistConfiguration(context: TenantContext): AssistConfiguration | undefined {
  const value = readJson<AssistConfiguration | null>(assistKey(context, 'config'), null)
  if (!value || typeof value.tenantEnabled !== 'boolean' || typeof value.venueEnabled !== 'boolean' || !['low', 'normal', 'high'].includes(value.sensitivity)) return undefined
  return value
}

export function saveCachedAssistConfiguration(context: TenantContext, value: AssistConfiguration) {
  try {
    if (JSON.stringify(getCachedAssistConfiguration(context)) !== JSON.stringify(value)) writeJson(assistKey(context, 'config'), value)
  } catch { /* Assist storage must never break restaurant synchronization. */ }
}

export function getAssistJournal(context: TenantContext): AssistSituation[] {
  const value = readJson<AssistSituation[]>(assistKey(context, 'journal'), [])
  if (!Array.isArray(value)) return []
  return value.filter((event) => event && typeof event.key === 'string' && typeof event.episodeId === 'string' && Number.isFinite(Date.parse(event.startedAt)) && Date.now() - Date.parse(event.startedAt) < 24 * 60 * 60_000).slice(-128)
}

export function saveAssistJournal(context: TenantContext, value: AssistSituation[]) {
  try { writeJson(assistKey(context, 'journal'), value.slice(-128)) } catch { /* Best effort secondary journal. */ }
}

export function getAssistEpisodes(context: TenantContext) {
  const value = readJson<AssistSituation[]>(assistKey(context, 'episodes'), [])
  return Array.isArray(value) ? value.filter((event) => event && typeof event.key === 'string' && typeof event.episodeId === 'string' && ['INFO', 'ATTENTION', 'ACTION'].includes(event.severity) && Date.parse(event.expiresAt) > Date.now()).slice(-64) : []
}

export function saveAssistEpisodes(context: TenantContext, value: AssistSituation[]) {
  try { writeJson(assistKey(context, 'episodes'), value.slice(-64)) } catch { /* Best effort secondary cache. */ }
}

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
  } catch (error) {
    if (/:(queue|ledger|cash|session-tickets)(:|$)/.test(key)) reportOperationError(error, { operation: 'offline.storage', step: 'read', syncStatus: 'unreadable' })
    return fallback
  }
}

function writeJson<T>(key: string, value: T) {
  if (!hasStorage()) {
    return
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    reportOperationError(error, { operation: 'offline.storage', step: 'write' })
    throw error
  }
}

function removeKey(key: string) {
  if (!hasStorage()) {
    return
  }

  window.localStorage.removeItem(key)
}

function contextKey(route: AppRoute = getAppRoute()) {
  return `${prefix}:context:${route}`
}

function contextRoute(context: TenantContext): AppRoute {
  if (context.role === 'superadmin') return 'superadmin'
  if (context.role === 'owner' || context.role === 'manager') return 'crm'
  return 'pos'
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
  const scoped = readJson<TenantContext | null>(contextKey(), null)
  if (scoped) return scoped

  const legacyKey = `${prefix}:context`
  const legacy = readJson<TenantContext | null>(legacyKey, null)
  if (legacy && contextRoute(legacy) === getAppRoute()) {
    writeJson(contextKey(), legacy)
    removeKey(legacyKey)
    return legacy
  }
  return null
}

export function saveCachedContext(context: TenantContext | null) {
  if (context) {
    writeJson(contextKey(contextRoute(context)), context)
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

export function removeSaleFromLedger(context: TenantContext, saleId: string) {
  saveSaleLedger(context, getSaleLedger(context).filter((record) => record.id !== saleId))
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
  saveOfflineQueue(appendFrozenQueueEvent(getOfflineQueue(), {
    ...event,
    schemaVersion: OFFLINE_QUEUE_SCHEMA_VERSION,
  }))
}

export function forgetOfflineEvent(eventId: string) {
  saveOfflineQueue(getOfflineQueue().filter((event) => event.id !== eventId))
}

export function markOfflineEventFailed(eventId: string, error: string) {
  saveOfflineQueue(recordQueueEventFailure(getOfflineQueue(), eventId, error))
}
