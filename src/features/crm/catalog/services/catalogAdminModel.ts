import type { CatalogBatchCommand } from '../../../catalog/data/commands.ts'
import type {
  CatalogCategory,
  CatalogData,
  CatalogProduct,
  CatalogTab,
  CatalogVariant,
} from '../../../catalog/domain/types.ts'

export type CatalogProductFilters = {
  query: string
  status: 'all' | 'active' | 'inactive'
  type: 'all' | 'standard' | 'menu'
  categoryId: string
  tabId: string
  showInternal: boolean
}

export type CatalogProductSummary = {
  product: CatalogProduct
  variants: CatalogVariant[]
  categories: CatalogCategory[]
  tabs: CatalogTab[]
  placementCount: number
  internal: boolean
  minPriceCents: number | null
  maxPriceCents: number | null
}

export function getCatalogProductSummaries(catalog: CatalogData): CatalogProductSummary[] {
  const variantsByProduct = new Map<string, CatalogVariant[]>()
  const placementsByProduct = new Map<string, typeof catalog.placements>()
  for (const variant of catalog.variants) {
    const variants = variantsByProduct.get(variant.productId) ?? []
    variants.push(variant)
    variantsByProduct.set(variant.productId, variants)
  }
  for (const placement of catalog.placements) {
    const placements = placementsByProduct.get(placement.productId) ?? []
    placements.push(placement)
    placementsByProduct.set(placement.productId, placements)
  }
  const categoryById = new Map(catalog.categories.map((category) => [category.id, category]))
  const tabById = new Map(catalog.tabs.map((tab) => [tab.id, tab]))
  return catalog.products.map((product) => {
    const variants = variantsByProduct.get(product.id) ?? []
    const placements = placementsByProduct.get(product.id) ?? []
    const activePrices = variants.filter((variant) => variant.active).map((variant) => variant.priceCents)
    return {
      product,
      variants,
      categories: [...new Map(placements.flatMap((placement) => {
        const category = placement.categoryId ? categoryById.get(placement.categoryId) : undefined
        return category ? [[category.id, category] as const] : []
      })).values()],
      tabs: [...new Map(placements.flatMap((placement) => {
        const tab = tabById.get(placement.tabId)
        return tab ? [[tab.id, tab] as const] : []
      })).values()],
      placementCount: placements.length,
      internal: !placements.some((placement) => placement.active),
      minPriceCents: activePrices.length ? Math.min(...activePrices) : null,
      maxPriceCents: activePrices.length ? Math.max(...activePrices) : null,
    }
  })
}

export function filterCatalogProducts(
  summaries: readonly CatalogProductSummary[],
  filters: CatalogProductFilters,
) {
  const query = filters.query.trim().toLocaleLowerCase('es')
  return summaries.filter((summary) => {
    if (filters.status === 'active' && !summary.product.active) return false
    if (filters.status === 'inactive' && summary.product.active) return false
    if (filters.type !== 'all' && summary.product.type !== filters.type) return false
    if (filters.categoryId && !summary.categories.some((category) => category.id === filters.categoryId)) return false
    if (filters.tabId && !summary.tabs.some((tab) => tab.id === filters.tabId)) return false
    if (!filters.showInternal && summary.internal) return false
    if (!query) return true
    return [
      summary.product.name,
      summary.product.description ?? '',
      summary.product.type,
      ...summary.variants.map((variant) => variant.name),
      ...summary.categories.map((category) => category.name),
      ...summary.tabs.map((tab) => tab.label),
    ].join(' ').toLocaleLowerCase('es').includes(query)
  })
}

export function validateVariantDrafts(variants: readonly {
  formatId?: string | null
  name: string
  priceCents: number
  active: boolean
  isDefault: boolean
}[], productActive: boolean) {
  if (!variants.length) return 'Añade al menos una variante.'
  const usesFormats = variants.some((variant) => Object.hasOwn(variant, 'formatId'))
  if (usesFormats && variants.some((variant) => !variant.formatId)) return 'Selecciona un formato para todas las variantes.'
  if (usesFormats && new Set(variants.map((variant) => variant.formatId)).size !== variants.length) return 'No puedes repetir un formato en el mismo producto.'
  if (variants.some((variant) => !variant.name.trim())) return 'Todas las variantes necesitan nombre.'
  if (variants.some((variant) => !Number.isSafeInteger(variant.priceCents) || variant.priceCents < 0)) {
    return 'Los precios deben ser céntimos enteros no negativos.'
  }
  if (variants.filter((variant) => variant.isDefault).length !== 1) return 'Debe existir una única variante predeterminada.'
  if (productActive && !variants.some((variant) => variant.active && variant.isDefault)) {
    return 'Un producto activo necesita una variante predeterminada activa.'
  }
  return null
}

export function validateSelectionCapacity(input: {
  minSelection: number
  maxSelection: number
  required: boolean
  availableOptions: number
}) {
  if (!Number.isSafeInteger(input.minSelection) || input.minSelection < 0) return 'El mínimo no puede ser negativo.'
  if (!Number.isSafeInteger(input.maxSelection) || input.maxSelection < 1) return 'El máximo debe ser al menos uno.'
  if (input.minSelection > input.maxSelection) return 'El mínimo no puede superar el máximo.'
  if (input.required && input.minSelection < 1) return 'Un grupo obligatorio debe exigir al menos una selección.'
  if (input.availableOptions < input.minSelection) return 'No hay suficientes opciones activas para satisfacer el mínimo.'
  return null
}

export function moveCatalogItem<T extends { id: string }>(items: readonly T[], id: string, direction: -1 | 1) {
  const index = items.findIndex((item) => item.id === id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= items.length) return [...items]
  const reordered = [...items]
  ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
  return reordered
}

export function toReorderItems(items: readonly { id: string }[]) {
  return items.map((item, index) => ({ id: item.id, sortOrder: index * 10 }))
}

export function buildProductCreationBatch(input: {
  productId: string
  venueId: string
  type: 'standard' | 'menu'
  name: string
  description: string | null
  vatRate: number | null
  active: boolean
  sortOrder: number
  variants: Array<{
    id: string
    formatId: string
    name: string
    priceCents: number
    sku?: string | null
    active: boolean
    isDefault: boolean
    sortOrder: number
  }>
  placement?: {
    id: string
    tabId: string
    categoryId: string
    pinnedVariantId: string | null
    featured?: boolean
    sortOrder: number
  }
}): CatalogBatchCommand[] {
  const batch: CatalogBatchCommand[] = [{
    command: 'create_product',
    payload: {
      id: input.productId,
      type: input.type,
      name: input.name.trim(),
      description: input.description,
      vatRate: input.vatRate,
      active: input.active,
      sortOrder: input.sortOrder,
      variants: input.variants,
    },
  }]
  if (input.placement) {
    batch.push({
      command: 'create_placement',
      payload: {
        id: input.placement.id,
        productId: input.productId,
        tabId: input.placement.tabId,
        categoryId: input.placement.categoryId,
        pinnedVariantId: input.placement.pinnedVariantId,
        featured: input.placement.featured ?? false,
        active: true,
        sortOrder: input.placement.sortOrder,
      },
    })
  }
  return batch
}

export function buildProductDuplicationPlan(
  catalog: CatalogData,
  sourceProductId: string,
  createId: () => string,
) {
  const source = catalog.products.find((product) => product.id === sourceProductId)
  if (!source) throw new Error('El producto que quieres duplicar ya no existe.')

  const productId = createId()
  const variantIdBySourceId = new Map<string, string>()
  const variants = catalog.variants
    .filter((variant) => variant.productId === sourceProductId)
    .map((variant) => {
      const id = createId()
      variantIdBySourceId.set(variant.id, id)
      return {
        id,
        formatId: variant.formatId ?? '',
        name: variant.name,
        priceCents: variant.priceCents,
        sku: variant.sku,
        active: variant.active,
        isDefault: variant.isDefault,
        sortOrder: variant.sortOrder,
      }
    })

  if (!variants.length) throw new Error('No se puede duplicar un producto sin variantes.')

  const batch: CatalogBatchCommand[] = [{
    command: 'create_product',
    payload: {
      id: productId,
      type: source.type,
      name: source.name,
      description: source.description,
      vatRate: source.vatRate,
      active: source.active,
      sortOrder: catalog.products.length * 10,
      variants,
    },
  }]

  for (const placement of catalog.placements.filter((item) => item.productId === sourceProductId)) {
    batch.push({
      command: 'create_placement',
      payload: {
        id: createId(),
        productId,
        tabId: placement.tabId,
        categoryId: placement.categoryId,
        pinnedVariantId: placement.pinnedVariantId
          ? variantIdBySourceId.get(placement.pinnedVariantId) ?? null
          : null,
        featured: placement.featured,
        active: placement.active,
        sortOrder: placement.sortOrder,
      },
    })
  }

  const assignments = [
    ...catalog.selectionAssignments
      .filter((assignment) => assignment.productId === sourceProductId)
      .map((assignment) => ({ assignment, domain: 'selection' as const })),
    ...catalog.modifierAssignments
      .filter((assignment) => assignment.productId === sourceProductId)
      .map((assignment) => ({ assignment, domain: 'modifier' as const })),
  ]
  for (const { assignment, domain } of assignments) {
    batch.push({
      command: 'save_assignment',
      payload: {
        id: createId(),
        domain,
        productId,
        groupId: assignment.groupId,
        displayName: assignment.displayName,
        minSelection: assignment.minSelection,
        maxSelection: assignment.maxSelection,
        appliesToAllVariants: assignment.appliesToAllVariants,
        variantIds: assignment.variantIds.map((id) => variantIdBySourceId.get(id)).filter((id): id is string => Boolean(id)),
        active: assignment.active,
        sortOrder: assignment.sortOrder,
      },
    })
  }

  return {
    productId,
    batch,
    variantFormats: variants.flatMap((variant) => variant.formatId
      ? [{ variantId: variant.id, formatId: variant.formatId }]
      : []),
    image: source.image,
  }
}
