import type {
  Catalog,
  CatalogPlacement,
  CatalogTab,
  ModifierGroup,
  Product,
  ProductVariant,
  VariantSelectionGroup,
} from '../../../types/index.ts'

export function getCatalogTabs(catalog: Catalog): CatalogTab[] {
  return (catalog.tabs ?? []).filter((tab) => tab.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, 'es'))
}

export function getCatalogPlacements(catalog: Catalog, tabId?: string | null): CatalogPlacement[] {
  return (catalog.placements ?? []).filter((placement) => (
    placement.isActive && (!tabId || placement.tabId === tabId)
  )).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
}
export function getCatalogForPOS(catalog: Catalog) {
  const tabs = getCatalogTabs(catalog)
  return {
    ...catalog,
    tabs,
    placements: tabs.flatMap((tab) => getCatalogPlacements(catalog, tab.id)),
  }
}

export function getProductSaleOptions(product: Product): ProductVariant[] {
  return [...product.variants]
    .filter((variant) => variant.isActive !== false)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'))
}

export function getVariantSelectionGroups(product: Product, variantId: string): VariantSelectionGroup[] {
  return (product.variantSelectionGroups ?? [])
    .filter((assignment) => assignment.variantId === variantId && assignment.group.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export function getProductModifierGroups(product: Product, variantId?: string): ModifierGroup[] {
  if (product.modifierGroupAssignments?.length) {
    return product.modifierGroupAssignments
      .filter((assignment) => assignment.variantId === null || assignment.variantId === variantId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((assignment) => assignment.group)
  }
  return (product.modifierGroups ?? [])
    .filter((group) => group.isActive !== false)
    .sort((a, b) => a.sortOrder - b.sortOrder)
}
