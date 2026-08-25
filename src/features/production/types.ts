export type ProductionLineState = {
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
  warnings: ProductionWarning[]
}

export type ProductionSelection = { lineId: string; quantity: number }

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
  snapshot: {
    productName?: string
    variantName?: string
    parentProductName?: string
    lineModifiers?: Array<{ name?: string }>
    componentModifiers?: Array<{ name?: string }>
    note?: string | null
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

