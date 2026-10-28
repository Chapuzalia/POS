import { describe, expect, it } from 'vitest'
import { buildStockRows, filterStockRows, inventoryUnitCost, replenishmentQuantities, stockCoverage, stockState, summarizeStock } from '../../src/features/crm/inventory/stockControlModel'
import { consumptionComparison, inventoryHistoryPeriod, movementLabel, recordedStockSegments } from '../../src/features/crm/inventory/stockHistoryModel'
import type { InventoryItem, InventorySnapshot, InventoryStockMovement } from '../../src/features/crm/inventory/types'
import { createInventoryItemDraft, parseInventoryItemDraft } from '../../src/features/crm/inventory/inventoryItemEditorModel'
import { getSectionTitle, inventoryNavItems, inventorySections } from '../../src/features/crm/routing/crmNavigation'
import { buildInventoryStockTotalChanges } from '../../src/features/crm/inventory/inventoryModel'

const item: InventoryItem = { id: 'beer', tenantId: 'tenant', venueId: 'venue', name: 'Cerveza', description: '', baseUnitId: 'bottle', active: true, averageCost: 1.25, lastPurchaseCost: 2, referenceCost: 3, createdAt: '', updatedAt: '' }
export function stockFixture(): InventorySnapshot {
  return {
    items: [item, { ...item, id: 'oil', name: 'Aceite', averageCost: null, lastPurchaseCost: null, referenceCost: null }],
    warehouses: ['bar', 'store'].map((id) => ({ id, name: id === 'bar' ? 'Barra' : 'Almacén', tenantId: 'tenant', venueId: 'venue', active: true, description: null, sortOrder: 0, createdAt: '', updatedAt: '' })),
    units: [{ id: 'bottle', tenantId: 'tenant', venueId: 'venue', name: 'Botella', symbol: 'bot', active: true, decimalPlaces: 3, contentQuantity: 330, contentUnitId: 'ml', sortOrder: 0, createdAt: '', updatedAt: '' }],
    itemRoutes: [{ inventoryItemId: 'beer', warehouseId: 'bar', enabled: true, priority: 1 }, { inventoryItemId: 'beer', warehouseId: 'store', enabled: true, priority: 2 }],
    levels: [{ inventoryItemId: 'beer', warehouseId: 'bar', quantity: -2, targetQuantity: 12, enabled: true }, { inventoryItemId: 'beer', warehouseId: 'store', quantity: 100, targetQuantity: 24, enabled: true }, { inventoryItemId: 'oil', warehouseId: 'store', quantity: 2.125, targetQuantity: null, enabled: true }],
    productionRecipes: [], productionRecipeLines: [], modifierEffects: [], recipes: [], recipeLines: [],
  }
}

describe('inventory control uses physical stock and warehouse targets', () => {
  it('does not conceal local negatives or shortages behind a global surplus', () => {
    const snapshot = stockFixture()
    const rows = buildStockRows(snapshot)
    expect(rows).toHaveLength(3)
    const beerBar = rows.find((row) => row.key === 'beer:bar')
    expect(beerBar).toMatchObject({ quantity: -2, shortage: 14, state: 'negative', valueCents: -250 })
    expect(summarizeStock(rows)).toMatchObject({ controlledCount: 2, replenishCount: 1, negativeCount: 1, valueCents: 12250, partial: true, valuedCount: 1, heldCount: 2 })
    expect(replenishmentQuantities(snapshot.levels.filter((level) => level.inventoryItemId === 'beer'))).toEqual({ stock: 98, target: 36, shortage: 14 })
  })
  it('distinguishes no target from a configured zero without arbitrary thresholds', () => {
    expect(stockState(0, null)).toBe('no-target')
    expect(stockState(0, 0)).toBe('healthy')
    expect(stockState(0, 0.001)).toBe('replenish')
    expect(stockState(-0.001, null)).toBe('negative')
  })
  it('keeps known zero costs and preserves the existing persisted cost priority', () => {
    expect(inventoryUnitCost(item)).toBe(1.25)
    expect(inventoryUnitCost({ ...item, averageCost: 0 })).toBe(0)
    expect(inventoryUnitCost({ ...item, averageCost: null })).toBe(2)
    expect(inventoryUnitCost({ ...item, averageCost: null, lastPurchaseCost: null })).toBe(3)
    expect(inventoryUnitCost({ ...item, averageCost: null, lastPurchaseCost: null, referenceCost: null })).toBeNull()
  })
  it('retains nonzero disabled and inactive balances without counting them as active control', () => {
    const snapshot = stockFixture()
    snapshot.items[0] = { ...item, active: false }
    snapshot.levels[0].enabled = false
    const rows = buildStockRows(snapshot)
    expect(rows.find((row) => row.key === 'beer:bar')?.quantity).toBe(-2)
    expect(summarizeStock(rows)).toMatchObject({ controlledCount: 1, negativeCount: 1, replenishCount: 0 })
  })
  it('uses routes for zero balances and filters by name, warehouse, type and state', () => {
    const snapshot = stockFixture()
    snapshot.levels = snapshot.levels.filter((level) => level.warehouseId !== 'bar')
    snapshot.productionRecipes = [{ id: 'recipe', inventoryItemId: 'oil', productionWarehouseId: 'store', active: true, referenceQuantity: 1, referenceUnitId: 'bottle' }]
    const rows = buildStockRows(snapshot)
    expect(rows.find((row) => row.key === 'beer:bar')).toMatchObject({ quantity: 0, target: null, state: 'no-target' })
    expect(filterStockRows(rows, 'all', 'ALMACEN', 'store', 'preparation').map((row) => row.item.id)).toEqual(['oil'])
    expect(filterStockRows(rows, 'unknown-cost', '', '', '').map((row) => row.item.id)).toEqual(['oil'])
    expect(filterStockRows(rows, 'valued', '', '', '').map((row) => row.key)).toEqual(['beer:store'])
  })
  it('does not replace missing valuation with zero', () => {
    const rows = buildStockRows(stockFixture()).filter((row) => row.item.id === 'oil')
    expect(summarizeStock(rows)).toMatchObject({ valueCents: null, partial: true })
    expect(replenishmentQuantities([{ inventoryItemId: 'oil', warehouseId: 'bar', quantity: 0.1, targetQuantity: 0.3, enabled: true }]).shortage).toBe(0.2)
  })
  it('keeps an unrouted active article accessible without inventing a target or an alert', () => {
    const snapshot = stockFixture()
    snapshot.levels = []
    snapshot.itemRoutes = []
    const rows = buildStockRows(snapshot)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.warehouse === undefined && row.quantity === 0 && row.state === 'no-target')).toBe(true)
    expect(summarizeStock(rows)).toMatchObject({ controlledCount: 0, replenishCount: 0, negativeCount: 0 })
  })
})

describe('article configuration in the unified stock view', () => {
  it('offers one navigation entry and keeps the legacy section identifiable', () => {
    expect(inventoryNavItems.filter((entry) => entry.id === 'inventory-stock')).toHaveLength(1)
    expect(inventoryNavItems.some((entry) => entry.id === 'inventory-items')).toBe(false)
    expect(inventorySections.has('inventory-items')).toBe(true)
    expect(getSectionTitle('inventory-items')).toBe(getSectionTitle('inventory-stock'))
  })
  it('starts a new article in the first active warehouse with no invented objective', () => {
    const snapshot = stockFixture()
    snapshot.warehouses[0].active = false
    const draft = createInventoryItemDraft(snapshot, null)
    expect(draft).toMatchObject({ id: null, active: true, baseUnitId: 'bottle', routes: { bar: { enabled: false }, store: { enabled: true, targetQuantity: '' } } })
    draft.name = 'Nuevo ingrediente'
    expect(parseInventoryItemDraft(draft, snapshot).routes).toEqual([{ warehouseId: 'store', enabled: true, priority: 2, targetQuantity: null }])
  })
  it('loads article fields and existing objectives without changing physical balances', () => {
    const snapshot = stockFixture()
    const draft = createInventoryItemDraft(snapshot, { ...item, description: 'Bebida fría' })
    draft.name = 'Cerveza de barril'
    draft.description = 'Conservar en frío'
    draft.active = false
    draft.routes.bar.targetQuantity = '24,125'
    draft.routes.bar.priority = '2'
    draft.routes.store.priority = '1'
    const parsed = parseInventoryItemDraft(draft, snapshot)
    expect(parsed).toMatchObject({ id: 'beer', name: 'Cerveza de barril', description: 'Conservar en frío', active: false, routes: [{ warehouseId: 'bar', targetQuantity: 24.125, priority: 2 }, { warehouseId: 'store', priority: 1 }] })
    expect(parsed.routes.every((route) => !('quantity' in route))).toBe(true)
    expect(snapshot.levels[0].quantity).toBe(-2)
  })
  it('explicitly disables removed locations and preserves their target without sending a zero balance', () => {
    const snapshot = stockFixture()
    const draft = createInventoryItemDraft(snapshot, item)
    draft.routes.bar.enabled = false
    expect(parseInventoryItemDraft(draft, snapshot).routes[0]).toEqual({ warehouseId: 'bar', enabled: false, priority: 1, targetQuantity: 12 })
    expect(snapshot.levels[0].quantity).toBe(-2)
  })
  it('validates distinct route priorities, configured unit precision and required fields', () => {
    const snapshot = stockFixture()
    const draft = createInventoryItemDraft(snapshot, item)
    draft.routes.bar.priority = '2'
    expect(() => parseInventoryItemDraft(draft, snapshot)).toThrow('prioridades')
    draft.routes.bar.priority = '1'
    draft.routes.bar.targetQuantity = '1.0001'
    expect(() => parseInventoryItemDraft(draft, snapshot)).toThrow('3 decimales')
    draft.routes.bar.targetQuantity = '-1'
    expect(() => parseInventoryItemDraft(draft, snapshot)).toThrow()
    draft.routes.bar.targetQuantity = '0'
    expect(parseInventoryItemDraft(draft, snapshot).routes[0].targetQuantity).toBe(0)
    draft.routes.bar.enabled = false
    draft.routes.store.enabled = false
    expect(() => parseInventoryItemDraft(draft, snapshot)).toThrow('al menos un almacén')
  })
  it('keeps the base unit fixed while any warehouse has stock, including negative stock', () => {
    const snapshot = stockFixture()
    snapshot.units.push({ ...snapshot.units[0], id: 'litre', name: 'Litro', symbol: 'l' })
    const draft = createInventoryItemDraft(snapshot, item)
    draft.baseUnitId = 'litre'
    expect(() => parseInventoryItemDraft(draft, snapshot)).toThrow('existencias')
    snapshot.levels.filter((level) => level.inventoryItemId === item.id).forEach((level) => { level.quantity = 0 })
    expect(parseInventoryItemDraft(draft, snapshot).baseUnitId).toBe('litre')
  })
  it('keeps inactive zero-stock articles discoverable and filterable for reactivation', () => {
    const snapshot = stockFixture()
    snapshot.items[0] = { ...item, active: false }
    snapshot.levels = []
    snapshot.itemRoutes = []
    const rows = buildStockRows(snapshot)
    expect(filterStockRows(rows, 'all', '', '', '', 'inactive').map((row) => row.item.id)).toEqual(['beer'])
    expect(filterStockRows(rows, 'all', '', '', '', 'active').map((row) => row.item.id)).toEqual(['oil'])
    expect(summarizeStock(rows)).toMatchObject({ controlledCount: 0, negativeCount: 0, replenishCount: 0 })
  })
})

describe('manual stock totals', () => {
  const current = [{ warehouseId: 'bar', quantity: -0.14 }, { warehouseId: 'store', quantity: 100 }]
  it('does not write unchanged or untouched warehouses', () => {
    expect(buildInventoryStockTotalChanges(current, { bar: '-0,14', store: '100' }, 2)).toEqual([])
    expect(buildInventoryStockTotalChanges(current, { bar: '3,25' }, 2)).toEqual([{ warehouseId: 'bar', quantity: 3.25, expectedQuantity: -0.14, enabled: true }])
  })
  it('preserves negative totals and requires a valid quantity with the configured precision', () => {
    expect(buildInventoryStockTotalChanges(current, { bar: '-1,25' }, 2)[0]).toMatchObject({ quantity: -1.25, expectedQuantity: -0.14 })
    expect(() => buildInventoryStockTotalChanges(current, { bar: '' }, 2)).toThrow()
    expect(() => buildInventoryStockTotalChanges(current, { bar: '1.001' }, 2)).toThrow('2 decimales')
  })
})

describe('stock table percentage scale', () => {
  it('uses red below 10, orange below 60, and green from 60 percent', () => {
    expect(stockCoverage(9.99, 100)).toEqual({ percentage: 9.9, tone: 'red' })
    expect(stockCoverage(10, 100)).toEqual({ percentage: 10, tone: 'orange' })
    expect(stockCoverage(59.99, 100)).toEqual({ percentage: 59.9, tone: 'orange' })
    expect(stockCoverage(60, 100)).toEqual({ percentage: 60, tone: 'green' })
    expect(stockCoverage(61, 100)).toEqual({ percentage: 61, tone: 'green' })
    expect(stockCoverage(0.3, 3)).toEqual({ percentage: 10, tone: 'orange' })
    expect(stockCoverage(1.8, 3)).toEqual({ percentage: 60, tone: 'green' })
  })
  it('retains negative and above-target stock without inventing a percentage for missing or zero targets', () => {
    expect(stockCoverage(-0.14, 2)).toEqual({ percentage: -7, tone: 'red' })
    expect(stockCoverage(-18, 48)).toEqual({ percentage: -37.5, tone: 'red' })
    expect(stockCoverage(24, 12)).toEqual({ percentage: 200, tone: 'green' })
    expect(stockCoverage(0, 12)).toEqual({ percentage: 0, tone: 'red' })
    expect(stockCoverage(3, null)).toBeNull()
    expect(stockCoverage(3, 0)).toBeNull()
  })
})

const movement = (patch: Partial<InventoryStockMovement> = {}): InventoryStockMovement => ({ id: '1', createdAt: '2026-10-27T10:00:00Z', warehouseId: 'bar', unitId: 'bottle', sourceType: 'sale_aggregate', sourceId: 'line', ticketLineId: 'line', productionId: null, before: 12, delta: -2, after: 10, ...patch })

describe('inventory history preserves provenance and operational time', () => {
  it('uses full operational days through the daylight saving change', () => {
    const period = inventoryHistoryPeriod(7, { dayChangeTime: '04:00', timeZone: 'Europe/Madrid' }, new Date('2026-10-28T02:30:00Z'))
    expect(period.today).toBe('2026-10-27')
    expect(period.currentStartDay).toBe('2026-10-20')
    expect(period.currentStartIso).toBe('2026-10-20T02:00:00.000Z')
    expect(period.endIso).toBe('2026-10-27T03:00:00.000Z')
  })
  it('suppresses misleading comparisons when consumption has failures or unit gaps', () => {
    const report = { daily: [{ day: '2026-10-13', quantity: 10 }, { day: '2026-10-21', quantity: 20 }], failureCount: 0, incompatibleCount: 0 }
    expect(consumptionComparison(report, '2026-10-20', '2026-10-27')).toEqual({ current: 20, previous: 10, percent: 100 })
    expect(consumptionComparison({ ...report, failureCount: 1 }, '2026-10-20', '2026-10-27').percent).toBeNull()
    expect(consumptionComparison({ ...report, incompatibleCount: 1 }, '2026-10-20', '2026-10-27').percent).toBeNull()
  })
  it('only labels verified sale consumption as sales', () => {
    expect(movementLabel(movement())).toBe('Consumo asociado a ventas')
    expect(movementLabel(movement({ ticketLineId: null }))).toBe('Otro movimiento')
    expect(movementLabel(movement({ sourceType: 'production_ingredient' }))).toBe('Consumo para elaboración')
    expect(movementLabel(movement({ sourceType: 'supplier_document_correction' }))).toBe('Corrección de compra')
  })
  it('breaks chart lines at unrecorded changes, equal timestamps and incompatible units', () => {
    const points = [movement(), movement({ id: '2', createdAt: '2026-10-27T11:00:00Z', before: 10, after: 8 }), movement({ id: '3', createdAt: '2026-10-27T12:00:00Z', before: 15, after: 13 }), movement({ id: '4', createdAt: '2026-10-27T12:00:00Z', before: 13, after: 11 }), movement({ id: '5', unitId: 'ml' })]
    expect(recordedStockSegments(points.slice(0, 4), 'bar', 'bottle').map((segment) => segment.length)).toEqual([2, 1, 1])
    expect(recordedStockSegments(points, 'bar', 'bottle').map((segment) => segment.length)).toEqual([1, 1, 1, 1])
    expect(recordedStockSegments(points, 'store', 'bottle')).toEqual([])
  })
})
