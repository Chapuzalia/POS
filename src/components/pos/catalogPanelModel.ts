import type { ResolvedCatalogItem } from '../../features/catalog/domain/types'

export const TOP_ITEMS_LIMIT = 12

function getRepresentativePriority(item: ResolvedCatalogItem) {
  if (item.placement.pinnedVariantId === null) return 0
  if (item.variant.isDefault) return 1
  return 2
}

export function groupCatalogItemsByProduct(items: readonly ResolvedCatalogItem[]) {
  const productItems = new Map<string, ResolvedCatalogItem>()

  for (const item of items) {
    const current = productItems.get(item.product.id)
    if (!current || getRepresentativePriority(item) < getRepresentativePriority(current)) {
      productItems.set(item.product.id, item)
    }
  }

  return [...productItems.values()]
}

export function getAvailableFormatCounts(items: readonly ResolvedCatalogItem[]) {
  const variantsByProduct = new Map<string, Set<string>>()

  for (const item of items) {
    const variantIds = variantsByProduct.get(item.product.id) ?? new Set<string>()
    variantIds.add(item.variant.id)
    variantsByProduct.set(item.product.id, variantIds)
  }

  return new Map([...variantsByProduct].map(([productId, variantIds]) => [productId, variantIds.size]))
}

export function limitTopCatalogItems<T>(items: readonly T[]) {
  return items.slice(0, TOP_ITEMS_LIMIT)
}
