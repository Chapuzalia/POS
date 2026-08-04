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
  enabled: boolean
  productId: string
  warehouseId: string
  quantity: number
}

export type InventoryDevice = {
  active: boolean
  id: string
  name: string
}

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
  levels: InventoryStockLevel[]
  settings: InventoryProductSetting[]
  units: InventoryUnit[]
  warehouses: InventoryWarehouse[]
}
