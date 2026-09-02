import type { SupplierDocumentStatus, SupplierDocumentType } from '../supplier-documents/types'

export type PurchaseLine = {
  documentId: string
  inventoryItemId: string | null
  inventoryItemName: string | null
  description: string
  amount: number
  normalizedUnitCost: number | null
}

export type PurchaseDocument = {
  id: string
  supplierId: string | null
  supplierName: string | null
  documentType: SupplierDocumentType
  documentNumber: string | null
  documentDate: string | null
  status: SupplierDocumentStatus
  affectsStock: boolean
  storageBucket: string | null
  storagePath: string | null
  originalFileName: string | null
  originalMimeType: string | null
  total: number
  linkedDocumentCount: number
  excludedFromSpend: boolean
  lines: PurchaseLine[]
}

export type VenueSupplier = {
  id: string
  name: string
  taxId: string | null
}

export type VenueSupplierInput = {
  id?: string
  name: string
  taxId: string | null
}
