import { z } from 'zod'

export const CATALOG_FORMAT = 'club-pos-catalog-export'
export const CATALOG_SCHEMA_VERSION = 2
export const COLLECTIONS = [
  'categories', 'saleFormats', 'tabs', 'tabCategories', 'products', 'variants', 'placements',
  'selectionGroups', 'selectionGroupOptions', 'selectionAssignments', 'modifierGroups',
  'modifiers', 'modifierAssignments', 'images',
]

const openBlock = z.record(z.string(), z.unknown())
const ref = z.string().regex(/^[a-z][a-z0-9_]*$/)
const sortOrder = z.number().int().nonnegative()
const money = z.number().int().min(-100_000_000).max(100_000_000)
const nullableString = z.string().nullable()
const common = { ref, sortOrder, isActive: z.boolean() }

const category = z.object({ ...common, name: z.string().min(1), icon: nullableString, unused: z.boolean(), trace: openBlock, source: openBlock }).strict()
const saleFormat = z.object({ ...common, key: z.string().min(1), label: z.string().min(1), trace: openBlock, source: openBlock }).strict()
const tab = z.object({ ...common, key: z.string().min(1), label: z.string().min(1), icon: nullableString, trace: openBlock }).strict()
const tabCategory = z.object({ ...common, tabRef: ref, categoryRef: ref, source: openBlock }).strict()
const product = z.object({ ...common, type: z.enum(['standard', 'menu']), name: z.string().min(1), description: nullableString, imageRef: ref.nullable(), taxRate: z.number().min(0).max(100).multipleOf(0.01).nullable(), trace: openBlock, source: openBlock }).strict()
const variant = z.object({ ...common, productRef: ref, name: z.string().min(1), priceCents: z.number().int().min(0).max(100_000_000), sku: nullableString, isDefault: z.boolean(), trace: openBlock, source: openBlock }).strict()
const placement = z.object({ ...common, productRef: ref, tabRef: ref, categoryRef: ref.nullable(), variantRef: ref.nullable(), featured: z.boolean(), trace: openBlock }).strict()
const selectionGroup = z.object({ ...common, name: z.string().min(1), type: z.enum(['mixer', 'menu_component']), trace: openBlock, source: openBlock }).strict()
const selectionOption = z.object({ ...common, groupRef: ref, productRef: ref, variantRef: ref.nullable(), supplementCents: money, defaultQuantity: z.number().int().nonnegative(), maxQuantity: z.number().int().nonnegative().nullable(), trace: openBlock }).strict()
const assignment = z.object({ ...common, productRef: ref, groupRef: ref, variantRefs: z.array(ref), minSelection: z.number().int().nonnegative(), maxSelection: z.number().int().positive(), displayName: nullableString, trace: openBlock }).strict()
const modifierGroup = z.object({ ...common, name: z.string().min(1), trace: openBlock, source: openBlock }).strict()
const modifier = z.object({ ...common, groupRef: ref, name: z.string().min(1), supplementCents: money, isDefault: z.boolean(), trace: openBlock }).strict()
const image = z.object({
  ref, productRef: ref, file: z.string().regex(/^images\/[a-z][a-z0-9_]*\.[a-z0-9]+$/).nullable(),
  mimeType: z.string().nullable(), sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), missing: z.boolean(), trace: openBlock, source: openBlock,
}).strict()

export const catalogExportSchema = z.object({
  format: z.literal(CATALOG_FORMAT), schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  metadata: z.object({
    exportedAt: z.string().datetime(), origin: z.record(z.string(), z.unknown()),
    fiscal: z.object({ defaultTaxRate: z.number().min(0).max(100).multipleOf(0.01), currencyCode: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1) }).passthrough(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
  }).passthrough(),
  catalog: z.object({
    categories: z.array(category), saleFormats: z.array(saleFormat), tabs: z.array(tab), tabCategories: z.array(tabCategory),
    products: z.array(product), variants: z.array(variant), placements: z.array(placement), selectionGroups: z.array(selectionGroup),
    selectionGroupOptions: z.array(selectionOption), selectionAssignments: z.array(assignment), modifierGroups: z.array(modifierGroup),
    modifiers: z.array(modifier), modifierAssignments: z.array(assignment), images: z.array(image),
  }).strict(),
}).strict()

function add(issues, level, code, path, message, details) { issues.push({ level, code, path, message, ...(details ? { details } : {}) }) }
function mapRefs(items, path, issues) {
  const map = new Map()
  items.forEach((item, index) => {
    if (map.has(item.ref)) add(issues, 'ERROR', 'DUPLICATE_REF', `${path}[${index}].ref`, `Referencia duplicada: ${item.ref}`)
    map.set(item.ref, item)
  })
  return map
}
function result(issues) {
  const counts = { ERROR: 0, WARNING: 0, INFO: 0 }
  issues.forEach((item) => { counts[item.level] += 1 })
  return { valid: counts.ERROR === 0, counts, issues }
}

export function validateCatalog(document) {
  const parsed = catalogExportSchema.safeParse(document)
  if (!parsed.success) {
    return result(parsed.error.issues.map((entry) => ({
      level: 'ERROR', code: 'SCHEMA_VIOLATION', path: `$.${entry.path.join('.')}`,
      message: entry.message,
    })))
  }
  const { catalog } = parsed.data
  const issues = []
  const products = mapRefs(catalog.products, '$.catalog.products', issues)
  const variants = mapRefs(catalog.variants, '$.catalog.variants', issues)
  const categories = mapRefs(catalog.categories, '$.catalog.categories', issues)
  const tabs = mapRefs(catalog.tabs, '$.catalog.tabs', issues)
  const groups = mapRefs(catalog.selectionGroups, '$.catalog.selectionGroups', issues)
  const modifierGroups = mapRefs(catalog.modifierGroups, '$.catalog.modifierGroups', issues)
  const images = mapRefs(catalog.images, '$.catalog.images', issues)
  for (const name of COLLECTIONS.filter((name) => !['products', 'variants', 'categories', 'tabs', 'selectionGroups', 'modifierGroups', 'images'].includes(name))) mapRefs(catalog[name], `$.catalog.${name}`, issues)

  const variantsByProduct = new Map()
  catalog.variants.forEach((item, index) => {
    if (!products.has(item.productRef)) add(issues, 'ERROR', 'VARIANT_WITHOUT_PRODUCT', `$.catalog.variants[${index}].productRef`, 'La variante no apunta a un producto.')
    variantsByProduct.set(item.productRef, [...(variantsByProduct.get(item.productRef) ?? []), item])
  })
  catalog.products.forEach((item, index) => {
    const own = variantsByProduct.get(item.ref) ?? []
    if (!own.length) add(issues, 'ERROR', 'PRODUCT_WITHOUT_VARIANTS', `$.catalog.products[${index}]`, 'El producto no tiene variantes.')
    const defaults = own.filter((variantItem) => variantItem.isActive && variantItem.isDefault)
    if (defaults.length !== 1) add(issues, 'ERROR', 'INVALID_ACTIVE_DEFAULT_VARIANT_COUNT', `$.catalog.products[${index}]`, `Se esperaba una variante predeterminada activa y hay ${defaults.length}.`)
    if (item.imageRef && (!images.has(item.imageRef) || images.get(item.imageRef).productRef !== item.ref)) add(issues, 'ERROR', 'INVALID_PRODUCT_IMAGE', `$.catalog.products[${index}].imageRef`, 'La imagen no pertenece al producto.')
  })
  catalog.tabCategories.forEach((item, index) => {
    if (!tabs.has(item.tabRef)) add(issues, 'ERROR', 'BROKEN_TAB_CATEGORY_TAB', `$.catalog.tabCategories[${index}].tabRef`, 'Pestaña inexistente.')
    if (!categories.has(item.categoryRef)) add(issues, 'ERROR', 'BROKEN_TAB_CATEGORY_CATEGORY', `$.catalog.tabCategories[${index}].categoryRef`, 'Categoría inexistente.')
  })
  const placementKeys = new Set()
  catalog.placements.forEach((item, index) => {
    const ownVariant = item.variantRef ? variants.get(item.variantRef) : null
    if (!products.has(item.productRef) || !tabs.has(item.tabRef) || (item.categoryRef && !categories.has(item.categoryRef))) add(issues, 'ERROR', 'BROKEN_PLACEMENT_REFERENCE', `$.catalog.placements[${index}]`, 'La colocación contiene una referencia inexistente.')
    if (item.variantRef && ownVariant?.productRef !== item.productRef) add(issues, 'ERROR', 'PLACEMENT_VARIANT_PRODUCT_MISMATCH', `$.catalog.placements[${index}].variantRef`, 'La variante fijada pertenece a otro producto.')
    const key = [item.productRef, item.tabRef, item.categoryRef ?? '<null>', item.variantRef ?? '<null>'].join('|')
    if (placementKeys.has(key)) add(issues, 'ERROR', 'DUPLICATE_PLACEMENT', `$.catalog.placements[${index}]`, 'Colocación exacta duplicada.')
    placementKeys.add(key)
  })
  const optionsByGroup = new Map()
  catalog.selectionGroupOptions.forEach((item, index) => {
    const group = groups.get(item.groupRef); const optionProduct = products.get(item.productRef); const optionVariant = item.variantRef ? variants.get(item.variantRef) : null
    if (!group || !optionProduct) add(issues, 'ERROR', 'BROKEN_SELECTION_OPTION', `$.catalog.selectionGroupOptions[${index}]`, 'La opción contiene una referencia inexistente.')
    if (optionProduct?.type !== 'standard') add(issues, 'ERROR', 'NESTED_MENU', `$.catalog.selectionGroupOptions[${index}].productRef`, 'Las opciones solo pueden apuntar a productos estándar.')
    if (item.variantRef && optionVariant?.productRef !== item.productRef) add(issues, 'ERROR', 'OPTION_VARIANT_PRODUCT_MISMATCH', `$.catalog.selectionGroupOptions[${index}].variantRef`, 'La variante de la opción pertenece a otro producto.')
    if (item.maxQuantity != null && item.defaultQuantity > item.maxQuantity) add(issues, 'ERROR', 'INVALID_OPTION_QUANTITY', `$.catalog.selectionGroupOptions[${index}]`, 'La cantidad predeterminada supera la máxima.')
    optionsByGroup.set(item.groupRef, [...(optionsByGroup.get(item.groupRef) ?? []), item])
  })
  const checkAssignments = (items, groupIndex, codePrefix, path) => items.forEach((item, index) => {
    const assignedProduct = products.get(item.productRef); const assignedGroup = groupIndex.get(item.groupRef)
    if (!assignedProduct || !assignedGroup) add(issues, 'ERROR', `BROKEN_${codePrefix}_ASSIGNMENT`, `${path}[${index}]`, 'La asignación contiene una referencia inexistente.')
    if (item.minSelection > item.maxSelection) add(issues, 'ERROR', `INVALID_${codePrefix}_LIMITS`, `${path}[${index}]`, 'El mínimo supera el máximo.')
    for (const variantRef of item.variantRefs) if (variants.get(variantRef)?.productRef !== item.productRef) add(issues, 'ERROR', `${codePrefix}_ASSIGNMENT_VARIANT_MISMATCH`, `${path}[${index}].variantRefs`, 'Una variante afectada pertenece a otro producto.')
    if (item.isActive && (!assignedProduct?.isActive || !assignedGroup?.isActive)) add(issues, 'WARNING', 'ACTIVE_ASSIGNMENT_WITH_INACTIVE_TARGET', `${path}[${index}]`, 'La asignación activa depende de producto o grupo inactivo.')
  })
  checkAssignments(catalog.selectionAssignments, groups, 'SELECTION', '$.catalog.selectionAssignments')
  checkAssignments(catalog.modifierAssignments, modifierGroups, 'MODIFIER', '$.catalog.modifierAssignments')
  catalog.selectionAssignments.forEach((item, index) => {
    const capacity = (optionsByGroup.get(item.groupRef) ?? []).filter((option) => option.isActive).reduce((sum, option) => sum + (option.maxQuantity ?? item.maxSelection), 0)
    if (item.isActive && capacity < item.minSelection) add(issues, 'ERROR', 'INSUFFICIENT_ACTIVE_CAPACITY', `$.catalog.selectionAssignments[${index}]`, 'Las opciones activas no cubren el mínimo.')
  })
  catalog.modifiers.forEach((item, index) => { if (!modifierGroups.has(item.groupRef)) add(issues, 'ERROR', 'MODIFIER_WITHOUT_GROUP', `$.catalog.modifiers[${index}].groupRef`, 'Grupo de modificadores inexistente.') })
  catalog.images.forEach((item, index) => {
    if (!products.has(item.productRef)) add(issues, 'ERROR', 'IMAGE_WITHOUT_PRODUCT', `$.catalog.images[${index}].productRef`, 'Producto de imagen inexistente.')
    const complete = item.file != null && item.mimeType != null && item.sizeBytes != null && item.sha256 != null
    if (item.missing === complete) add(issues, 'ERROR', 'INCONSISTENT_IMAGE_STATE', `$.catalog.images[${index}]`, 'Una imagen ausente no puede tener metadatos de archivo y viceversa.')
    if (item.missing) add(issues, 'WARNING', 'MISSING_IMAGE', `$.catalog.images[${index}]`, 'El binario de imagen no está disponible.')
  })
  catalog.products.filter((item) => !catalog.placements.some((placementItem) => placementItem.productRef === item.ref)).forEach((item) => add(issues, 'INFO', 'INTERNAL_PRODUCT', `$.catalog.products.${item.ref}`, 'Producto interno sin colocaciones.'))
  catalog.categories.filter((item) => item.unused).forEach((item) => add(issues, 'INFO', 'UNUSED_CATEGORY', `$.catalog.categories.${item.ref}`, 'Categoría conservada sin asociación automática.'))
  if (catalog.saleFormats.length) add(issues, 'INFO', 'SALE_FORMATS_SOURCE_ONLY', '$.catalog.saleFormats', 'Los formatos de venta solo son trazabilidad.')
  return result(issues)
}

export function assertValidCatalog(document) {
  const validation = validateCatalog(document)
  if (!validation.valid) {
    const error = new Error(`Catálogo inválido: ${validation.counts.ERROR} error(es)`)
    error.validation = validation
    throw error
  }
  return validation
}

export function formatValidation(validation) {
  return `${[`ERROR ${validation.counts.ERROR} | WARNING ${validation.counts.WARNING} | INFO ${validation.counts.INFO}`, ...validation.issues.map((item) => `${item.level} ${item.code} ${item.path} - ${item.message}`)].join('\n')}\n`
}
