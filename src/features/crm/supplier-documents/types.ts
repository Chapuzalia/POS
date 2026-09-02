export type SupplierDocumentStatus = 'processing' | 'review' | 'confirmed' | 'error'
export type SupplierDocumentType = 'invoice' | 'delivery_note'
export type SupplierDocumentMatchStatus = 'recognized' | 'probable' | 'needs_review'

export type SupplierDocument = {
  id: string
  tenantId: string
  venueId: string
  supplierId: string | null
  supplierName: string | null
  documentType: SupplierDocumentType
  documentNumber: string | null
  documentDate: string | null
  affectsStock: boolean
  stockAppliedAt: string | null
  storageBucket: string | null
  storagePath: string | null
  originalFileName: string | null
  status: SupplierDocumentStatus
  extractionMetadata: Record<string, unknown>
  createdAt: string
  confirmedAt: string | null
}

export type SupplierDocumentListItem = SupplierDocument & {
  total: number
  linkedDocumentCount: number
}

export type SupplierDocumentLinkCandidate = {
  id: string
  supplierName: string | null
  documentNumber: string | null
  documentDate: string
  total: number
}

export type SupplierDocumentLine = {
  id: string
  lineNumber: number
  supplierReference: string | null
  descriptionRaw: string
  descriptionNormalized: string
  barcode: string | null
  quantity: number | null
  purchaseUnit: string | null
  packageCount: number | null
  packageUnitQuantity: number | null
  packageUnitSymbol: string | null
  unitPrice: number | null
  discountAmount: number
  chargesAmount: number
  grossCost: number | null
  netCost: number | null
  lineTotal: number | null
  taxRate: number | null
  inventoryItemId: string | null
  warehouseId: string | null
  baseQuantity: number | null
  normalizedUnitCost: number | null
  matchStatus: SupplierDocumentMatchStatus
  extractionConfidence: number | null
  updateReferenceCost: boolean
  referenceCostDecided: boolean
  wasCorrected: boolean
}

export type SupplierDocumentDetail = {
  document: SupplierDocument
  lines: SupplierDocumentLine[]
}

export type SupplierDocumentLineDraft = {
  inventoryItemId: string
  warehouseId: string
  quantity: number
  purchaseUnit: string
  packageCount: number | null
  packageUnitQuantity: number | null
  packageUnitSymbol: string
  unitPrice: number
  discountAmount: number
  baseQuantity: number
  normalizedUnitCost: number
  updateReferenceCost: boolean
  referenceCostDecided: boolean
}

export type SupplierDocumentMockFixtureOption = {
  id: string
  label: string
  description: string
}
