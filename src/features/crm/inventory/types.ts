export type InventoryUnit = {
  id: string
  tenantId: string
  venueId: string
  name: string
  symbol: string
  decimalPlaces: number
  contentQuantity: number
  contentUnitId: string
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type InventoryWarehouse = {
  id: string
  tenantId: string
  venueId: string
  name: string
  description: string | null
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type InventoryItem = {
  id: string
  tenantId: string
  venueId: string
  name: string
  description: string
  baseUnitId: string
  referenceCost: number | null
  lastPurchaseCost: number | null
  averageCost: number | null
  active: boolean
  createdAt: string
  updatedAt: string
}

export type InventoryItemWarehouseRoute = {
  inventoryItemId: string
  warehouseId: string
  priority: number
  enabled: boolean
}

export type InventoryStockLevel = {
  enabled: boolean
  inventoryItemId: string
  warehouseId: string
  quantity: number
}

export type InventoryRecipe = {
  id: string
  variantId: string
  mode: 'direct' | 'recipe'
  active: boolean
}

export type InventoryRecipeLine = {
  id: string
  recipeId: string
  inventoryItemId: string
  quantity: number | null
  unitId: string | null
  usesFormatDefault: boolean
  sortOrder: number
}

export type ModifierInventoryEffect = {
  id: string
  modifierId: string
  operation: 'ADD' | 'REMOVE'
  inventoryItemId: string
  quantity: number | null
  unitId: string | null
  sortOrder: number
}

export type InventoryProductionRecipe = {
  id: string
  inventoryItemId: string
  productionWarehouseId: string
  referenceQuantity: number
  referenceUnitId: string
  active: boolean
}

export type InventoryProductionRecipeLine = {
  id: string
  recipeId: string
  inventoryItemId: string
  quantity: number
  unitId: string
  sortOrder: number
}

export type InventoryWarehouseStockSummary = {
  nonZeroItemCount: number
  warehouseId: string
}

export type InventoryDevice = { active: boolean; id: string; name: string }

export type InventoryDeviceWarehouse = {
  deviceId: string
  enabled: boolean
  priority: number
  warehouseId: string
}

export type InventoryWarehouseRouting = {
  assignments: InventoryDeviceWarehouse[]
  devices: InventoryDevice[]
}

export type InventorySnapshot = {
  items: InventoryItem[]
  itemRoutes: InventoryItemWarehouseRoute[]
  levels: InventoryStockLevel[]
  modifierEffects: ModifierInventoryEffect[]
  productionRecipeLines: InventoryProductionRecipeLine[]
  productionRecipes: InventoryProductionRecipe[]
  recipeLines: InventoryRecipeLine[]
  recipes: InventoryRecipe[]
  units: InventoryUnit[]
  warehouses: InventoryWarehouse[]
}
