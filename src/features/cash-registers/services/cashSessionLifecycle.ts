import { loadSalesLedgerFromSupabase, loadSessionTicketsFromSupabase } from '../../../services/posService'
import type { CashClosedPayload, CashSession, TenantContext } from '../../../types'
import { closeCashRegisterSession, openCashRegisterSession } from '../service'

export async function openCashSession(context: TenantContext, registerId: string, openingFloatCents: number) {
  return openCashRegisterSession(context, registerId, openingFloatCents)
}

export async function joinCashSession(context: TenantContext, session: CashSession) {
  const [ledger, tickets] = await Promise.all([
    loadSalesLedgerFromSupabase(context, session.id),
    loadSessionTicketsFromSupabase(context, session.id),
  ])
  return { ledger, tickets }
}

export async function closeCashSession(context: TenantContext, payload: CashClosedPayload) {
  await closeCashRegisterSession(context, payload.sessionId, payload)
}
