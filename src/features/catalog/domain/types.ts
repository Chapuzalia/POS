import type { ProductType, SelectionGroupKind } from '../../../types/index.ts'

export type CatalogReadMode = 'admin' | 'pos'

export type CatalogImage = {
  id: string
  tenantId: string
  venueId: string
  productId: string
  storagePath: string
  publicUrl: string | null
  mimeType: string
  sizeBytes: number
  sha256: string
  createdAt: string
  updatedAt: string
}

export type CatalogProduct = {
  id: string
  tenantId: string
  venueId: string
  type: ProductType
  name: string
  description: string | null
  image: CatalogImage | null
  vatRate: number | null
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogSaleFormat = {
  id: string
  tenantId: string
  venueId: string
  name: string
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogVariant = {
  id: string
  tenantId: string
  venueId: string
  productId: string
  formatId: string | null
  name: string
  priceCents: number
  sku: string | null
  active: boolean
  isDefault: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogPlacement = {
  id: string
  tenantId: string
  venueId: string
  productId: string
  tabId: string
  categoryId: string | null
  pinnedVariantId: string | null
  featured: boolean
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogTab = {
  id: string
  tenantId: string
  venueId: string
  key: string
  label: string
  icon: string | null
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogCategory = {
  id: string
  tenantId: string
  venueId: string
  name: string
  icon: string | null
  unused: boolean
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogTabCategory = {
  id: string
  tenantId: string
  venueId: string
  tabId: string
  categoryId: string
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogSelectionGroup = {
  id: string
  tenantId: string
  venueId: string
  name: string
  type: SelectionGroupKind
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogSelectionOption = {
  id: string
  tenantId: string
  venueId: string
  groupId: string
  productId: string
  variantId: string | null
  supplementCents: number
  defaultQuantity: number
  maxQuantity: number | null
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogAssignment = {
  id: string
  tenantId: string
  venueId: string
  productId: string
  groupId: string
  displayName: string | null
  minSelection: number
  maxSelection: number
  appliesToAllVariants: boolean
  variantIds: string[]
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogModifierGroup = {
  id: string
  tenantId: string
  venueId: string
  name: string
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogModifier = {
  id: string
  tenantId: string
  venueId: string
  groupId: string
  name: string
  supplementCents: number
  isDefault: boolean
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type CatalogData = {
  tenantId: string
  venueId: string
  mode: CatalogReadMode
  products: CatalogProduct[]
  saleFormats: CatalogSaleFormat[]
  variants: CatalogVariant[]
  placements: CatalogPlacement[]
  tabs: CatalogTab[]
  categories: CatalogCategory[]
  tabCategories: CatalogTabCategory[]
  selectionGroups: CatalogSelectionGroup[]
  selectionOptions: CatalogSelectionOption[]
  selectionAssignments: CatalogAssignment[]
  modifierGroups: CatalogModifierGroup[]
  modifiers: CatalogModifier[]
  modifierAssignments: CatalogAssignment[]
  loadedAt: string
}

export type ResolvedCatalogSelectionOption = CatalogSelectionOption & {
  product: CatalogProduct
  variant: CatalogVariant
}

export type ResolvedCatalogSelectionGroup = {
  assignment: CatalogAssignment
  group: CatalogSelectionGroup
  options: ResolvedCatalogSelectionOption[]
}

export type ResolvedCatalogModifierGroup = {
  assignment: CatalogAssignment
  group: CatalogModifierGroup
  modifiers: CatalogModifier[]
}

export type ResolvedSellableProduct = {
  product: CatalogProduct
  variant: CatalogVariant
  selectionGroups: ResolvedCatalogSelectionGroup[]
  modifierGroups: ResolvedCatalogModifierGroup[]
  basePriceCents: number
  vatRate: number | null
  image: CatalogImage | null
}

export type ResolvedCatalogItem = ResolvedSellableProduct & {
  placement: CatalogPlacement
  tab: CatalogTab
  category: CatalogCategory | null
  featured: boolean
  sortOrder: number
}

export type CatalogPriceBreakdown = {
  baseVariantPriceCents: number
  selectionSupplementsCents: number
  modifierSupplementsCents: number
  menuSupplementsCents: number
  grossUnitPriceCents: number
  discountCents: number
  netUnitPriceCents: number
  vatRate: number
  taxableBaseCents: number
  taxAmountCents: number
  finalUnitPriceCents: number
}

export type CatalogPriceSelection = {
  type: SelectionGroupKind
  supplementCents: number
  quantity: number
}

export type CatalogPriceModifier = {
  supplementCents: number
  quantity?: number
}

