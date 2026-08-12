import type { CatalogBatchCommand } from '../../../catalog/data/commands.ts'
import type { CatalogData, CatalogPlacement, CatalogVariant } from '../../../catalog/domain/types.ts'
import type { RevoImportProduct } from '../../../../lib/revoImport.ts'

function key(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}

function nextSortOrder(items: readonly { sortOrder: number }[]) {
  return items.reduce((maximum, item) => Math.max(maximum, item.sortOrder), -10) + 10
}

function placementKey(tabId: string, categoryId: string) {
  return `${tabId}:${categoryId}`
}

function uniqueTabKey(label: string, usedKeys: Set<string>) {
  const base = key(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'revo'
  let candidate = base
  let suffix = 2
  while (usedKeys.has(candidate)) {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  usedKeys.add(candidate)
  return candidate
}

export type FinalCatalogImportResult = {
  categories: number
  categoryLinks: number
  formats: number
  placements: number
  placementsUpdated: number
  products: number
  productsUpdated: number
  tabs: number
  variants: number
  variantsUpdated: number
}

export type RevoCatalogImportPlan = {
  batch: CatalogBatchCommand[]
  formatSaves: Array<{ id: string; name: string; active: boolean; sortOrder: number }>
  result: FinalCatalogImportResult
  variantFormats: Array<{ variantId: string; formatId: string }>
}

export type RevoCatalogImportChunk = {
  batch: CatalogBatchCommand[]
  variantFormats: Array<{ variantId: string; formatId: string }>
}

type ExistingProductTarget = {
  id: string
  placements: CatalogPlacement[]
  sortOrder: number
  variants: CatalogVariant[]
}

export function buildRevoCatalogImportPlan(
  catalog: CatalogData,
  products: readonly RevoImportProduct[],
  createId: () => string,
): RevoCatalogImportPlan {
  if (!products.length) throw new Error('No hay productos para importar.')

  const batch: CatalogBatchCommand[] = []
  const formatSaves: RevoCatalogImportPlan['formatSaves'] = []
  const variantFormats: RevoCatalogImportPlan['variantFormats'] = []
  const result: FinalCatalogImportResult = {
    categories: 0,
    categoryLinks: 0,
    formats: 0,
    placements: 0,
    placementsUpdated: 0,
    products: 0,
    productsUpdated: 0,
    tabs: 0,
    variants: 0,
    variantsUpdated: 0,
  }

  const formatsByName = new Map(catalog.saleFormats.map((format) => [key(format.name), {
    active: format.active,
    id: format.id,
    name: format.name,
    sortOrder: format.sortOrder,
  }]))
  const scheduledFormatIds = new Set<string>()
  let nextFormatSortOrder = nextSortOrder(catalog.saleFormats)

  function getFormat(formatName: string) {
    const formatKey = key(formatName)
    const existing = formatsByName.get(formatKey)
    if (existing) {
      if (!existing.active && !scheduledFormatIds.has(existing.id)) {
        scheduledFormatIds.add(existing.id)
        formatSaves.push({ id: existing.id, name: existing.name, active: true, sortOrder: existing.sortOrder })
      }
      return existing
    }

    const created = { id: createId(), name: formatName.trim(), active: true, sortOrder: nextFormatSortOrder }
    nextFormatSortOrder += 10
    formatsByName.set(formatKey, created)
    scheduledFormatIds.add(created.id)
    formatSaves.push(created)
    result.formats += 1
    return created
  }

  const usedTabKeys = new Set(catalog.tabs.map((tab) => key(tab.key)))
  const tabsByName = new Map<string, { id: string; label: string }>()
  for (const tab of catalog.tabs) {
    tabsByName.set(key(tab.label), { id: tab.id, label: tab.label })
    if (!tabsByName.has(key(tab.key))) tabsByName.set(key(tab.key), { id: tab.id, label: tab.label })
  }
  const scheduledTabIds = new Set<string>()
  let nextTabSortOrder = nextSortOrder(catalog.tabs)

  function getTab(tabName: string) {
    const tabKey = key(tabName)
    const found = tabsByName.get(tabKey)
    if (found) {
      const existing = catalog.tabs.find((tab) => tab.id === found.id)
      if (existing && !existing.active && !scheduledTabIds.has(existing.id)) {
        scheduledTabIds.add(existing.id)
        batch.push({
          command: 'save_tab',
          payload: {
            id: existing.id,
            key: existing.key,
            label: existing.label,
            icon: existing.icon,
            active: true,
            sortOrder: existing.sortOrder,
          },
        })
      }
      return found
    }

    const created = { id: createId(), label: tabName.trim() }
    tabsByName.set(tabKey, created)
    batch.push({
      command: 'save_tab',
      payload: {
        id: created.id,
        key: uniqueTabKey(created.label, usedTabKeys),
        label: created.label,
        icon: 'receipt',
        active: true,
        sortOrder: nextTabSortOrder,
      },
    })
    nextTabSortOrder += 10
    result.tabs += 1
    return created
  }

  const categoriesByName = new Map(catalog.categories.map((category) => [key(category.name), {
    active: category.active,
    icon: category.icon,
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    unused: category.unused,
  }]))
  const scheduledCategoryIds = new Set<string>()
  let nextCategorySortOrder = nextSortOrder(catalog.categories)

  function getCategory(categoryName: string) {
    const categoryKey = key(categoryName)
    const existing = categoriesByName.get(categoryKey)
    if (existing) {
      if ((!existing.active || existing.unused) && !scheduledCategoryIds.has(existing.id)) {
        scheduledCategoryIds.add(existing.id)
        batch.push({
          command: 'save_category',
          payload: {
            id: existing.id,
            name: existing.name,
            icon: existing.icon,
            unused: false,
            active: true,
            sortOrder: existing.sortOrder,
          },
        })
      }
      return existing
    }

    const created = {
      active: true,
      icon: null,
      id: createId(),
      name: categoryName.trim(),
      sortOrder: nextCategorySortOrder,
      unused: false,
    }
    nextCategorySortOrder += 10
    categoriesByName.set(categoryKey, created)
    batch.push({
      command: 'save_category',
      payload: { id: created.id, name: created.name, active: true, unused: false, sortOrder: created.sortOrder },
    })
    result.categories += 1
    return created
  }

  const tabCategoriesByKey = new Map(catalog.tabCategories.map((relation) => [
    placementKey(relation.tabId, relation.categoryId),
    { active: relation.active, id: relation.id, sortOrder: relation.sortOrder },
  ]))
  const nextTabCategorySortOrder = new Map(catalog.tabs.map((tab) => [
    tab.id,
    nextSortOrder(catalog.tabCategories.filter((relation) => relation.tabId === tab.id)),
  ]))

  function ensureTabCategory(tabId: string, categoryId: string) {
    const relationKey = placementKey(tabId, categoryId)
    const existing = tabCategoriesByKey.get(relationKey)
    if (existing) {
      if (!existing.active) {
        batch.push({
          command: 'save_tab_category',
          payload: { id: existing.id, tabId, categoryId, active: true, sortOrder: existing.sortOrder },
        })
      }
      return
    }

    const sortOrder = nextTabCategorySortOrder.get(tabId) ?? 0
    nextTabCategorySortOrder.set(tabId, sortOrder + 10)
    const created = { active: true, id: createId(), sortOrder }
    tabCategoriesByKey.set(relationKey, created)
    batch.push({
      command: 'save_tab_category',
      payload: { id: created.id, tabId, categoryId, active: true, sortOrder },
    })
    result.categoryLinks += 1
  }

  const variantsByProductId = new Map<string, CatalogVariant[]>()
  for (const variant of catalog.variants) {
    const current = variantsByProductId.get(variant.productId) ?? []
    current.push(variant)
    variantsByProductId.set(variant.productId, current)
  }
  const placementsByProductId = new Map<string, CatalogPlacement[]>()
  for (const placement of catalog.placements) {
    const current = placementsByProductId.get(placement.productId) ?? []
    current.push(placement)
    placementsByProductId.set(placement.productId, current)
  }
  const targetsByName = new Map<string, ExistingProductTarget[]>()
  for (const product of catalog.products) {
    const current = targetsByName.get(key(product.name)) ?? []
    current.push({
      id: product.id,
      placements: placementsByProductId.get(product.id) ?? [],
      sortOrder: product.sortOrder,
      variants: variantsByProductId.get(product.id) ?? [],
    })
    current.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    targetsByName.set(key(product.name), current)
  }
  const importedNameCounts = new Map<string, number>()
  for (const product of products) {
    const productNameKey = key(product.name)
    importedNameCounts.set(productNameKey, (importedNameCounts.get(productNameKey) ?? 0) + 1)
  }
  const claimedProductIds = new Set<string>()
  let nextProductSortOrder = nextSortOrder(catalog.products)
  const nextPlacementSortOrder = new Map<string, number>()
  for (const placement of catalog.placements) {
    const targetKey = placementKey(placement.tabId, placement.categoryId ?? '')
    nextPlacementSortOrder.set(targetKey, Math.max(nextPlacementSortOrder.get(targetKey) ?? 0, placement.sortOrder + 10))
  }

  function findExistingProduct(product: RevoImportProduct, tabId: string, categoryId: string) {
    const productNameKey = key(product.name)
    const candidates = (targetsByName.get(productNameKey) ?? []).filter((candidate) => !claimedProductIds.has(candidate.id))
    const exact = candidates.filter((candidate) => candidate.placements.some((placement) => (
      placement.tabId === tabId && placement.categoryId === categoryId
    )))
    const target = exact[0] ?? (importedNameCounts.get(productNameKey) === 1 && candidates.length === 1 ? candidates[0] : null)
    if (target) claimedProductIds.add(target.id)
    return target
  }

  products.forEach((imported) => {
    const tab = getTab(imported.tabName)
    const category = getCategory(imported.categoryName)
    ensureTabCategory(tab.id, category.id)
    const existing = findExistingProduct(imported, tab.id, category.id)
    const productId = existing?.id ?? createId()

    if (existing) {
      batch.push({
        command: 'update_product',
        payload: {
          id: productId,
          type: 'standard',
          name: imported.name,
          vatRate: imported.vatRate,
          active: imported.active,
          sortOrder: existing.sortOrder,
        },
      })
      result.productsUpdated += 1

      const claimedVariantIds = new Set<string>()
      const activeDefaultId = existing.variants.find((variant) => variant.active && variant.isDefault)?.id
      let hasAssignedDefault = activeDefaultId !== undefined
      imported.variants.forEach((variant, index) => {
        const format = getFormat(variant.formatName)
        const current = existing.variants.find((candidate) => !claimedVariantIds.has(candidate.id)
          && (candidate.formatId === format.id || (!candidate.formatId && key(candidate.name) === key(format.name))))
        const variantId = current?.id ?? createId()
        const isDefault = current?.id === activeDefaultId || !hasAssignedDefault
        if (isDefault) hasAssignedDefault = true
        if (current) claimedVariantIds.add(current.id)
        batch.push(current ? {
          command: 'update_variant',
          payload: {
            id: variantId,
            productId,
            name: format.name,
            priceCents: variant.priceCents,
            sku: variant.sku ?? current.sku,
            active: true,
            isDefault,
            sortOrder: index * 10,
          },
        } : {
          command: 'create_variant',
          payload: {
            id: variantId,
            productId,
            name: format.name,
            priceCents: variant.priceCents,
            sku: variant.sku,
            active: true,
            isDefault,
            sortOrder: index * 10,
          },
        })
        variantFormats.push({ variantId, formatId: format.id })
        if (current) result.variantsUpdated += 1
        else result.variants += 1
      })
    } else {
      const variants = imported.variants.map((variant, index) => {
        const id = createId()
        const format = getFormat(variant.formatName)
        variantFormats.push({ variantId: id, formatId: format.id })
        return {
          id,
          formatId: format.id,
          name: format.name,
          priceCents: variant.priceCents,
          sku: variant.sku,
          active: true,
          isDefault: index === 0,
          sortOrder: index * 10,
        }
      })
      batch.push({
        command: 'create_product',
        payload: {
          id: productId,
          type: 'standard',
          name: imported.name,
          description: null,
          vatRate: imported.vatRate,
          active: imported.active,
          sortOrder: nextProductSortOrder,
          variants,
        },
      })
      nextProductSortOrder += 10
      result.products += 1
      result.variants += variants.length
    }

    const existingPlacement = existing?.placements.find((placement) => (
      placement.tabId === tab.id && placement.categoryId === category.id && placement.pinnedVariantId === null
    ))
    if (existingPlacement) {
      if (!existingPlacement.active) {
        batch.push({
          command: 'update_placement',
          payload: {
            id: existingPlacement.id,
            productId,
            tabId: tab.id,
            categoryId: category.id,
            pinnedVariantId: null,
            featured: existingPlacement.featured,
            active: true,
            sortOrder: existingPlacement.sortOrder,
          },
        })
        result.placementsUpdated += 1
      }
      return
    }

    const targetPlacementKey = placementKey(tab.id, category.id)
    const sortOrder = nextPlacementSortOrder.get(targetPlacementKey) ?? 0
    nextPlacementSortOrder.set(targetPlacementKey, sortOrder + 10)
    batch.push({
      command: 'create_placement',
      payload: {
        id: createId(),
        productId,
        tabId: tab.id,
        categoryId: category.id,
        pinnedVariantId: null,
        featured: false,
        active: true,
        sortOrder,
      },
    })
    result.placements += 1
  })

  return { batch, formatSaves, result, variantFormats }
}

export function splitRevoCatalogImportPlan(
  plan: Pick<RevoCatalogImportPlan, 'batch' | 'variantFormats'>,
  maxCommands = 80,
): RevoCatalogImportChunk[] {
  if (!Number.isSafeInteger(maxCommands) || maxCommands < 1) {
    throw new Error('El tamaño del lote REVO no es válido.')
  }

  const formatByVariantId = new Map(plan.variantFormats.map((relation) => [relation.variantId, relation]))
  const chunks: RevoCatalogImportChunk[] = []
  for (let start = 0; start < plan.batch.length; start += maxCommands) {
    const batch = plan.batch.slice(start, start + maxCommands)
    const variantIds = new Set<string>()
    for (const item of batch) {
      if (item.command === 'create_product' && Array.isArray(item.payload.variants)) {
        for (const variant of item.payload.variants) {
          if (variant && typeof variant === 'object' && 'id' in variant && typeof variant.id === 'string') {
            variantIds.add(variant.id)
          }
        }
      }
      if ((item.command === 'create_variant' || item.command === 'update_variant')
        && typeof item.payload.id === 'string') {
        variantIds.add(item.payload.id)
      }
    }
    chunks.push({
      batch,
      variantFormats: [...variantIds].flatMap((variantId) => {
        const relation = formatByVariantId.get(variantId)
        return relation ? [relation] : []
      }),
    })
  }
  return chunks
}
