import type { CatalogData } from '../catalog/domain/types.ts'
import { resolveSellableProduct } from '../catalog/domain/resolver.ts'
import type { ProductionEntry } from '../production/types.ts'
import type { RestaurantOrderLine } from './types.ts'

export function isMenuOrderLine(line: Pick<RestaurantOrderLine, 'catalogSnapshot' | 'components'>) {
  return line.catalogSnapshot?.productType === 'menu' || Boolean(line.components?.some((component) => component.type === 'menu_component'))
}

export function getMenuCourseGroups(line: RestaurantOrderLine, catalog?: CatalogData | null) {
  const legacyGroups = () => [...new Set(line.components.map((component) => component.selectionGroupId ?? component.id))].map((id) => ({
    id, name: line.components.find((component) => (component.selectionGroupId ?? component.id) === id)?.selectionGroupName ?? '', remaining: 0,
    components: line.components.filter((component) => (component.selectionGroupId ?? component.id) === id),
  }))
  if (!catalog || !line.productId || !line.variantId) return legacyGroups()
  try {
    const groups = resolveSellableProduct(catalog, line.productId, line.variantId).selectionGroups.flatMap((group) => {
      if (group.group.type !== 'menu_component') return []
      const components = line.components.filter((component) => component.selectionGroupId === group.group.id)
      const chosen = components.reduce((sum, component) => sum + component.quantity, 0)
      const remaining = Math.max(0, group.assignment.minSelection - chosen)
      return [{ id: group.group.id, name: group.assignment.displayName ?? group.group.name, remaining, components }]
    })
    const known = new Set(groups.map((group) => group.id))
    return [...groups, ...legacyGroups().filter((group) => !known.has(group.id))]
  } catch { return legacyGroups() }
}

export function getMenuCourseService(line: Pick<RestaurantOrderLine, 'quantity' | 'servedQuantity'>, entry?: ProductionEntry, productionEnabled = false) {
  const served = Math.min(line.quantity, Math.max(line.servedQuantity, entry?.servedQuantity ?? 0))
  const pending = Math.max(0, line.quantity - served)
  const unsent = entry ? Math.min(pending, Math.max(0, line.quantity - Math.max(served, entry.sentQuantity + (entry.skippedQuantity ?? 0)))) : pending
  const ready = Math.min(pending, entry?.readyQuantity ?? 0)
  const action = pending === 0 ? null : ready > 0 ? 'serve' : productionEnabled && entry?.hasProductionDestination && unsent > 0 ? 'send' : 'serve'
  const status = pending === 0 ? 'Servido' : ready > 0 ? 'Listo' : productionEnabled && entry?.hasProductionDestination && unsent < pending ? 'En cocina' : ''
  const serveQuantity = Math.min(1, pending, ready > 0 ? ready : pending)
  return { served, pending, unsent, ready, serveQuantity, action, status }
}

export function isMenuServiceComplete(line: RestaurantOrderLine, entries: ProductionEntry[], missingChoices: number) {
  if (line.servedQuantity >= line.quantity) return true
  return missingChoices === 0 && line.components.length > 0 && line.components.every((component) =>
    getMenuCourseService(line, entries.find((entry) => entry.componentId === component.id)).pending === 0)
}
