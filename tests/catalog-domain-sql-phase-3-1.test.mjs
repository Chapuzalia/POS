import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const tableService = readFileSync(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8')

test('las comandas usan la RPC definitiva sin sufijo', () => {
  assert.match(tableService, /rpc\('save_catalog_order_lines'/)
  assert.doesNotMatch(tableService, /save_restaurant_order_lines_v3/)
})

test('la RPC de venta canoniza exclusivamente contra asignaciones finales', () => {
  assert.match(migration, /product_selection_group_assignments/)
  assert.match(migration, /selection_group_options/)
  assert.match(migration, /product_modifier_group_assignments/)
  assert.match(migration, /canonical_catalog_modifiers/)
  assert.match(migration, /CATALOG_NEGATIVE_FINAL_PRICE/)
  assert.doesNotMatch(migration, /selection_group_items|variant_selection_groups|product_modifier_groups/)
})
