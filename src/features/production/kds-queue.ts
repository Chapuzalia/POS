import type { KdsItem } from './types'

export type KdsColumn = 'new' | 'preparing' | 'completed'
export const kdsColumns: Array<{ id: KdsColumn; label: string; status: string }> = [
  { id: 'new', label: 'Nuevos pedidos', status: 'Enviado' },
  { id: 'preparing', label: 'En preparación', status: 'En preparación' },
  { id: 'completed', label: 'Completados', status: 'Pendiente de servir' },
]

export function getKdsRemainingQuantity(item: KdsItem) {
  return Math.max(0, Math.round((item.quantity - item.readyQuantity - item.cancelledQuantity) * 1000) / 1000)
}

export function getKdsUnservedQuantity(item: KdsItem) {
  return Math.max(0, Math.round((item.quantity - item.cancelledQuantity - (item.servedQuantity ?? 0)) * 1000) / 1000)
}

export function groupKdsItems(items: KdsItem[]) {
  const groups = new Map<string, { id: string; orderId: string; tableName: string; sequence: number; sentAt: string; items: KdsItem[] }>()
  for (const item of items) {
    if (item.quantity <= item.cancelledQuantity) continue
    const key = `${item.orderId}:${item.batchId}`
    const group = groups.get(key)
    if (group) {
      group.items.push(item)
      if (item.sentAt < group.sentAt) group.sentAt = item.sentAt
    } else {
      groups.set(key, { id: key, orderId: item.orderId, tableName: item.tableName, sequence: item.batchSequence, sentAt: item.sentAt, items: [item] })
    }
  }
  return [...groups.values()]
    .filter((group) => group.items.some((item) => getKdsUnservedQuantity(item) > 0))
    .map((group) => ({ ...group, column: group.items.every((item) => getKdsRemainingQuantity(item) <= 0 || getKdsUnservedQuantity(item) <= 0)
      ? 'completed' as const
      : group.items.some((item) => item.acceptedAt || item.readyQuantity > 0) ? 'preparing' as const : 'new' as const }))
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.sequence - b.sequence || a.id.localeCompare(b.id))
}
