import { getPrintAgentStorageKey } from '../services/printAgentStorage.ts'
import type { CashlogyIntent, CashlogyManagementIntent, PrintAgentScope } from '../types.ts'

export function getCashlogyIntentStorageKey(scope: PrintAgentScope) {
  return `${getPrintAgentStorageKey(scope)}:cashlogy-intent`
}

export function getCashlogyManagementIntentStorageKey(scope: PrintAgentScope) {
  return `${getPrintAgentStorageKey(scope)}:cashlogy-management-intent`
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

export function loadCashlogyManagementIntent(scope: PrintAgentScope): CashlogyManagementIntent | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(getCashlogyManagementIntentStorageKey(scope))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CashlogyManagementIntent
    return parsed.requestId && ['refill', 'give_change', 'withdraw', 'empty', 'remove_stacker'].includes(parsed.type)
      ? parsed
      : null
  } catch {
    return null
  }
}

export function saveCashlogyManagementIntent(scope: PrintAgentScope, intent: CashlogyManagementIntent | null) {
  if (typeof window === 'undefined') return
  const key = getCashlogyManagementIntentStorageKey(scope)
  if (intent) window.localStorage.setItem(key, JSON.stringify(intent))
  else window.localStorage.removeItem(key)
}
