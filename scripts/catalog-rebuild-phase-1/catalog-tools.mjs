/**
 * TEMPORARY PHASE-1 TOOLING.
 * Remove this directory after the catalogue reconstruction has been completed.
 *
 * This module is deliberately dependency-free and side-effect free. It converts a
 * read-only snapshot of the current database into a schema-independent document,
 * validates that document, and renders the conversion report.
 */

export const CATALOG_EXPORT_FORMAT = 'club-pos-catalog-export'
export const CATALOG_SCHEMA_VERSION = 1

const arrays = [
  'categories', 'saleFormats', 'tabs', 'tabCategories', 'products', 'variants',
  'placements', 'selectionGroups', 'selectionGroupOptions', 'selectionAssignments',
  'modifierGroups', 'modifiers', 'modifierAssignments', 'images',
]

const byOrderNameId = (a, b) =>
  Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)
  || String(a.name ?? a.label ?? a.key ?? '').localeCompare(String(b.name ?? b.label ?? b.key ?? ''), 'es')
  || String(a.id ?? '').localeCompare(String(b.id ?? ''))

const sorted = (items) => [...(items ?? [])].sort(byOrderNameId)
const integer = (value, fallback = 0) => Number.isSafeInteger(value) ? value : fallback
const boolean = (value, fallback = true) => typeof value === 'boolean' ? value : fallback
const nullable = (value) => value === undefined ? null : value

function makeRefs(prefix, rows) {
  const map = new Map()
  sorted(rows).forEach((row, index) => map.set(row.id, `${prefix}_${String(index + 1).padStart(4, '0')}`))
  return map
}

function trace(row, venueId) {
  return {
    originalId: row.id ?? null,
    tenantId: row.tenant_id ?? null,
    venueId: row.venue_id ?? venueId ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function refFor(map, id) {
  return id == null ? null : map.get(id) ?? null
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function makeAssignmentRef(prefix, index) {
  return `${prefix}_${String(index + 1).padStart(4, '0')}`
}

/** Build the portable export from rows already isolated to one venue. */
export function buildCatalogExport(snapshot, options = {}) {
  const exportedAt = options.exportedAt ?? new Date().toISOString()
  const venue = snapshot.venue
  const tenant = snapshot.tenant ?? { id: venue?.tenant_id, name: null, slug: null }
  if (!venue?.id || !venue?.tenant_id) throw new Error('The source snapshot does not contain a valid venue.')

  const source = Object.fromEntries(arrays.map((key) => [key, []]))
  const sourceWarnings = [...(snapshot.sourceWarnings ?? [])]
  const categories = sorted(snapshot.categories)
  const saleFormats = sorted(snapshot.saleFormats)
  const products = sorted(snapshot.products)
  const variants = sorted(snapshot.productVariants)
  const tabs = sorted(snapshot.catalogTabs)
  const placements = sorted(snapshot.catalogPlacements)
  const groups = sorted(snapshot.selectionGroups)
  const groupOptions = sorted(snapshot.selectionGroupItems)
  const modifierGroups = sorted(snapshot.modifierGroups)
  const modifiers = sorted(snapshot.modifiers)

  const refs = {
    category: makeRefs('category', categories), saleFormat: makeRefs('sale_format', saleFormats),
    tab: makeRefs('tab', tabs), product: makeRefs('product', products), variant: makeRefs('variant', variants),
    placement: makeRefs('placement', placements), selectionGroup: makeRefs('selection_group', groups),
    selectionOption: makeRefs('selection_option', groupOptions), modifierGroup: makeRefs('modifier_group', modifierGroups),
    modifier: makeRefs('modifier', modifiers),
  }

  source.categories = categories.map((row) => ({
    ref: refs.category.get(row.id), name: row.name, icon: row.icon ?? null,
    sortOrder: integer(row.sort_order), isActive: boolean(row.is_active),
    trace: trace(row, null), source: { kind: row.kind ?? null, currentScope: 'tenant' },
  }))
  source.saleFormats = saleFormats.map((row) => ({
    ref: refs.saleFormat.get(row.id), key: row.key, label: row.label,
    sortOrder: integer(row.sort_order), isActive: boolean(row.is_active), trace: trace(row, null),
    source: { currentScope: row.venue_id ? 'venue' : 'tenant' },
  }))
  source.tabs = tabs.map((row) => ({
    ref: refs.tab.get(row.id), key: row.key, label: row.label, icon: row.icon ?? 'receipt',
    sortOrder: integer(row.sort_order), isActive: boolean(row.is_active), trace: trace(row, venue.id),
  }))

  source.products = products.map((row) => ({
    ref: refs.product.get(row.id), type: row.product_type === 'menu' ? 'menu' : 'standard',
    name: row.name, description: row.description ?? null,
    imageRef: row.image_path ? `image_${String(source.images.length + 1).padStart(4, '0')}` : null,
    taxRate: nullable(row.tax_rate), sortOrder: integer(row.sort_order), isActive: boolean(row.is_active),
    trace: trace(row, venue.id),
    source: {
      categoryRef: refFor(refs.category, row.category_id), kind: row.kind ?? null,
      saleFormatKeys: Array.isArray(row.sale_formats) ? [...row.sale_formats] : [],
      canSellStandalone: boolean(row.can_sell_standalone), canUseAsMixer: boolean(row.can_use_as_mixer, false),
      isFeatured: boolean(row.is_featured, false), mixerSupplementCents: integer(row.mixer_supplement_cents),
    },
  }))

  for (const row of products) {
    if (!row.image_path) continue
    source.images.push({
      ref: `image_${String(source.images.length + 1).padStart(4, '0')}`,
      productRef: refFor(refs.product, row.id), storageBucket: 'product-images', path: row.image_path,
      embeddedData: null, trace: { originalPath: row.image_path },
    })
  }

  source.variants = variants.map((row) => ({
    ref: refs.variant.get(row.id), productRef: refFor(refs.product, row.product_id), name: row.name,
    priceCents: row.price_cents, sku: row.sku ?? null, isDefault: boolean(row.is_default, false),
    sortOrder: integer(row.sort_order), isActive: boolean(row.is_active), trace: trace(row, venue.id),
    source: { saleFormatRef: refFor(refs.saleFormat, row.sale_format_id) },
  }))
  source.placements = placements.map((row) => ({
    ref: refs.placement.get(row.id), productRef: refFor(refs.product, row.product_id),
    tabRef: refFor(refs.tab, row.tab_id), categoryRef: refFor(refs.category, row.category_id),
    variantRef: refFor(refs.variant, row.default_variant_id), featured: boolean(row.is_featured, false),
    sortOrder: integer(row.sort_order), isActive: boolean(row.is_active), trace: trace(row, venue.id),
  }))

  const tabCategoryMap = new Map()
  for (const placement of source.placements) {
    if (!placement.tabRef || !placement.categoryRef) continue
    const key = `${placement.tabRef}|${placement.categoryRef}`
    const existing = tabCategoryMap.get(key)
    if (existing) {
      existing.source.derivedFromPlacementRefs.push(placement.ref)
      existing.sortOrder = Math.min(existing.sortOrder, placement.sortOrder)
      existing.isActive ||= placement.isActive
    } else {
      tabCategoryMap.set(key, {
        ref: '', tabRef: placement.tabRef, categoryRef: placement.categoryRef,
        sortOrder: placement.sortOrder, isActive: placement.isActive,
        source: { derivedFromPlacementRefs: [placement.ref] },
      })
    }
  }
  source.tabCategories = [...tabCategoryMap.values()]
    .sort((a, b) => a.tabRef.localeCompare(b.tabRef) || a.sortOrder - b.sortOrder || a.categoryRef.localeCompare(b.categoryRef))
    .map((row, index) => ({ ...row, ref: makeAssignmentRef('tab_category', index) }))

  source.selectionGroups = groups.map((row) => ({
    ref: refs.selectionGroup.get(row.id), name: row.name,
    type: row.kind === 'menu_component' ? 'menu_component' : 'mixer',
    sortOrder: integer(row.sort_order), isActive: boolean(row.is_active), trace: trace(row, venue.id),
    source: { minSelection: integer(row.min_select), maxSelection: integer(row.max_select, 1) },
  }))
  source.selectionGroupOptions = groupOptions.map((row) => ({
    ref: refs.selectionOption.get(row.id), groupRef: refFor(refs.selectionGroup, row.group_id),
    productRef: refFor(refs.product, row.product_id), variantRef: refFor(refs.variant, row.variant_id),
    supplementCents: row.price_delta_cents, defaultQuantity: boolean(row.is_default, false) ? 1 : 0,
    maxQuantity: null, sortOrder: integer(row.sort_order), isActive: boolean(row.is_active), trace: trace(row, venue.id),
  }))

  const variantById = new Map(variants.map((row) => [row.id, row]))
  const groupById = new Map(groups.map((row) => [row.id, row]))
  const selectionAssignmentMap = new Map()
  for (const row of sorted(snapshot.variantSelectionGroups)) {
    const variant = variantById.get(row.variant_id)
    const group = groupById.get(row.selection_group_id)
    const key = `${variant?.product_id ?? 'broken'}|${row.selection_group_id}`
    const existing = selectionAssignmentMap.get(key) ?? {
      productRef: refFor(refs.product, variant?.product_id), groupRef: refFor(refs.selectionGroup, row.selection_group_id),
      variantRefs: [], minSelection: integer(group?.min_select), maxSelection: integer(group?.max_select, 1),
      sortOrder: integer(row.sort_order), isActive: boolean(group?.is_active), displayName: null,
      trace: { originalAssignmentIds: [] },
    }
    existing.variantRefs.push(refFor(refs.variant, row.variant_id))
    existing.trace.originalAssignmentIds.push(`${row.variant_id}:${row.selection_group_id}`)
    selectionAssignmentMap.set(key, existing)
  }
  source.selectionAssignments = [...selectionAssignmentMap.values()]
    .sort((a, b) => String(a.productRef).localeCompare(String(b.productRef)) || a.sortOrder - b.sortOrder || String(a.groupRef).localeCompare(String(b.groupRef)))
    .map((row, index) => ({ ...row, ref: makeAssignmentRef('selection_assignment', index), variantRefs: unique(row.variantRefs) }))

  source.modifierGroups = modifierGroups.map((row) => ({
    ref: refs.modifierGroup.get(row.id), name: row.name, sortOrder: integer(row.sort_order),
    isActive: boolean(row.is_active), trace: trace(row, venue.id),
    source: {
      ownerProductRef: refFor(refs.product, row.product_id),
      minSelection: integer(row.min_select), maxSelection: integer(row.max_select, 1),
    },
  }))
  source.modifiers = modifiers.map((row) => ({
    ref: refs.modifier.get(row.id), groupRef: refFor(refs.modifierGroup, row.group_id), name: row.name,
    supplementCents: row.price_cents, isDefault: boolean(row.is_default, false),
    sortOrder: integer(row.sort_order), isActive: boolean(row.is_active), trace: trace(row, venue.id),
  }))

  const modifierAssignmentMap = new Map()
  for (const row of sorted(snapshot.productModifierGroups)) {
    const group = modifierGroups.find((item) => item.id === row.modifier_group_id)
    const key = `${row.product_id}|${row.modifier_group_id}`
    const existing = modifierAssignmentMap.get(key) ?? {
      productRef: refFor(refs.product, row.product_id), groupRef: refFor(refs.modifierGroup, row.modifier_group_id),
      appliesToAllVariants: false, variantRefs: [], minSelection: integer(group?.min_select),
      maxSelection: integer(group?.max_select, 1), sortOrder: integer(row.sort_order), isActive: boolean(group?.is_active),
      displayName: null, trace: { originalAssignmentIds: [], derivedFromOwner: false },
    }
    if (row.variant_id == null) existing.appliesToAllVariants = true
    else existing.variantRefs.push(refFor(refs.variant, row.variant_id))
    existing.trace.originalAssignmentIds.push(`${row.product_id}:${row.variant_id ?? '*'}:${row.modifier_group_id}`)
    modifierAssignmentMap.set(key, existing)
  }
  // Before migration 29, ownership itself was the assignment. Preserve that meaning.
  for (const group of modifierGroups) {
    if (!refs.product.has(group.product_id)) continue
    const key = `${group.product_id}|${group.id}`
    if (modifierAssignmentMap.has(key)) continue
    modifierAssignmentMap.set(key, {
      productRef: refFor(refs.product, group.product_id), groupRef: refFor(refs.modifierGroup, group.id),
      appliesToAllVariants: true, variantRefs: [], minSelection: integer(group.min_select),
      maxSelection: integer(group.max_select, 1), sortOrder: integer(group.sort_order), isActive: boolean(group.is_active),
      displayName: null, trace: { originalAssignmentIds: [], derivedFromOwner: true },
    })
  }
  source.modifierAssignments = [...modifierAssignmentMap.values()]
    .sort((a, b) => String(a.productRef).localeCompare(String(b.productRef)) || a.sortOrder - b.sortOrder || String(a.groupRef).localeCompare(String(b.groupRef)))
    .map((row, index) => ({ ...row, ref: makeAssignmentRef('modifier_assignment', index), variantRefs: unique(row.variantRefs) }))

  const document = {
    format: CATALOG_EXPORT_FORMAT,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    metadata: {
      exportedAt, exporter: 'scripts/catalog-rebuild-phase-1', readOnly: true,
      origin: {
        tenant: { name: tenant.name ?? null, slug: tenant.slug ?? null, trace: { originalId: tenant.id ?? venue.tenant_id } },
        venue: {
          name: venue.name, address: venue.address ?? null, legalName: venue.legal_name ?? null,
          taxId: venue.tax_id ?? null, trace: { originalId: venue.id, tenantId: venue.tenant_id },
        },
      },
      fiscal: {
        defaultTaxRate: venue.default_tax_rate ?? 21, currencyCode: venue.currency_code ?? 'EUR',
        timezone: venue.timezone ?? 'Europe/Madrid',
      },
      sourceCatalogProfile: venue.catalog_profile ?? null,
      warnings: sourceWarnings,
      counts: {},
    },
    catalog: source,
  }
  document.metadata.counts = Object.fromEntries(arrays.map((key) => [key, document.catalog[key].length]))
  const validation = validateCatalogExport(document)
  document.metadata.warnings = unique([
    ...sourceWarnings,
    ...validation.issues.filter((issue) => issue.level !== 'INFO').map((issue) => `${issue.level} ${issue.code}: ${issue.message}`),
  ])
  return document
}

function issue(issues, level, code, path, message) {
  issues.push({ level, code, path, message })
}

function indexByRef(items, issues, path) {
  const result = new Map()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item || typeof item.ref !== 'string' || !item.ref) {
      issue(issues, 'ERROR', 'INVALID_REF', `${path}[${index}].ref`, 'La referencia no es una cadena no vacía.')
      continue
    }
    if (result.has(item.ref)) issue(issues, 'ERROR', 'DUPLICATE_REF', `${path}[${index}].ref`, `La referencia ${item.ref} está duplicada.`)
    result.set(item.ref, item)
  }
  return result
}

function checkOrder(issues, items, path, groupKey = () => 'all') {
  const positions = new Map()
  items.forEach((item, index) => {
    if (!Number.isSafeInteger(item.sortOrder) || item.sortOrder < 0) {
      issue(issues, 'ERROR', 'INVALID_SORT_ORDER', `${path}[${index}].sortOrder`, 'El orden debe ser un entero mayor o igual que cero.')
      return
    }
    const key = `${groupKey(item)}|${item.sortOrder}`
    if (positions.has(key)) issue(issues, 'WARNING', 'DUPLICATE_SORT_ORDER', `${path}[${index}].sortOrder`, 'Dos registros hermanos comparten el mismo orden.')
    else positions.set(key, index)
  })
}

function checkMoney(issues, value, path, code = 'INVALID_PRICE') {
  if (!Number.isSafeInteger(value) || value < 0) issue(issues, 'ERROR', code, path, 'El importe debe ser un entero de céntimos mayor o igual que cero.')
}

function checkTax(issues, value, path) {
  if (value == null) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || Math.round(value * 100) !== value * 100) {
    issue(issues, 'ERROR', 'INVALID_TAX_RATE', path, 'El IVA debe estar entre 0 y 100 y tener como máximo dos decimales.')
  }
}

export function validateCatalogExport(document) {
  const issues = []
  if (!document || typeof document !== 'object') return { valid: false, counts: { ERROR: 1, WARNING: 0, INFO: 0 }, issues: [{ level: 'ERROR', code: 'INVALID_DOCUMENT', path: '$', message: 'El archivo no contiene un objeto JSON.' }] }
  if (document.format !== CATALOG_EXPORT_FORMAT) issue(issues, 'ERROR', 'INVALID_FORMAT', '$.format', `Se esperaba ${CATALOG_EXPORT_FORMAT}.`)
  if (document.schemaVersion !== CATALOG_SCHEMA_VERSION) issue(issues, 'ERROR', 'UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion', `Solo se admite schemaVersion ${CATALOG_SCHEMA_VERSION}.`)
  const catalog = document.catalog
  if (!catalog || typeof catalog !== 'object') {
    issue(issues, 'ERROR', 'MISSING_CATALOG', '$.catalog', 'Falta el catálogo exportado.')
    return summarizeValidation(issues)
  }
  for (const name of arrays) if (!Array.isArray(catalog[name])) issue(issues, 'ERROR', 'MISSING_COLLECTION', `$.catalog.${name}`, 'La colección es obligatoria.')
  if (issues.some((item) => item.code === 'MISSING_COLLECTION')) return summarizeValidation(issues)

  const categoryByRef = indexByRef(catalog.categories, issues, '$.catalog.categories')
  const tabByRef = indexByRef(catalog.tabs, issues, '$.catalog.tabs')
  const productByRef = indexByRef(catalog.products, issues, '$.catalog.products')
  const variantByRef = indexByRef(catalog.variants, issues, '$.catalog.variants')
  const placementByRef = indexByRef(catalog.placements, issues, '$.catalog.placements')
  const selectionGroupByRef = indexByRef(catalog.selectionGroups, issues, '$.catalog.selectionGroups')
  indexByRef(catalog.selectionGroupOptions, issues, '$.catalog.selectionGroupOptions')
  const modifierGroupByRef = indexByRef(catalog.modifierGroups, issues, '$.catalog.modifierGroups')
  indexByRef(catalog.modifiers, issues, '$.catalog.modifiers')
  indexByRef(catalog.tabCategories, issues, '$.catalog.tabCategories')
  indexByRef(catalog.selectionAssignments, issues, '$.catalog.selectionAssignments')
  indexByRef(catalog.modifierAssignments, issues, '$.catalog.modifierAssignments')
  indexByRef(catalog.images, issues, '$.catalog.images')

  checkTax(issues, document.metadata?.fiscal?.defaultTaxRate, '$.metadata.fiscal.defaultTaxRate')
  checkOrder(issues, catalog.categories, '$.catalog.categories')
  checkOrder(issues, catalog.tabs, '$.catalog.tabs')
  checkOrder(issues, catalog.products, '$.catalog.products')
  checkOrder(issues, catalog.variants, '$.catalog.variants', (item) => item.productRef)
  checkOrder(issues, catalog.placements, '$.catalog.placements', (item) => `${item.tabRef}|${item.categoryRef ?? ''}`)
  checkOrder(issues, catalog.selectionGroupOptions, '$.catalog.selectionGroupOptions', (item) => item.groupRef)
  checkOrder(issues, catalog.modifiers, '$.catalog.modifiers', (item) => item.groupRef)

  const variantsByProduct = new Map()
  catalog.variants.forEach((variant, index) => {
    if (!productByRef.has(variant.productRef)) issue(issues, 'ERROR', 'VARIANT_WITHOUT_PRODUCT', `$.catalog.variants[${index}].productRef`, 'La variante no apunta a un producto exportado.')
    else variantsByProduct.set(variant.productRef, [...(variantsByProduct.get(variant.productRef) ?? []), variant])
    checkMoney(issues, variant.priceCents, `$.catalog.variants[${index}].priceCents`)
  })
  catalog.products.forEach((product, index) => {
    checkTax(issues, product.taxRate, `$.catalog.products[${index}].taxRate`)
    const productVariants = variantsByProduct.get(product.ref) ?? []
    if (!productVariants.length) issue(issues, 'ERROR', 'PRODUCT_WITHOUT_VARIANTS', `$.catalog.products[${index}]`, `El producto ${product.name} no tiene variantes.`)
    const activeDefaults = productVariants.filter((variant) => variant.isActive && variant.isDefault)
    if (activeDefaults.length === 0) issue(issues, 'ERROR', 'PRODUCT_WITHOUT_DEFAULT_VARIANT', `$.catalog.products[${index}]`, `El producto ${product.name} no tiene variante predeterminada activa.`)
    if (activeDefaults.length > 1) issue(issues, 'ERROR', 'MULTIPLE_DEFAULT_VARIANTS', `$.catalog.products[${index}]`, `El producto ${product.name} tiene varias variantes predeterminadas activas.`)
  })

  catalog.tabCategories.forEach((relation, index) => {
    if (!tabByRef.has(relation.tabRef)) issue(issues, 'ERROR', 'BROKEN_TAB_CATEGORY_TAB', `$.catalog.tabCategories[${index}].tabRef`, 'La asociación apunta a una pestaña inexistente.')
    if (!categoryByRef.has(relation.categoryRef)) issue(issues, 'ERROR', 'BROKEN_TAB_CATEGORY_CATEGORY', `$.catalog.tabCategories[${index}].categoryRef`, 'La asociación apunta a una categoría inexistente.')
  })
  const placementIdentities = new Map()
  catalog.placements.forEach((placement, index) => {
    const path = `$.catalog.placements[${index}]`
    const product = productByRef.get(placement.productRef)
    const tab = tabByRef.get(placement.tabRef)
    const category = placement.categoryRef == null ? null : categoryByRef.get(placement.categoryRef)
    const variant = placement.variantRef == null ? null : variantByRef.get(placement.variantRef)
    if (!product) issue(issues, 'ERROR', 'INVALID_PLACEMENT_PRODUCT', `${path}.productRef`, 'La colocación apunta a un producto inexistente.')
    if (!tab) issue(issues, 'ERROR', 'INVALID_PLACEMENT_TAB', `${path}.tabRef`, 'La colocación apunta a una pestaña inexistente.')
    if (placement.categoryRef != null && !category) issue(issues, 'ERROR', 'INVALID_PLACEMENT_CATEGORY', `${path}.categoryRef`, 'La colocación apunta a una categoría inexistente.')
    if (placement.variantRef != null && (!variant || variant.productRef !== placement.productRef)) issue(issues, 'ERROR', 'INVALID_PLACEMENT_VARIANT', `${path}.variantRef`, 'La variante fijada no pertenece al producto de la colocación.')
    const identity = `${placement.productRef}|${placement.tabRef}|${placement.categoryRef ?? ''}|${placement.variantRef ?? ''}`
    if (placementIdentities.has(identity)) issue(issues, 'ERROR', 'DUPLICATE_PLACEMENT', path, `Duplica exactamente ${placementIdentities.get(identity)}.`)
    else placementIdentities.set(identity, placement.ref)
    if (placement.isActive && (!product?.isActive || !tab?.isActive || (category && !category.isActive) || (variant && !variant.isActive))) {
      issue(issues, 'WARNING', 'ACTIVE_PLACEMENT_WITH_INACTIVE_TARGET', path, 'La colocación está activa y uno de sus destinos está inactivo.')
    }
  })

  const optionsByGroup = new Map()
  const optionIdentities = new Map()
  catalog.selectionGroupOptions.forEach((option, index) => {
    const path = `$.catalog.selectionGroupOptions[${index}]`
    const group = selectionGroupByRef.get(option.groupRef)
    const product = productByRef.get(option.productRef)
    const variant = option.variantRef == null ? null : variantByRef.get(option.variantRef)
    if (!group) issue(issues, 'ERROR', 'BROKEN_SELECTION_GROUP_REF', `${path}.groupRef`, 'La opción apunta a un grupo inexistente.')
    if (!product) issue(issues, 'ERROR', group?.type === 'mixer' ? 'MIXER_WITHOUT_PRODUCT' : 'OPTION_WITHOUT_PRODUCT', `${path}.productRef`, 'La opción no apunta a un producto exportado.')
    if (variant && variant.productRef !== option.productRef) issue(issues, 'ERROR', 'OPTION_VARIANT_PRODUCT_MISMATCH', `${path}.variantRef`, 'La variante de la opción no pertenece a su producto.')
    if (group?.type === 'menu_component' && product?.type === 'menu') issue(issues, 'ERROR', 'NESTED_MENU', path, 'Una opción de menú apunta a otro menú.')
    checkMoney(issues, option.supplementCents, `${path}.supplementCents`, 'INVALID_SUPPLEMENT')
    if (!Number.isSafeInteger(option.defaultQuantity) || option.defaultQuantity < 0 || (option.maxQuantity != null && (!Number.isSafeInteger(option.maxQuantity) || option.maxQuantity < option.defaultQuantity))) {
      issue(issues, 'ERROR', 'INVALID_OPTION_QUANTITY', path, 'Las cantidades predeterminada y máxima de la opción no son válidas.')
    }
    const identity = `${option.groupRef}|${option.productRef}|${option.variantRef ?? ''}`
    if (optionIdentities.has(identity)) issue(issues, 'ERROR', 'DUPLICATE_SELECTION_OPTION', path, `Duplica ${optionIdentities.get(identity)}.`)
    else optionIdentities.set(identity, option.ref)
    optionsByGroup.set(option.groupRef, [...(optionsByGroup.get(option.groupRef) ?? []), option])
    if (option.isActive && (!group?.isActive || !product?.isActive || (variant && !variant.isActive))) issue(issues, 'WARNING', 'ACTIVE_OPTION_WITH_INACTIVE_TARGET', path, 'La opción activa depende de un elemento inactivo.')
  })

  const selectionAssignmentIdentities = new Set()
  catalog.selectionAssignments.forEach((assignment, index) => {
    const path = `$.catalog.selectionAssignments[${index}]`
    const product = productByRef.get(assignment.productRef)
    const group = selectionGroupByRef.get(assignment.groupRef)
    if (!product) issue(issues, 'ERROR', 'BROKEN_SELECTION_ASSIGNMENT_PRODUCT', `${path}.productRef`, 'La asignación apunta a un producto inexistente.')
    if (!group) issue(issues, 'ERROR', 'BROKEN_SELECTION_ASSIGNMENT_GROUP', `${path}.groupRef`, 'La asignación apunta a un grupo inexistente.')
    if (!Number.isSafeInteger(assignment.minSelection) || !Number.isSafeInteger(assignment.maxSelection) || assignment.minSelection < 0 || assignment.maxSelection < 1 || assignment.minSelection > assignment.maxSelection) issue(issues, 'ERROR', 'INVALID_SELECTION_LIMITS', path, 'Los mínimos y máximos de la asignación no son válidos.')
    for (const variantRef of assignment.variantRefs ?? []) {
      const variant = variantByRef.get(variantRef)
      if (!variant || variant.productRef !== assignment.productRef) issue(issues, 'ERROR', 'ASSIGNMENT_VARIANT_PRODUCT_MISMATCH', `${path}.variantRefs`, 'Una variante afectada no pertenece al producto asignado.')
    }
    const identity = `${assignment.productRef}|${assignment.groupRef}`
    if (selectionAssignmentIdentities.has(identity)) issue(issues, 'ERROR', 'DUPLICATE_SELECTION_ASSIGNMENT', path, 'La asignación producto/grupo está duplicada.')
    selectionAssignmentIdentities.add(identity)
    const activeOptions = (optionsByGroup.get(assignment.groupRef) ?? []).filter((option) => option.isActive)
    const capacity = activeOptions.reduce((sum, option) => sum + (option.maxQuantity ?? assignment.maxSelection), 0)
    if (assignment.isActive && assignment.minSelection > capacity) issue(issues, 'ERROR', 'MANDATORY_GROUP_WITHOUT_ENOUGH_OPTIONS', path, 'El grupo obligatorio no ofrece capacidad activa suficiente para cumplir el mínimo.')
    if (assignment.isActive && (!product?.isActive || !group?.isActive)) issue(issues, 'WARNING', 'ACTIVE_ASSIGNMENT_WITH_INACTIVE_TARGET', path, 'La asignación activa depende de un elemento inactivo.')
  })

  catalog.modifiers.forEach((modifier, index) => {
    if (!modifierGroupByRef.has(modifier.groupRef)) issue(issues, 'ERROR', 'MODIFIER_WITHOUT_GROUP', `$.catalog.modifiers[${index}].groupRef`, 'El modificador apunta a un grupo inexistente.')
    checkMoney(issues, modifier.supplementCents, `$.catalog.modifiers[${index}].supplementCents`, 'INVALID_SUPPLEMENT')
  })
  catalog.modifierAssignments.forEach((assignment, index) => {
    const path = `$.catalog.modifierAssignments[${index}]`
    if (!productByRef.has(assignment.productRef)) issue(issues, 'ERROR', 'BROKEN_MODIFIER_ASSIGNMENT_PRODUCT', `${path}.productRef`, 'La asignación de modificadores apunta a un producto inexistente.')
    if (!modifierGroupByRef.has(assignment.groupRef)) issue(issues, 'ERROR', 'BROKEN_MODIFIER_ASSIGNMENT_GROUP', `${path}.groupRef`, 'La asignación apunta a un grupo de modificadores inexistente.')
    if (!Number.isSafeInteger(assignment.minSelection) || !Number.isSafeInteger(assignment.maxSelection) || assignment.minSelection < 0 || assignment.maxSelection < 1 || assignment.minSelection > assignment.maxSelection) issue(issues, 'ERROR', 'INVALID_MODIFIER_LIMITS', path, 'Los límites de la asignación de modificadores no son válidos.')
    for (const variantRef of assignment.variantRefs ?? []) {
      const variant = variantByRef.get(variantRef)
      if (!variant || variant.productRef !== assignment.productRef) issue(issues, 'ERROR', 'MODIFIER_ASSIGNMENT_VARIANT_MISMATCH', `${path}.variantRefs`, 'Una variante afectada no pertenece al producto asignado.')
    }
  })

  const tenantId = document.metadata?.origin?.venue?.trace?.tenantId
  const venueId = document.metadata?.origin?.venue?.trace?.originalId
  for (const name of ['tabs', 'products', 'variants', 'placements', 'selectionGroups', 'selectionGroupOptions', 'modifierGroups', 'modifiers']) {
    catalog[name].forEach((item, index) => {
      if (tenantId && item.trace?.tenantId && item.trace.tenantId !== tenantId) issue(issues, 'ERROR', 'CROSS_TENANT_RELATION', `$.catalog.${name}[${index}].trace.tenantId`, 'El registro pertenece a otro tenant.')
      if (['tabs', 'products', 'variants', 'placements', 'selectionGroups', 'selectionGroupOptions', 'modifierGroups', 'modifiers'].includes(name) && venueId && item.trace?.venueId && item.trace.venueId !== venueId) issue(issues, 'ERROR', 'CROSS_VENUE_RELATION', `$.catalog.${name}[${index}].trace.venueId`, 'El registro pertenece a otro local.')
    })
  }
  for (const product of catalog.products) {
    if (product.source?.isFeatured && !catalog.placements.some((placement) => placement.productRef === product.ref && placement.featured)) issue(issues, 'WARNING', 'UNMAPPED_GLOBAL_FEATURED', `$.catalog.products.${product.ref}.source.isFeatured`, 'El destacado global no coincide con ninguna colocación destacada; requiere decisión de conversión.')
    if (product.source?.canUseAsMixer && !catalog.selectionGroupOptions.some((option) => option.productRef === product.ref && selectionGroupByRef.get(option.groupRef)?.type === 'mixer')) issue(issues, 'WARNING', 'UNMAPPED_LEGACY_MIXER', `$.catalog.products.${product.ref}.source.canUseAsMixer`, 'El producto era mixer, pero no aparece en una opción de grupo mixer.')
    if (!catalog.placements.some((placement) => placement.productRef === product.ref)) issue(issues, 'INFO', 'INTERNAL_PRODUCT', `$.catalog.products.${product.ref}`, 'Producto sin colocaciones: se conservará como producto interno.')
  }
  if (catalog.saleFormats.length) issue(issues, 'INFO', 'SALE_FORMATS_ARE_SOURCE_ONLY', '$.catalog.saleFormats', 'Los formatos actuales se conservan para trazabilidad; las variantes y colocaciones absorben su semántica en el modelo final.')
  if ([...placementByRef.values()].length !== catalog.placements.length) issue(issues, 'ERROR', 'PLACEMENT_INDEX_INCOMPLETE', '$.catalog.placements', 'No se pudieron indexar todas las colocaciones.')
  return summarizeValidation(issues)
}

function summarizeValidation(issues) {
  const counts = { ERROR: 0, WARNING: 0, INFO: 0 }
  for (const item of issues) counts[item.level] += 1
  return { valid: counts.ERROR === 0, counts, issues }
}

export function formatValidation(validation) {
  const lines = [`ERROR ${validation.counts.ERROR} | WARNING ${validation.counts.WARNING} | INFO ${validation.counts.INFO}`]
  for (const item of validation.issues) lines.push(`${item.level} ${item.code} ${item.path} - ${item.message}`)
  return `${lines.join('\n')}\n`
}

export function renderConversionReport(document) {
  const { catalog } = document
  const categoryByRef = new Map(catalog.categories.map((item) => [item.ref, item]))
  const tabByRef = new Map(catalog.tabs.map((item) => [item.ref, item]))
  const variantByRef = new Map(catalog.variants.map((item) => [item.ref, item]))
  const groupByRef = new Map(catalog.selectionGroups.map((item) => [item.ref, item]))
  const lines = [
    '# Informe de conversión del catálogo', '',
    `Origen: ${document.metadata.origin.venue.name}`,
    `Exportado: ${document.metadata.exportedAt}`,
    `Schema: ${document.schemaVersion}`, '',
  ]
  for (const product of catalog.products) {
    lines.push(`## Producto: ${product.name}`, '', `Destino: products (${product.type})`, '', 'Variantes:')
    const variants = catalog.variants.filter((variant) => variant.productRef === product.ref)
    if (variants.length) for (const variant of variants) lines.push(`- ${variant.name}: ${(variant.priceCents / 100).toFixed(2)} EUR${variant.isDefault ? ' · predeterminada' : ''}${variant.isActive ? '' : ' · inactiva'}`)
    else lines.push('- ERROR: no existen variantes recuperables')
    lines.push('', 'Colocaciones previstas:')
    const placements = catalog.placements.filter((placement) => placement.productRef === product.ref)
    if (!placements.length) lines.push('- Ninguna: producto interno')
    for (const placement of placements) {
      const tab = tabByRef.get(placement.tabRef)?.label ?? `[pestaña rota: ${placement.tabRef}]`
      const category = placement.categoryRef ? categoryByRef.get(placement.categoryRef)?.name ?? `[categoría rota: ${placement.categoryRef}]` : 'Sin categoría'
      const variant = placement.variantRef ? variantByRef.get(placement.variantRef)?.name ?? `[variante rota: ${placement.variantRef}]` : 'selector automático'
      lines.push(`- ${tab} / ${category} / ${variant}${placement.featured ? ' · destacada' : ''}${placement.isActive ? '' : ' · inactiva'}`)
    }
    lines.push('', 'Grupos:')
    const assignments = catalog.selectionAssignments.filter((assignment) => assignment.productRef === product.ref)
    if (!assignments.length) lines.push('- Ninguno')
    for (const assignment of assignments) {
      const group = groupByRef.get(assignment.groupRef)
      lines.push(`- ${group?.name ?? `[grupo roto: ${assignment.groupRef}]`} (${group?.type ?? 'desconocido'}), ${assignment.minSelection}-${assignment.maxSelection}, aplicado a ${assignment.variantRefs.length ? assignment.variantRefs.map((ref) => variantByRef.get(ref)?.name ?? ref).join(', ') : 'todas las variantes'}`)
    }
    const ambiguities = []
    if (product.source.isFeatured && !placements.some((placement) => placement.featured)) ambiguities.push('El destacado global no tiene una colocación destacada equivalente.')
    if (product.source.canUseAsMixer && !catalog.selectionGroupOptions.some((option) => option.productRef === product.ref && groupByRef.get(option.groupRef)?.type === 'mixer')) ambiguities.push(`Mixer histórico sin opción contextual; suplemento histórico ${(product.source.mixerSupplementCents / 100).toFixed(2)} EUR.`)
    if (product.source.saleFormatKeys.some((key) => !catalog.saleFormats.some((format) => format.key === key))) ambiguities.push('Hay claves de formato históricas sin definición exportada.')
    if (ambiguities.length) {
      lines.push('', 'Decisión manual requerida:')
      for (const ambiguity of ambiguities) lines.push(`- ${ambiguity}`)
    }
    lines.push('')
  }
  const validation = validateCatalogExport(document)
  lines.push('## Resumen de validación', '', `Errores: ${validation.counts.ERROR}; avisos: ${validation.counts.WARNING}; información: ${validation.counts.INFO}.`, '')
  for (const item of validation.issues.filter((entry) => entry.level !== 'INFO')) lines.push(`- ${item.level} ${item.code}: ${item.message}`)
  return `${lines.join('\n')}\n`
}

export function stableJson(document) {
  return `${JSON.stringify(document, null, 2)}\n`
}
