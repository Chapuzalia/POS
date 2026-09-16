import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20260916170000_add_theoretical_profitability.sql', import.meta.url), 'utf8')

test('la rentabilidad conserva snapshots y no rellena históricos', () => {
  assert.match(migration, /add column if not exists theoretical_cost_cents integer/i)
  assert.match(migration, /theoretical_cost_known boolean not null default false/i)
  assert.match(migration, /new\.theoretical_cost_cents := case when new\.theoretical_cost_known/i)
  assert.match(migration, /theoretical_cost_cents is null/i)
})

test('el coste de compras usa las últimas tres compras confirmadas con precio', () => {
  assert.match(migration, /order by coalesce\(document\.confirmed_at, document\.document_date::timestamptz, document\.created_at\) desc/i)
  assert.match(migration, /limit 3/i)
  assert.match(migration, /select avg\(costs\.normalized_unit_cost\)/i)
})

test('los porcentajes de rentabilidad salen de totales y hay cobertura', () => {
  assert.match(migration, /known_net_sales_cents/i)
  assert.match(migration, /known_gross_sales_cents/i)
  assert.match(migration, /theoretical_cost_known then theoretical_cost_cents else 0 end/i)
})
