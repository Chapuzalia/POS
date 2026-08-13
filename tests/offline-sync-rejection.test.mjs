import assert from 'node:assert/strict'
import test from 'node:test'
import { isClosedCashSaleRejection } from '../src/features/offline/services/cashSessionRejection.ts'

const saleEvent = {
  id: 'event',
  kind: 'sale_created',
  tenantId: 'tenant',
  createdAt: '2026-08-11T12:00:00.000Z',
  attempts: 0,
  payload: {},
}

test('solo los errores reales de caja cerrada activan la recuperacion de caja', () => {
  assert.equal(isClosedCashSaleRejection(saleEvent, {
    code: '55000',
    message: 'No se pueden registrar ventas en una caja cerrada',
  }), true)
  assert.equal(isClosedCashSaleRejection(saleEvent, {
    code: 'P0001',
    message: 'La caja indicada no existe',
  }), true)
})

test('los errores de inventario no eliminan la caja activa', () => {
  assert.equal(isClosedCashSaleRejection(saleEvent, {
    code: '22023',
    message: 'INVENTORY_CONSUMPTION_UNIT_MISMATCH',
  }), false)
  assert.equal(isClosedCashSaleRejection(saleEvent, {
    code: 'P0001',
    message: 'INVENTORY_INSUFFICIENT_STOCK',
  }), false)
})

test('otros eventos offline nunca activan la recuperacion de una venta', () => {
  assert.equal(isClosedCashSaleRejection({ ...saleEvent, kind: 'cash_opened' }, {
    code: '55000',
    message: 'caja cerrada',
  }), false)
})
