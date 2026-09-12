import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCatalogSnapshot } from '../src/features/catalog/services/catalogSnapshots.ts'

test('historical snapshots normalize without consulting a live product', () => {
  const snapshot = normalizeCatalogSnapshot({ categoryName: 'Histórica', saleFormatName: 'Copa' }, {
    productId: 'deleted-product',
    productName: 'Nombre histórico',
    variantId: 'deleted-variant',
    variantName: 'Copa',
    basePriceCents: 700,
  })
  assert.equal(snapshot.productName, 'Nombre histórico')
  assert.equal(snapshot.categoryName, 'Histórica')
  assert.equal(snapshot.basePriceCents, 700)
  assert.equal(snapshot.placementId, null)
})
