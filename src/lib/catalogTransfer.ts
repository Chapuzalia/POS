import { strFromU8, strToU8, unzip, zip, type AsyncZippable } from 'fflate'
import type {
  CatalogKind,
  Category,
  ModifierGroup,
  Product,
  ProductVariant,
  SaleFormatDefinition,
} from '../types'

const CATALOG_FORMAT = 'club-pos-catalog'
const CATALOG_VERSION = 1
const MAX_ZIP_SIZE = 200 * 1024 * 1024
const MAX_IMAGE_SIZE = 1024 * 1024
const catalogKinds: CatalogKind[] = [
  'beer',
  'mixed',
  'shot',
  'other',
  'alcohol',
  'mixer',
  'beer_bottle',
  'soft_bottle',
  'cocktail',
]

export type CatalogTransferCategory = Omit<Category, 'tenantId'>
export type CatalogTransferVariant = Omit<ProductVariant, 'productId'>
export type CatalogTransferModifierGroup = Omit<ModifierGroup, 'productId'>

export type CatalogTransferProduct = Omit<
  Product,
  'tenantId' | 'venueId' | 'imagePath' | 'imageUrl' | 'variants' | 'modifierGroups'
> & {
  imageFile: string | null
  modifierGroups: CatalogTransferModifierGroup[]
  variants: CatalogTransferVariant[]
}

export type CatalogTransferManifest = {
  format: typeof CATALOG_FORMAT
  version: typeof CATALOG_VERSION
  exportedAt: string
  source: {
    tenantName: string
    venueName: string
  }
  categories: CatalogTransferCategory[]
  saleFormats: SaleFormatDefinition[]
  products: CatalogTransferProduct[]
}

export type ParsedCatalogTransfer = {
  manifest: CatalogTransferManifest
  images: Map<string, Uint8Array>
}

function zipFiles(files: AsyncZippable) {
  return new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 6 }, (error, data) => {
      if (error) {
        reject(error)
      } else {
        resolve(data)
      }
    })
  })
}

function unzipFiles(data: Uint8Array) {
  return new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let extractedSize = 0
    let extractedFiles = 0
    unzip(data, {
      filter: (file) => {
        const isManifest = file.name === 'catalog.json'
        const isImage = /^images\/[a-zA-Z0-9_-]+\.webp$/.test(file.name)
        if (!isManifest && !isImage) {
          return false
        }
        const maximumSize = isManifest ? 10 * 1024 * 1024 : MAX_IMAGE_SIZE
        extractedSize += file.originalSize
        extractedFiles += 1
        if (file.originalSize > maximumSize || extractedSize > MAX_ZIP_SIZE || extractedFiles > 5_001) {
          throw new Error('El ZIP contiene demasiados datos.')
        }
        return true
      },
    }, (error, files) => {
      if (error) {
        reject(error)
      } else {
        resolve(files)
      }
    })
  })
}

function safeFilePart(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'catalogo'
}

function downloadBlob(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

async function readProductImage(product: Product) {
  if (!product.imageUrl) {
    return null
  }

  const response = await fetch(product.imageUrl)
  if (!response.ok) {
    throw new Error(`No se ha podido descargar la imagen de ${product.name}.`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_IMAGE_SIZE) {
    throw new Error(`La imagen de ${product.name} no cumple el limite de 1 MB.`)
  }

  return bytes
}

function toTransferProduct(product: Product, imageFile: string | null): CatalogTransferProduct {
  return {
    id: product.id,
    categoryId: product.categoryId,
    name: product.name,
    description: product.description,
    imageFile,
    kind: product.kind,
    saleFormats: [...product.saleFormats],
    canSellStandalone: product.canSellStandalone,
    canUseAsMixer: product.canUseAsMixer,
    isFeatured: product.isFeatured,
    mixerSupplementCents: product.mixerSupplementCents,
    isActive: product.isActive,
    sortOrder: product.sortOrder,
    variants: product.variants.map(({ productId: _productId, ...variant }) => variant),
    modifierGroups: product.modifierGroups.map(({ productId: _productId, ...group }) => ({
      ...group,
      modifiers: group.modifiers.map((modifier) => ({ ...modifier })),
    })),
  }
}

export async function exportCatalogZip(input: {
  categories: Category[]
  products: Product[]
  saleFormats: SaleFormatDefinition[]
  tenantName: string
  venueName: string
}) {
  const imageEntries = await Promise.all(
    input.products.map(async (product) => {
      const bytes = await readProductImage(product)
      return {
        bytes,
        imageFile: bytes ? `images/${product.id}.webp` : null,
        product,
      }
    }),
  )
  const manifest: CatalogTransferManifest = {
    format: CATALOG_FORMAT,
    version: CATALOG_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      tenantName: input.tenantName,
      venueName: input.venueName,
    },
    categories: input.categories.map(({ tenantId: _tenantId, ...category }) => ({ ...category })),
    saleFormats: input.saleFormats.map((saleFormat) => ({ ...saleFormat })),
    products: imageEntries.map(({ imageFile, product }) => toTransferProduct(product, imageFile)),
  }
  const files: AsyncZippable = {
    'catalog.json': strToU8(JSON.stringify(manifest, null, 2)),
  }

  for (const entry of imageEntries) {
    if (entry.imageFile && entry.bytes) {
      files[entry.imageFile] = [entry.bytes, { level: 0 }]
    }
  }

  const archive = await zipFiles(files)
  const date = new Date().toISOString().slice(0, 10)
  downloadBlob(
    new Blob([archive.buffer as ArrayBuffer], { type: 'application/zip' }),
    `catalogo-${safeFilePart(input.venueName)}-${date}.zip`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, label: string, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`El campo ${label} no es valido.`)
  }
  return value
}

function readId(value: unknown, label: string) {
  const id = readString(value, label)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`El campo ${label} no contiene un identificador valido.`)
  }
  return id
}

function readBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') {
    throw new Error(`El campo ${label} no es valido.`)
  }
  return value
}

function readInteger(value: unknown, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`El campo ${label} no es valido.`)
  }
  return value as number
}

function readKind(value: unknown, label: string) {
  if (!catalogKinds.includes(value as CatalogKind)) {
    throw new Error(`El campo ${label} contiene un tipo desconocido.`)
  }
  return value as CatalogKind
}

function readArray(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw new Error(`El campo ${label} no es valido.`)
  }
  return value
}

function parseVariant(value: unknown, productIndex: number, variantIndex: number): CatalogTransferVariant {
  if (!isRecord(value)) {
    throw new Error(`La variante ${variantIndex + 1} del producto ${productIndex + 1} no es valida.`)
  }
  const prefix = `products[${productIndex}].variants[${variantIndex}]`
  return {
    id: readId(value.id, `${prefix}.id`),
    name: readString(value.name, `${prefix}.name`),
    priceCents: readInteger(value.priceCents, `${prefix}.priceCents`),
    sku: value.sku === null ? null : readString(value.sku, `${prefix}.sku`, true),
    isDefault: readBoolean(value.isDefault, `${prefix}.isDefault`),
    sortOrder: readInteger(value.sortOrder, `${prefix}.sortOrder`),
  }
}

function parseModifierGroup(value: unknown, productIndex: number, groupIndex: number): CatalogTransferModifierGroup {
  if (!isRecord(value)) {
    throw new Error(`El grupo ${groupIndex + 1} del producto ${productIndex + 1} no es valido.`)
  }
  const prefix = `products[${productIndex}].modifierGroups[${groupIndex}]`
  return {
    id: readId(value.id, `${prefix}.id`),
    name: readString(value.name, `${prefix}.name`),
    minSelect: readInteger(value.minSelect, `${prefix}.minSelect`),
    maxSelect: readInteger(value.maxSelect, `${prefix}.maxSelect`, 1),
    sortOrder: readInteger(value.sortOrder, `${prefix}.sortOrder`),
    modifiers: readArray(value.modifiers, `${prefix}.modifiers`).map((modifier, modifierIndex) => {
      if (!isRecord(modifier)) {
        throw new Error(`El modificador ${modifierIndex + 1} de ${prefix} no es valido.`)
      }
      return {
        id: readId(modifier.id, `${prefix}.modifiers[${modifierIndex}].id`),
        groupId: readId(modifier.groupId, `${prefix}.modifiers[${modifierIndex}].groupId`),
        name: readString(modifier.name, `${prefix}.modifiers[${modifierIndex}].name`),
        priceCents: readInteger(modifier.priceCents, `${prefix}.modifiers[${modifierIndex}].priceCents`),
        sortOrder: readInteger(modifier.sortOrder, `${prefix}.modifiers[${modifierIndex}].sortOrder`),
      }
    }),
  }
}

function parseManifest(value: unknown): CatalogTransferManifest {
  if (!isRecord(value) || value.format !== CATALOG_FORMAT || value.version !== CATALOG_VERSION) {
    throw new Error('El ZIP no es una copia de catalogo compatible con esta version del CRM.')
  }
  if (!isRecord(value.source)) {
    throw new Error('El origen del catalogo no es valido.')
  }

  const categories = readArray(value.categories, 'categories').map((category, index) => {
    if (!isRecord(category)) {
      throw new Error(`La categoria ${index + 1} no es valida.`)
    }
    return {
      id: readId(category.id, `categories[${index}].id`),
      name: readString(category.name, `categories[${index}].name`),
      kind: readKind(category.kind, `categories[${index}].kind`),
      icon: readString(category.icon, `categories[${index}].icon`, true),
      isActive: readBoolean(category.isActive, `categories[${index}].isActive`),
      sortOrder: readInteger(category.sortOrder, `categories[${index}].sortOrder`),
    }
  })
  const saleFormats = readArray(value.saleFormats, 'saleFormats').map((saleFormat, index) => {
    if (!isRecord(saleFormat)) {
      throw new Error(`El formato ${index + 1} no es valido.`)
    }
    const key = readString(saleFormat.key, `saleFormats[${index}].key`)
    if (!/^[a-z0-9_]+$/.test(key) || key === 'all' || key === 'top') {
      throw new Error(`La clave del formato ${index + 1} no es valida.`)
    }
    return {
      key,
      label: readString(saleFormat.label, `saleFormats[${index}].label`),
      isActive: readBoolean(saleFormat.isActive, `saleFormats[${index}].isActive`),
      sortOrder: readInteger(saleFormat.sortOrder, `saleFormats[${index}].sortOrder`),
    }
  })
  const products = readArray(value.products, 'products').map((product, index) => {
    if (!isRecord(product)) {
      throw new Error(`El producto ${index + 1} no es valido.`)
    }
    const prefix = `products[${index}]`
    const imageFile = product.imageFile === null ? null : readString(product.imageFile, `${prefix}.imageFile`)
    if (imageFile && !/^images\/[a-zA-Z0-9_-]+\.webp$/.test(imageFile)) {
      throw new Error(`La ruta de imagen de ${prefix} no es valida.`)
    }
    return {
      id: readId(product.id, `${prefix}.id`),
      categoryId: readId(product.categoryId, `${prefix}.categoryId`),
      name: readString(product.name, `${prefix}.name`),
      description: product.description === null ? null : readString(product.description, `${prefix}.description`, true),
      imageFile,
      kind: readKind(product.kind, `${prefix}.kind`),
      saleFormats: readArray(product.saleFormats, `${prefix}.saleFormats`).map((format, formatIndex) =>
        readString(format, `${prefix}.saleFormats[${formatIndex}]`),
      ),
      canSellStandalone: readBoolean(product.canSellStandalone, `${prefix}.canSellStandalone`),
      canUseAsMixer: readBoolean(product.canUseAsMixer, `${prefix}.canUseAsMixer`),
      isFeatured: readBoolean(product.isFeatured, `${prefix}.isFeatured`),
      mixerSupplementCents: readInteger(product.mixerSupplementCents, `${prefix}.mixerSupplementCents`),
      isActive: readBoolean(product.isActive, `${prefix}.isActive`),
      sortOrder: readInteger(product.sortOrder, `${prefix}.sortOrder`),
      variants: readArray(product.variants, `${prefix}.variants`).map((variant, variantIndex) =>
        parseVariant(variant, index, variantIndex),
      ),
      modifierGroups: readArray(product.modifierGroups, `${prefix}.modifierGroups`).map((group, groupIndex) =>
        parseModifierGroup(group, index, groupIndex),
      ),
    }
  })

  const categoryIds = new Set(categories.map((category) => category.id))
  if (categoryIds.size !== categories.length) {
    throw new Error('El ZIP contiene categorias duplicadas.')
  }
  const saleFormatKeys = new Set(saleFormats.map((saleFormat) => saleFormat.key))
  if (saleFormatKeys.size !== saleFormats.length) {
    throw new Error('El ZIP contiene formatos de venta duplicados.')
  }
  const productIds = new Set(products.map((product) => product.id))
  if (productIds.size !== products.length) {
    throw new Error('El ZIP contiene productos duplicados.')
  }
  for (const product of products) {
    if (!categoryIds.has(product.categoryId)) {
      throw new Error(`El producto ${product.name} referencia una categoria que no esta en el ZIP.`)
    }
    if (product.saleFormats.some((format) => !saleFormatKeys.has(format))) {
      throw new Error(`El producto ${product.name} referencia un formato que no esta en el ZIP.`)
    }
  }

  return {
    format: CATALOG_FORMAT,
    version: CATALOG_VERSION,
    exportedAt: readString(value.exportedAt, 'exportedAt'),
    source: {
      tenantName: readString(value.source.tenantName, 'source.tenantName'),
      venueName: readString(value.source.venueName, 'source.venueName'),
    },
    categories,
    saleFormats,
    products,
  }
}

export async function parseCatalogZip(file: File): Promise<ParsedCatalogTransfer> {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    throw new Error('Selecciona un archivo ZIP exportado desde el CRM.')
  }
  if (!file.size || file.size > MAX_ZIP_SIZE) {
    throw new Error('El ZIP esta vacio o supera el limite de 200 MB.')
  }

  let files: Record<string, Uint8Array>
  try {
    files = await unzipFiles(new Uint8Array(await file.arrayBuffer()))
  } catch {
    throw new Error('No se ha podido abrir el ZIP. Puede estar danado o no ser compatible.')
  }
  const manifestBytes = files['catalog.json']
  if (!manifestBytes || manifestBytes.length > 10 * 1024 * 1024) {
    throw new Error('El ZIP no contiene un catalog.json valido.')
  }

  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(strFromU8(manifestBytes))
  } catch {
    throw new Error('El archivo catalog.json no contiene JSON valido.')
  }
  const manifest = parseManifest(rawManifest)
  const images = new Map<string, Uint8Array>()

  for (const product of manifest.products) {
    if (!product.imageFile) {
      continue
    }
    const image = files[product.imageFile]
    if (!image || !image.length || image.length > MAX_IMAGE_SIZE) {
      throw new Error(`Falta la imagen de ${product.name} o supera el limite de 1 MB.`)
    }
    images.set(product.imageFile, image)
  }

  return { manifest, images }
}
