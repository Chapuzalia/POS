import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCatalogExport, validateCatalogExport } from '../scripts/catalog-rebuild-phase-1/catalog-tools.mjs'
import { inconsistentCurrentCatalogSnapshot } from './fixtures/catalog-rebuild-phase-1/inconsistent-current-catalog.mjs'

test('the inconsistent source fixture remains exportable and produces actionable diagnostics', () => {
  const document = buildCatalogExport(inconsistentCurrentCatalogSnapshot(), { exportedAt: '2026-07-22T12:00:00.000Z' })
  const validation = validateCatalogExport(document)
  assert.equal(document.catalog.products.some((product) => product.name === 'Producto inconsistente'), true)
  assert.equal(validation.valid, false)
  const codes = new Set(validation.issues.map((item) => item.code))
  assert.ok(codes.has('PRODUCT_WITHOUT_VARIANTS'))
  assert.ok(codes.has('INVALID_TAX_RATE'))
  assert.ok(codes.has('INVALID_SORT_ORDER'))
  assert.ok(codes.has('CROSS_VENUE_RELATION'))
})
