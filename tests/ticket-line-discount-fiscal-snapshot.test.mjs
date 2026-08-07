import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { calculateTaxFromGross } from '../src/lib/tax.ts'

const migrationUrl = new URL(
  '../supabase/migrations/20260807120000_fix_discounted_ticket_line_fiscal_snapshot.sql',
  import.meta.url,
)

test('el snapshot fiscal se recalcula cuando el descuento cambia el total neto', async () => {
  const [migration, consolidated] = await Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
  ])

  for (const sql of [migration, consolidated]) {
    assert.match(
      sql,
      /new\.net_total_cents is not distinct from old\.net_total_cents[\s\S]*calculate_tax_from_gross\(new\.net_total_cents, effective_tax_rate\)/i,
    )
  }
})

test('los descuentos del 20 y del 100 por ciento mantienen base mas cuota igual al neto', () => {
  const cases = [
    { discountPercent: 20, netTotalCents: 560, taxableBaseCents: 509, taxAmountCents: 51 },
    { discountPercent: 100, netTotalCents: 0, taxableBaseCents: 0, taxAmountCents: 0 },
  ]

  for (const expected of cases) {
    const netTotalCents = Math.round(700 * (100 - expected.discountPercent) / 100)
    const snapshot = calculateTaxFromGross(netTotalCents, 10)

    assert.deepEqual(snapshot, {
      grossTotalCents: expected.netTotalCents,
      taxableBaseCents: expected.taxableBaseCents,
      taxAmountCents: expected.taxAmountCents,
    })
    assert.equal(snapshot.taxableBaseCents + snapshot.taxAmountCents, netTotalCents)
  }
})
