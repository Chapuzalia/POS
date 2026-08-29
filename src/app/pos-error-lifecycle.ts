import type { CashlogyIntent, CashlogyTransaction } from '../features/local-printing/types'
import { cashlogyActiveStatuses } from '../features/local-printing/cashlogy/cashlogyPolling'

export const POS_TRANSIENT_ERROR_DURATION_MS = 5_000

type ActiveCashlogyErrorInput = {
  displayedError: string | null
  cashlogyError: Error | null
  intent: CashlogyIntent | null
  transaction: CashlogyTransaction | null
}

export function isActiveCashlogyError(input: ActiveCashlogyErrorInput) {
  if (!input.displayedError || input.cashlogyError?.message !== input.displayedError || !input.intent) return false
  if (!input.transaction) return true
  return cashlogyActiveStatuses.has(input.transaction.status)
    || input.transaction.status === 'unknown'
    || input.transaction.status === 'needs_attention'
}
