import type { AssistConfiguration, AssistOrder, AssistSnapshot } from './types.ts'

export type AssistAllocation = { current_order_line_id: string; ready_quantity: number; quantity?: number; cancelled_quantity?: number; created_at?: string; updated_at?: string }
export function buildAssistSnapshot(configuration: AssistConfiguration,
  orders: Array<{ id: string; orderGroupId: string; status: string; openedAt: string; updatedAt: string; guestCount: number }>,
  lines: Array<{ id: string; orderId: string; servedQuantity: number }>,
  tables: Array<{ orderId: string | null; name: string; areaId: string }>,
  allocations: AssistAllocation[], observedAt: string, contextKey = ''): AssistSnapshot {
  const active = new Map<string, AssistOrder>()
  const tableByOrder = new Map(tables.filter((table) => table.orderId).map((table) => [table.orderId, table]))
  const tableByGroup = new Map<string, (typeof tables)[number]>()
  for (const order of orders) { const table = tableByOrder.get(order.id); if (table) tableByGroup.set(order.orderGroupId, table) }
  for (const order of orders) {
    if (order.status !== 'open') continue
    const table = tableByOrder.get(order.id)
    const groupTable = table ?? tableByGroup.get(order.orderGroupId)
    active.set(order.id, { id: order.id, groupId: order.orderGroupId, tableName: groupTable?.name ? `Mesa ${groupTable.name}` : 'Comanda',
      zoneId: groupTable?.areaId ?? null, openedAt: order.openedAt, updatedAt: order.updatedAt, guests: order.guestCount,
      lineCount: 0, pendingUnits: 0, readyUnits: 0, oldestPendingAt: null, readyAt: null })
  }
  const lineById = new Map(lines.map((line) => [line.id, line]))
  const readyByLine = new Map<string, { quantity: number; at: string | null }>()
  const pendingTimes = new Map<string, { sentSum: number; units: number }>()
  for (const line of lines) { const order = active.get(line.orderId); if (order) order.lineCount++ }
  for (const allocation of allocations) {
    const line = lineById.get(allocation.current_order_line_id)
    const order = line ? active.get(line.orderId) : undefined
    if (!order || !line) continue
    const pending = Math.max(0, Number(allocation.quantity ?? 0) - Number(allocation.ready_quantity) - Number(allocation.cancelled_quantity ?? 0))
    order.pendingUnits += pending
    if (pending && allocation.created_at && (!order.oldestPendingAt || allocation.created_at < order.oldestPendingAt)) order.oldestPendingAt = allocation.created_at
    const sentAt = Date.parse(allocation.created_at ?? '')
    if (pending && Number.isFinite(sentAt) && sentAt <= Date.parse(observedAt)) {
      const times = pendingTimes.get(order.id) ?? { sentSum: 0, units: 0 }
      times.sentSum += sentAt * pending; times.units += pending
      pendingTimes.set(order.id, times)
    }
    const ready = readyByLine.get(line.id) ?? { quantity: 0, at: null }
    ready.quantity += Number(allocation.ready_quantity)
    if (allocation.ready_quantity > 0 && allocation.updated_at && (!ready.at || allocation.updated_at > ready.at)) ready.at = allocation.updated_at
    readyByLine.set(line.id, ready)
  }
  for (const [id, times] of pendingTimes) {
    const order = active.get(id)
    if (order) { order.averagePendingAt = new Date(times.sentSum / times.units).toISOString(); order.timedPendingUnits = times.units }
  }
  for (const [id, ready] of readyByLine) {
    const line = lineById.get(id)
    const order = line ? active.get(line.orderId) : undefined
    if (!order || !line) continue
    const remaining = Math.max(0, ready.quantity - line.servedQuantity)
    order.readyUnits += remaining
    if (remaining && ready.at && (!order.readyAt || ready.at > order.readyAt)) order.readyAt = ready.at
  }
  return { configuration, orders: [...active.values()], observedAt, contextKey }
}
