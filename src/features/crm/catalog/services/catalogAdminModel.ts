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
      active: source.type === 'menu' ? false : source.active,
      sortOrder: catalog.products.length * 10,
      variants,
    },
  }]

  const duplicatedPlacements: Array<{ id: string; placement: CatalogData['placements'][number] }> = []
  for (const placement of catalog.placements.filter((item) => item.productId === sourceProductId)) {
    const placementId = createId()
    duplicatedPlacements.push({ id: placementId, placement })
    batch.push({
      command: 'create_placement',
      payload: {
        id: placementId,
        productId,
        tabId: placement.tabId,
        categoryId: placement.categoryId,
        pinnedVariantId: placement.pinnedVariantId
          ? variantIdBySourceId.get(placement.pinnedVariantId) ?? null
          : null,
        featured: placement.featured,
        active: source.type === 'menu' ? false : placement.active,
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
  const localMenuGroupIdBySourceId = new Map<string, string>()
  for (const { assignment, domain } of assignments) {
    let groupId = assignment.groupId
    if (source.type === 'menu' && domain === 'selection') {
      const sourceGroup = catalog.selectionGroups.find((group) => group.id === assignment.groupId)
      if (sourceGroup?.type === 'menu_component') {
        let localGroupId = localMenuGroupIdBySourceId.get(sourceGroup.id)
        if (!localGroupId) {
          localGroupId = createId()
          localMenuGroupIdBySourceId.set(sourceGroup.id, localGroupId)
          batch.push({
            command: 'save_selection_group',
            payload: { id: localGroupId, name: sourceGroup.name, type: sourceGroup.type, active: sourceGroup.active, sortOrder: catalog.selectionGroups.length * 10 + localMenuGroupIdBySourceId.size * 10 },
          })
          for (const option of catalog.selectionOptions.filter((candidate) => candidate.groupId === sourceGroup.id)) {
            batch.push({
              command: 'save_selection_option',
              payload: { ...option, id: createId(), groupId: localGroupId, defaultQuantity: 0 },
            })
          }
        }
        groupId = localGroupId
      }
    }
    batch.push({
      command: 'save_assignment',
      payload: {
        id: createId(),
        domain,
        productId,
        groupId,
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
  if (source.type === 'menu' && source.active) {
    batch.push({ command: 'set_product_active', payload: { id: productId, active: true } })
    for (const { id, placement } of duplicatedPlacements) {
      batch.push({ command: 'update_placement', payload: { id, productId, tabId: placement.tabId, categoryId: placement.categoryId, pinnedVariantId: placement.pinnedVariantId ? variantIdBySourceId.get(placement.pinnedVariantId) ?? null : null, featured: placement.featured, active: placement.active, sortOrder: placement.sortOrder } })
    }
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

function normalizedCatalogName(value: string) {
  return value.trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

export function buildCrossVenueProductDuplicationPlan(
  sourceCatalog: CatalogData,
  targetCatalog: CatalogData,
  sourceProductId: string,
  createId: () => string,
) {
  const source = sourceCatalog.products.find((product) => product.id === sourceProductId)
  if (!source) throw new Error('El producto que quieres duplicar ya no existe.')
  if (sourceCatalog.tenantId !== targetCatalog.tenantId) throw new Error('No se puede duplicar un producto a otro negocio.')

  const productId = createId()
  const variantIdBySourceId = new Map<string, string>()
  const targetFormatByName = new Map(targetCatalog.saleFormats.map((format) => [normalizedCatalogName(format.name), format]))
  const newFormatBySourceId = new Map<string, { id: string; name: string; active: boolean; sortOrder: number }>()
  const variants = sourceCatalog.variants
    .filter((variant) => variant.productId === sourceProductId)
    .map((variant) => {
      const id = createId()
      variantIdBySourceId.set(variant.id, id)
      const sourceFormat = variant.formatId
        ? sourceCatalog.saleFormats.find((format) => format.id === variant.formatId) ?? null
        : null
      let formatId = ''
      if (sourceFormat) {
        const existing = targetFormatByName.get(normalizedCatalogName(sourceFormat.name))
        if (existing) {
          formatId = existing.id
        } else {
          let created = newFormatBySourceId.get(sourceFormat.id)
          if (!created) {
            created = {
              id: createId(),
              name: sourceFormat.name,
              active: sourceFormat.active,
              sortOrder: (targetCatalog.saleFormats.length + newFormatBySourceId.size) * 10,
            }
            newFormatBySourceId.set(sourceFormat.id, created)
          }
          formatId = created.id
        }
      }
      return {
        id,
        formatId,
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
      active: source.type === 'menu' ? false : source.active,
      sortOrder: targetCatalog.products.length * 10,
      variants,
    },
  }]

  const targetTabIdByKey = new Map<string, string>()
  for (const tab of targetCatalog.tabs) {
    targetTabIdByKey.set(normalizedCatalogName(tab.key), tab.id)
    targetTabIdByKey.set(normalizedCatalogName(tab.label), tab.id)
  }
  const targetCategoryIdByName = new Map(targetCatalog.categories.map((category) => [normalizedCatalogName(category.name), category.id]))
  const targetTabCategoryKeys = new Set(targetCatalog.tabCategories.map((item) => `${item.tabId}:${item.categoryId}`))
  const relationCountByTabId = new Map(targetCatalog.tabs.map((tab) => [tab.id, targetCatalog.tabCategories.filter((item) => item.tabId === tab.id).length]))
  let nextTabSortOrder = targetCatalog.tabs.length * 10
  let nextCategorySortOrder = targetCatalog.categories.length * 10
  const duplicatedTargetPlacements: Array<{ id: string; payload: Record<string, unknown>; active: boolean }> = []
  for (const placement of sourceCatalog.placements.filter((item) => item.productId === sourceProductId)) {
    const sourceTab = sourceCatalog.tabs.find((tab) => tab.id === placement.tabId)
    const sourceCategory = sourceCatalog.categories.find((category) => category.id === placement.categoryId)
    if (!sourceTab) continue
    let targetTabId = targetTabIdByKey.get(normalizedCatalogName(sourceTab.key))
      ?? targetTabIdByKey.get(normalizedCatalogName(sourceTab.label))
    if (!targetTabId) {
      targetTabId = createId()
      batch.push({
        command: 'save_tab',
        payload: { id: targetTabId, key: sourceTab.key, label: sourceTab.label, icon: sourceTab.icon, active: sourceTab.active, sortOrder: nextTabSortOrder },
      })
      nextTabSortOrder += 10
      targetTabIdByKey.set(normalizedCatalogName(sourceTab.key), targetTabId)
      targetTabIdByKey.set(normalizedCatalogName(sourceTab.label), targetTabId)
    }
    let targetCategoryId = sourceCategory ? targetCategoryIdByName.get(normalizedCatalogName(sourceCategory.name)) : null
    if (sourceCategory && !targetCategoryId) {
      targetCategoryId = createId()
      batch.push({
        command: 'save_category',
        payload: { id: targetCategoryId, name: sourceCategory.name, icon: sourceCategory.icon, active: sourceCategory.active, unused: sourceCategory.unused, sortOrder: nextCategorySortOrder },
      })
      nextCategorySortOrder += 10
      targetCategoryIdByName.set(normalizedCatalogName(sourceCategory.name), targetCategoryId)
    }
    if (targetCategoryId && !targetTabCategoryKeys.has(`${targetTabId}:${targetCategoryId}`)) {
      batch.push({
        command: 'save_tab_category',
        payload: { id: createId(), tabId: targetTabId, categoryId: targetCategoryId, active: true, sortOrder: (relationCountByTabId.get(targetTabId) ?? 0) * 10 },
      })
      targetTabCategoryKeys.add(`${targetTabId}:${targetCategoryId}`)
      relationCountByTabId.set(targetTabId, (relationCountByTabId.get(targetTabId) ?? 0) + 1)
    }
    const targetPlacementId = createId()
    const targetPlacementPayload = {
      id: targetPlacementId,
      productId,
      tabId: targetTabId,
      categoryId: targetCategoryId ?? null,
      pinnedVariantId: placement.pinnedVariantId ? variantIdBySourceId.get(placement.pinnedVariantId) ?? null : null,
      featured: placement.featured,
      active: source.type === 'menu' ? false : placement.active,
      sortOrder: placement.sortOrder,
    }
    duplicatedTargetPlacements.push({ id: targetPlacementId, payload: targetPlacementPayload, active: placement.active })
    batch.push({
      command: 'create_placement',
      payload: targetPlacementPayload,
    })
  }

  const targetSelectionGroupByName = new Map(targetCatalog.selectionGroups.map((group) => [`${normalizedCatalogName(group.name)}:${group.type}`, group]))
  const targetModifierGroupByName = new Map(targetCatalog.modifierGroups.map((group) => [normalizedCatalogName(group.name), group]))
  const targetStandardProductByName = new Map(targetCatalog.products.filter((item) => item.type === 'standard').map((item) => [normalizedCatalogName(item.name), item]))
  const createdGroupIdBySourceId = new Map<string, string>()
  const assignments = [
    ...sourceCatalog.selectionAssignments.filter((item) => item.productId === sourceProductId).map((assignment) => ({ assignment, domain: 'selection' as const })),
    ...sourceCatalog.modifierAssignments.filter((item) => item.productId === sourceProductId).map((assignment) => ({ assignment, domain: 'modifier' as const })),
  ]
  for (const { assignment, domain } of assignments) {
    const sourceGroup = domain === 'selection'
      ? sourceCatalog.selectionGroups.find((group) => group.id === assignment.groupId)
      : sourceCatalog.modifierGroups.find((group) => group.id === assignment.groupId)
    const requiresLocalMenuGroup = source.type === 'menu' && domain === 'selection'
      && sourceGroup && 'type' in sourceGroup && sourceGroup.type === 'menu_component'
    let targetGroup = !requiresLocalMenuGroup && domain === 'selection' && sourceGroup && 'type' in sourceGroup
      ? targetSelectionGroupByName.get(`${normalizedCatalogName(sourceGroup.name)}:${sourceGroup.type}`)
      : !requiresLocalMenuGroup && sourceGroup ? targetModifierGroupByName.get(normalizedCatalogName(sourceGroup.name)) : null
    let targetGroupId = targetGroup?.id ?? (sourceGroup ? createdGroupIdBySourceId.get(sourceGroup.id) : undefined)
    if (!targetGroupId && sourceGroup && domain === 'selection' && 'type' in sourceGroup) {
      targetGroupId = createId()
      createdGroupIdBySourceId.set(sourceGroup.id, targetGroupId)
      batch.push({ command: 'save_selection_group', payload: { id: targetGroupId, name: sourceGroup.name, type: sourceGroup.type, active: sourceGroup.active, sortOrder: targetCatalog.selectionGroups.length * 10 + createdGroupIdBySourceId.size * 10 } })
      for (const option of sourceCatalog.selectionOptions.filter((item) => item.groupId === sourceGroup.id)) {
        const sourceOptionProduct = sourceCatalog.products.find((item) => item.id === option.productId)
        const targetOptionProduct = sourceOptionProduct ? targetStandardProductByName.get(normalizedCatalogName(sourceOptionProduct.name)) : null
        if (!targetOptionProduct) throw new Error(`No se puede duplicar el menú: falta el producto “${sourceOptionProduct?.name ?? 'desconocido'}” en el local destino.`)
        const sourceOptionVariant = sourceCatalog.variants.find((item) => item.id === option.variantId)
        const targetOptionVariant = sourceOptionVariant
          ? targetCatalog.variants.find((item) => item.productId === targetOptionProduct.id && normalizedCatalogName(item.name) === normalizedCatalogName(sourceOptionVariant.name))
          : null
        batch.push({ command: 'save_selection_option', payload: { id: createId(), groupId: targetGroupId, productId: targetOptionProduct.id, variantId: targetOptionVariant?.id ?? null, supplementCents: option.supplementCents, defaultQuantity: sourceGroup.type === 'menu_component' ? 0 : option.defaultQuantity, maxQuantity: option.maxQuantity, active: option.active, sortOrder: option.sortOrder } })
      }
    } else if (!targetGroupId && sourceGroup && domain === 'modifier') {
      targetGroupId = createId()
      createdGroupIdBySourceId.set(sourceGroup.id, targetGroupId)
      batch.push({ command: 'save_modifier_group', payload: { id: targetGroupId, name: sourceGroup.name, active: sourceGroup.active, sortOrder: targetCatalog.modifierGroups.length * 10 + createdGroupIdBySourceId.size * 10 } })
      for (const modifier of sourceCatalog.modifiers.filter((item) => item.groupId === sourceGroup.id)) {
        batch.push({ command: 'save_modifier', payload: { id: createId(), groupId: targetGroupId, name: modifier.name, supplementCents: modifier.supplementCents, isDefault: modifier.isDefault, active: modifier.active, sortOrder: modifier.sortOrder } })
      }
    }
    if (!targetGroupId) throw new Error('No se pudo resolver una dependencia del producto en el local destino.')
    batch.push({
      command: 'save_assignment',
      payload: {
        id: createId(),
        domain,
        productId,
        groupId: targetGroupId,
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
  if (source.type === 'menu' && source.active) {
    batch.push({ command: 'set_product_active', payload: { id: productId, active: true } })
    for (const placement of duplicatedTargetPlacements) {
      batch.push({ command: 'update_placement', payload: { ...placement.payload, id: placement.id, active: placement.active } })
    }
  }

  return {
    batch,
    image: source.image,
    newFormats: [...newFormatBySourceId.values()],
    productId,
    variantFormats: variants.flatMap((variant) => variant.formatId ? [{ variantId: variant.id, formatId: variant.formatId }] : []),
  }
}
