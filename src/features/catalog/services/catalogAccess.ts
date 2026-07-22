import { canSellProductStandalone, getActiveSaleFormats, getProductSaleFormats, getProductVariantForSaleFormat } from '../../../lib/catalog.ts'
import type {
  Catalog,
  CatalogPlacement,
  CatalogTab,
  ModifierGroup,
  Product,
  ProductVariant,
  VariantSelectionGroup,
} from '../../../types/index.ts'

let warnedAboutLegacyFallback = false

function warnLegacyFallback() {
  if (warnedAboutLegacyFallback) return
  warnedAboutLegacyFallback = true
  console.warn('[catalog] No hay colocaciones validas; se usa temporalmente el adaptador legacy.')
}

export function getCatalogTabs(catalog: Catalog): CatalogTab[] {
  const configured = (catalog.tabs ?? []).filter((tab) => tab.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, 'es'))
  if (configured.length) return configured

  warnLegacyFallback()
  return getActiveSaleFormats(catalog.saleFormats).map((format) => ({
    id: `legacy-tab:${format.key}`,
    tenantId: format.tenantId ?? '',
    venueId: format.venueId ?? '',
    key: format.key,
    label: format.label,
    icon: format.key,
    isActive: true,
    sortOrder: format.sortOrder,
  }))
}

function getLegacyPlacements(catalog: Catalog, tab: CatalogTab): CatalogPlacement[] {
  return catalog.products.flatMap((product) => {
    if (!product.isActive || !canSellProductStandalone(product) || !getProductSaleFormats(product).includes(tab.key)) return []
    const variant = getProductVariantForSaleFormat(product, tab.key)
    if (!variant) return []
    return [{
      id: `legacy-placement:${tab.id}:${product.id}`,
      tenantId: product.tenantId,
      venueId: product.venueId,
      tabId: tab.id,
      categoryId: product.categoryId,
      productId: product.id,
      defaultVariantId: variant.id,
      isFeatured: product.isFeatured,
      isActive: true,
      sortOrder: product.sortOrder,
    }]
  })
}

export function getCatalogPlacements(catalog: Catalog, tabId?: string | null): CatalogPlacement[] {
  const configured = (catalog.placements ?? []).filter((placement) => (
    placement.isActive && (!tabId || placement.tabId === tabId)
  ))
  if (configured.length || (catalog.tabs?.length && !catalog.usesLegacyFallback)) {
    return configured.sort((a, b) => a.sortOrder - b.sortOrder)
  }

  warnLegacyFallback()
  const tabs = getCatalogTabs(catalog).filter((tab) => !tabId || tab.id === tabId)
  return tabs.flatMap((tab) => getLegacyPlacements(catalog, tab))
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
