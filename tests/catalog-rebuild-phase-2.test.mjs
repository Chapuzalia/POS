import assert from 'node:assert/strict'
import test from 'node:test'
import { unzipSync, zipSync } from 'fflate'
import { buildCatalogExport } from '../scripts/catalog-rebuild-phase-1/catalog-tools.mjs'
import { createCatalogArchive, readCatalogArchive } from '../scripts/catalog-rebuild/lib/archive.mjs'
import { compareCatalogs } from '../scripts/catalog-rebuild/lib/comparator.mjs'
import { validateCatalog } from '../scripts/catalog-rebuild/lib/contract.mjs'
import { buildImportPlan, normalizeForImport, upgradeDraftExport } from '../scripts/catalog-rebuild/lib/conversion.mjs'
import { importCatalogArchive, MemoryCatalogRepository } from '../scripts/catalog-rebuild/lib/importer.mjs'
import { calculateSaleLineTotals } from '../src/features/catalog/services/saleLineBuilder.ts'
import { barSnapshot, restaurantSnapshot } from './fixtures/catalog-rebuild-phase-1/current-catalog-snapshots.mjs'

const exportedAt = '2026-07-22T12:00:00.000Z'
const venue = '11111111-1111-4111-8111-111111111111'
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const draft = (snapshot = barSnapshot()) => buildCatalogExport(snapshot, { exportedAt })
const contract = (snapshot = barSnapshot()) => upgradeDraftExport(draft(snapshot))
const archiveFor = async (document = contract(), loadImage = async () => ({ bytes: png, mimeType: 'image/png' })) => {
  const built = await createCatalogArchive(document, { conversionReport: '# Test\n', loadImage })
  return readCatalogArchive(built.bytes)
}

test('freezes schema v2, rejects incompatible versions and fixes phase-1 image refs', () => {
  const document = contract()
  assert.equal(document.schemaVersion, 2)
  assert.equal(validateCatalog(document).counts.ERROR, 0)
  assert.equal(new Set(document.catalog.products.map((item) => item.imageRef).filter(Boolean)).size, document.catalog.images.length)
  assert.throws(() => upgradeDraftExport({ ...draft(), schemaVersion: 99 }), /incompatible/)
  const unknown = structuredClone(document); unknown.catalog.products[0].unexpected = true
  assert.equal(validateCatalog(unknown).valid, false)
})

test('builds and reads a valid ZIP with real type, checksum and deduplication metadata', async () => {
  const document = contract(); document.catalog.products[1].imageRef = 'image_extra'
  document.catalog.images.push({ ...structuredClone(document.catalog.images[0]), ref: 'image_extra', productRef: document.catalog.products[1].ref })
  const archive = await archiveFor(document)
  assert.equal(archive.manifest.images.length, 2)
  assert.equal(archive.manifest.images[0].mimeType, 'image/png')
  assert.equal(archive.manifest.images[0].sha256.length, 64)
  assert.equal(archive.manifest.images[1].deduplicated, true)
  assert.equal(new Set(archive.manifest.images.map((item) => item.file)).size, 1)
})

test('rejects corrupt ZIPs and incorrect image checksums', async () => {
  assert.throws(() => readCatalogArchive(new Uint8Array([1, 2, 3, 4])), /ZIP corrupto/)
  const built = await createCatalogArchive(contract(), { conversionReport: '# Test\n', loadImage: async () => ({ bytes: png, mimeType: 'image/png' }) })
  const files = unzipSync(built.bytes); files[built.manifest.images[0].file] = new Uint8Array([...png, 99])
  assert.throws(() => readCatalogArchive(zipSync(files)), /Checksum incorrecto/)
})

test('keeps a missing image as a warning without failing the backup', async () => {
  const archive = await archiveFor(contract(), async () => null)
  assert.equal(archive.validation.valid, true)
  assert.equal(archive.manifest.images[0].missing, true)
  assert.equal(archive.manifest.warnings[0].code, 'MISSING_IMAGE')
})

test('allows negative supplements but never a negative final unit price', () => {
  const document = contract(); document.catalog.selectionGroupOptions[0].supplementCents = -100
  assert.equal(validateCatalog(document).valid, true)
  assert.throws(() => calculateSaleLineTotals({ priceCents: 50 }, [{ priceDeltaCents: -100, quantity: 1, modifiers: [] }], []), /no puede ser negativo/)
})

test('validates internal products, nested menus, active default variants, ownership and venue scope', () => {
  const internal = contract(); assert.ok(validateCatalog(internal).issues.some((item) => item.code === 'INTERNAL_PRODUCT'))
  const nested = contract(restaurantSnapshot()); nested.catalog.selectionGroupOptions[0].productRef = nested.catalog.products.find((item) => item.type === 'menu').ref
  assert.ok(validateCatalog(nested).issues.some((item) => item.code === 'NESTED_MENU'))
  const defaults = contract(); defaults.catalog.variants.filter((item) => item.productRef === defaults.catalog.products[0].ref).forEach((item) => { item.isDefault = false })
  assert.ok(validateCatalog(defaults).issues.some((item) => item.code === 'INVALID_ACTIVE_DEFAULT_VARIANT_COUNT'))
  const ownership = contract(); ownership.catalog.placements[0].variantRef = ownership.catalog.variants.find((item) => item.productRef !== ownership.catalog.placements[0].productRef).ref
  assert.ok(validateCatalog(ownership).issues.some((item) => item.code === 'PLACEMENT_VARIANT_PRODUCT_MISMATCH'))
  const crossVenue = contract(); crossVenue.catalog.products[0].trace.venueId = 'another-venue'
  assert.ok(validateCatalog(crossVenue).issues.some((item) => item.code === 'CROSS_VENUE_RELATION'))
})

test('marks and preserves unused categories without adding tab associations', () => {
  const document = contract(); const category = document.catalog.categories[1]
  document.catalog.tabCategories = document.catalog.tabCategories.filter((item) => item.categoryRef !== category.ref)
  document.catalog.placements = document.catalog.placements.filter((item) => item.categoryRef !== category.ref)
  category.unused = true
  const plan = buildImportPlan(document, { venueId: venue })
  assert.deepEqual(plan.changes.unusedCategories, [{ ref: category.ref, name: category.name }])
  assert.equal(plan.document.catalog.tabCategories.some((item) => item.categoryRef === category.ref), false)
})

test('normalizes sibling order deterministically and reports every changed value', () => {
  const document = contract(); document.catalog.products.forEach((item) => { item.sortOrder = 0 })
  const { document: normalized, changes } = normalizeForImport(document)
  assert.deepEqual(normalized.catalog.products.map((item) => item.sortOrder).sort((a, b) => a - b), [10, 20, 30])
  assert.equal(changes.orderNormalizations.filter((item) => item.collection === 'products').length, 3)
})

test('deactivates assignments for inactive product/group and excludes inactive specific variants', () => {
  const productCase = contract(); const assignment = productCase.catalog.selectionAssignments[0]
  productCase.catalog.products.find((item) => item.ref === assignment.productRef).isActive = false
  assert.equal(normalizeForImport(productCase).document.catalog.selectionAssignments[0].isActive, false)
  const groupCase = contract(); groupCase.catalog.selectionGroups[0].isActive = false
  assert.equal(normalizeForImport(groupCase).document.catalog.selectionAssignments[0].isActive, false)
  const variantCase = contract(); const specific = variantCase.catalog.selectionAssignments[0].variantRefs[0]
  variantCase.catalog.variants.find((item) => item.ref === specific).isActive = false
  const normalized = normalizeForImport(variantCase)
  assert.equal(normalized.document.catalog.selectionAssignments[0].variantRefs.length, 0)
  assert.equal(normalized.document.catalog.selectionAssignments[0].isActive, false)
  assert.equal(normalized.changes.excludedVariants[0].variantRef, specific)
})

test('dry run performs no writes and empty rejects a populated venue', async () => {
  const archive = await archiveFor(); const repository = new MemoryCatalogRepository()
  await importCatalogArchive(archive, { repository, venueId: venue, mode: 'empty', dryRun: true })
  assert.equal(repository.writes, 0)
  const populated = new MemoryCatalogRepository({ venues: { [venue]: { products: [{}] } } })
  await assert.rejects(importCatalogArchive(archive, { repository: populated, venueId: venue, mode: 'empty' }), /rechazado/)
  assert.equal(populated.writes, 0)
})

test('empty imports with new UUIDs and resolves every relation by ref', async () => {
  const archive = await archiveFor(); const repository = new MemoryCatalogRepository()
  const report = await importCatalogArchive(archive, { repository, venueId: venue, mode: 'empty' })
  const state = repository.snapshot().venues[venue]
  assert.equal(state.products.length, archive.document.catalog.products.length)
  assert.notEqual(report.generatedIds.products[archive.document.catalog.products[0].ref], archive.document.catalog.products[0].trace.originalId)
  assert.ok(state.variants.every((item) => report.generatedIds.products[item.productRef]))
})

test('replace is venue-isolated and preserves tickets, open orders, cash and users', async () => {
  const archive = await archiveFor(); const other = '22222222-2222-4222-8222-222222222222'
  const initial = { venues: { [venue]: { products: [{ old: true }] }, [other]: { products: [{ keep: true }] } }, tickets: [{ id: 'ticket' }], orders: [{ id: 'open-order', status: 'open' }], cash: [{ id: 'cash' }], users: [{ id: 'user' }] }
  const repository = new MemoryCatalogRepository(initial)
  await importCatalogArchive(archive, { repository, venueId: venue, mode: 'replace' })
  const state = repository.snapshot()
  assert.deepEqual(state.venues[other], initial.venues[other])
  assert.deepEqual(state.tickets, initial.tickets); assert.deepEqual(state.orders, initial.orders); assert.deepEqual(state.cash, initial.cash); assert.deepEqual(state.users, initial.users)
})

test('rolls back the full replace transaction on any failure', async () => {
  const archive = await archiveFor(); const repository = new MemoryCatalogRepository({ venues: { [venue]: { products: [{ old: true }] } }, tickets: [{ id: 'history' }] })
  const before = repository.snapshot(); repository.failAfterDelete = true
  await assert.rejects(importCatalogArchive(archive, { repository, venueId: venue, mode: 'replace' }), /Fallo inyectado/)
  assert.deepEqual(repository.snapshot(), before)
})

test('is repeatable on clean stores and direct/ZIP plans are semantically equivalent', async () => {
  const document = contract(); const archive = await archiveFor(document)
  const first = new MemoryCatalogRepository(); const second = new MemoryCatalogRepository()
  await importCatalogArchive(archive, { repository: first, venueId: venue, mode: 'empty' })
  await importCatalogArchive(archive, { repository: second, venueId: venue, mode: 'empty' })
  assert.equal(first.snapshot().venues[venue].products.length, second.snapshot().venues[venue].products.length)
  const direct = normalizeForImport(document).document; const zipped = normalizeForImport(archive.document).document
  assert.equal(compareCatalogs(direct, zipped).status, 'MATCH')
})

test('semantic comparator ignores UUIDs and classifies documented normalization', () => {
  const source = contract(); source.catalog.products.forEach((item) => { item.sortOrder = 0 })
  const target = normalizeForImport(source).document
  target.catalog.products.forEach((item) => { item.trace.originalId = `different-${item.ref}` })
  const comparison = compareCatalogs(source, target)
  assert.equal(comparison.status, 'EXPECTED_NORMALIZATION')
  assert.deepEqual(comparison.differences, [])
})
