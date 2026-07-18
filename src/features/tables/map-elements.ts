import type { RestaurantMapElement, RestaurantMapElementKind } from './types'

const kinds = new Set<RestaurantMapElementKind>(['wall', 'column', 'text'])

export function createMapElement(kind: RestaurantMapElementKind, index: number): RestaurantMapElement {
  const offset = Math.min(20, index * 2)
  if (kind === 'wall') return { id: crypto.randomUUID(), kind, positionX: 10 + offset, positionY: 12 + offset, width: 30, height: 2, text: '' }
  if (kind === 'column') return { id: crypto.randomUUID(), kind, positionX: 20 + offset, positionY: 20 + offset, width: 7, height: 7, text: '' }
  return { id: crypto.randomUUID(), kind, positionX: 30 + offset, positionY: 10 + offset, width: 24, height: 6, text: 'Entrada' }
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function normalizeMapElements(value: unknown): RestaurantMapElement[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const item = candidate as Partial<RestaurantMapElement>
    if (typeof item.id !== 'string' || !kinds.has(item.kind as RestaurantMapElementKind)) return []
    const width = Math.max(1, Math.min(100, finiteNumber(item.width, 10)))
    const height = Math.max(1, Math.min(100, finiteNumber(item.height, 5)))
    return [{
      id: item.id,
      kind: item.kind as RestaurantMapElementKind,
      positionX: Math.max(0, Math.min(100 - width, finiteNumber(item.positionX, 0))),
      positionY: Math.max(0, Math.min(100 - height, finiteNumber(item.positionY, 0))),
      width,
      height,
      text: typeof item.text === 'string' ? item.text.slice(0, 120) : '',
    }]
  }).slice(0, 250)
}
