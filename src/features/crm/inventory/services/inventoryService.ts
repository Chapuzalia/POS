import type { TenantContext } from '../../../../types'
import { requireSupabase } from '../../shared/services/crmServiceSupport'
import { validateInventoryDecimalPlaces, validateInventoryName, validateInventoryUnitSymbol } from '../inventoryModel'
import type {
  InventoryDeviceWarehouse, InventoryItem, InventoryItemWarehouseRoute,
  InventoryProductionRecipe, InventoryProductionRecipeLine, InventoryRecipe,
  InventoryRecipeLine, InventorySnapshot, InventoryStockLevel, InventoryUnit,
  InventoryWarehouse, InventoryWarehouseRouting, InventoryWarehouseStockSummary,
  ModifierInventoryEffect,
} from '../types'

type DbRow = Record<string, unknown>
const number = (value: unknown) => Number(value)
const string = (value: unknown) => String(value ?? '')

function mapInventoryUnit(row: DbRow): InventoryUnit {
  return {
    id: string(row.id), tenantId: string(row.tenant_id), venueId: string(row.venue_id),
    name: string(row.name), symbol: string(row.symbol), decimalPlaces: number(row.decimal_places),
    contentQuantity: number(row.content_quantity), contentUnitId: string(row.content_unit_id),
    active: Boolean(row.is_active), sortOrder: number(row.sort_order),
    createdAt: string(row.created_at), updatedAt: string(row.updated_at),
  }
}

function mapInventoryWarehouse(row: DbRow): InventoryWarehouse {
  return {
    id: string(row.id), tenantId: string(row.tenant_id), venueId: string(row.venue_id),
    name: string(row.name), description: row.description == null ? null : string(row.description),
    active: Boolean(row.is_active), sortOrder: number(row.sort_order),
    createdAt: string(row.created_at), updatedAt: string(row.updated_at),
  }
}

function mapInventoryItem(row: DbRow): InventoryItem {
  return {
    id: string(row.id), tenantId: string(row.tenant_id), venueId: string(row.venue_id),
    name: string(row.name), description: string(row.description), baseUnitId: string(row.base_unit_id),
    referenceCost: row.reference_cost == null ? null : number(row.reference_cost),
    active: Boolean(row.is_active), createdAt: string(row.created_at), updatedAt: string(row.updated_at),
  }
}

async function rows(table: string, columns: string, context: Pick<TenantContext, 'tenantId'>, venueId: string) {
  const { data, error } = await requireSupabase().from(table).select(columns)
    .eq('tenant_id', context.tenantId).eq('venue_id', venueId)
  if (error) throw error
  return (data ?? []) as unknown as DbRow[]
}

export async function loadInventoryUnits(context: Pick<TenantContext, 'tenantId'>, venueId: string) {
  return (await rows('inventory_units', 'id, tenant_id, venue_id, name, symbol, decimal_places, content_quantity, content_unit_id, is_active, sort_order, created_at, updated_at', context, venueId))
    .map(mapInventoryUnit).toSorted((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'))
}

export async function createInventoryUnit(context: TenantContext, venueId: string, input: {
  name: string; symbol: string; decimalPlaces: number; contentQuantity: number; contentUnitId: string | null
}) {
  const name = validateInventoryName(input.name, 'de la unidad')
  const symbol = validateInventoryUnitSymbol(input.symbol)
  const decimalPlaces = validateInventoryDecimalPlaces(input.decimalPlaces)
  const unitId = crypto.randomUUID()
  const { error } = await requireSupabase().from('inventory_units').insert({
    id: unitId, tenant_id: context.tenantId, venue_id: venueId, name, symbol,
    decimal_places: decimalPlaces, content_quantity: input.contentQuantity,
    content_unit_id: input.contentUnitId ?? unitId, is_active: true, sort_order: 0,
  })
  if (error) throw error
}

export async function loadInventoryWarehouses(context: Pick<TenantContext, 'tenantId'>, venueId: string) {
  return (await rows('inventory_warehouses', 'id, tenant_id, venue_id, name, description, is_active, sort_order, created_at, updated_at', context, venueId))
    .map(mapInventoryWarehouse).toSorted((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'))
}

export async function createInventoryWarehouse(context: TenantContext, venueId: string, input: { name: string; description: string }) {
  const name = validateInventoryName(input.name, 'del almacén')
  const description = input.description.trim()
  if (description.length > 240) throw new Error('La descripción no puede superar 240 caracteres.')
  const { error } = await requireSupabase().from('inventory_warehouses').insert({
    tenant_id: context.tenantId, venue_id: venueId, name, description, is_active: true, sort_order: 0,
  })
  if (error) throw error
}

export async function loadInventorySnapshot(context: Pick<TenantContext, 'tenantId'>, venueId: string): Promise<InventorySnapshot> {
  const [units, warehouses, itemRows, routeRows, levelRows, recipeRows, recipeLineRows, effectRows, productionRows, productionLineRows] = await Promise.all([
    loadInventoryUnits(context, venueId), loadInventoryWarehouses(context, venueId),
    rows('inventory_items', 'id, tenant_id, venue_id, name, description, base_unit_id, reference_cost, is_active, created_at, updated_at', context, venueId),
    rows('inventory_item_warehouse_routes', 'inventory_item_id, warehouse_id, priority, is_enabled', context, venueId),
    rows('inventory_stock_levels', 'inventory_item_id, warehouse_id, quantity, is_enabled', context, venueId),
    rows('inventory_recipes', 'id, variant_id, mode, is_active', context, venueId),
    rows('inventory_recipe_lines', 'id, recipe_id, inventory_item_id, quantity, unit_id, uses_format_default, sort_order', context, venueId),
    rows('modifier_inventory_effects', 'id, modifier_id, operation, inventory_item_id, quantity, unit_id, sort_order', context, venueId),
    rows('inventory_production_recipes', 'id, inventory_item_id, production_warehouse_id, reference_quantity, reference_unit_id, is_active', context, venueId),
    rows('inventory_production_recipe_lines', 'id, recipe_id, inventory_item_id, quantity, unit_id, sort_order', context, venueId),
  ])
  return {
    units, warehouses, items: itemRows.map(mapInventoryItem),
    itemRoutes: routeRows.map<InventoryItemWarehouseRoute>((row) => ({
      inventoryItemId: string(row.inventory_item_id), warehouseId: string(row.warehouse_id),
      priority: number(row.priority), enabled: Boolean(row.is_enabled),
    })),
    levels: levelRows.map<InventoryStockLevel>((row) => ({
      inventoryItemId: string(row.inventory_item_id), warehouseId: string(row.warehouse_id),
      quantity: number(row.quantity), enabled: Boolean(row.is_enabled),
    })),
    recipes: recipeRows.map<InventoryRecipe>((row) => ({
      id: string(row.id), variantId: string(row.variant_id), mode: row.mode === 'direct' ? 'direct' : 'recipe', active: Boolean(row.is_active),
    })),
    recipeLines: recipeLineRows.map<InventoryRecipeLine>((row) => ({
      id: string(row.id), recipeId: string(row.recipe_id), inventoryItemId: string(row.inventory_item_id),
      quantity: row.quantity == null ? null : number(row.quantity), unitId: row.unit_id == null ? null : string(row.unit_id),
      usesFormatDefault: Boolean(row.uses_format_default), sortOrder: number(row.sort_order),
    })),
    modifierEffects: effectRows.map<ModifierInventoryEffect>((row) => ({
      id: string(row.id), modifierId: string(row.modifier_id), operation: row.operation === 'REMOVE' ? 'REMOVE' : 'ADD',
      inventoryItemId: string(row.inventory_item_id), quantity: row.quantity == null ? null : number(row.quantity),
      unitId: row.unit_id == null ? null : string(row.unit_id), sortOrder: number(row.sort_order),
    })),
    productionRecipes: productionRows.map<InventoryProductionRecipe>((row) => ({
      id: string(row.id), inventoryItemId: string(row.inventory_item_id), productionWarehouseId: string(row.production_warehouse_id),
      referenceQuantity: number(row.reference_quantity), referenceUnitId: string(row.reference_unit_id), active: Boolean(row.is_active),
    })),
    productionRecipeLines: productionLineRows.map<InventoryProductionRecipeLine>((row) => ({
      id: string(row.id), recipeId: string(row.recipe_id), inventoryItemId: string(row.inventory_item_id),
      quantity: number(row.quantity), unitId: string(row.unit_id), sortOrder: number(row.sort_order),
    })),
  }
}

export async function saveInventoryItem(venueId: string, input: {
  id?: string | null; name: string; description: string; baseUnitId: string; active: boolean
  routes: Array<{ warehouseId: string; priority: number; enabled: boolean }>
}) {
  const { data, error } = await requireSupabase().rpc('save_inventory_item', {
    p_venue_id: venueId, p_inventory_item_id: input.id ?? null, p_name: input.name,
    p_description: input.description, p_base_unit_id: input.baseUnitId, p_active: input.active,
    p_routes: input.routes.map((route) => ({ warehouseId: route.warehouseId, priority: route.priority, enabled: route.enabled })),
  })
  if (error) throw error
  return String(data)
}

export async function saveInventoryItemStock(context: TenantContext, venueId: string, inventoryItemId: string, levels: Array<{ enabled: boolean; warehouseId: string; quantity: number }>) {
  const { error } = await requireSupabase().rpc('set_inventory_item_stock', {
    p_tenant_id: context.tenantId, p_venue_id: venueId, p_inventory_item_id: inventoryItemId,
    p_levels: levels.map((level) => ({ enabled: level.enabled, warehouseId: level.warehouseId, quantity: level.quantity })),
  })
  if (error) throw error
}

export async function saveVariantInventoryRecipe(variantId: string, mode: 'none' | 'direct' | 'recipe', lines: Array<{
  inventoryItemId: string; quantity: number | null; unitId: string | null; usesFormatDefault: boolean; sortOrder: number
}>) {
  const { error } = await requireSupabase().rpc('save_variant_inventory_recipe', {
    p_variant_id: variantId, p_mode: mode, p_lines: lines.map((line) => ({
      inventoryItemId: line.inventoryItemId, quantity: line.quantity, unitId: line.unitId,
      usesFormatDefault: line.usesFormatDefault, sortOrder: line.sortOrder,
    })),
  })
  if (error) throw error
}

export async function saveModifierInventoryEffects(modifierId: string, effects: Array<{
  operation: 'ADD' | 'REMOVE'; inventoryItemId: string; quantity: number | null; unitId: string | null; sortOrder: number
}>) {
  const { error } = await requireSupabase().rpc('save_modifier_inventory_effects', {
    p_modifier_id: modifierId, p_effects: effects.map((effect) => ({
      operation: effect.operation, inventoryItemId: effect.inventoryItemId,
      quantity: effect.quantity, unitId: effect.unitId, sortOrder: effect.sortOrder,
    })),
  })
  if (error) throw error
}

export async function saveInventoryProductionRecipe(input: {
  inventoryItemId: string; productionWarehouseId: string; referenceQuantity: number; referenceUnitId: string; active: boolean
  lines: Array<{ inventoryItemId: string; quantity: number; unitId: string; sortOrder: number }>
}) {
  const { error } = await requireSupabase().rpc('save_inventory_production_recipe', {
    p_inventory_item_id: input.inventoryItemId, p_production_warehouse_id: input.productionWarehouseId,
    p_reference_quantity: input.referenceQuantity, p_reference_unit_id: input.referenceUnitId,
    p_active: input.active, p_lines: input.lines.map((line) => ({
      inventoryItemId: line.inventoryItemId, quantity: line.quantity, unitId: line.unitId, sortOrder: line.sortOrder,
    })),
  })
  if (error) throw error
}

export async function deleteInventoryWarehouse(context: TenantContext, venueId: string, warehouseId: string, targetWarehouseId: string | null) {
  const { data, error } = await requireSupabase().rpc('delete_inventory_warehouse', {
    p_tenant_id: context.tenantId, p_venue_id: venueId, p_warehouse_id: warehouseId, p_target_warehouse_id: targetWarehouseId,
  })
  if (error) throw error
  return Number(data ?? 0)
}

export async function loadInventoryWarehouseStockSummaries(context: TenantContext, venueId: string): Promise<InventoryWarehouseStockSummary[]> {
  const levels = await rows('inventory_stock_levels', 'warehouse_id, quantity', context, venueId)
  const counts = new Map<string, number>()
  for (const row of levels) {
    if (number(row.quantity) === 0) continue
    const warehouseId = string(row.warehouse_id)
    counts.set(warehouseId, (counts.get(warehouseId) ?? 0) + 1)
  }
  return [...counts].map(([warehouseId, nonZeroItemCount]) => ({ warehouseId, nonZeroItemCount }))
}

export async function loadInventoryWarehouseRouting(context: TenantContext, venueId: string): Promise<InventoryWarehouseRouting> {
  const client = requireSupabase()
  const [devicesResult, assignmentsResult] = await Promise.all([
    client.from('devices').select('id, name, is_active').eq('tenant_id', context.tenantId).eq('venue_id', venueId).order('name'),
    client.from('inventory_device_warehouses').select('device_id, warehouse_id, is_enabled, priority').eq('tenant_id', context.tenantId).eq('venue_id', venueId),
  ])
  if (devicesResult.error) throw devicesResult.error
  if (assignmentsResult.error) throw assignmentsResult.error
  return {
    devices: ((devicesResult.data ?? []) as DbRow[]).map((row) => ({ id: string(row.id), name: string(row.name), active: Boolean(row.is_active) })),
    assignments: ((assignmentsResult.data ?? []) as DbRow[]).map<InventoryDeviceWarehouse>((row) => ({
      deviceId: string(row.device_id), warehouseId: string(row.warehouse_id), enabled: Boolean(row.is_enabled), priority: number(row.priority),
    })),
  }
}

export async function saveInventoryDeviceWarehouses(context: TenantContext, venueId: string, deviceId: string, assignments: Array<{ enabled: boolean; priority: number; warehouseId: string }>) {
  const { error } = await requireSupabase().rpc('set_inventory_device_warehouses', {
    p_tenant_id: context.tenantId, p_venue_id: venueId, p_device_id: deviceId,
    p_assignments: assignments.map((assignment) => ({ enabled: assignment.enabled, priority: assignment.priority, warehouseId: assignment.warehouseId })),
  })
  if (error) throw error
}

export async function setVenueInventoryEnabled(venueId: string, enabled: boolean) {
  const { data, error } = await requireSupabase().rpc('set_venue_inventory_enabled', { p_venue_id: venueId, p_enabled: enabled })
  if (error) throw error
  return Boolean(data)
}
