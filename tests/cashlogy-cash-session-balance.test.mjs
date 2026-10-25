import assert from 'node:assert/strict'

import test from 'node:test'

import { validateCashlogyTotal } from '../src/features/local-printing/cashlogy/cashlogyCashBalanceValidation.ts'
import { getExpectedCashAfterStackerCollections } from '../src/features/cash-registers/services/cashSummary.ts'

test('el fondo Cashlogy suma reciclador y stacker y rechaza lecturas incoherentes', () => {
  const total = { recyclerTotalCents: 5000, stackerTotalCents: 12000, totalCents: 17000, queriedAt: '2026-08-19T10:00:00Z' }
  assert.equal(validateCashlogyTotal(total).totalCents, 17000)
  assert.throws(() => validateCashlogyTotal({ ...total, totalCents: 16999 }), /no coincide/)
  assert.throws(() => validateCashlogyTotal({ ...total, stackerTotalCents: -1 }), /no válido/)
})

test('el cierre previo descuenta las retiradas de stacker antes de exigir una justificación', async () => {

  const expectedBeforeCollectionCents = 15000
  const stackerCollectionsCents = 3000
  const countedCashlogyCents = 12000
  assert.equal(countedCashlogyCents - getExpectedCashAfterStackerCollections(expectedBeforeCollectionCents, stackerCollectionsCents), 0)
})
