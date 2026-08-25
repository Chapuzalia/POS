import { supabase } from '../../lib/supabase'
import type { TenantContext } from '../../types'
import type {
  KdsQueue,
  OrderProductionState,
  ProductionBatchResult,
  ProductionSelection,
} from './types'

function client() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

function readNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function mapOrderState(value: unknown): OrderProductionState {
  const row = (value ?? {}) as Record<string, unknown>
  return {
    effective: Boolean(row.effective),
    lines: Array.isArray(row.lines) ? row.lines.map((entry) => {
      const line = entry as Record<string, unknown>
      return {
        lineId: String(line.lineId ?? ''),
        sentQuantity: readNumber(line.sentQuantity),
        readyQuantity: readNumber(line.readyQuantity),
        unsentQuantity: readNumber(line.unsentQuantity),
      }
    }) : [],
    warnings: Array.isArray(row.warnings) ? row.warnings.map((entry) => {
      const warning = entry as Record<string, unknown>
      return {
        destinationId: String(warning.destinationId ?? ''),
        status: warning.status === 'unknown' ? 'unknown' as const : 'failed' as const,
        message: String(warning.message ?? 'No se puede confirmar la impresión.'),
      }
    }) : [],
  }
}

export async function loadOrderProductionState(orderId: string) {
  const { data, error } = await client().rpc('get_order_production_state', { p_order_id: orderId })
  if (error) throw error
  return mapOrderState(data)
}

export async function sendProductionBatch(input: {
  orderId: string
  expectedRevision: number
  deviceId: string
  requestId: string
  selection?: ProductionSelection[]
}) {
  const { data, error } = await client().rpc('send_production_batch', {
    p_order_id: input.orderId,
    p_expected_revision: input.expectedRevision,
    p_device_id: input.deviceId,
    p_request_id: input.requestId,
    p_selection: input.selection ?? null,
  })
  if (error) throw error
  return data as ProductionBatchResult
}

export async function loadKdsQueue(deviceId: string) {
  const { data, error } = await client().rpc('get_kds_queue', { p_device_id: deviceId })
  if (error) throw error
  return data as KdsQueue
}

export async function markKdsItemReady(deviceId: string, itemId: string, quantity: number) {
  const { error } = await client().rpc('mark_production_item_ready', {
    p_device_id: deviceId,
    p_item_id: itemId,
    p_quantity: quantity,
  })
  if (error) throw error
}

export function subscribeToOrderProduction(context: TenantContext, orderId: string, onChange: () => void) {
  if (!supabase) return () => undefined
  const channel = supabase.channel(`production-order:${context.venueId}:${orderId}`)
  const schedule = () => onChange()
  channel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_batches', filter: `order_id=eq.${orderId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_line_allocations', filter: `venue_id=eq.${context.venueId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_printer_dispatches', filter: `venue_id=eq.${context.venueId}` }, schedule)
    .subscribe()
  return () => { void supabase?.removeChannel(channel) }
}

export function subscribeToKds(context: TenantContext, destinationId: string, onChange: () => void) {
  if (!supabase) return () => undefined
  const channel = supabase.channel(`production-kds:${context.venueId}:${destinationId}`)
  const schedule = () => onChange()
  channel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_items', filter: `destination_id=eq.${destinationId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_events', filter: `destination_id=eq.${destinationId}` }, schedule)
    .subscribe()
  return () => { void supabase?.removeChannel(channel) }
}

