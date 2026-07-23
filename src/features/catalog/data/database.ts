import type { ProductType, SelectionGroupKind } from '../../../types/index.ts'

export type CatalogProductRow = {
  id: string
  tenant_id: string
  venue_id: string
  product_type: ProductType
  name: string
  description: string | null
  tax_rate: number | string | null
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogVariantRow = {
  id: string
  tenant_id: string
  venue_id: string
  product_id: string
  name: string
  price_cents: number
  sku: string | null
  is_default: boolean
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogSaleFormatRow = {
  id: string
  tenant_id: string
  venue_id: string
  name: string
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogVariantFormatRow = {
  variant_id: string
  format_id: string
}

export type CatalogPlacementRow = {
  id: string
  tenant_id: string
  venue_id: string
  product_id: string
  tab_id: string
  category_id: string | null
  variant_id: string | null
  is_featured: boolean
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogTabRow = {
  id: string
  tenant_id: string
  venue_id: string
  key: string
  label: string
  icon: string | null
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogCategoryRow = {
  id: string
  tenant_id: string
  venue_id: string
  name: string
  icon: string | null
  unused: boolean
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogTabCategoryRow = {
  id: string
  tenant_id: string
  venue_id: string
  tab_id: string
  category_id: string
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogSelectionGroupRow = {
  id: string
  tenant_id: string
  venue_id: string
  name: string
  kind: SelectionGroupKind
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogSelectionOptionRow = {
  id: string
  tenant_id: string
  venue_id: string
  group_id: string
  product_id: string
  variant_id: string | null
  supplement_cents: number
  default_quantity: number
  max_quantity: number | null
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogAssignmentRow = {
  id: string
  tenant_id: string
  venue_id: string
  product_id: string
  group_id: string
  display_name: string | null
  min_selection: number
  max_selection: number
  applies_to_all_variants: boolean
  variant_ids: string[]
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogModifierGroupRow = {
  id: string
  tenant_id: string
  venue_id: string
  name: string
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogModifierRow = {
  id: string
  tenant_id: string
  venue_id: string
  group_id: string
  name: string
  supplement_cents: number
  is_default: boolean
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type CatalogImageRow = {
  id: string
  tenant_id: string
  venue_id: string
  product_id: string
  storage_path: string
  mime_type: string
  size_bytes: number
  sha256: string
  created_at: string
  updated_at: string
}

export type CatalogRpcPayload = {
  tenant_id: string
  venue_id: string
  mode: 'admin' | 'pos'
  products: CatalogProductRow[]
  sale_formats?: CatalogSaleFormatRow[]
  variant_formats?: CatalogVariantFormatRow[]
  variants: CatalogVariantRow[]
  placements: CatalogPlacementRow[]
  tabs: CatalogTabRow[]
  categories: CatalogCategoryRow[]
  tab_categories: CatalogTabCategoryRow[]
  selection_groups: CatalogSelectionGroupRow[]
  selection_options: CatalogSelectionOptionRow[]
  selection_assignments: CatalogAssignmentRow[]
  modifier_groups: CatalogModifierGroupRow[]
  modifiers: CatalogModifierRow[]
  modifier_assignments: CatalogAssignmentRow[]
  images: CatalogImageRow[]
}
