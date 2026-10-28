import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeSales } from '../src/features/cash-registers/services/cashSummary.ts'

const movement = (type, amountCents, id = `${type}-${amountCents}`) => ({
  id, tenantId: 'tenant', venueId: 'venue', cashSessionId: 'session', createdBy: 'user', type,
  direction: type === 'cash_in' ? 'entry' : 'exit', amountCents, notes: 'Motivo',
  requestId: `request-${id}`, createdAt: '2026-07-21T10:00:00Z',
})

test('efectivo por tarjeta resta caja y aumenta tarjeta por el mismo importe', () => {
  const summary = summarizeSales(10000, [], [movement('card_cashback', 3000)])
  assert.equal(summary.cashCents, 7000)
  assert.equal(summary.cardCents, 3000)
  assert.equal(summary.cardCashbackCents, 3000)
  assert.equal(summary.cashEntriesCents, 0)
})

test('combina ventas y movimientos sin convertir movimientos en facturacion', () => {
  const sales = [
    { id: 'cash', cashSessionId: 'session', paymentMethod: 'cash', totalCents: 4000, createdAt: '' },
    { id: 'card', cashSessionId: 'session', paymentMethod: 'card', totalCents: 6000, createdAt: '' },
    { id: 'invitation', cashSessionId: 'session', paymentMethod: 'invitation', totalCents: 1000, createdAt: '' },
    { id: 'other', cashSessionId: 'session', paymentMethod: 'other', totalCents: 500, createdAt: '' },
  ]
  const movements = [movement('cash_in', 2000), movement('cash_out', 500), movement('card_cashback', 1500)]
  const summary = summarizeSales(10000, sales, movements)
  assert.equal(summary.cashCents, 14000)
  assert.equal(summary.cardCents, 7500)
  assert.equal(summary.totalSalesCents, 11500)
  assert.equal(summary.cashEntriesCents, 2000)
  assert.equal(summary.cashExitsCents, 500)
  assert.equal(summary.cardCashbackCents, 1500)
})
