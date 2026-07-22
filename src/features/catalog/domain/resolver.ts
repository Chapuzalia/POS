import { CatalogDomainError } from './errors.ts'
import type { ResolvedCatalog } from './resolved-types.ts'
import type {
  CatalogAssignment,
  CatalogData,
  CatalogProduct,
  CatalogVariant,
  ResolvedCatalogItem,
  ResolvedCatalogModifierGroup,
  ResolvedCatalogSelectionGroup,
  ResolvedCatalogSelectionOption,
  ResolvedSellableProduct,
} from './types.ts'

const compareText = (left: string, right: string) => left.localeCompare(right, 'es')
const byOrder = <T extends { id: string; sortOrder: number }>(left: T, right: T) => left.sortOrder - right.sortOrder || compareText(left.id, right.id)

function mapById<T extends { id: string }>(rows: readonly T[]) {
  return new Map(rows.map((row) => [row.id, row]))
}

function groupedBy<T>(rows: readonly T[], key: (row: T) => string) {
  const result = new Map<string, T[]>()
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row])
  return result
}

function indexCatalog(catalog: CatalogData) {
  return {
    products: mapById(catalog.products),
    variants: mapById(catalog.variants),
    variantsByProduct: groupedBy(catalog.variants, (row) => row.productId),
    tabs: mapById(catalog.tabs),
    categories: mapById(catalog.categories),
    selectionGroups: mapById(catalog.selectionGroups),
    selectionOptionsByGroup: groupedBy(catalog.selectionOptions, (row) => row.groupId),
    selectionAssignmentsByProduct: groupedBy(catalog.selectionAssignments, (row) => row.productId),
    modifierGroups: mapById(catalog.modifierGroups),
    modifiersByGroup: groupedBy(catalog.modifiers, (row) => row.groupId),
    modifierAssignmentsByProduct: groupedBy(catalog.modifierAssignments, (row) => row.productId),
  }
}

type CatalogIndexes = ReturnType<typeof indexCatalog>

function assertVenue(catalog: CatalogData, entity: { venueId: string; id: string }, relation: string) {
  if (entity.venueId !== catalog.venueId) {
    throw new CatalogDomainError('CATALOG_CROSS_VENUE', `${relation} pertenece a otro local.`, { id: entity.id, venueId: entity.venueId })
  }
}

function resolveActiveDefaultVariant(product: CatalogProduct, indexes: CatalogIndexes) {
  const active = (indexes.variantsByProduct.get(product.id) ?? []).filter((variant) => variant.active)
  const defaults = active.filter((variant) => variant.isDefault)
  if (defaults.length !== 1) {
    throw new CatalogDomainError('CATALOG_PRODUCT_NOT_SELLABLE', `${product.name} no tiene una única variante predeterminada activa.`, {
      productId: product.id,
      activeVariants: active.length,
      activeDefaults: defaults.length,
    })
  }
  return defaults[0]
}

function resolveRequestedVariant(product: CatalogProduct, variantId: string | null, indexes: CatalogIndexes) {
  if (!variantId) return resolveActiveDefaultVariant(product, indexes)
  const variant = indexes.variants.get(variantId)
  if (!variant) throw new CatalogDomainError('CATALOG_VARIANT_NOT_FOUND', 'La variante fijada no existe.', { variantId })
  if (variant.productId !== product.id) {
    throw new CatalogDomainError('CATALOG_VARIANT_PRODUCT_MISMATCH', 'La variante fijada no pertenece al producto.', { productId: product.id, variantId })
  }
  if (!variant.active) {
    throw new CatalogDomainError('CATALOG_PRODUCT_NOT_SELLABLE', 'La variante fijada está inactiva.', { productId: product.id, variantId })
  }
  return variant
}

function assignmentApplies(assignment: CatalogAssignment, variantId: string) {
  // Hay una sola asignación producto/grupo. El alcance a todo el producto tiene
  // precedencia; las variantes hijas solo delimitan cuando este indicador es false.
  return assignment.active && (assignment.appliesToAllVariants || assignment.variantIds.includes(variantId))
}

function resolveSelectionOption(optionId: string, catalog: CatalogData, indexes: CatalogIndexes): ResolvedCatalogSelectionOption {
  const option = catalog.selectionOptions.find((candidate) => candidate.id === optionId)
  if (!option) throw new CatalogDomainError('CATALOG_GROUP_INVALID', 'La opción de selección no existe.', { optionId })
  const product = indexes.products.get(option.productId)
  if (!product || !product.active) {
    throw new CatalogDomainError('CATALOG_GROUP_INVALID', 'La opción apunta a un producto inactivo o inexistente.', { optionId, productId: option.productId })
  }
  assertVenue(catalog, product, 'El producto de la opción')
  const variant = resolveRequestedVariant(product, option.variantId, indexes)
  return { ...option, product, variant }
}

function resolveSelectionGroups(product: CatalogProduct, variant: CatalogVariant, catalog: CatalogData, indexes: CatalogIndexes): ResolvedCatalogSelectionGroup[] {
  return (indexes.selectionAssignmentsByProduct.get(product.id) ?? [])
    .filter((assignment) => assignmentApplies(assignment, variant.id))
    .sort(byOrder)
    .flatMap((assignment) => {
      const group = indexes.selectionGroups.get(assignment.groupId)
      if (!group || !group.active) return []
      assertVenue(catalog, group, 'El grupo de selección')
      const options = (indexes.selectionOptionsByGroup.get(group.id) ?? [])
        .filter((option) => option.active)
        .sort(byOrder)
        .flatMap((option) => {
          try { return [resolveSelectionOption(option.id, catalog, indexes)] }
          catch (error) {
            if (error instanceof CatalogDomainError && error.code === 'CATALOG_GROUP_INVALID') return []
            throw error
          }
        })
      const capacity = options.reduce((total, option) => total + (option.maxQuantity ?? assignment.maxSelection), 0)
      if (capacity < assignment.minSelection) {
        throw new CatalogDomainError('CATALOG_SELECTION_OUT_OF_BOUNDS', `${group.name} no tiene capacidad activa suficiente.`, {
          assignmentId: assignment.id, capacity, minSelection: assignment.minSelection,
        })
      }
      return [{ assignment, group, options }]
    })
}

function resolveModifierGroups(product: CatalogProduct, variant: CatalogVariant, catalog: CatalogData, indexes: CatalogIndexes): ResolvedCatalogModifierGroup[] {
  return (indexes.modifierAssignmentsByProduct.get(product.id) ?? [])
    .filter((assignment) => assignmentApplies(assignment, variant.id))
    .sort(byOrder)
    .flatMap((assignment) => {
      const group = indexes.modifierGroups.get(assignment.groupId)
      if (!group || !group.active) return []
      assertVenue(catalog, group, 'El grupo de modificadores')
      const modifiers = (indexes.modifiersByGroup.get(group.id) ?? []).filter((modifier) => modifier.active).sort(byOrder)
      if (modifiers.length < assignment.minSelection) {
        throw new CatalogDomainError('CATALOG_SELECTION_OUT_OF_BOUNDS', `${group.name} no tiene modificadores activos suficientes.`, {
          assignmentId: assignment.id, activeModifiers: modifiers.length, minSelection: assignment.minSelection,
        })
      }
      return [{ assignment, group, modifiers }]
    })
}

function resolveSellableProductWithIndexes(catalog: CatalogData, productId: string, variantId: string | null, indexes: CatalogIndexes): ResolvedSellableProduct {
  const product = indexes.products.get(productId)
  if (!product) throw new CatalogDomainError('CATALOG_PRODUCT_NOT_FOUND', 'El producto no existe.', { productId })
  assertVenue(catalog, product, 'El producto')
  if (!product.active) throw new CatalogDomainError('CATALOG_PRODUCT_NOT_SELLABLE', 'El producto está inactivo.', { productId })
  const variant = resolveRequestedVariant(product, variantId, indexes)
  return {
    product,
    variant,
    selectionGroups: resolveSelectionGroups(product, variant, catalog, indexes),
    modifierGroups: resolveModifierGroups(product, variant, catalog, indexes),
    basePriceCents: variant.priceCents,
    vatRate: product.vatRate,
    image: product.image,
  }
}

export function resolveSellableProduct(catalog: CatalogData, productId: string, variantId: string | null = null) {
  return resolveSellableProductWithIndexes(catalog, productId, variantId, indexCatalog(catalog))
}

export function resolveCatalogItem(catalog: CatalogData, placementId: string): ResolvedCatalogItem {
  const indexes = indexCatalog(catalog)
  const placement = catalog.placements.find((candidate) => candidate.id === placementId)
  if (!placement || !placement.active) throw new CatalogDomainError('CATALOG_PLACEMENT_INVALID', 'El placement no existe o está inactivo.', { placementId })
  assertVenue(catalog, placement, 'El placement')
  const tab = indexes.tabs.get(placement.tabId)
  const category = placement.categoryId ? indexes.categories.get(placement.categoryId) ?? null : null
  if (!tab?.active || (placement.categoryId && !category?.active)) {
    throw new CatalogDomainError('CATALOG_PLACEMENT_INVALID', 'El placement apunta a una pestaña o categoría inactiva.', { placementId })
  }
  const sellable = resolveSellableProductWithIndexes(catalog, placement.productId, placement.pinnedVariantId, indexes)
  return { ...sellable, placement, tab, category, featured: placement.featured, sortOrder: placement.sortOrder }
}

export function resolveSellableCatalog(catalog: CatalogData): ResolvedCatalog {
  const placementProductIds = new Set(catalog.placements.map((placement) => placement.productId))
  const internalProducts = catalog.products.filter((product) => !placementProductIds.has(product.id)).sort(byOrder)
  const items: ResolvedCatalogItem[] = []
  const rejected: ResolvedCatalog['rejected'] = []
  for (const placement of [...catalog.placements].sort(byOrder)) {
    try { items.push(resolveCatalogItem(catalog, placement.id)) }
    catch (error) {
      const mapped = error instanceof CatalogDomainError
        ? error
        : new CatalogDomainError('CATALOG_INCONSISTENT', 'No se pudo resolver el placement.', { placementId: placement.id }, { cause: error })
      rejected.push({ placementId: placement.id, code: mapped.code, message: mapped.message })
    }
  }
  return { items, internalProducts, rejected }
}

export function getActiveTabs(catalog: CatalogData) {
  return catalog.tabs.filter((tab) => tab.active).sort(byOrder)
}

export function getCategoriesForTab(catalog: CatalogData, tabId: string) {
  const categories = new Map(catalog.categories.map((category) => [category.id, category]))
  return catalog.tabCategories.filter((relation) => relation.tabId === tabId && relation.active).sort(byOrder)
    .flatMap((relation) => {
      const category = categories.get(relation.categoryId)
      return category?.active ? [category] : []
    })
}

export function getProductVariants(catalog: CatalogData, productId: string, activeOnly = true) {
  return catalog.variants.filter((variant) => variant.productId === productId && (!activeOnly || variant.active)).sort(byOrder)
}

export function getApplicableSelectionGroups(catalog: CatalogData, productId: string, variantId: string) {
  return resolveSellableProduct(catalog, productId, variantId).selectionGroups
}

export function getApplicableModifierGroups(catalog: CatalogData, productId: string, variantId: string) {
  return resolveSellableProduct(catalog, productId, variantId).modifierGroups
}
