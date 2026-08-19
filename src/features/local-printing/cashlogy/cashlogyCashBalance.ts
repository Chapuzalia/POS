import { createPrintAgentClient } from '../api/printAgentClient'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import type { CashlogyTotal } from '../types'
import { validateCashlogyTotal } from './cashlogyCashBalanceValidation'

export async function loadActiveCashlogyCashBalance(): Promise<CashlogyTotal | null> {
  const state = usePrintAgentStore.getState()
  if (!state.cashlogyConfigured) return null

  const health = await state.checkCashlogyHealth()
  if (!health.enabled || !health.ok || health.sessionState !== 'ready') {
    throw new Error('Cashlogy está activa, pero no está preparada para consultar el fondo de efectivo.')
  }

  const current = usePrintAgentStore.getState()
  const client = createPrintAgentClient({ baseUrl: current.baseUrl, token: current.token })
  return validateCashlogyTotal(await client.getCashlogyTotal())
}
