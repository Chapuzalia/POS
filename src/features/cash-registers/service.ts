import { supabase } from '../../lib/supabase'
import type { CashClosedPayload, CashRegister, CashSession, TenantContext } from '../../types'

type RegisterRow = { id: string; tenant_id: string; venue_id: string; name: string; is_active: boolean; sort_order: number }
type SessionRow = { id: string; tenant_id: string; venue_id: string; cash_register_id: string; opened_by_device_id: string; opened_by: string; opened_at: string; opening_float_cents: number }

function client() {
  if (!supabase) throw new Error('Supabase no esta configurado.')
  return supabase
}

export async function loadCashRegisterOptions(context: TenantContext) {
  const [registerResult, sessionResult] = await Promise.all([
    client().from('cash_registers').select('id, tenant_id, venue_id, name, is_active, sort_order').eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).order('sort_order'),
    client().from('cash_sessions').select('id, tenant_id, venue_id, cash_register_id, opened_by_device_id, opened_by, opened_at, opening_float_cents').eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('status', 'open').order('opened_at'),
  ])
  if (registerResult.error) throw registerResult.error
  if (sessionResult.error) throw sessionResult.error
  const registers = ((registerResult.data ?? []) as RegisterRow[]).map((row): CashRegister => ({ id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, name: row.name, isActive: row.is_active, sortOrder: row.sort_order }))
  const registerNames = new Map(registers.map((register) => [register.id, register.name]))
  const sessions = ((sessionResult.data ?? []) as SessionRow[]).map((row): CashSession => ({
    id: row.id, tenantId: row.tenant_id, venueId: row.venue_id,
    deviceId: row.opened_by_device_id, userId: row.opened_by,
    cashRegisterId: row.cash_register_id, cashRegisterName: registerNames.get(row.cash_register_id) ?? 'Caja',
    openedAt: row.opened_at, openingFloatCents: row.opening_float_cents, status: 'open',
  }))
  return { registers, sessions }
}

export async function openCashRegisterSession(context: TenantContext, cashRegisterId: string, openingFloatCents: number) {
  const { data, error } = await client().rpc('open_cash_register_session', { p_cash_register_id: cashRegisterId, p_opening_float_cents: openingFloatCents, p_device_id: context.deviceId })
  if (error) throw error
  const state = await loadCashRegisterOptions(context)
  const session = state.sessions.find((item) => item.id === String(data))
  if (!session) throw new Error('La caja se abrio, pero no se pudo recuperar la sesion.')
  return session
}

export async function closeCashRegisterSession(context: TenantContext, sessionId: string, payload: CashClosedPayload) {
  const { error } = await client().rpc('close_cash_register_session', { p_cash_session_id: sessionId, p_device_id: context.deviceId, p_payload: payload })
  if (error) throw error
}

export function subscribeToVenueCashSessions(context: TenantContext, onChange: () => void) {
  if (!supabase) return () => undefined
  const channel = supabase.channel(`cash-registers:${context.tenantId}:${context.venueId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_sessions', filter: `venue_id=eq.${context.venueId}` }, onChange)
    .subscribe()
  return () => { void supabase?.removeChannel(channel) }
}
