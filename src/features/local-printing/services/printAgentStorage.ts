import type { PrintAgentPersistedConfig, PrintAgentScope } from '../types.ts'
import { DEFAULT_PRINT_AGENT_URL } from '../constants/config.ts'

const prefix = 'clubpos:v1:print-agent-config'

export const defaultPrintAgentPreferences = {
  autoOpenCashDrawer: true,
  alwaysPrintTicket: true,
  cut: true,
  copies: 1,
  footer: 'Gracias por tu visita',
  printCashClosingAutomatically: true,
  includeExpectedAndCountedAmounts: false,
  includeUserNames: true,
  includeOpeningAndClosingTimes: false,
  includeZeroPaymentMethods: false,
  includeTotalPayments: false,
  cashClosingCopies: 1,
  cashClosingPaperWidth: 42 as const,
  moneySymbol: 'currency' as const,
}

export function getPrintAgentStorageKey(scope: PrintAgentScope) {
  return `${prefix}:${scope.tenantId}:${scope.establishmentId}:${scope.terminalId}`
}

export function getDefaultPrintAgentConfig(): PrintAgentPersistedConfig {
  return {
    baseUrl: DEFAULT_PRINT_AGENT_URL,
    token: null,
    selectedPrinterId: null,
    lastSuccessfulConnectionAt: null,
    preferences: { ...defaultPrintAgentPreferences },
  }
}

export function loadPrintAgentConfig(scope: PrintAgentScope): PrintAgentPersistedConfig {
  if (typeof window === 'undefined') return getDefaultPrintAgentConfig()
  try {
    const raw = window.localStorage.getItem(getPrintAgentStorageKey(scope))
    if (!raw) return getDefaultPrintAgentConfig()
    const parsed = JSON.parse(raw) as Partial<PrintAgentPersistedConfig>
    return {
      ...getDefaultPrintAgentConfig(),
      ...parsed,
      preferences: { ...defaultPrintAgentPreferences, ...parsed.preferences },
      token: typeof parsed.token === 'string' && parsed.token ? parsed.token : null,
    }
  } catch { return getDefaultPrintAgentConfig() }
}

export function savePrintAgentConfig(scope: PrintAgentScope, config: PrintAgentPersistedConfig) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(getPrintAgentStorageKey(scope), JSON.stringify(config))
}

export function clearPrintAgentConfig(scope: PrintAgentScope) {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(getPrintAgentStorageKey(scope))
}

function copyCounterKey(scope: PrintAgentScope, documentId: string, kind = 'sale') {
  return `${getPrintAgentStorageKey(scope)}:copy:${kind}:${documentId}`
}

export function nextPrintCopyNumber(scope: PrintAgentScope, saleId: string) {
  if (typeof window === 'undefined') return 1
  const key = copyCounterKey(scope, saleId)
  const next = Number(window.localStorage.getItem(key) || '0') + 1
  window.localStorage.setItem(key, String(next))
  return next
}

export function nextCashClosingCopyNumber(scope: PrintAgentScope, closingId: string) {
  if (typeof window === 'undefined') return 1
  const key = copyCounterKey(scope, closingId, 'cash-closing')
  const next = Number(window.localStorage.getItem(key) || '0') + 1
  window.localStorage.setItem(key, String(next))
  return next
}

// El token permanece en localStorage durante el MVP. Este modulo es el unico
// punto de acceso para poder sustituirlo por almacenamiento nativo seguro.
