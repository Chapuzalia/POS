import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rectificativeLineAmounts } from '../src/features/fiscal/local/localLedger.ts'
import { assertFiscalClock } from '../src/features/fiscal/local/clock.ts'

test('la devolución invierte el desglose fiscal guardado sin recalcular el IVA', () => {
  assert.deepEqual(rectificativeLineAmounts({ description: 'Bebida', grossCents: 600, discountCents: 0, baseCents: 545, taxCents: 55, taxRate: '10.00' }, 1, 1), {
    description: 'Bebida', grossCents: -600, discountCents: 0, baseCents: -545, taxCents: -55, taxRate: '10.00',
  })
})

test('clock reference rejects future drift, rollback and stale samples', () => {
  const sample = { serverUtcAtReceipt: '2026-09-28T10:00:00Z', wallUtcAtReceipt: Date.parse('2026-09-28T10:00:00Z'), monotonicAtReceipt: 1000 }
  assert.doesNotThrow(() => assertFiscalClock(sample, Date.parse('2026-09-28T10:01:00Z'), 61000))
  assert.throws(() => assertFiscalClock(sample, Date.parse('2026-09-28T10:10:00Z'), 61000), /reloj/)
  assert.throws(() => assertFiscalClock(sample, Date.parse('2026-09-28T09:50:00Z'), 61000), /reloj/)
  assert.throws(() => assertFiscalClock(sample, Date.parse('2026-09-29T11:00:00Z'), 90001000), /referencia horaria/)
})
