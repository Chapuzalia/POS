import type { CatalogBatchCommand } from '../../../catalog/data/commands.ts'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import type { RevoImportProduct } from '../../../../lib/revoImport.ts'
import { PRODUCT_IMAGE_BUCKET } from '../../../../lib/productImages.ts'
import { supabase } from '../../../../lib/supabase.ts'
import { catalogAdminService } from './catalogAdminService.ts'
import {
  CATALOG_EXPORT_FORMAT,
  CATALOG_EXPORT_SCHEMA_VERSION,
  buildCatalogImportIds,
  getCatalogImportSummary,
  type CatalogExportDocument,
  type CatalogExportImage,
  type CatalogImportSummary,
} from './catalogTransferDocument.ts'

function key(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}

function requireClient() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}
export type CatalogImportProgress = {
  label: string
  value: number
}

type CatalogImportProgressHandler = (progress: CatalogImportProgress) => void

function reportProgress(handler: CatalogImportProgressHandler | undefined, value: number, label: string) {
  handler?.({ label, value: Math.min(100, Math.max(0, Math.round(value))) })
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

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('No se ha podido incluir una imagen en la exportación.'))
    reader.readAsDataURL(blob)
  })
}

function imageBlobFromDataUrl(dataUrl: string) {
  const match = /^data:(image\/(?:webp|png|jpeg|avif));base64,([a-z0-9+/=]+)$/i.exec(dataUrl)
  if (!match) throw new Error('El catálogo contiene una imagen no válida.')
  const binary = window.atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: match[1].toLowerCase() })
}

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function imageExtension(mimeType: string) {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/avif') return 'avif'
  return 'webp'
}

function exportedImages(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La exportación ha devuelto un documento no válido.')
  const document = value as Record<string, unknown>
  if (document.format !== CATALOG_EXPORT_FORMAT || document.schemaVersion !== CATALOG_EXPORT_SCHEMA_VERSION) {
    throw new Error('La base de datos todavía no tiene instalada la migración de importación/exportación completa.')
  }
  const catalog = document.catalog
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('La exportación no contiene un catálogo válido.')
  const images = (catalog as Record<string, unknown>).images
  if (!Array.isArray(images)) throw new Error('La exportación no contiene la colección de imágenes.')
  return { catalog: catalog as Record<string, unknown>, document, images: images as CatalogExportImage[] }
}

export async function exportFinalCatalog(venueId: string, venueName: string) {
  const client = requireClient()
  const { data, error } = await client.rpc('export_catalog', { p_venue_id: venueId })
  if (error) throw error

  const exported = exportedImages(data)
  const images = await Promise.all(exported.images.map(async (image) => {
    if (image.missing === true) return image
    const source = image.source
    const storagePath = source && typeof source === 'object' && !Array.isArray(source)
      ? (source as Record<string, unknown>).storagePath
      : null
    if (typeof storagePath !== 'string' || !storagePath) throw new Error(`No se ha encontrado la ruta de la imagen ${image.ref}.`)
    const { data: blob, error: downloadError } = await client.storage.from(PRODUCT_IMAGE_BUCKET).download(storagePath)
    if (downloadError) throw downloadError
    return { ...image, dataBase64: await blobToDataUrl(blob) }
  }))

  downloadJson({
    ...exported.document,
    catalog: { ...exported.catalog, images },
  }, venueName)
}

export type OwnCatalogImportResult = CatalogImportSummary

export async function importOwnCatalog(
  targetCatalog: CatalogData,
  document: CatalogExportDocument,
  onProgress?: CatalogImportProgressHandler,
): Promise<OwnCatalogImportResult> {
  const client = requireClient()
  const generatedIds = buildCatalogImportIds(document)
  const imagePaths: Record<string, string> = {}
  const uploadedPaths: string[] = []

  reportProgress(onProgress, 5, 'Validando catálogo')
  try {
    const importableImages = document.catalog.images.filter((image) => image.missing !== true)
    let uploadedImageCount = 0
    for (const rawImage of document.catalog.images) {
      const image = rawImage as CatalogExportImage
      if (image.missing === true) continue
      if (typeof image.dataBase64 !== 'string') throw new Error(`Faltan los datos de la imagen ${image.ref}.`)
      const blob = imageBlobFromDataUrl(image.dataBase64)
      if (blob.size <= 0 || blob.size > 1024 * 1024) throw new Error(`La imagen ${image.ref} supera el máximo de 1 MB.`)
      if (typeof image.mimeType !== 'string' || blob.type !== image.mimeType.toLowerCase()) {
        throw new Error(`El tipo de la imagen ${image.ref} no coincide con su contenido.`)
      }
      if (typeof image.sizeBytes === 'number' && image.sizeBytes !== blob.size) {
        throw new Error(`El tamaño de la imagen ${image.ref} no coincide con el documento.`)
      }
      if (typeof image.sha256 !== 'string' || await sha256(blob) !== image.sha256) {
        throw new Error(`La integridad de la imagen ${image.ref} no es válida.`)
      }

      const productRef = String(image.productRef ?? '')
      const productId = generatedIds.products[productRef]
      const imageId = generatedIds.images[image.ref]
      if (!productId || !imageId) throw new Error(`La imagen ${image.ref} apunta a un producto inexistente.`)
      const storagePath = `${targetCatalog.tenantId}/${targetCatalog.venueId}/products/${productId}/${imageId}.${imageExtension(blob.type)}`
      const { error: uploadError } = await client.storage.from(PRODUCT_IMAGE_BUCKET).upload(storagePath, blob, {
        cacheControl: '31536000',
        contentType: blob.type,
        upsert: false,
      })
      if (uploadError) throw uploadError
      imagePaths[image.ref] = storagePath
      uploadedPaths.push(storagePath)
      uploadedImageCount += 1
      reportProgress(
        onProgress,
        10 + (uploadedImageCount / Math.max(1, importableImages.length)) * 55,
        `Subiendo imágenes (${uploadedImageCount}/${importableImages.length})`,
      )
    }
    if (!importableImages.length) reportProgress(onProgress, 65, 'Catálogo preparado')

    const databaseDocument = {
      ...document,
      catalog: {
        ...document.catalog,
        images: document.catalog.images.map(({ dataBase64: _dataBase64, ...image }) => image),
      },
    }
    reportProgress(onProgress, 72, 'Reemplazando catálogo')
    const { data, error } = await client.rpc('import_catalog', {
      p_mode: 'replace',
      p_plan: {
        document: databaseDocument,
        generatedIds,
        imagePaths,
        venueId: targetCatalog.venueId,
      },
      p_venue_id: targetCatalog.venueId,
    })
    if (error) throw error

    const removedPaths = data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).removedImagePaths
      : null
    reportProgress(onProgress, 92, 'Limpiando imágenes anteriores')
    if (Array.isArray(removedPaths)) {
      const stalePaths = removedPaths.filter((path): path is string => typeof path === 'string' && !uploadedPaths.includes(path))
      if (stalePaths.length) await client.storage.from(PRODUCT_IMAGE_BUCKET).remove(stalePaths)
    }
    reportProgress(onProgress, 100, 'Importación completada')
    return getCatalogImportSummary(document)
  } catch (error) {
    if (uploadedPaths.length) await client.storage.from(PRODUCT_IMAGE_BUCKET).remove(uploadedPaths)
    throw error
  }
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
  onProgress?: CatalogImportProgressHandler,
): Promise<FinalCatalogImportResult> {
  if (!products.length) throw new Error('No hay productos para importar.')
  reportProgress(onProgress, 5, 'Preparando archivo REVO')
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

  for (const [productIndex, imported] of products.entries()) {
    reportProgress(
      onProgress,
      10 + (productIndex / products.length) * 60,
      `Preparando productos (${productIndex + 1}/${products.length})`,
    )
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
  reportProgress(onProgress, 75, 'Guardando catálogo REVO')
  await catalogAdminService.batchWithVariantFormats(catalog.venueId, batch, variantFormats, formatSaves)
  reportProgress(onProgress, 100, 'Importación REVO completada')
  return result
}
