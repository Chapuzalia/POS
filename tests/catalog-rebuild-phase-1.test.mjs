import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildCatalogExport, renderConversionReport, stableJson, validateCatalogExport } from '../scripts/catalog-rebuild-phase-1/catalog-tools.mjs'
import { barSnapshot, restaurantSnapshot } from './fixtures/catalog-rebuild-phase-1/current-catalog-snapshots.mjs'

const exportedAt = '2026-07-22T12:00:00.000Z'

test('exports products, variants, categories, tabs, placements, featured flags, images and fiscal data', () => {
  const document = buildCatalogExport(barSnapshot(), { exportedAt })
  assert.equal(document.schemaVersion, 1)
  assert.equal(document.catalog.products.length, 3)
  assert.equal(document.catalog.variants.length, 4)
  assert.equal(document.catalog.categories.length, 2)
  assert.equal(document.catalog.tabs.length, 2)
  assert.equal(document.catalog.tabCategories.length, 2)
  assert.equal(document.catalog.placements.filter((item) => item.featured).length, 1)
  assert.equal(document.catalog.images[0].path, 'tenant-a/products/gin.webp')
  assert.equal(document.metadata.fiscal.defaultTaxRate, 21)
  assert.ok(document.catalog.placements.every((item) => item.productRef.startsWith('product_')))
  assert.ok(document.catalog.products.every((item) => item.trace.originalId && !item.ref.includes(item.trace.originalId)))
})

test('exports contextual mixer supplements, reusable modifiers, menus and internal products', () => {
  const bar = buildCatalogExport(barSnapshot(), { exportedAt })
  const tonicOption = bar.catalog.selectionGroupOptions.find((item) => item.supplementCents === 100)
  assert.ok(tonicOption)
  assert.equal(bar.catalog.selectionAssignments[0].minSelection, 1)
  assert.equal(bar.catalog.modifierGroups[0].source.ownerProductRef, bar.catalog.products.find((item) => item.name === 'Ginebra').ref)
  assert.equal(bar.catalog.modifiers[0].supplementCents, 50)
  assert.ok(validateCatalogExport(bar).issues.some((item) => item.code === 'INTERNAL_PRODUCT'))

  const restaurant = buildCatalogExport(restaurantSnapshot(), { exportedAt })
  assert.equal(restaurant.catalog.products.find((item) => item.name === 'Menú del día').type, 'menu')
  assert.equal(restaurant.catalog.selectionGroups[0].type, 'menu_component')
  assert.match(renderConversionReport(restaurant), /Producto: Menú del día/)
  assert.match(renderConversionReport(restaurant), /Principal \(menu_component\), 1-1/)
})

test('validation detects broken references, invalid prices, nested menus, duplicates, bad limits and cross-venue data', () => {
  const document = buildCatalogExport(restaurantSnapshot(), { exportedAt })
  const menu = document.catalog.products.find((item) => item.type === 'menu')
  const option = document.catalog.selectionGroupOptions[0]
  option.productRef = menu.ref
  option.variantRef = document.catalog.variants.find((item) => item.productRef === menu.ref).ref
  option.supplementCents = -1
  document.catalog.variants[0].priceCents = -20
  document.catalog.variants[0].trace.venueId = 'another-venue'
  document.catalog.placements[0].categoryRef = 'missing-category'
  document.catalog.placements.push({ ...document.catalog.placements[0], ref: 'placement_duplicate' })
  document.catalog.selectionAssignments[0].minSelection = 3
  document.catalog.selectionAssignments[0].maxSelection = 3
  option.maxQuantity = 1
  const result = validateCatalogExport(document)
  const codes = new Set(result.issues.map((item) => item.code))
  assert.equal(result.valid, false)
  for (const code of ['NESTED_MENU', 'INVALID_SUPPLEMENT', 'INVALID_PRICE', 'CROSS_VENUE_RELATION', 'INVALID_PLACEMENT_CATEGORY', 'DUPLICATE_PLACEMENT', 'MANDATORY_GROUP_WITHOUT_ENOUGH_OPTIONS']) assert.ok(codes.has(code), code)
})

test('validation detects products without variants/defaults and broken variant ownership', () => {
  const document = buildCatalogExport(barSnapshot(), { exportedAt })
  const product = document.catalog.products.find((item) => item.name === 'Sirope interno')
  document.catalog.variants = document.catalog.variants.filter((item) => item.productRef !== product.ref)
  const ginVariants = document.catalog.variants.filter((item) => item.productRef === document.catalog.products.find((item) => item.name === 'Ginebra').ref)
  ginVariants.forEach((item) => { item.isDefault = false })
  document.catalog.variants[0].productRef = 'missing-product'
  const codes = new Set(validateCatalogExport(document).issues.map((item) => item.code))
  assert.ok(codes.has('PRODUCT_WITHOUT_VARIANTS'))
  assert.ok(codes.has('PRODUCT_WITHOUT_DEFAULT_VARIANT'))
  assert.ok(codes.has('VARIANT_WITHOUT_PRODUCT'))
})

test('generation is stable for the same snapshot and timestamp', () => {
  const first = stableJson(buildCatalogExport(barSnapshot(), { exportedAt }))
  const second = stableJson(buildCatalogExport(barSnapshot(), { exportedAt }))
  assert.equal(first, second)
})

test('venue isolation excludes products from another venue fixture', () => {
  const bar = buildCatalogExport(barSnapshot(), { exportedAt })
  const restaurant = buildCatalogExport(restaurantSnapshot(), { exportedAt })
  assert.ok(bar.catalog.products.every((item) => item.trace.venueId === 'venue-bar'))
  assert.ok(restaurant.catalog.products.every((item) => item.trace.venueId === 'venue-restaurant'))
  assert.equal(bar.catalog.products.some((item) => item.name === 'Menú del día'), false)
})

test('validator CLI returns a non-zero status when the export has errors', () => {
  const document = buildCatalogExport(barSnapshot(), { exportedAt })
  document.catalog.variants[0].priceCents = -1
  const directory = mkdtempSync(join(tmpdir(), 'catalog-phase-1-'))
  const file = join(directory, 'invalid.json')
  writeFileSync(file, stableJson(document), 'utf8')
  const command = resolve('scripts/catalog-rebuild-phase-1/validate-catalog.mjs')
  const result = spawnSync(process.execPath, [command, '--file', file], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stdout, /ERROR [1-9]/)
  assert.match(result.stdout, /INVALID_PRICE/)
})
