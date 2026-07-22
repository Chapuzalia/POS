import type { ProductType, SelectionGroupKind } from '../../../types/index.ts'

export type CatalogCommandName =
  | 'create_product'
  | 'update_product'
  | 'set_product_active'
  | 'delete_product'
  | 'create_variant'
  | 'update_variant'
  | 'set_default_variant'
  | 'delete_variant'
  | 'create_placement'
  | 'update_placement'
  | 'delete_placement'
  | 'save_tab'
  | 'delete_tab'
  | 'save_category'
  | 'delete_category'
  | 'save_selection_group'
  | 'delete_selection_group'
  | 'save_selection_option'
  | 'delete_selection_option'
  | 'save_modifier_group'
  | 'delete_modifier_group'
  | 'save_modifier'
  | 'delete_modifier'
  | 'save_assignment'
  | 'delete_assignment'
  | 'reorder'

export type CatalogVariantInput = {
  id?: string
  formatId?: string | null
  name: string
  priceCents: number
  sku?: string | null
  active?: boolean
  isDefault?: boolean
  sortOrder: number
}

export type CatalogProductInput = {
  id?: string
  type: ProductType
  name: string
  description?: string | null
  vatRate?: number | null
  active?: boolean
  sortOrder: number
  variants?: CatalogVariantInput[]
}

export type CatalogPlacementInput = {
  id?: string
  productId: string
  tabId: string
  categoryId?: string | null
  pinnedVariantId?: string | null
  featured?: boolean
  active?: boolean
  sortOrder: number
}

export type CatalogAssignmentInput = {
  id?: string
  domain: 'selection' | 'modifier'
  productId: string
  groupId: string
  displayName?: string | null
  minSelection: number
  maxSelection: number
  appliesToAllVariants: boolean
  variantIds: string[]
  active?: boolean
  sortOrder: number
}

export type CatalogSelectionGroupInput = {
  id?: string
  name: string
  type: SelectionGroupKind
  active?: boolean
  sortOrder: number
}

export type CatalogReorderInput = {
  entity: 'products' | 'variants' | 'placements' | 'tabs' | 'categories' | 'tab_categories' | 'selection_groups' | 'selection_options' | 'selection_assignments' | 'modifier_groups' | 'modifiers' | 'modifier_assignments'
  items: Array<{ id: string; sortOrder: number }>
}

export type CatalogSaleFormatInput = {
  id?: string
  name: string
  active?: boolean
  sortOrder: number
}
export type CatalogBatchCommand = {
  command: CatalogCommandName | 'save_tab_category'
  payload: Readonly<Record<string, unknown>>
}
