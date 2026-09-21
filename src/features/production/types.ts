export type ProductionRoutingPass = {
  id: string
  name: string
  sortOrder: number
}

export type ProductionRouting = {
  passes: ProductionRoutingPass[]
  defaultPass: ProductionRoutingPass | null
  productRoutes: Array<{ productId: string; passId: string }>
  categoryRoutes: Array<{ categoryId: string; passId: string }>
  loadedAt: string
}

export type ProductionEntry = {
  lineId: string
  componentId: string | null
  productName: string
  parentProductName?: string | null
  quantity: number
  sentQuantity: number
  readyQuantity: number
  unsentQuantity: number
  passId: string
  passName: string
  passSortOrder: number
  hasProductionDestination: boolean
  optimistic?: boolean
}

export type ProductionLineState = {
  hasProductionDestination: boolean
  lineId: string
  sentQuantity: number
  readyQuantity: number
  unsentQuantity: number
}

export type ProductionWarning = {
  destinationId: string
  status: 'failed' | 'unknown'
  message: string
}

export type OrderProductionState = {
  effective: boolean
  lines: ProductionLineState[]
  entries: ProductionEntry[]
  warnings: ProductionWarning[]
}

export type ProductionSelection = {
  lineId: string
  componentId?: string | null
  quantity: number
  passId?: string
  passName?: string
}

export type ProductionBatchResult = {
  batchId: string
  sequence: number
  duplicate: boolean
  sentUnits: number
  itemCount?: number
  printerDispatches?: number
}

export type KdsItem = {
  id: string
  batchId: string
  batchSequence: number
  orderId: string
  tableName: string
  quantity: number
  readyQuantity: number
  cancelledQuantity: number
  passName?: string | null
  snapshot: {
    productName?: string
    variantName?: string
    parentProductName?: string
    lineModifiers?: Array<{ name?: string }>
    componentModifiers?: Array<{ name?: string }>
    note?: string | null
    passName?: string | null
  }
  sentAt: string
}

export type KdsEvent = {
  id: string
  event_type: 'cancelled' | 'modified'
  quantity: number
  payload: Record<string, unknown>
  created_at: string
}

export type KdsQueue = { destinationId: string; items: KdsItem[]; events: KdsEvent[] }

