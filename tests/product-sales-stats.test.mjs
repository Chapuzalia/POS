import test from 'node:test'
import assert from 'node:assert/strict'
import { addProductSalesStats, removeProductSalesStats } from '../src/features/quick-sale/services/productSalesStats.ts'

test('actualiza y revierte estadisticas optimistas por producto', () => {
  const added = addProductSalesStats([], [{ productId: 'a', quantity: 2, unitPriceCents: 150 }])
  assert.deepEqual(added, [{ productId: 'a', quantity: 2, totalCents: 300 }])
  assert.deepEqual(removeProductSalesStats(added, [{ productId: 'a', quantity: 2, lineTotalCents: 300 }]), [])
})

test('el top de ventas del TPV prioriza las unidades vendidas sobre la facturacion', () => {
  const stats = addProductSalesStats([], [
    { productId: 'caro', quantity: 1, unitPriceCents: 10_000 },
    { productId: 'popular', quantity: 3, unitPriceCents: 100 },
  ])

  assert.deepEqual(stats.map((stat) => stat.productId), ['popular', 'caro'])
})
