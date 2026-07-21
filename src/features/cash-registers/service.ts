import { supabase } from '../../lib/supabase'
import type { CashClosedPayload, CashClosingPrintSnapshot, CashClosingRecord, CashRegister, CashSession, TenantContext } from '../../types'
import { cashClosingPrintDocumentSchema } from '../local-printing/schemas/printSchemas'

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
  return loadCashClosing(context, sessionId)
}

type ClosingRow = {
  id: string
  tenant_id: string
  venue_id: string
  cash_register_id: string
  closed_at: string
  closed_by: string
  print_snapshot: CashClosingPrintSnapshot
  print_status: CashClosingRecord['printStatus']
  print_job_id: string | null
  print_request_id: string | null
  printed_at: string | null
  print_error_code: string | null
  print_attempts: number
  print_copies: number
}

const closingColumns = 'id, tenant_id, venue_id, cash_register_id, closed_at, closed_by, print_snapshot, print_status, print_job_id, print_request_id, printed_at, print_error_code, print_attempts, print_copies'

function mapClosing(row: ClosingRow): CashClosingRecord {
  const snapshot = cashClosingPrintDocumentSchema
    .omit({ copyLabel: true, paperWidth: true, includeTotalPayments: true, users: true, times: true })
    .extend({
      openedAt: cashClosingPrintDocumentSchema.shape.closedAt,
      openedBy: cashClosingPrintDocumentSchema.shape.companyName.optional(),
      closedBy: cashClosingPrintDocumentSchema.shape.companyName.optional(),
      expectedAndCounted: cashClosingPrintDocumentSchema.shape.expectedAndCounted.unwrap(),
    })
    .parse(row.print_snapshot) as CashClosingPrintSnapshot
  return {
    id: row.id, tenantId: row.tenant_id, venueId: row.venue_id,
    cashRegisterId: row.cash_register_id, closedAt: row.closed_at, closedBy: row.closed_by,
    printSnapshot: snapshot, printStatus: row.print_status || 'not_requested',
    printJobId: row.print_job_id, printRequestId: row.print_request_id, printedAt: row.printed_at,
    printErrorCode: row.print_error_code, printAttempts: row.print_attempts || 0, printCopies: row.print_copies || 0,
  }
}

export async function loadCashClosing(context: TenantContext, closingId: string) {
  const { data, error } = await client().from('cash_sessions').select(closingColumns)
    .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('id', closingId).eq('status', 'closed').single()
  if (error) throw error
  return mapClosing(data as ClosingRow)
}

export async function loadCashClosingHistory(context: TenantContext, limit = 50) {
  const { data, error } = await client().from('cash_sessions').select(closingColumns)
    .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('status', 'closed')
    .not('print_snapshot', 'is', null).order('closed_at', { ascending: false }).limit(limit)
  if (error) throw error
  return ((data ?? []) as ClosingRow[]).map(mapClosing)
}

export async function recordCashClosingPrintResult(context: TenantContext, input: {
  closingId: string
  printerId: string
  printJobId?: string | null
  requestId: string
  status: 'pending' | 'printed' | 'failed' | 'unknown'
  errorCode?: string | null
  isReprint: boolean
  copyNumber: number
}) {
  const { data, error } = await client().rpc('record_cash_closing_print_result', {
    p_cash_closing_id: input.closingId,
    p_terminal_id: context.deviceId,
    p_printer_id: input.printerId,
    p_print_job_id: input.printJobId || null,
    p_request_id: input.requestId,
    p_status: input.status,
    p_error_code: input.errorCode || null,
    p_is_reprint: input.isReprint,
    p_copy_number: input.copyNumber,
  })
  if (error) throw error
  return data !== false
}

export function subscribeToVenueCashSessions(context: TenantContext, onChange: () => void) {
  if (!supabase) return () => undefined
  const channel = supabase.channel(`cash-registers:${context.tenantId}:${context.venueId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_sessions', filter: `venue_id=eq.${context.venueId}` }, onChange)
    .subscribe()
  return () => { void supabase?.removeChannel(channel) }
}
