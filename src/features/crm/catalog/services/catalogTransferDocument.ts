export const CATALOG_EXPORT_FORMAT = 'club-pos-catalog-export'
export const CATALOG_EXPORT_SCHEMA_VERSION = 4

export const catalogExportCollections = [
  'categories',
  'saleFormats',
  'tabs',
  'tabCategories',
  'products',
  'variants',
  'placements',
  'selectionGroups',
  'selectionGroupOptions',
  'selectionAssignments',
  'modifierGroups',
  'modifiers',
  'modifierAssignments',
  'images',
] as const

export type CatalogExportCollection = typeof catalogExportCollections[number]
export type CatalogExportEntity = Record<string, unknown> & { ref: string }
export type CatalogExportImage = CatalogExportEntity & {
  dataBase64?: string
  mimeType?: string
  missing?: boolean
  productRef?: string
  sha256?: string
  sizeBytes?: number
}

export type CatalogExportDocument = {
  catalog: Record<CatalogExportCollection, CatalogExportEntity[]>
  format: typeof CATALOG_EXPORT_FORMAT
  metadata?: Record<string, unknown>
  schemaVersion: number
}

export type CatalogImportSummary = {
  categories: number
  formats: number
  images: number
  modifiers: number
  placements: number
  products: number
  selectionGroups: number
  tabs: number
  variants: number
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} debe ser un objeto.`)
  }
  return value as JsonObject
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} debe ser un texto no vacío.`)
  }
  return value
}

function entityRefs(entities: CatalogExportEntity[], label: string) {
  const refs = new Set<string>()
  for (const [index, entity] of entities.entries()) {
    const ref = requiredString(entity.ref, `${label}[${index}].ref`)
    if (refs.has(ref)) throw new Error(`${label} contiene la referencia duplicada ${ref}.`)
    refs.add(ref)
  }
  return refs
}

function requireRelatedRef(
  entity: CatalogExportEntity,
  field: string,
  refs: Set<string>,
  label: string,
  optional = false,
) {
  const value = entity[field]
  if (optional && (value === null || value === undefined || value === '')) return
  const ref = requiredString(value, `${label}.${field}`)
  if (!refs.has(ref)) throw new Error(`${label}.${field} apunta a una referencia inexistente.`)
}

function requireVariantRefs(entity: CatalogExportEntity, variants: Set<string>, label: string) {
  const value = entity.variantRefs
  if (!Array.isArray(value)) throw new Error(`${label}.variantRefs debe ser un array.`)
  for (const ref of value) {
    if (typeof ref !== 'string' || !variants.has(ref)) {
      throw new Error(`${label}.variantRefs contiene una referencia inexistente.`)
    }
  }
}

export function parseCatalogExportJson(text: string): CatalogExportDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('El archivo no contiene un JSON válido.')
  }

  const root = asObject(parsed, 'El documento')
  if (root.format !== CATALOG_EXPORT_FORMAT) {
    throw new Error('El archivo no es una exportación de catálogo de esta aplicación.')
  }
  const schemaVersion = root.schemaVersion
  if (schemaVersion !== 3 && schemaVersion !== CATALOG_EXPORT_SCHEMA_VERSION) {
    throw new Error(`La versión ${String(schemaVersion)} del catálogo no es compatible.`)
  }

  const rawCatalog = asObject(root.catalog, 'catalog')
  const catalog = {} as Record<CatalogExportCollection, CatalogExportEntity[]>
  for (const collection of catalogExportCollections) {
    const value = rawCatalog[collection]
    if (collection === 'saleFormats' && schemaVersion === 3 && value === undefined) {
      catalog.saleFormats = []
      continue
    }
    if (!Array.isArray(value)) throw new Error(`catalog.${collection} debe ser un array.`)
    catalog[collection] = value.map((entry, index) => asObject(entry, `catalog.${collection}[${index}]`) as CatalogExportEntity)
  }

  const refs = Object.fromEntries(
    catalogExportCollections.map((collection) => [collection, entityRefs(catalog[collection], `catalog.${collection}`)]),
  ) as Record<CatalogExportCollection, Set<string>>

  catalog.variants.forEach((entity, index) => {
    const label = `catalog.variants[${index}]`
    requireRelatedRef(entity, 'productRef', refs.products, label)
    requireRelatedRef(entity, 'saleFormatRef', refs.saleFormats, label, true)
  })
  catalog.images.forEach((entity, index) => {
    const label = `catalog.images[${index}]`
    requireRelatedRef(entity, 'productRef', refs.products, label)
    if (entity.missing !== true && schemaVersion >= CATALOG_EXPORT_SCHEMA_VERSION) {
      const data = requiredString(entity.dataBase64, `${label}.dataBase64`)
      if (!/^data:image\/(?:webp|png|jpeg|avif);base64,/i.test(data)) {
        throw new Error(`${label}.dataBase64 no contiene una imagen compatible.`)
      }
    }
    if (entity.missing !== true && schemaVersion === 3) {
      throw new Error('Esta exportación antigua no incluye las imágenes. Vuelve a exportar el catálogo con la versión actual.')
    }
  })
  catalog.tabCategories.forEach((entity, index) => {
    const label = `catalog.tabCategories[${index}]`
    requireRelatedRef(entity, 'tabRef', refs.tabs, label)
    requireRelatedRef(entity, 'categoryRef', refs.categories, label)
  })
  catalog.placements.forEach((entity, index) => {
    const label = `catalog.placements[${index}]`
    requireRelatedRef(entity, 'tabRef', refs.tabs, label)
    requireRelatedRef(entity, 'categoryRef', refs.categories, label, true)
    requireRelatedRef(entity, 'productRef', refs.products, label)
    requireRelatedRef(entity, 'variantRef', refs.variants, label, true)
  })
  catalog.selectionGroupOptions.forEach((entity, index) => {
    const label = `catalog.selectionGroupOptions[${index}]`
    requireRelatedRef(entity, 'groupRef', refs.selectionGroups, label)
    requireRelatedRef(entity, 'productRef', refs.products, label)
    requireRelatedRef(entity, 'variantRef', refs.variants, label, true)
  })
  catalog.selectionAssignments.forEach((entity, index) => {
    const label = `catalog.selectionAssignments[${index}]`
    requireRelatedRef(entity, 'productRef', refs.products, label)
    requireRelatedRef(entity, 'groupRef', refs.selectionGroups, label)
    requireVariantRefs(entity, refs.variants, label)
  })
  catalog.modifiers.forEach((entity, index) => {
    requireRelatedRef(entity, 'groupRef', refs.modifierGroups, `catalog.modifiers[${index}]`)
  })
  catalog.modifierAssignments.forEach((entity, index) => {
    const label = `catalog.modifierAssignments[${index}]`
    requireRelatedRef(entity, 'productRef', refs.products, label)
    requireRelatedRef(entity, 'groupRef', refs.modifierGroups, label)
    requireVariantRefs(entity, refs.variants, label)
  })

  return {
    catalog,
    format: CATALOG_EXPORT_FORMAT,
    metadata: root.metadata && typeof root.metadata === 'object' && !Array.isArray(root.metadata)
      ? root.metadata as Record<string, unknown>
      : undefined,
    schemaVersion,
  }
}

export function getCatalogImportSummary(document: CatalogExportDocument): CatalogImportSummary {
  return {
    categories: document.catalog.categories.length,
    formats: document.catalog.saleFormats.length,
    images: document.catalog.images.filter((image) => image.missing !== true).length,
    modifiers: document.catalog.modifiers.length,
    placements: document.catalog.placements.length,
    products: document.catalog.products.length,
    selectionGroups: document.catalog.selectionGroups.length,
    tabs: document.catalog.tabs.length,
    variants: document.catalog.variants.length,
  }
}

export function buildCatalogImportIds(
  document: CatalogExportDocument,
  createUuid: () => string = () => crypto.randomUUID(),
) {
  return Object.fromEntries(
    catalogExportCollections.map((collection) => [
      collection,
      Object.fromEntries(document.catalog[collection].map((entity) => [entity.ref, createUuid()])),
    ]),
  ) as Record<CatalogExportCollection, Record<string, string>>
}