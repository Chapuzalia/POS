import test from 'node:test'
import assert from 'node:assert/strict'

import { calculateTaxFromGross } from '../src/lib/tax.ts'

test('lineas gratuitas y tickets con varios tipos mantienen la identidad fiscal', () => {
  const lines = [
    calculateTaxFromGross(1000, 21),
    calculateTaxFromGross(500, 10),
    calculateTaxFromGross(0, 4),
  ]
  assert.equal(lines.reduce((sum, line) => sum + line.grossTotalCents, 0), 1500)
  assert.equal(
    lines.reduce((sum, line) => sum + line.taxableBaseCents + line.taxAmountCents, 0),
    1500,
  )
})
