import { supabase } from '../../lib/supabase'
import { splitLegacyMixerModifiers } from '../../lib/mixers'
import type { AppliedDiscount, PaymentMethod, TenantContext, TicketLineMixer, TicketLineModifier } from '../../types/domain'
import type { CloseRestaurantOrderResult, DiningArea, DiningAreaCreateInput, DiningAreaUpdateInput, MoveRestaurantOrderLinesResult, OpenRestaurantOrderInput, PayRestaurantEqualPartResult, RestaurantEqualSplit, RestaurantMap, RestaurantOrder, RestaurantOrderDetail, RestaurantOrderGroupDetail, RestaurantOrderLine, RestaurantOrderLineMove, RestaurantTable, RestaurantTableCreateInput, RestaurantTableMapItem, RestaurantTableUpdateInput, SaveRestaurantOrderLinesResult } from './types'
import { getOrderPendingUnits } from './service-status'
import { buildRestaurantOrderLinesPayload } from './order-line-payload'
import { normalizeMapElements } from './map-elements'

export { buildRestaurantOrderLinesPayload } from './order-line-payload'

type AreaRow = { id: string; tenant_id: string; venue_id: string; name: string; sort_order: number; is_active: boolean; canvas_width: number; canvas_height: number; map_elements: unknown; created_at: string; updated_at: string }
type TableRow = { id: string; tenant_id: string; venue_id: string; area_id: string; name: string; capacity: number; shape: RestaurantTable['shape']; position_x: number; position_y: number; width: number; height: number; is_active: boolean; sort_order: number; reserved_until: string | null; reservation_note: string | null; created_at: string; updated_at: string }
type OrderRow = { id: string; tenant_id: string; venue_id: string; cash_session_id: string; cash_register_id: string; opened_by_user_id: string; opened_by_device_id: string; guest_count: number; status: RestaurantOrder['status']; revision: number; order_group_id: string; split_sequence: number; opened_at: string; updated_at: string; closed_at: string | null }
type OrderTableRow = { order_id: string; order_group_id: string; table_id: string; joined_at: string; released_at: string | null }
type OrderLineRow = { id: string; tenant_id: string; venue_id: string; order_id: string; product_id: string | null; variant_id: string | null; product_name: string; variant_name: string; unit_price_cents: number; quantity: number; served_quantity: number; fully_served_at: string | null; modifiers: TicketLineModifier[]; mixer_product_id: string | null; mixer: TicketLineMixer | null; note: string | null; created_at: string; updated_at: string }

const areaColumns = 'id, tenant_id, venue_id, name, sort_order, is_active, canvas_width, canvas_height, map_elements, created_at, updated_at'
const tableColumns = 'id, tenant_id, venue_id, area_id, name, capacity, shape, position_x, position_y, width, height, is_active, sort_order, reserved_until, reservation_note, created_at, updated_at'
const orderColumns = 'id, tenant_id, venue_id, cash_session_id, cash_register_id, opened_by_user_id, opened_by_device_id, guest_count, status, revision, order_group_id, split_sequence, opened_at, updated_at, closed_at'
const lineColumns = 'id, tenant_id, venue_id, order_id, product_id, variant_id, product_name, variant_name, unit_price_cents, quantity, served_quantity, fully_served_at, modifiers, mixer_product_id, mixer, note, created_at, updated_at'

function requireSupabase() {
  if (!supabase) throw new Error('Supabase no esta configurado.')
  return supabase
}

const mapArea = (row: AreaRow): DiningArea => ({ id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, name: row.name, sortOrder: row.sort_order, isActive: row.is_active, canvasWidth: row.canvas_width, canvasHeight: row.canvas_height, mapElements: normalizeMapElements(row.map_elements), createdAt: row.created_at, updatedAt: row.updated_at })
const mapTable = (row: TableRow): RestaurantTable => ({ id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, areaId: row.area_id, name: row.name, capacity: row.capacity, shape: row.shape, positionX: Number(row.position_x), positionY: Number(row.position_y), width: Number(row.width), height: Number(row.height), isActive: row.is_active, sortOrder: row.sort_order, reservedUntil: row.reserved_until, reservationNote: row.reservation_note, createdAt: row.created_at, updatedAt: row.updated_at })
const mapOrder = (row: OrderRow): RestaurantOrder => ({ id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, cashSessionId: row.cash_session_id, cashRegisterId: row.cash_register_id, openedByUserId: row.opened_by_user_id, openedByDeviceId: row.opened_by_device_id, guestCount: row.guest_count, status: row.status, revision: row.revision, orderGroupId: row.order_group_id, splitSequence: row.split_sequence, openedAt: row.opened_at, updatedAt: row.updated_at, closedAt: row.closed_at })
const mapLine = (row: OrderLineRow): RestaurantOrderLine => {
  const selection = splitLegacyMixerModifiers(row.modifiers, row.mixer_product_id, row.mixer)
  return { id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, orderId: row.order_id, productId: row.product_id, variantId: row.variant_id, productName: row.product_name, variantName: row.variant_name, unitPriceCents: row.unit_price_cents, quantity: row.quantity, servedQuantity: Number(row.served_quantity), fullyServedAt: row.fully_served_at, modifiers: selection.modifiers, mixerProductId: selection.mixerProductId, mixer: selection.mixer, note: row.note, createdAt: row.created_at, updatedAt: row.updated_at }
}

export async function loadVenueTablesEnabled(context: TenantContext, venueId = context.venueId) {
  const { data, error } = await requireSupabase().from('venues').select('tables_enabled').eq('tenant_id', context.tenantId).eq('id', venueId).single<{ tables_enabled: boolean }>()
  if (error) throw error
  return data.tables_enabled
}

export async function setVenueTablesEnabled(venueId: string, enabled: boolean) {
  const { data, error } = await requireSupabase().rpc('set_venue_tables_enabled', { p_venue_id: venueId, p_enabled: enabled })
  if (error) throw error
  return Boolean(data)
}

export async function loadDiningAreas(context: TenantContext, venueId = context.venueId, includeInactive = false): Promise<DiningArea[]> {
  let query = requireSupabase().from('dining_areas').select(areaColumns).eq('tenant_id', context.tenantId).eq('venue_id', venueId).order('sort_order')
  if (!includeInactive) query = query.eq('is_active', true)
  const { data, error } = await query
  if (error) throw error
  return ((data ?? []) as AreaRow[]).map(mapArea)
}

export async function loadRestaurantTables(context: TenantContext, venueId = context.venueId, includeInactive = false): Promise<RestaurantTable[]> {
  let query = requireSupabase().from('restaurant_tables').select(tableColumns).eq('tenant_id', context.tenantId).eq('venue_id', venueId).order('sort_order')
  if (!includeInactive) query = query.eq('is_active', true)
  const { data, error } = await query
  if (error) throw error
  return ((data ?? []) as TableRow[]).map(mapTable)
}

export async function loadRestaurantMap(context: TenantContext): Promise<RestaurantMap> {
  const client = requireSupabase()
  const [areas, tables, linksResult, ordersResult, equalSplitsResult] = await Promise.all([
    loadDiningAreas(context), loadRestaurantTables(context),
    client.from('order_tables').select('order_id, order_group_id, table_id, joined_at, released_at').eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).is('released_at', null),
    client.from('orders').select(orderColumns).eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('status', 'open'),
    client.from('restaurant_order_equal_splits').select('order_group_id, paid_cents').eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('status', 'open'),
  ])
  if (linksResult.error) throw linksResult.error
  if (ordersResult.error) throw ordersResult.error
  if (equalSplitsResult.error) throw equalSplitsResult.error
  const links = (linksResult.data ?? []) as OrderTableRow[]
  const orders = ((ordersResult.data ?? []) as OrderRow[]).map(mapOrder)
  let lines: RestaurantOrderLine[] = []
  if (orders.length) {
    const { data, error } = await client.from('order_lines').select(lineColumns).in('order_id', orders.map((order) => order.id))
    if (error) throw error
    lines = ((data ?? []) as OrderLineRow[]).map(mapLine)
  }
  const orderByGroup = new Map<string, RestaurantOrder[]>()
  orders.forEach((order) => orderByGroup.set(order.orderGroupId, [...(orderByGroup.get(order.orderGroupId) ?? []), order]))
  orderByGroup.forEach((groupOrders) => groupOrders.sort((a, b) => a.splitSequence - b.splitSequence))
  const groupByOrder = new Map(orders.map((order) => [order.id, order.orderGroupId]))
  const totals = new Map<string, number>()
  const pendingUnits = new Map<string, number>()
  const paidCents = new Map<string, number>()
  ;((equalSplitsResult.data ?? []) as Array<{ order_group_id: string; paid_cents: number }>).forEach((split) => paidCents.set(split.order_group_id, (paidCents.get(split.order_group_id) ?? 0) + Number(split.paid_cents)))
  lines.forEach((line) => {
    const groupId = groupByOrder.get(line.orderId)
    if (!groupId) return
    totals.set(groupId, (totals.get(groupId) ?? 0) + line.quantity * line.unitPriceCents)
    pendingUnits.set(groupId, (pendingUnits.get(groupId) ?? 0) + Math.max(0, line.quantity - line.servedQuantity))
  })
  const linkByTable = new Map(links.map((link) => [link.table_id, link]))
  const tableIdsByGroup = new Map<string, string[]>()
  links.forEach((link) => tableIdsByGroup.set(link.order_group_id, [...(tableIdsByGroup.get(link.order_group_id) ?? []), link.table_id]))
  const now = Date.now()
  const mappedTables: RestaurantTableMapItem[] = tables.map((table) => {
    const link = linkByTable.get(table.id)
    const order = link ? orderByGroup.get(link.order_group_id)?.[0] : undefined
    const groupId = order?.orderGroupId
    const reserved = table.reservedUntil ? new Date(table.reservedUntil).getTime() > now : false
    return { ...table, status: order ? 'occupied' : reserved ? 'reserved' : 'free', orderId: order?.id ?? null, orderOpenedAt: order?.openedAt ?? null, guestCount: order?.guestCount ?? null, totalCents: groupId ? Math.max(0, (totals.get(groupId) ?? 0) - (paidCents.get(groupId) ?? 0)) : 0, pendingUnits: groupId ? (pendingUnits.get(groupId) ?? 0) : 0, groupTableIds: groupId ? (tableIdsByGroup.get(groupId) ?? []) : [] }
  })
  return { areas, tables: mappedTables }
}

export async function loadRestaurantOrder(context: TenantContext, orderId: string): Promise<RestaurantOrderDetail> {
  const client = requireSupabase()
  const orderResult = await client.from('orders').select(orderColumns).eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('id', orderId).single<OrderRow>()
  if (orderResult.error) throw orderResult.error
  const [linesResult, linksResult] = await Promise.all([
    client.from('order_lines').select(lineColumns).eq('tenant_id', context.tenantId).eq('order_id', orderId).order('created_at'),
    client.from('order_tables').select('table_id').eq('tenant_id', context.tenantId).eq('order_group_id', orderResult.data.order_group_id).is('released_at', null),
  ])
  if (linesResult.error) throw linesResult.error
  if (linksResult.error) throw linksResult.error
  const tableIds = (linksResult.data ?? []).map((row: { table_id: string }) => row.table_id)
  let tableRows: TableRow[] = []
  if (tableIds.length) {
    const { data, error } = await client.from('restaurant_tables').select(tableColumns).in('id', tableIds)
    if (error) throw error
    tableRows = (data ?? []) as TableRow[]
  }
  const lines = ((linesResult.data ?? []) as OrderLineRow[]).map(mapLine)
  const { data: register } = await client.from('cash_registers').select('name').eq('id', orderResult.data.cash_register_id).maybeSingle<{ name: string }>()
  return { order: mapOrder(orderResult.data), cashRegisterName: register?.name ?? 'Caja', lines, tables: tableRows.map(mapTable), totalCents: lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0) }
}

export async function createDiningArea(context: TenantContext, input: DiningAreaCreateInput) {
  const { data, error } = await requireSupabase().from('dining_areas').insert({ tenant_id: context.tenantId, venue_id: input.venueId, name: input.name.trim(), sort_order: input.sortOrder }).select(areaColumns).single<AreaRow>()
  if (error) throw error
  return mapArea(data)
}
export async function updateDiningArea(context: TenantContext, areaId: string, input: DiningAreaUpdateInput) {
  const { error } = await requireSupabase().from('dining_areas').update({ name: input.name?.trim(), sort_order: input.sortOrder, is_active: input.isActive, canvas_width: input.canvasWidth, canvas_height: input.canvasHeight, map_elements: input.mapElements }).eq('tenant_id', context.tenantId).eq('id', areaId)
  if (error) throw error
}
export async function createRestaurantTable(context: TenantContext, input: RestaurantTableCreateInput) {
  const { data, error } = await requireSupabase().from('restaurant_tables').insert({ tenant_id: context.tenantId, venue_id: input.venueId, area_id: input.areaId, name: input.name.trim(), capacity: input.capacity, shape: input.shape, position_x: input.positionX, position_y: input.positionY, width: input.width, height: input.height, sort_order: input.sortOrder }).select(tableColumns).single<TableRow>()
  if (error) throw error
  return mapTable(data)
}
export async function updateRestaurantTable(context: TenantContext, tableId: string, input: RestaurantTableUpdateInput) {
  const { error } = await requireSupabase().from('restaurant_tables').update({ name: input.name?.trim(), capacity: input.capacity, shape: input.shape, position_x: input.positionX, position_y: input.positionY, width: input.width, height: input.height, is_active: input.isActive, sort_order: input.sortOrder }).eq('tenant_id', context.tenantId).eq('id', tableId)
  if (error) throw error
}

export async function openRestaurantOrder(input: OpenRestaurantOrderInput) { const { data, error } = await requireSupabase().rpc('open_restaurant_order', { p_table_ids: input.tableIds, p_guest_count: input.guestCount, p_cash_session_id: input.cashSessionId, p_device_id: input.deviceId }); if (error) throw error; return String(data) }
export async function addRestaurantOrderLine(orderId: string, productId: string, variantId: string, modifiers: TicketLineModifier[], mixerProductId: string | null = null) { const { data, error } = await requireSupabase().rpc('add_restaurant_order_line_with_mixer', { p_order_id: orderId, p_product_id: productId, p_variant_id: variantId, p_modifier_ids: modifiers.map((modifier) => modifier.id), p_quantity: 1, p_note: null, p_mixer_product_id: mixerProductId }); if (error) throw error; return String(data) }
export async function setRestaurantOrderLineQuantity(lineId: string, quantity: number) { const { error } = await requireSupabase().rpc('set_restaurant_order_line_quantity', { p_line_id: lineId, p_quantity: quantity }); if (error) throw error }
export async function removeRestaurantOrderLine(lineId: string) { const { error } = await requireSupabase().rpc('remove_restaurant_order_line', { p_line_id: lineId }); if (error) throw error }
export async function removeRestaurantOrderLineConfirmed(lineId: string, expectedRevision: number) {
  const { data, error } = await requireSupabase().rpc('remove_restaurant_order_line_confirmed', {
    p_line_id: lineId,
    p_expected_revision: expectedRevision,
  })
  if (error) throw error
  return Number(data)
}

function mapEqualSplit(value: unknown): RestaurantEqualSplit {
  const row = value as Record<string, unknown>
  const read = (camel: string, snake: string) => row[camel] ?? row[snake]
  const totalCents = Number(read('totalCents', 'total_cents'))
  const partCount = Number(read('partCount', 'part_count'))
  const paidParts = Number(read('paidParts', 'paid_parts'))
  const paidCents = Number(read('paidCents', 'paid_cents'))
  const nextPartCents = paidParts >= partCount ? 0 : Math.floor(totalCents / partCount) + (paidParts + 1 <= totalCents % partCount ? 1 : 0)
  return {
    id: String(row.id), orderId: String(read('orderId', 'order_id')), orderGroupId: String(read('orderGroupId', 'order_group_id')),
    totalCents, partCount, paidParts, paidCents,
    remainingParts: Number(read('remainingParts', 'remaining_parts') ?? partCount - paidParts),
    remainingCents: Number(read('remainingCents', 'remaining_cents') ?? totalCents - paidCents),
    nextPartCents: Number(read('nextPartCents', 'next_part_cents') ?? nextPartCents),
    status: row.status as RestaurantEqualSplit['status'], revision: Number(row.revision),
    allowPendingService: Boolean(read('allowPendingService', 'allow_pending_service')),
  }
}

export async function loadRestaurantOrderGroup(context: TenantContext, orderId: string): Promise<RestaurantOrderGroupDetail> {
  const client = requireSupabase()
  const { data: selected, error: selectedError } = await client.from('orders').select(orderColumns)
    .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('id', orderId).single<OrderRow>()
  if (selectedError) throw selectedError
  const [ordersResult, linksResult, registerResult] = await Promise.all([
    client.from('orders').select(orderColumns).eq('tenant_id', context.tenantId).eq('venue_id', context.venueId)
      .eq('order_group_id', selected.order_group_id).neq('status', 'cancelled').order('split_sequence'),
    client.from('order_tables').select('table_id').eq('tenant_id', context.tenantId)
      .eq('order_group_id', selected.order_group_id).is('released_at', null),
    client.from('cash_registers').select('name').eq('id', selected.cash_register_id).maybeSingle<{ name: string }>(),
  ])
  if (ordersResult.error) throw ordersResult.error
  if (linksResult.error) throw linksResult.error
  const orderRows = (ordersResult.data ?? []) as OrderRow[]
  const orderIds = orderRows.map((order) => order.id)
  const tableIds = (linksResult.data ?? []).map((row: { table_id: string }) => row.table_id)
  const [linesResult, tablesResult] = await Promise.all([
    orderIds.length ? client.from('order_lines').select(lineColumns).in('order_id', orderIds).order('created_at') : Promise.resolve({ data: [], error: null }),
    tableIds.length ? client.from('restaurant_tables').select(tableColumns).in('id', tableIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (linesResult.error) throw linesResult.error
  if (tablesResult.error) throw tablesResult.error
  const allLines = ((linesResult.data ?? []) as OrderLineRow[]).map(mapLine)
  const tables = ((tablesResult.data ?? []) as TableRow[]).map(mapTable)
  const orders = orderRows.map((row) => {
    const lines = allLines.filter((line) => line.orderId === row.id)
    return { order: mapOrder(row), cashRegisterName: registerResult.data?.name ?? 'Caja', lines, tables, totalCents: lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0) }
  })
  return { id: selected.order_group_id, orders, tables }
}
export async function moveRestaurantOrder(orderId: string, tableId: string) { const { error } = await requireSupabase().rpc('move_restaurant_order', { p_order_id: orderId, p_target_table_id: tableId }); if (error) throw error }
export async function moveRestaurantOrderLines(sourceOrderId: string, targetOrderId: string | null, expectedSourceRevision: number, expectedTargetRevision: number | null, moves: RestaurantOrderLineMove[]) {
  const { data, error } = await requireSupabase().rpc('move_restaurant_order_lines', {
    p_source_order_id: sourceOrderId,
    p_target_order_id: targetOrderId,
    p_expected_source_revision: expectedSourceRevision,
    p_expected_target_revision: expectedTargetRevision,
    p_moves: moves.map((move) => ({ lineId: move.lineId, quantity: move.quantity })),
  })
  if (error) throw error
  return data as MoveRestaurantOrderLinesResult
}
export async function closeRestaurantOrder(orderId: string, paymentMethod: PaymentMethod | null, receivedCents: number | null, allowPending = false, discount: AppliedDiscount | null = null) {
  const { data, error } = await requireSupabase().rpc('close_restaurant_order_checked_v2', {
    p_order_id: orderId,
    p_payment_method: paymentMethod,
    p_received_cents: receivedCents,
    p_allow_pending: allowPending,
    p_discount: discount,
  })
  if (error) throw error
  return data as CloseRestaurantOrderResult
}

export async function cancelEmptyRestaurantOrder(orderId: string, expectedRevision: number) {
  const { data, error } = await requireSupabase().rpc('cancel_empty_restaurant_order', {
    p_order_id: orderId,
    p_expected_revision: expectedRevision,
  })
  if (error) throw error
  return Number(data)
}

export async function loadRestaurantEqualSplit(context: TenantContext, orderId: string): Promise<RestaurantEqualSplit | null> {
  const { data, error } = await requireSupabase().from('restaurant_order_equal_splits').select('*')
    .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('order_id', orderId).eq('status', 'open').maybeSingle()
  if (error) throw error
  return data ? mapEqualSplit(data) : null
}

export async function configureRestaurantEqualSplit(orderId: string, partCount: number, expectedRevision: number) {
  const { data, error } = await requireSupabase().rpc('configure_restaurant_order_equal_split', { p_order_id: orderId, p_part_count: partCount, p_expected_order_revision: expectedRevision })
  if (error) throw error
  return mapEqualSplit(data)
}

export async function payRestaurantEqualPart(splitId: string, paymentMethod: PaymentMethod, receivedCents: number | null, allowPending = false): Promise<PayRestaurantEqualPartResult> {
  const { data, error } = await requireSupabase().rpc('pay_restaurant_order_equal_part', { p_split_id: splitId, p_payment_method: paymentMethod, p_received_cents: receivedCents, p_allow_pending: allowPending })
  if (error) throw error
  const result = data as Record<string, unknown>
  return { ...result, requiresConfirmation: Boolean(result.requiresConfirmation), pendingUnits: Number(result.pendingUnits), split: mapEqualSplit(result.split) } as PayRestaurantEqualPartResult
}

export async function saveRestaurantOrderLines(detail: RestaurantOrderDetail): Promise<SaveRestaurantOrderLinesResult> {
  const { data, error } = await requireSupabase().rpc('save_restaurant_order_lines', {
    p_order_id: detail.order.id,
    p_expected_revision: detail.order.revision,
    p_lines: buildRestaurantOrderLinesPayload(detail),
  })
  if (error) throw error
  return data as SaveRestaurantOrderLinesResult
}

export async function markRestaurantOrderLineUnitsServed(lineId: string, units = 1) {
  const { error } = await requireSupabase().rpc('mark_order_line_units_served', { p_order_line_id: lineId, p_units: units })
  if (error) throw error
}

export async function markRestaurantOrderLineFullyServed(lineId: string) {
  const { error } = await requireSupabase().rpc('mark_order_line_fully_served', { p_order_line_id: lineId })
  if (error) throw error
}

export async function markRestaurantOrderFullyServed(orderId: string) {
  const { error } = await requireSupabase().rpc('mark_order_fully_served', { p_order_id: orderId })
  if (error) throw error
}

export async function loadRestaurantOrderPendingUnits(context: TenantContext, orderId: string) {
  const detail = await loadRestaurantOrder(context, orderId)
  return { detail, pendingUnits: getOrderPendingUnits(detail.lines) }
}

export async function loadOpenRestaurantOrders(context: TenantContext, cashSessionId?: string) {
  let query = requireSupabase().from('orders').select(orderColumns).eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('status', 'open').order('opened_at')
  if (cashSessionId) query = query.eq('cash_session_id', cashSessionId)
  const { data, error } = await query
  if (error) throw error
  return ((data ?? []) as OrderRow[]).map(mapOrder)
}

export function subscribeToRestaurantMap(
  context: TenantContext,
  onChange: () => void,
  onStatus?: (status: string, error?: Error) => void,
) {
  if (!supabase) return () => undefined
  const channel = supabase.channel(`restaurant-map:${context.tenantId}:${context.venueId}`)
  ;(['order_groups', 'orders', 'order_tables', 'order_lines', 'restaurant_order_equal_splits', 'restaurant_order_equal_split_payments'] as const).forEach((table) => channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `venue_id=eq.${context.venueId}` }, onChange))
  channel.subscribe((status, error) => onStatus?.(status, error))
  return () => { void supabase?.removeChannel(channel) }
}
