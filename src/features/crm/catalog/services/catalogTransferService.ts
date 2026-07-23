import type { CatalogBatchCommand } from '../../../catalog/data/commands.ts'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import type { RevoImportProduct } from '../../../../lib/revoImport.ts'
import { supabase } from '../../../../lib/supabase.ts'
import { catalogAdminService } from './catalogAdminService.ts'

function key(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}

function downloadJson(value: unknown, venueName: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `catalogo-${key(venueName).replace(/[^a-z0-9]+/g, '-') || 'local'}-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function exportFinalCatalog(venueId: string, venueName: string) {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { data, error } = await supabase.rpc('export_catalog', { p_venue_id: venueId })
  if (error) throw error
  downloadJson(data, venueName)
}

export type FinalCatalogImportResult = {
  categories: number
  formats: number
  products: number
  variants: number
  placements: number
}

export async function importRevoIntoFinalCatalog(
  catalog: CatalogData,
  products: readonly RevoImportProduct[],
): Promise<FinalCatalogImportResult> {
  if (!products.length) throw new Error('No hay productos para importar.')
  const batch: CatalogBatchCommand[] = []
  const categoriesByName = new Map(catalog.categories.map((category) => [key(category.name), category.id]))
  const formatsByName = new Map(catalog.saleFormats.map((format) => [key(format.name), format]))
  const productsByName = new Map(catalog.products.map((product) => [key(product.name), product]))
  const formatSaves: Array<{ id: string; name: string; active: boolean; sortOrder: number }> = []
  const variantFormats: Array<{ variantId: string; formatId: string }> = []
  let tabId = catalog.tabs.find((tab) => tab.active)?.id
  if (!tabId) {
    tabId = catalogAdminService.uuid()
    batch.push({ command: 'save_tab', payload: { id: tabId, key: 'productos', label: 'Productos', icon: 'receipt', active: true, sortOrder: 0 } })
  }
  const associatedCategoryIds = new Set(catalog.tabCategories.filter((relation) => relation.tabId === tabId).map((relation) => relation.categoryId))
  const result: FinalCatalogImportResult = { categories: 0, formats: 0, products: 0, variants: 0, placements: 0 }

  function getFormatId(formatName: string) {
    const formatKey = key(formatName)
    const existing = formatsByName.get(formatKey)
    if (existing) {
      if (!existing.active && !formatSaves.some((format) => format.id === existing.id)) {
        formatSaves.push({ id: existing.id, name: existing.name, active: true, sortOrder: existing.sortOrder })
      }
      return existing.id
    }
    const created = { id: catalogAdminService.uuid(), name: formatName.trim(), active: true, sortOrder: (catalog.saleFormats.length + formatSaves.length) * 10 }
    formatsByName.set(formatKey, { ...created, tenantId: catalog.tenantId, venueId: catalog.venueId, createdAt: '', updatedAt: '' })
    formatSaves.push(created)
    result.formats += 1
    return created.id
  }

  for (const imported of products) {
    const categoryKey = key(imported.categoryName)
    let categoryId = categoriesByName.get(categoryKey)
    if (!categoryId) {
      categoryId = catalogAdminService.uuid()
      categoriesByName.set(categoryKey, categoryId)
      batch.push({ command: 'save_category', payload: { id: categoryId, name: imported.categoryName, active: true, unused: false, sortOrder: categoriesByName.size * 10 } })
      result.categories += 1
    }
    if (!associatedCategoryIds.has(categoryId)) {
      associatedCategoryIds.add(categoryId)
      batch.push({ command: 'save_tab_category', payload: { id: catalogAdminService.uuid(), tabId, categoryId, active: true, sortOrder: associatedCategoryIds.size * 10 } } as CatalogBatchCommand)
    }

    const existing = productsByName.get(key(imported.name))
    const productId = existing?.id ?? catalogAdminService.uuid()
    if (existing) {
      batch.push({ command: 'update_product', payload: { id: productId, type: 'standard', name: imported.name, active: imported.active, sortOrder: existing.sortOrder } })
      const existingVariants = catalog.variants.filter((variant) => variant.productId === productId)
      const variantsByName = new Map(existingVariants.map((variant) => [key(variant.name), variant]))
      imported.variants.forEach((variant, index) => {
        const current = variantsByName.get(key(variant.name))
        const formatId = getFormatId(variant.name)
        const variantId = current?.id ?? catalogAdminService.uuid()
        batch.push(current
          ? { command: 'update_variant', payload: { id: variantId, productId, name: variant.name, priceCents: variant.priceCents, sku: current.sku, active: true, isDefault: current.isDefault, sortOrder: index * 10 } }
          : { command: 'create_variant', payload: { id: variantId, productId, name: variant.name, priceCents: variant.priceCents, sku: null, active: true, isDefault: existingVariants.length === 0 && index === 0, sortOrder: index * 10 } })
        variantFormats.push({ variantId, formatId })
        result.variants += 1
      })
    } else {
      const variants = imported.variants.map((variant, index) => {
        const id = catalogAdminService.uuid()
        const formatId = getFormatId(variant.name)
        variantFormats.push({ variantId: id, formatId })
        return { id, formatId, name: variant.name, priceCents: variant.priceCents, active: true, isDefault: index === 0, sortOrder: index * 10 }
      })
      batch.push({ command: 'create_product', payload: { id: productId, type: 'standard', name: imported.name, description: null, vatRate: null, active: imported.active, sortOrder: catalog.products.length * 10 + result.products * 10, variants } })
      result.products += 1
      result.variants += variants.length
    }
    if (!catalog.placements.some((placement) => placement.productId === productId && placement.tabId === tabId && placement.categoryId === categoryId)) {
      batch.push({ command: 'create_placement', payload: { id: catalogAdminService.uuid(), productId, tabId, categoryId, pinnedVariantId: null, featured: false, active: true, sortOrder: result.placements * 10 } })
      result.placements += 1
    }
  }
  await catalogAdminService.batchWithVariantFormats(catalog.venueId, batch, variantFormats, formatSaves)
  return result
}
