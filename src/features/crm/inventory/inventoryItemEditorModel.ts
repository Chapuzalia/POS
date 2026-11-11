import { parseInventoryQuantity } from './inventoryModel'
import type { InventoryStockPageData } from './services/inventoryService'
import type { InventoryItem } from './types'

export type InventoryItemDraft = {
  id: string | null
  name: string
  description: string
  baseUnitId: string
  active: boolean
  routes: Record<string, { enabled: boolean; priority: string; targetQuantity: string }>
}

export function createInventoryItemDraft(snapshot: InventoryStockPageData, item: InventoryItem | null): InventoryItemDraft {
  const defaultWarehouseId = snapshot.warehouses.find((warehouse) => warehouse.active)?.id
  return {
    id: item?.id ?? null,
    name: item?.name ?? '',
    description: item?.description ?? '',
    baseUnitId: item?.baseUnitId ?? snapshot.units.find((unit) => unit.active)?.id ?? '',
    active: item?.active ?? true,
    routes: Object.fromEntries(snapshot.warehouses.map((warehouse, index) => {
      const route = snapshot.itemRoutes.find((candidate) => candidate.inventoryItemId === item?.id && candidate.warehouseId === warehouse.id)
      const level = snapshot.levels.find((candidate) => candidate.inventoryItemId === item?.id && candidate.warehouseId === warehouse.id)
      return [warehouse.id, {
        enabled: route?.enabled ?? (!item && warehouse.id === defaultWarehouseId),
        priority: String(route?.priority ?? index + 1),
        targetQuantity: level?.targetQuantity == null ? '' : String(level.targetQuantity),
      }]
    })),
  }
}

export function parseInventoryItemDraft(draft: InventoryItemDraft, snapshot: InventoryStockPageData) {
  const unit = snapshot.units.find((candidate) => candidate.id === draft.baseUnitId)
  const enabled = snapshot.warehouses.filter((warehouse) => draft.routes[warehouse.id]?.enabled)
  if (!draft.name.trim() || !unit || !enabled.length) throw new Error('Indica nombre, unidad y al menos un almacén.')
  if (draft.name.trim().length > 120 || draft.description.length > 500) throw new Error('Revisa la longitud del nombre y la descripción.')
  const currentItem = snapshot.items.find((item) => item.id === draft.id)
  if (!unit.active && currentItem?.baseUnitId !== unit.id) throw new Error('Selecciona una unidad física activa.')
  if (currentItem && currentItem.baseUnitId !== unit.id && snapshot.levels.some((level) => level.inventoryItemId === draft.id && level.quantity !== 0)) {
    throw new Error('Para cambiar la unidad física, todas las existencias del artículo deben estar a cero.')
  }
  const priorities = enabled.map((warehouse) => Number(draft.routes[warehouse.id].priority))
  if (priorities.some((priority) => !Number.isInteger(priority) || priority < 1 || priority > 9999) || new Set(priorities).size !== priorities.length) {
    throw new Error('Las prioridades activas deben ser enteros diferentes entre 1 y 9999.')
  }
  const routes = snapshot.warehouses.flatMap((warehouse) => {
    const route = draft.routes[warehouse.id]
    const previousRoute = snapshot.itemRoutes.find((candidate) => candidate.inventoryItemId === draft.id && candidate.warehouseId === warehouse.id)
    const previousLevel = snapshot.levels.find((candidate) => candidate.inventoryItemId === draft.id && candidate.warehouseId === warehouse.id)
    if (!route?.enabled && !previousRoute && !previousLevel) return []
    return [{
      warehouseId: warehouse.id,
      enabled: route?.enabled ?? false,
      priority: route?.enabled ? Number(route.priority) : previousRoute?.priority ?? 1,
      // Explicitly disable removed locations through the existing atomic RPC;
      // keep their target and balance rather than leaving an enabled orphan level.
      targetQuantity: route?.enabled
        ? route.targetQuantity.trim() ? parseInventoryQuantity(route.targetQuantity, unit.decimalPlaces) : null
        : previousLevel?.targetQuantity ?? null,
    }]
  })
  return { id: draft.id, name: draft.name.trim(), description: draft.description.trim(), baseUnitId: unit.id, active: draft.active, routes }
}
