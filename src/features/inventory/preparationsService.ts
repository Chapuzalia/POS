import { supabase } from '../../lib/supabase'

export type InventoryPreparation = {
  inventoryItemId: string
  name: string
  availableStock: number
  unitId: string
  unitSymbol: string
  warehouseId: string
  warehouseName: string
  referenceQuantity: number
  referenceUnitId: string
  referenceUnitSymbol: string
}

export type InventoryPreparationPreview = {
  inventoryItemId: string
  name: string
  quantity: number
  unitId: string
  stockQuantity: number
  warehouseId: string
  warehouseName: string
  factor: number
  ingredients: Array<{
    inventoryItemId: string
    name: string
    quantity: number
    unitId: string
    unitSymbol: string
    availableStock: number
    sufficient: boolean
  }>
}

function client() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

export async function loadInventoryPreparations(venueId: string) {
  const { data, error } = await client().rpc('list_inventory_preparations', { p_venue_id: venueId })
  if (error) throw error
  return (Array.isArray(data) ? data : []) as InventoryPreparation[]
}

export async function previewInventoryPreparation(inventoryItemId: string, quantity: number, unitId: string) {
  const { data, error } = await client().rpc('preview_inventory_production', {
    p_inventory_item_id: inventoryItemId, p_quantity: quantity, p_unit_id: unitId,
  })
  if (error) throw error
  return data as InventoryPreparationPreview
}

export async function recordInventoryPreparation(input: { inventoryItemId: string; quantity: number; unitId: string; deviceId: string; requestId: string }) {
  const { data, error } = await client().rpc('record_inventory_production', {
    p_inventory_item_id: input.inventoryItemId, p_quantity: input.quantity,
    p_unit_id: input.unitId, p_device_id: input.deviceId, p_request_id: input.requestId,
  })
  if (error) throw error
  return data as { productionId: string; duplicate: boolean; preview?: InventoryPreparationPreview }
}
