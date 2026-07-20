import test from 'node:test'
import assert from 'node:assert/strict'
import { addProductSalesStats, removeProductSalesStats } from '../src/features/quick-sale/services/productSalesStats.ts'

test('actualiza y revierte estadisticas optimistas por producto', () => {
  const added = addProductSalesStats([], [{ productId: 'a', quantity: 2, unitPriceCents: 150 }])
  assert.deepEqual(added, [{ productId: 'a', quantity: 2, totalCents: 300 }])
  assert.deepEqual(removeProductSalesStats(added, [{ productId: 'a', quantity: 2, lineTotalCents: 300 }]), [])
})
