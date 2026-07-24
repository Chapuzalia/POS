import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  calculateGrossFromNet,
  calculateTaxFromGross,
  resolveEffectiveTaxRate,
} from '../src/lib/tax.ts'

test('desglosa 10 EUR por linea con los tipos habituales sin alterar el total final', () => {
  const cases = [
    [21, 826, 174],
    [10, 909, 91],
    [4, 962, 38],
    [0, 1000, 0],
  ]

  for (const [rate, expectedBase, expectedTax] of cases) {
    assert.deepEqual(calculateTaxFromGross(1000, rate), {
      grossTotalCents: 1000,
      taxableBaseCents: expectedBase,
      taxAmountCents: expectedTax,
    })
  }
})

test('editar la base recalcula cuota y precio final desde centimos enteros', () => {
  assert.deepEqual(calculateGrossFromNet(826, 21), {
    grossTotalCents: 999,
    taxableBaseCents: 826,
    taxAmountCents: 173,
  })
})

test('resuelve herencia, IVA propio y cero explicito sin confundirlo con null', () => {
  assert.equal(resolveEffectiveTaxRate(null, 21), 21)
  assert.equal(resolveEffectiveTaxRate(10, 21), 10)
  assert.equal(resolveEffectiveTaxRate(0, 21), 0)
  assert.throws(() => resolveEffectiveTaxRate(-1, 21), /entre 0 y 100/)
  assert.throws(() => resolveEffectiveTaxRate(null, 101), /entre 0 y 100/)
})

test('variantes, modificadores, mixer y cantidad tributan como una unica linea final', () => {
  const unitGrossCents = 800 + 50 + 150
  const result = calculateTaxFromGross(unitGrossCents * 3, 21)
  assert.equal(result.grossTotalCents, 3000)
  assert.equal(result.taxableBaseCents + result.taxAmountCents, 3000)
})

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

test('el esquema consolidado conserva historico y calcula el snapshot en servidor', async () => {
  const sql = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
  assert.match(sql, /tax_rate numeric\(5,2\)/)
  assert.match(sql, /coalesce\(p\.tax_rate, v\.default_tax_rate\)/)
  assert.match(sql, /before insert or update on public\.ticket_lines/i)
  assert.match(sql, /Se ignora cualquier valor fiscal aportado por el cliente/)
  assert.doesNotMatch(sql, /update\s+public\.ticket_lines\s+set\s+tax_rate/i)
})
