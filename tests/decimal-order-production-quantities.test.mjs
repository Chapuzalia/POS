import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../supabase/migrations/20260916130100_decimal_order_production_quantities.sql', import.meta.url),
  'utf8',
)

test('restaurant and production quantities are fixed at three decimal places', () => {
  for (const table of ['order_lines', 'ticket_lines', 'production_items', 'production_line_allocations', 'production_events']) {
    assert.match(migration, new RegExp(`alter table public\\.${table}[\\s\\S]*?numeric\\(18,3\\)`, 'i'))
  }
  assert.doesNotMatch(migration, /alter column allocated_quantity type numeric\(18,3\)/)
  assert.match(migration, /scale\(quantity\) <= 3/)
})

test('the accumulated serving step is explicit, supports Todo, and is used by restaurant and KDS paths', () => {
  assert.match(migration, /create or replace function public\.next_quantity_step/)
  assert.match(migration, /if p_quantity >= remaining then return p_total; end if/)
  assert.match(migration, /if remaining <= 1\.500 then return p_total; end if/)
  assert.match(migration, /next_served := public\.next_quantity_step/)
  assert.match(migration, /next_ready := case when p_quantity::numeric(?:\(18,3\))? >= item_row\.quantity - item_row\.cancelled_quantity - item_row\.ready_quantity/)
  assert.match(migration, /item_row\.ready_quantity \/ item_row\.units_per_commercial_unit/)
})

test('decimal changes preserve legacy RPC signatures, dependencies, production routing, payments and offline validation', () => {
  assert.doesNotMatch(migration, /drop function/i)
  assert.match(migration, /create or replace function public\.mark_order_line_units_served\(p_order_line_id uuid, p_units integer/)
  assert.match(migration, /create or replace function public\.mark_production_item_ready\(p_item_id uuid, p_quantity integer, p_device_id uuid\)/)
  for (const functionName of ['persist_catalog_order_line_draft', 'move_restaurant_order_lines', 'send_production_batch', 'get_order_production_state', 'production_move_allocations_to_split_line', 'production_notify_line_change', 'pay_restaurant_order_items', 'pay_restaurant_order_equal_part', 'sync_sale_created_v2']) {
    assert.match(migration, new RegExp(`pg_get_functiondef\\('public\\.${functionName}`))
  }
  assert.match(migration, /DECIMAL_SEND_PRODUCTION_SIGNATURE_NOT_FOUND/)
  assert.match(migration, /round\(selected\.quantity \* ol\.unit_price_cents\)::integer/)
  assert.match(migration, /round\(\(line ->> ''unitPriceCents''\)::numeric \* \(line ->> ''quantity''\)::numeric\(18,3\)\)::bigint/)
  assert.match(migration, /notify pgrst, 'reload schema'/)
})
