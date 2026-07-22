import { normalizeForImport, upgradeDraftExport } from './conversion.mjs'
import { assertValidCatalog } from './contract.mjs'

const deepSort = (value) => Array.isArray(value) ? value.map(deepSort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, deepSort(value[key])])) : value
const canonicalString = (value) => JSON.stringify(deepSort(value))
const strip = (value) => {
  if (Array.isArray(value)) return value.map(strip)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['ref', 'trace', 'source', 'id', 'venueId'].includes(key)).map(([key, item]) => [key, strip(item)]))
}
const keyed = (rows, key) => new Map(rows.map((row) => [row.ref, key(row)]))
const mapped = (value, map) => value == null ? null : map.get(value) ?? `[missing:${value}]`

export function canonicalCatalog(input) {
  const document = input.schemaVersion === 1 ? upgradeDraftExport(input) : structuredClone(input)
  assertValidCatalog(document)
  const normalized = normalizeForImport(document).document.catalog
  const products = keyed(normalized.products, (item) => `product:${item.type}:${item.name}`)
  const variants = keyed(normalized.variants, (item) => `variant:${mapped(item.productRef, products)}:${item.name}:${item.sku ?? ''}`)
  const categories = keyed(normalized.categories, (item) => `category:${item.name}`)
  const tabs = keyed(normalized.tabs, (item) => `tab:${item.key}:${item.label}`)
  const groups = keyed(normalized.selectionGroups, (item) => `selection-group:${item.type}:${item.name}`)
  const modifierGroups = keyed(normalized.modifierGroups, (item) => `modifier-group:${item.name}`)
  const convert = {
    categories: (item) => strip(item), tabs: (item) => strip(item),
    tabCategories: (item) => ({ ...strip(item), tabRef: mapped(item.tabRef, tabs), categoryRef: mapped(item.categoryRef, categories) }),
    products: (item) => ({ ...strip(item), imageRef: item.imageRef ? `image:${mapped(item.ref, products)}` : null }),
    variants: (item) => ({ ...strip(item), productRef: mapped(item.productRef, products) }),
    placements: (item) => ({ ...strip(item), productRef: mapped(item.productRef, products), tabRef: mapped(item.tabRef, tabs), categoryRef: mapped(item.categoryRef, categories), variantRef: mapped(item.variantRef, variants) }),
    selectionGroups: (item) => strip(item),
    selectionGroupOptions: (item) => ({ ...strip(item), groupRef: mapped(item.groupRef, groups), productRef: mapped(item.productRef, products), variantRef: mapped(item.variantRef, variants) }),
    selectionAssignments: (item) => ({ ...strip(item), productRef: mapped(item.productRef, products), groupRef: mapped(item.groupRef, groups), variantRefs: item.variantRefs.map((ref) => mapped(ref, variants)).sort() }),
    modifierGroups: (item) => strip(item), modifiers: (item) => ({ ...strip(item), groupRef: mapped(item.groupRef, modifierGroups) }),
    modifierAssignments: (item) => ({ ...strip(item), productRef: mapped(item.productRef, products), groupRef: mapped(item.groupRef, modifierGroups), variantRefs: item.variantRefs.map((ref) => mapped(ref, variants)).sort() }),
    images: (item) => ({ ...strip(item), productRef: mapped(item.productRef, products) }),
  }
  return Object.fromEntries(Object.entries(convert).map(([name, fn]) => [name, normalized[name].map(fn).sort((a, b) => canonicalString(a).localeCompare(canonicalString(b)))]))
}

export function compareCatalogs(source, target) {
  try {
    const sourceV2 = source.schemaVersion === 1 ? upgradeDraftExport(source) : source
    const targetV2 = target.schemaVersion === 1 ? upgradeDraftExport(target) : target
    const left = canonicalCatalog(sourceV2); const right = canonicalCatalog(targetV2)
    if (sourceV2.catalog.images.every((item) => item.missing)) {
      left.images = left.images.map(({ productRef }) => ({ productRef }))
      right.images = right.images.map(({ productRef }) => ({ productRef }))
    }
    if (canonicalString(left) === canonicalString(right)) {
      const expected = normalizeForImport(sourceV2).changes
      const expectedCount = expected.orderNormalizations.length + expected.assignmentChanges.length + expected.excludedVariants.length
      return { status: expectedCount ? 'EXPECTED_NORMALIZATION' : 'MATCH', differences: [], expected }
    }
    const differences = []
    for (const name of Object.keys(left)) if (canonicalString(left[name]) !== canonicalString(right[name])) differences.push({ collection: name, source: left[name], target: right[name] })
    return { status: 'DIFFERENCE', differences, expected: normalizeForImport(sourceV2).changes }
  } catch (error) { return { status: 'ERROR', error: error.message, differences: [] } }
}
