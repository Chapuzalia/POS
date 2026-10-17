import { reportOperationError } from '../../lib/observability.ts'
import { recoverSupabaseRealtimeConnection, supabase } from '../../lib/supabase'
import type { TenantContext } from '../../types'
import type {
  KdsQueue,
  OrderProductionState,
  ProductionBatchResult,
  ProductionEntry,
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

function mapOrderState(value: unknown, orderId: string): OrderProductionState {
  const row = (value ?? {}) as Record<string, unknown>
  return {
    effective: Boolean(row.effective),
    entries: Array.isArray(row.entries) ? row.entries.map((entry): ProductionEntry => {
      const item = entry as Record<string, unknown>
      return {
        lineId: String(item.lineId ?? ''),
        componentId: typeof item.componentId === 'string' ? item.componentId : null,
        productName: String(item.productName ?? 'Producto'),
        parentProductName: typeof item.parentProductName === 'string' ? item.parentProductName : null,
        quantity: readNumber(item.quantity),
        sentQuantity: readNumber(item.sentQuantity),
        skippedQuantity: readNumber(item.skippedQuantity),
        readyQuantity: readNumber(item.readyQuantity),
        preparingQuantity: readNumber(item.preparingQuantity),
        unsentQuantity: readNumber(item.unsentQuantity),
        passId: String(item.passId ?? ''),
        passName: String(item.passName ?? 'Directo'),
        passSortOrder: readNumber(item.passSortOrder),
        hasProductionDestination: Boolean(item.hasProductionDestination),
      }
    }) : [],
    lines: Array.isArray(row.lines) ? row.lines.map((entry) => {
      const line = entry as Record<string, unknown>
      return {
        hasProductionDestination: Boolean(line.hasProductionDestination),
        lineId: String(line.lineId ?? ''),
        sentQuantity: readNumber(line.sentQuantity),
        readyQuantity: readNumber(line.readyQuantity),
        preparingQuantity: readNumber(line.preparingQuantity),
        unsentQuantity: readNumber(line.unsentQuantity),
      }
    }) : [],
    warnings: Array.isArray(row.warnings) ? row.warnings.map((entry) => {
      const warning = entry as Record<string, unknown>
      reportOperationError(new Error(typeof warning.message === 'string' ? warning.message : 'Production dispatch failed'), { operation: 'production.dispatch', operationId: orderId, step: warning.status === 'unknown' ? 'uncertain' : 'failed', integration: 'print-agent' })
      return {
        destinationId: String(warning.destinationId ?? ''),
        status: warning.status === 'unknown' ? 'unknown' as const : 'failed' as const,
        message: 'No se puede confirmar la impresión. Comprueba la impresora antes de repetirla.',
      }
    }) : [],
  }
}

export async function loadOrderProductionState(orderId: string) {
  const { data, error } = await client().rpc('get_order_production_state', { p_order_id: orderId })
  if (error) throw error
  return mapOrderState(data, orderId)
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
  if (error) {
    reportOperationError(error, { operation: 'production.send', operationId: input.requestId, step: 'persist_batch' })
    throw error
  }
  return data as ProductionBatchResult
}

export async function loadKdsQueue(deviceId: string) {
  const { data, error } = await client().rpc('get_kds_workflow_queue', { p_device_id: deviceId })
  if (error) throw error
  return data as KdsQueue
}

export async function acknowledgeKdsEvent(deviceId: string, eventId: string) {
  const { error } = await client().rpc('acknowledge_kds_event', { p_device_id: deviceId, p_event_id: eventId })
  if (error) throw error
}

export async function acceptKdsBatch(deviceId: string, batchId: string) {
  const { error } = await client().rpc('accept_production_batch', { p_device_id: deviceId, p_batch_id: batchId })
  if (error) throw error
}

export async function setOrderLineProductionPass(input: { lineId: string; componentId?: string | null; passId: string }) {
  const { error } = await client().rpc('set_order_line_production_pass', {
    p_order_line_id: input.lineId,
    p_component_id: input.componentId ?? '',
    p_pass_id: input.passId,
  })
  if (error) throw error
}

export async function markKdsItemReady(deviceId: string, itemId: string, quantity: number) {
  const { error } = await client().rpc('mark_production_item_ready', {
    p_device_id: deviceId,
    p_item_id: itemId,
    p_quantity: quantity,
  })
  if (error) throw error
}

export async function markKdsItemQuantityReady(deviceId: string, itemId: string, quantity: number) {
  const { error } = await client().rpc('mark_production_item_quantity_ready', {
    p_device_id: deviceId,
    p_item_id: itemId,
    p_quantity: quantity,
  })
  if (error) throw error
}

export function subscribeToOrderProduction(context: TenantContext, orderId: string, onChange: () => void) {
  if (!supabase) return () => undefined
  const channel = supabase.channel(`production-order:${context.venueId}:${orderId}`)
  let active = true
  let refreshTimer: number | undefined
  const schedule = () => {
    if (!active || refreshTimer !== undefined) return
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined
      if (active) onChange()
    }, 100)
  }
  const safetyTimer = window.setInterval(schedule, 15_000)
  window.addEventListener('focus', schedule)
  channel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_lines', filter: `order_id=eq.${orderId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `id=eq.${orderId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_batches', filter: `order_id=eq.${orderId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_items', filter: `venue_id=eq.${context.venueId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_line_allocations', filter: `venue_id=eq.${context.venueId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_component_allocations', filter: `venue_id=eq.${context.venueId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_printer_dispatches', filter: `venue_id=eq.${context.venueId}` }, schedule)
    .subscribe((status) => { if (status === 'SUBSCRIBED') schedule() })
  return () => {
    active = false
    window.clearTimeout(refreshTimer)
    window.clearInterval(safetyTimer)
    window.removeEventListener('focus', schedule)
    void supabase?.removeChannel(channel)
  }
}

export function subscribeToKds(context: Pick<TenantContext, 'tenantId' | 'venueId'>, destinationId: string, onChange: () => void) {
  if (!supabase) return () => undefined
  const channel = supabase.channel(`production-kds:${context.venueId}:${destinationId}`)
  let active = true
  let refreshTimer: number | undefined
  let fallbackTimer: number | undefined
  const schedule = () => {
    if (!active || refreshTimer !== undefined) return
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined
      if (active) onChange()
    }, 100)
  }
  const recover = () => {
    void recoverSupabaseRealtimeConnection().catch(() => undefined)
    schedule()
  }
  const onVisible = () => { if (document.visibilityState === 'visible') recover() }
  const safetyTimer = window.setInterval(schedule, 15_000)
  window.addEventListener('focus', recover)
  window.addEventListener('online', recover)
  document.addEventListener('visibilitychange', onVisible)
  channel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_items', filter: `destination_id=eq.${destinationId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_events', filter: `destination_id=eq.${destinationId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_lines', filter: `venue_id=eq.${context.venueId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `venue_id=eq.${context.venueId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_line_allocations', filter: `venue_id=eq.${context.venueId}` }, schedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'production_component_allocations', filter: `venue_id=eq.${context.venueId}` }, schedule)
    .subscribe((status) => {
      if (!active) return
      if (status === 'SUBSCRIBED') {
        if (fallbackTimer !== undefined) window.clearInterval(fallbackTimer)
        fallbackTimer = undefined
        schedule()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (fallbackTimer === undefined) fallbackTimer = window.setInterval(schedule, 3000)
        schedule()
      }
    })
  return () => {
    active = false
    window.clearTimeout(refreshTimer)
    window.clearInterval(fallbackTimer)
    window.clearInterval(safetyTimer)
    window.removeEventListener('focus', recover)
    window.removeEventListener('online', recover)
    document.removeEventListener('visibilitychange', onVisible)
    void supabase?.removeChannel(channel)
  }
}

