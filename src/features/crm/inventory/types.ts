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

export type InventoryProductSetting = {
  contentQuantity: number
  contentUnitId: string
  productId: string
  unitId: string
}

export type InventoryStockLevel = {
  productId: string
  warehouseId: string
  quantity: number
}

export type InventorySnapshot = {
  levels: InventoryStockLevel[]
  settings: InventoryProductSetting[]
  units: InventoryUnit[]
  warehouses: InventoryWarehouse[]
}
