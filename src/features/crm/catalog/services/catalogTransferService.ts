import type { CatalogData } from '../../../catalog/domain/types.ts'
import { CatalogDomainError, toCatalogDomainError } from '../../../catalog/domain/errors.ts'
import type { RevoImportProduct } from '../../../../lib/revoImport.ts'
import { PRODUCT_IMAGE_BUCKET } from '../../../../lib/productImages.ts'
import { supabase } from '../../../../lib/supabase.ts'
import { catalogAdminService } from './catalogAdminService.ts'
import {
  buildRevoCatalogImportPlan,
  splitRevoCatalogImportPlan,
  type FinalCatalogImportResult,
} from './revoCatalogImportPlan.ts'
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

function catalogErrorDiagnostic(error: unknown) {
  if (!(error instanceof Error)) return 'Error desconocido del servidor.'
  const databaseDetails = error instanceof CatalogDomainError ? error.details : {}
  const parts = [
    error.message,
    databaseDetails.databaseMessage,
    databaseDetails.databaseDetails,
    databaseDetails.databaseHint,
    databaseDetails.databaseCode ? `Código PostgreSQL: ${String(databaseDetails.databaseCode)}` : null,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
  return [...new Set(parts)].join(' · ')
}

async function materializeRevoSaleFormats(
  catalog: CatalogData,
  products: readonly RevoImportProduct[],
  onProgress?: CatalogImportProgressHandler,
) {
  const requiredFormats = new Map<string, string>()
  for (const product of products) {
    for (const variant of product.variants) {
      const formatKey = key(variant.formatName)
      if (!requiredFormats.has(formatKey)) requiredFormats.set(formatKey, variant.formatName.trim())
    }
  }

  const existingFormats = new Map(catalog.saleFormats.map((format) => [key(format.name), format]))
  let sortOrder = catalog.saleFormats.reduce((maximum, format) => Math.max(maximum, format.sortOrder), -10) + 10
  let completed = 0
  let created = 0
  for (const [formatKey, formatName] of requiredFormats) {
    const existing = existingFormats.get(formatKey)
    if (!existing) {
      await catalogAdminService.saveSaleFormat(catalog.venueId, {
        name: formatName,
        active: true,
        sortOrder,
      })
      sortOrder += 10
      created += 1
    } else if (!existing.active) {
      await catalogAdminService.saveSaleFormat(catalog.venueId, {
        id: existing.id,
        name: existing.name,
        inventoryConsumptionQuantity: existing.inventoryConsumptionQuantity,
        inventoryConsumptionUnitId: existing.inventoryConsumptionUnitId,
        active: true,
        sortOrder: existing.sortOrder,
      })
    }
    completed += 1
    reportProgress(
      onProgress,
      8 + (completed / Math.max(1, requiredFormats.size)) * 12,
      `Preparando formatos REVO (${completed}/${requiredFormats.size})`,
    )
  }

  return {
    catalog: await catalogAdminService.load(catalog.venueId, true),
    created,
  }
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

export type { FinalCatalogImportResult } from './revoCatalogImportPlan.ts'

export type CatalogClearCounts = {
  categories: number
  formats: number
  images: number
  modifierAssignments: number
  modifierGroups: number
  modifiers: number
  placements: number
  products: number
  selectionAssignments: number
  selectionGroups: number
  selectionOptions: number
  tabCategories: number
  tabs: number
  variants: number
}

export type CatalogClearResult = {
  counts: CatalogClearCounts
  imageFilesRemoved: number
  imageStorageCleanupPending: boolean
}

function catalogClearFallbackCounts(catalog: CatalogData): CatalogClearCounts {
  return {
    categories: catalog.categories.length,
    formats: catalog.saleFormats.length,
    images: catalog.products.filter((product) => product.image !== null).length,
    modifierAssignments: catalog.modifierAssignments.length,
    modifierGroups: catalog.modifierGroups.length,
    modifiers: catalog.modifiers.length,
    placements: catalog.placements.length,
    products: catalog.products.length,
    selectionAssignments: catalog.selectionAssignments.length,
    selectionGroups: catalog.selectionGroups.length,
    selectionOptions: catalog.selectionOptions.length,
    tabCategories: catalog.tabCategories.length,
    tabs: catalog.tabs.length,
    variants: catalog.variants.length,
  }
}

function readCatalogClearCounts(value: unknown, fallback: CatalogClearCounts) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const source = value as Record<string, unknown>
  return Object.fromEntries(Object.entries(fallback).map(([name, fallbackValue]) => {
    const parsed = source[name]
    return [name, typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallbackValue]
  })) as CatalogClearCounts
}

export async function clearFinalCatalog(catalog: CatalogData): Promise<CatalogClearResult> {
  const client = requireClient()
  const fallbackCounts = catalogClearFallbackCounts(catalog)
  const { data, error } = await client.rpc('clear_catalog', { p_venue_id: catalog.venueId })
  if (error) throw toCatalogDomainError(error, 'No se pudo borrar el catálogo del local.')

  catalogAdminService.invalidate(catalog.venueId)
  const response = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
  const removedImagePaths = Array.isArray(response.removedImagePaths)
    ? [...new Set(response.removedImagePaths.filter((path): path is string => typeof path === 'string' && path.length > 0))]
    : []
  let imageStorageCleanupPending = false
  if (removedImagePaths.length) {
    const { error: storageError } = await client.storage.from(PRODUCT_IMAGE_BUCKET).remove(removedImagePaths)
    imageStorageCleanupPending = storageError !== null
  }

  return {
    counts: readCatalogClearCounts(response.counts, fallbackCounts),
    imageFilesRemoved: imageStorageCleanupPending ? 0 : removedImagePaths.length,
    imageStorageCleanupPending,
  }
}

export async function importRevoIntoFinalCatalog(
  catalog: CatalogData,
  products: readonly RevoImportProduct[],
  onProgress?: CatalogImportProgressHandler,
): Promise<FinalCatalogImportResult> {
  if (!products.length) throw new Error('No hay productos para importar.')
  reportProgress(onProgress, 5, 'Preparando archivo REVO')
  const latestCatalog = await catalogAdminService.load(catalog.venueId, true)
  const prepared = await materializeRevoSaleFormats(latestCatalog, products, onProgress)
  const plan = buildRevoCatalogImportPlan(prepared.catalog, products, catalogAdminService.uuid)
  const chunks = splitRevoCatalogImportPlan(plan)
  reportProgress(onProgress, 25, `Catálogo preparado (${products.length} productos)`)

  for (const [index, chunk] of chunks.entries()) {
    reportProgress(
      onProgress,
      25 + (index / Math.max(1, chunks.length)) * 70,
      `Guardando catálogo REVO (${index + 1}/${chunks.length})`,
    )
    try {
      if (chunk.variantFormats.length) {
        await catalogAdminService.batchWithVariantFormats(
          prepared.catalog.venueId,
          chunk.batch,
          chunk.variantFormats,
        )
      } else {
        await catalogAdminService.batch(prepared.catalog.venueId, chunk.batch)
      }
    } catch (error) {
      const detail = catalogErrorDiagnostic(error)
      throw new Error(`Error en el lote REVO ${index + 1}/${chunks.length}: ${detail}`, { cause: error })
    }
  }
  plan.result.formats = prepared.created
  reportProgress(onProgress, 100, 'Importación REVO completada')
  return plan.result
}
