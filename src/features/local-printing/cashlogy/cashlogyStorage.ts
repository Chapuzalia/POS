import { getPrintAgentStorageKey } from '../services/printAgentStorage.ts'
import type { CashlogyIntent, PrintAgentScope } from '../types.ts'

export function getCashlogyIntentStorageKey(scope: PrintAgentScope) {
  return `${getPrintAgentStorageKey(scope)}:cashlogy-intent`
}

export function loadCashlogyIntent(scope: PrintAgentScope): CashlogyIntent | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(getCashlogyIntentStorageKey(scope))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CashlogyIntent
    return parsed.requestId && Number.isInteger(parsed.amountCents) && parsed.amountCents > 0 ? parsed : null
  } catch {
    return null
  }
}

export function saveCashlogyIntent(scope: PrintAgentScope, intent: CashlogyIntent | null) {
  if (typeof window === 'undefined') return
  const key = getCashlogyIntentStorageKey(scope)
  if (intent) window.localStorage.setItem(key, JSON.stringify(intent))
  else window.localStorage.removeItem(key)
}
