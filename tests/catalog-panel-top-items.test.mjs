import assert from 'node:assert/strict'
import test from 'node:test'
import { getAvailableFormatCounts, groupCatalogItemsByProduct, limitTopCatalogItems, TOP_ITEMS_LIMIT } from '../src/components/pos/catalogPanelModel.ts'

function item({ productId, placementId, pinnedVariantId, variantId, isDefault = false }) {
  return {
    product: { id: productId },
    placement: { id: placementId, pinnedVariantId },
    variant: { id: variantId, isDefault },
  }
}

test('top items shows one entry per product even when every format has its own placement', () => {
  const entries = groupCatalogItemsByProduct([
    item({ productId: 'beefeater', placementId: 'placement-cubata', pinnedVariantId: 'cubata', variantId: 'cubata' }),
    item({ productId: 'beefeater', placementId: 'placement-copa', pinnedVariantId: 'copa', variantId: 'copa', isDefault: true }),
    item({ productId: 'beefeater', placementId: 'placement-chupito', pinnedVariantId: 'chupito', variantId: 'chupito' }),
    item({ productId: 'absolut', placementId: 'placement-absolut', pinnedVariantId: null, variantId: 'botella', isDefault: true }),
  ])

  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((entry) => entry.product.id), ['beefeater', 'absolut'])
  assert.equal(entries[0].variant.id, 'copa')
})

test('top items prefers an unpinned appearance so the product default drives the card', () => {
  const entries = groupCatalogItemsByProduct([
    item({ productId: 'beefeater', placementId: 'placement-cubata', pinnedVariantId: 'cubata', variantId: 'cubata' }),
    item({ productId: 'beefeater', placementId: 'placement-product', pinnedVariantId: null, variantId: 'copa', isDefault: true }),
  ])

  assert.equal(entries.length, 1)
  assert.equal(entries[0].placement.id, 'placement-product')
})

test('top items only keeps the first 12 products after ranking', () => {
  const rankedProducts = Array.from({ length: 20 }, (_, index) => ({ id: `product-${index + 1}` }))
  const visibleProducts = limitTopCatalogItems(rankedProducts)

  assert.equal(TOP_ITEMS_LIMIT, 12)
  assert.equal(visibleProducts.length, 12)
  assert.deepEqual(visibleProducts.map((product) => product.id), rankedProducts.slice(0, 12).map((product) => product.id))
})

test('format counts only include the different formats represented in the current tab', () => {
  const counts = getAvailableFormatCounts([
    item({ productId: 'beefeater', placementId: 'placement-cubata-1', pinnedVariantId: 'cubata', variantId: 'cubata' }),
    item({ productId: 'beefeater', placementId: 'placement-cubata-2', pinnedVariantId: 'cubata', variantId: 'cubata' }),
    item({ productId: 'beefeater', placementId: 'placement-copa', pinnedVariantId: 'copa', variantId: 'copa' }),
    item({ productId: 'absolut', placementId: 'placement-botella', pinnedVariantId: 'botella', variantId: 'botella' }),
  ])

  assert.equal(counts.get('beefeater'), 2)
  assert.equal(counts.get('absolut'), 1)
})
