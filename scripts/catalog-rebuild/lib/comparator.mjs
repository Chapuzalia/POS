import { canonicalCatalog } from './canonicalizer.mjs'
import { normalizeForImport, upgradeDraftExport } from './conversion.mjs'

const deepSort = (value) => Array.isArray(value) ? value.map(deepSort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, deepSort(value[key])])) : value
const canonicalString = (value) => JSON.stringify(deepSort(value))

export { canonicalCatalog }

export function compareCatalogs(source, target) {
  try {
    const sourceV2 = source.schemaVersion === 1 ? upgradeDraftExport(source) : source
    const targetV2 = target.schemaVersion === 1 ? upgradeDraftExport(target) : target
    const left = canonicalCatalog(sourceV2); const right = canonicalCatalog(targetV2)
    if (sourceV2.catalog.images.every((item) => item.missing)) {
      const productOnly = (rows) => rows.map(({ productRef }) => ({ productRef })).sort((a, b) => a.productRef.localeCompare(b.productRef))
      left.images = productOnly(left.images); right.images = productOnly(right.images)
    }
    const expected = normalizeForImport(sourceV2).changes
    if (canonicalString(left) === canonicalString(right)) {
      const expectedCount = expected.orderNormalizations.length + expected.assignmentChanges.length + expected.excludedVariants.length
      return { status: expectedCount ? 'EXPECTED_NORMALIZATION' : 'MATCH', differences: [], expected }
    }
    const differences = []
    for (const name of Object.keys(left)) if (canonicalString(left[name]) !== canonicalString(right[name])) differences.push({ collection: name, source: left[name], target: right[name] })
    return { status: 'DIFFERENCE', differences, expected }
  } catch (error) { return { status: 'ERROR', error: error.message, differences: [] } }
}
