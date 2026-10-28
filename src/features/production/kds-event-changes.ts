import type { KdsEvent } from './types'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function names(value: unknown) {
  const result = new Map<string, string>()
  if (!Array.isArray(value)) return result
  for (const entry of value) {
    const item = record(entry)
    const name = item?.name ?? item?.productName
    if (!item || typeof name !== 'string' || !name.trim()) continue
    const id = typeof item.id === 'string' ? item.id : name
    const group = typeof item.groupId === 'string' ? item.groupId : ''
    result.set(`${group}:${id}`, name)
  }
  return result
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function getKdsEventChanges(event: KdsEvent): string[] {
  if (event.event_type !== 'modified') return []
  const after = event.payload
  const before = record(after.previousState) ?? record(after.previousSnapshot)
  const changes: string[] = []
  for (const field of ['lineModifiers', 'componentModifiers', 'components']) {
    if (!before || !Object.hasOwn(before, field) || !Object.hasOwn(after, field)) continue
    const previous = names(before?.[field])
    const current = names(after[field])
    const added = [...current].filter(([id]) => !previous.has(id)).map(([, name]) => name)
    const removed = [...previous].filter(([id]) => !current.has(id)).map(([, name]) => name)
    if (added.length) changes.push(`Añadido: ${added.join(', ')}`)
    if (removed.length) changes.push(`Quitado: ${removed.join(', ')}`)
  }
  if (before && Object.hasOwn(after, 'variantName') && text(after.variantName) !== text(before.variantName)) {
    changes.push(`Variante: ${text(before.variantName) || 'sin variante'} → ${text(after.variantName) || 'sin variante'}`)
  }
  if (Object.hasOwn(after, 'note') && text(after.note) !== text(before?.note)) {
    changes.push(text(after.note) ? `Comentario: ${text(after.note)}` : 'Comentario eliminado')
  }
  return changes.length ? changes : [text(after.detail) || 'Pedido modificado']
}
