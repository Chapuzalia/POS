import { randomUUID } from 'node:crypto'
import { CATALOG_FORMAT, CATALOG_SCHEMA_VERSION, COLLECTIONS, assertValidCatalog } from './contract.mjs'

const clone = (value) => structuredClone(value)
export const normalizedName = (value) => String(value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es').trim()

function exactEntity(item, keys) { return Object.fromEntries(keys.map((key) => [key, item[key]])) }

export function upgradeDraftExport(input) {
  if (input?.format !== CATALOG_FORMAT) throw new Error(`Formato no compatible: ${input?.format ?? '<ausente>'}`)
  if (input.schemaVersion === CATALOG_SCHEMA_VERSION) return clone(input)
  if (input.schemaVersion !== 1) throw new Error(`schemaVersion incompatible: ${input.schemaVersion}`)
  const draft = clone(input)
  const usedCategories = new Set([
    ...draft.catalog.tabCategories.map((item) => item.categoryRef),
    ...draft.catalog.placements.map((item) => item.categoryRef).filter(Boolean),
  ])
  const imagesByProduct = new Map(draft.catalog.images.map((item) => [item.productRef, item]))
  const document = {
    format: CATALOG_FORMAT,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    metadata: { ...draft.metadata, exporter: 'scripts/catalog-rebuild', source: { ...(draft.metadata.source ?? {}), upgradedFromDraftSchemaVersion: 1 } },
    catalog: {
      categories: draft.catalog.categories.map((item) => ({ ...exactEntity(item, ['ref', 'name', 'icon', 'sortOrder', 'isActive', 'trace', 'source']), unused: !usedCategories.has(item.ref) })),
      saleFormats: draft.catalog.saleFormats.map((item) => exactEntity(item, ['ref', 'key', 'label', 'sortOrder', 'isActive', 'trace', 'source'])),
      tabs: draft.catalog.tabs.map((item) => exactEntity(item, ['ref', 'key', 'label', 'icon', 'sortOrder', 'isActive', 'trace'])),
      tabCategories: draft.catalog.tabCategories.map((item) => exactEntity(item, ['ref', 'tabRef', 'categoryRef', 'sortOrder', 'isActive', 'source'])),
      products: draft.catalog.products.map((item) => ({ ...exactEntity(item, ['ref', 'type', 'name', 'description', 'taxRate', 'sortOrder', 'isActive', 'trace', 'source']), imageRef: imagesByProduct.get(item.ref)?.ref ?? null })),
      variants: draft.catalog.variants.map((item) => exactEntity(item, ['ref', 'productRef', 'name', 'priceCents', 'sku', 'isDefault', 'sortOrder', 'isActive', 'trace', 'source'])),
      placements: draft.catalog.placements.map((item) => exactEntity(item, ['ref', 'productRef', 'tabRef', 'categoryRef', 'variantRef', 'featured', 'sortOrder', 'isActive', 'trace'])),
      selectionGroups: draft.catalog.selectionGroups.map((item) => exactEntity(item, ['ref', 'name', 'type', 'sortOrder', 'isActive', 'trace', 'source'])),
      selectionGroupOptions: draft.catalog.selectionGroupOptions.map((item) => exactEntity(item, ['ref', 'groupRef', 'productRef', 'variantRef', 'supplementCents', 'defaultQuantity', 'maxQuantity', 'sortOrder', 'isActive', 'trace'])),
      selectionAssignments: draft.catalog.selectionAssignments.map((item) => exactEntity(item, ['ref', 'productRef', 'groupRef', 'variantRefs', 'minSelection', 'maxSelection', 'sortOrder', 'isActive', 'displayName', 'trace'])),
      modifierGroups: draft.catalog.modifierGroups.map((item) => exactEntity(item, ['ref', 'name', 'sortOrder', 'isActive', 'trace', 'source'])),
      modifiers: draft.catalog.modifiers.map((item) => ({
        ...exactEntity(item, ['ref', 'groupRef', 'name', 'sortOrder', 'isActive', 'trace']),
        supplementCents: item.supplementCents ?? item.priceCents,
        isDefault: item.isDefault,
      })),
      modifierAssignments: draft.catalog.modifierAssignments.map((item) => exactEntity(item, ['ref', 'productRef', 'groupRef', 'variantRefs', 'minSelection', 'maxSelection', 'sortOrder', 'isActive', 'displayName', 'trace'])),
      images: draft.catalog.images.map((item) => ({
        ref: item.ref, productRef: item.productRef, file: null, mimeType: null, sizeBytes: null, sha256: null, missing: true,
        trace: item.trace ?? {}, source: { storageBucket: item.storageBucket, path: item.path },
      })),
    },
  }
  document.metadata.counts = Object.fromEntries(COLLECTIONS.map((name) => [name, document.catalog[name].length]))
  return document
}

function labelFor(item, collection, indexes) {
  if (collection === 'tabs') return item.label
  if (collection === 'tabCategories') return indexes.categories.get(item.categoryRef)?.name
  if (collection === 'placements') return indexes.products.get(item.productRef)?.name
  if (collection === 'selectionAssignments' || collection === 'modifierAssignments') return indexes.selectionGroups.get(item.groupRef)?.name ?? indexes.modifierGroups.get(item.groupRef)?.name
  return item.name ?? item.label ?? item.key ?? item.ref
}

function normalizeCollection(items, collection, siblingKey, indexes, changes) {
  const groups = new Map()
  items.forEach((item) => {
    const key = siblingKey(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  })
  for (const [sibling, rows] of groups) {
    rows.sort((a, b) => a.sortOrder - b.sortOrder || normalizedName(labelFor(a, collection, indexes)).localeCompare(normalizedName(labelFor(b, collection, indexes)), 'es') || a.ref.localeCompare(b.ref))
    rows.forEach((item, index) => {
      const imported = (index + 1) * 10
      if (item.sortOrder !== imported) changes.push({ collection, ref: item.ref, sibling, originalSortOrder: item.sortOrder, importedSortOrder: imported })
      item.sortOrder = imported
    })
  }
}

export function normalizeForImport(input) {
  const document = clone(input)
  const changes = { orderNormalizations: [], assignmentChanges: [], excludedVariants: [], unusedCategories: [] }
  const c = document.catalog
  const indexes = {
    products: new Map(c.products.map((item) => [item.ref, item])), variants: new Map(c.variants.map((item) => [item.ref, item])),
    categories: new Map(c.categories.map((item) => [item.ref, item])), selectionGroups: new Map(c.selectionGroups.map((item) => [item.ref, item])),
    modifierGroups: new Map(c.modifierGroups.map((item) => [item.ref, item])),
  }
  normalizeCollection(c.products, 'products', () => 'venue', indexes, changes.orderNormalizations)
  normalizeCollection(c.variants, 'variants', (item) => item.productRef, indexes, changes.orderNormalizations)
  normalizeCollection(c.tabs, 'tabs', () => 'venue', indexes, changes.orderNormalizations)
  normalizeCollection(c.tabCategories, 'tabCategories', (item) => item.tabRef, indexes, changes.orderNormalizations)
  normalizeCollection(c.placements, 'placements', (item) => `${item.tabRef}|${item.categoryRef ?? '<null>'}`, indexes, changes.orderNormalizations)
  normalizeCollection(c.selectionGroupOptions, 'selectionGroupOptions', (item) => item.groupRef, indexes, changes.orderNormalizations)
  normalizeCollection(c.selectionAssignments, 'selectionAssignments', (item) => item.productRef, indexes, changes.orderNormalizations)
  normalizeCollection(c.modifierAssignments, 'modifierAssignments', (item) => item.productRef, indexes, changes.orderNormalizations)
  normalizeCollection(c.modifiers, 'modifiers', (item) => item.groupRef, indexes, changes.orderNormalizations)
  for (const [collection, groups] of [['selectionAssignments', indexes.selectionGroups], ['modifierAssignments', indexes.modifierGroups]]) {
    for (const assignment of c[collection]) {
      const product = indexes.products.get(assignment.productRef); const group = groups.get(assignment.groupRef)
      const originalState = assignment.isActive
      const requestedVariants = [...assignment.variantRefs]
      assignment.variantRefs = assignment.variantRefs.filter((variantRef) => {
        const variant = indexes.variants.get(variantRef)
        if (variant?.isActive) return true
        changes.excludedVariants.push({ collection, assignmentRef: assignment.ref, productRef: assignment.productRef, groupRef: assignment.groupRef, variantRef, originalState: true, importedState: false, rule: 'inactive_variant_excluded' })
        return false
      })
      let rule = null
      if (!product?.isActive) { assignment.isActive = false; rule = 'inactive_product_disables_assignment' }
      else if (!group?.isActive) { assignment.isActive = false; rule = 'inactive_group_disables_assignment' }
      else if (requestedVariants.length && !assignment.variantRefs.length) { assignment.isActive = false; rule = 'all_specific_variants_excluded' }
      if (originalState !== assignment.isActive || rule) changes.assignmentChanges.push({ collection, assignmentRef: assignment.ref, productRef: assignment.productRef, groupRef: assignment.groupRef, originalState, importedState: assignment.isActive, rule })
    }
  }
  changes.unusedCategories = c.categories.filter((item) => item.unused).map((item) => ({ ref: item.ref, name: item.name }))
  return { document, changes }
}

export function buildImportPlan(input, { venueId, uuid = randomUUID } = {}) {
  if (!venueId) throw new Error('venueId es obligatorio')
  assertValidCatalog(input)
  const { document, changes } = normalizeForImport(input)
  const ids = {}
  for (const name of COLLECTIONS.filter((name) => name !== 'saleFormats')) ids[name] = Object.fromEntries(document.catalog[name].map((item) => [item.ref, uuid()]))
  const plan = { venueId, document, generatedIds: ids, changes }
  plan.counts = Object.fromEntries(COLLECTIONS.filter((name) => name !== 'saleFormats').map((name) => [name, document.catalog[name].length]))
  return plan
}

export function stableJson(value) { return `${JSON.stringify(value, null, 2)}\n` }
