import type { TenantContext } from '../../../../types'
import { requireSupabase } from '../../shared/services/crmServiceSupport'
import {
  validateInventoryDecimalPlaces,
  validateInventoryName,
  validateInventoryUnitSymbol,
} from '../inventoryModel'
import type {
  InventoryProductSetting,
  InventorySnapshot,
  InventoryStockLevel,
  InventoryUnit,
  InventoryWarehouse,
} from '../types'

type InventoryUnitRow = {
  id: string
  tenant_id: string
  venue_id: string
  name: string
  symbol: string
  decimal_places: number
  content_quantity: number | string
  content_unit_id: string
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

type InventoryWarehouseRow = {
  id: string
  tenant_id: string
  venue_id: string
  name: string
  description: string | null
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

type InventoryProductSettingRow = {
  content_quantity: number | string
  content_unit_id: string
  product_id: string
  unit_id: string
}

type InventoryStockLevelRow = {
  product_id: string
  warehouse_id: string
  quantity: number | string
}

function mapInventoryUnit(row: InventoryUnitRow): InventoryUnit {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    venueId: row.venue_id,
    name: row.name,
    symbol: row.symbol,
    decimalPlaces: row.decimal_places,
    contentQuantity: Number(row.content_quantity),
    contentUnitId: row.content_unit_id,
    active: row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapInventoryWarehouse(row: InventoryWarehouseRow): InventoryWarehouse {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    venueId: row.venue_id,
    name: row.name,
    description: row.description,
    active: row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function loadInventoryUnits(context: Pick<TenantContext, 'tenantId'>, venueId: string) {
  const { data, error } = await requireSupabase()
    .from('inventory_units')
    .select('id, tenant_id, venue_id, name, symbol, decimal_places, content_quantity, content_unit_id, is_active, sort_order, created_at, updated_at')
    .eq('tenant_id', context.tenantId)
    .eq('venue_id', venueId)
    .order('sort_order')
    .order('name')
  if (error) throw error
  return ((data ?? []) as InventoryUnitRow[]).map(mapInventoryUnit)
}

export async function createInventoryUnit(
  context: TenantContext,
  venueId: string,
  input: {
    name: string
    symbol: string
    decimalPlaces: number
    contentQuantity: number
    contentUnitId: string | null
  },
) {
  const name = validateInventoryName(input.name, 'de la unidad')
  const symbol = validateInventoryUnitSymbol(input.symbol)
  const decimalPlaces = validateInventoryDecimalPlaces(input.decimalPlaces)
  const unitId = crypto.randomUUID()
  const { error } = await requireSupabase().from('inventory_units').insert({
    id: unitId,
    tenant_id: context.tenantId,
    venue_id: venueId,
    name,
    symbol,
    decimal_places: decimalPlaces,
    content_quantity: input.contentQuantity,
    content_unit_id: input.contentUnitId ?? unitId,
    is_active: true,
    sort_order: 0,
  })
  if (error) throw error
}

export async function loadInventoryWarehouses(context: TenantContext, venueId: string) {
  const { data, error } = await requireSupabase()
    .from('inventory_warehouses')
    .select('id, tenant_id, venue_id, name, description, is_active, sort_order, created_at, updated_at')
    .eq('tenant_id', context.tenantId)
    .eq('venue_id', venueId)
    .order('sort_order')
    .order('name')
  if (error) throw error
  return ((data ?? []) as InventoryWarehouseRow[]).map(mapInventoryWarehouse)
}

export async function createInventoryWarehouse(
  context: TenantContext,
  venueId: string,
  input: { name: string; description: string },
) {
  const name = validateInventoryName(input.name, 'del almacén')
  const description = input.description.trim()
  if (description.length > 240) throw new Error('La descripción no puede superar 240 caracteres.')
  const { error } = await requireSupabase().from('inventory_warehouses').insert({
    tenant_id: context.tenantId,
    venue_id: venueId,
    name,
    description,
    is_active: true,
    sort_order: 0,
  })
  if (error) throw error
}

export async function loadInventorySnapshot(context: TenantContext, venueId: string): Promise<InventorySnapshot> {
  const client = requireSupabase()
  const [units, warehouses, settingsResult, levelsResult] = await Promise.all([
    loadInventoryUnits(context, venueId),
    loadInventoryWarehouses(context, venueId),
    client.from('inventory_product_settings')
      .select('product_id, unit_id, content_quantity, content_unit_id')
      .eq('tenant_id', context.tenantId)
      .eq('venue_id', venueId),
    client.from('inventory_stock_levels')
      .select('product_id, warehouse_id, quantity')
      .eq('tenant_id', context.tenantId)
      .eq('venue_id', venueId),
  ])
  if (settingsResult.error) throw settingsResult.error
  if (levelsResult.error) throw levelsResult.error

  const settings = ((settingsResult.data ?? []) as InventoryProductSettingRow[]).map<InventoryProductSetting>((row) => ({
    contentQuantity: Number(row.content_quantity),
    contentUnitId: row.content_unit_id,
    productId: row.product_id,
    unitId: row.unit_id,
  }))
  const levels = ((levelsResult.data ?? []) as InventoryStockLevelRow[]).map<InventoryStockLevel>((row) => ({
    productId: row.product_id,
    warehouseId: row.warehouse_id,
    quantity: Number(row.quantity),
  }))
  return { levels, settings, units, warehouses }
}

export async function saveInventoryProductStock(
  context: TenantContext,
  venueId: string,
  productId: string,
  unitId: string,
  levels: Array<{ warehouseId: string; quantity: number }>,
) {
  const { error } = await requireSupabase().rpc('set_inventory_product_stock', {
    p_tenant_id: context.tenantId,
    p_venue_id: venueId,
    p_product_id: productId,
    p_unit_id: unitId,
    p_levels: levels.map((level) => ({
      warehouseId: level.warehouseId,
      quantity: level.quantity,
    })),
  })
  if (error) throw error
}
