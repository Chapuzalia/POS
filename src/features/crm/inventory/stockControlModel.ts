import { normalizeText } from '../../../lib/format'
import { getEffectiveInventoryItemCost } from './inventoryModel'
import type { InventoryItem, InventorySnapshot, InventoryStockLevel, InventoryUnit, InventoryWarehouse } from './types'

export type StockState = 'negative' | 'replenish' | 'healthy' | 'no-target'
export type StockFilter = 'all' | StockState | 'valued' | 'unknown-cost' | 'controlled'
export type StockActivity = 'all' | 'active' | 'inactive'
export type StockRow = {
  key: string
  item: InventoryItem
  unit: InventoryUnit | undefined
  warehouse: InventoryWarehouse | undefined
  quantity: number
  target: number | null
  shortage: number
  state: StockState
  isPreparation: boolean
  controlled: boolean
  unitCost: number | null
  valueCents: number | null
}

export const stockStateLabels: Record<StockState, string> = {
  negative: 'Stock negativo',
  replenish: 'Por reponer',
  healthy: 'Dentro del objetivo',
  'no-target': 'Sin objetivo',
}

export function inventoryUnitCost(item: InventoryItem) {
  return getEffectiveInventoryItemCost(item)?.cost ?? null
}

export function stockState(quantity: number, target: number | null): StockState {
  if (quantity < 0) return 'negative'
  if (target === null) return 'no-target'
  return quantity < target ? 'replenish' : 'healthy'
}

export function stockCoverage(quantity: number, target: number | null) {
  if (target === null || target <= 0 || !Number.isFinite(quantity) || !Number.isFinite(target)) return null
  // Truncate to one decimal so 9.99% does not appear as a red 10%, nor
  // 59.99% as an orange 60%. Retain negative and above-target percentages.
  const scaled = quantity / target * 1000
  const percentage = Math.floor(scaled + Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2) / 10
  const tone = percentage < 10 ? 'red' : percentage < 60 ? 'orange' : 'green'
  return { percentage, tone } as const
}

export function buildStockRows(snapshot: InventorySnapshot): StockRow[] {
  const units = new Map(snapshot.units.map((unit) => [unit.id, unit]))
  const warehouses = new Map(snapshot.warehouses.map((warehouse) => [warehouse.id, warehouse]))
  const preparations = new Set(snapshot.productionRecipes.filter((recipe) => recipe.active).map((recipe) => recipe.inventoryItemId))
  const levels = new Map<string, Map<string, InventoryStockLevel>>()
  const routes = new Map<string, Set<string>>()
  for (const level of snapshot.levels) {
    const itemLevels = levels.get(level.inventoryItemId) ?? new Map()
    itemLevels.set(level.warehouseId, level)
    levels.set(level.inventoryItemId, itemLevels)
  }
  for (const route of snapshot.itemRoutes) {
    if (!route.enabled) continue
    const itemRoutes = routes.get(route.inventoryItemId) ?? new Set()
    itemRoutes.add(route.warehouseId)
    routes.set(route.inventoryItemId, itemRoutes)
  }
  return snapshot.items.flatMap((item): StockRow[] => {
    const itemLevels = levels.get(item.id) ?? new Map<string, InventoryStockLevel>()
    const itemRoutes = routes.get(item.id) ?? new Set<string>()
    const warehouseIds = new Set([...itemLevels.keys(), ...itemRoutes])
    const unitCost = inventoryUnitCost(item)
    const createRow = (warehouseId: string): StockRow => {
      const level = itemLevels.get(warehouseId)
      const warehouse = warehouses.get(warehouseId)
      const controlled = item.active && warehouse?.active === true && (level?.enabled ?? itemRoutes.has(warehouseId))
      const quantity = level?.quantity ?? 0
      const target = level?.targetQuantity ?? null
      return {
        key: `${item.id}:${warehouseId}`, item, warehouse, quantity, target,
        unit: units.get(item.baseUnitId),
        shortage: target === null ? 0 : Math.max(0, Number((target - quantity).toFixed(6))),
        state: stockState(quantity, target), isPreparation: preparations.has(item.id), controlled,
        unitCost, valueCents: unitCost === null ? null : Math.round(quantity * unitCost * 100),
      }
    }
    // Keep every article editable, including inactive zero-stock articles.
    // Omit unused legacy zero positions, but retain configured locations.
    const itemRows = [...warehouseIds].map(createRow).filter((row) => row.controlled || row.quantity !== 0 || itemRoutes.has(row.warehouse?.id ?? ''))
    return itemRows.length ? itemRows : [createRow('')]
  }).toSorted((a, b) => a.item.name.localeCompare(b.item.name, 'es') || (a.warehouse?.name ?? '').localeCompare(b.warehouse?.name ?? '', 'es'))
}

export function summarizeStock(rows: StockRow[]) {
  const controlled = rows.filter((row) => row.controlled)
  const itemIds = new Set(controlled.map((row) => row.item.id))
  const heldItemIds = new Set(rows.filter((row) => row.quantity !== 0).map((row) => row.item.id))
  const valuedItemIds = new Set(rows.filter((row) => row.quantity !== 0 && row.valueCents !== null).map((row) => row.item.id))
  return {
    controlledCount: itemIds.size,
    replenishCount: new Set(controlled.filter((row) => row.shortage > 0).map((row) => row.item.id)).size,
    negativeCount: new Set(rows.filter((row) => row.quantity < 0).map((row) => row.item.id)).size,
    valueCents: valuedItemIds.size ? rows.reduce((total, row) => total + (row.valueCents ?? 0), 0) : null,
    valuedCount: valuedItemIds.size,
    heldCount: heldItemIds.size,
    partial: valuedItemIds.size < heldItemIds.size,
  }
}

export function filterStockRows(rows: StockRow[], filter: StockFilter, query: string, warehouseId: string, kind: string, activity: StockActivity = 'all') {
  const search = normalizeText(query.trim())
  return rows.filter((row) => {
    if (activity === 'active' && !row.item.active || activity === 'inactive' && row.item.active) return false
    if (warehouseId && row.warehouse?.id !== warehouseId) return false
    if (kind === 'preparation' && !row.isPreparation || kind === 'item' && row.isPreparation) return false
    if (search && !normalizeText(`${row.item.name} ${row.warehouse?.name ?? ''}`).includes(search)) return false
    if (filter === 'replenish') return row.controlled && row.shortage > 0
    if (filter === 'controlled') return row.controlled
    if (filter === 'valued') return row.quantity !== 0 && row.valueCents !== null
    if (filter === 'unknown-cost') return row.quantity !== 0 && row.valueCents === null
    if (filter === 'healthy' || filter === 'negative' || filter === 'no-target') return row.state === filter
    return true
  })
}

export function replenishmentQuantities(levels: InventoryStockLevel[]) {
  const enabled = levels.filter((level) => level.enabled)
  const targets = enabled.filter((level) => level.targetQuantity !== null)
  return {
    stock: enabled.reduce((sum, level) => sum + level.quantity, 0),
    target: targets.reduce((sum, level) => sum + (level.targetQuantity ?? 0), 0),
    // A surplus in another warehouse must not conceal a local shortage.
    shortage: Number(targets.reduce((sum, level) => sum + Math.max(0, (level.targetQuantity ?? 0) - level.quantity), 0).toFixed(6)),
  }
}
