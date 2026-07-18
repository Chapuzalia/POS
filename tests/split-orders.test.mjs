import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/21.split-restaurant-orders-migration.sql', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const modal = await readFile(new URL('../src/features/tables/components/SplitOrderModal.tsx', import.meta.url), 'utf8')

test('cada ocupacion tiene un grupo y las comandas existentes se migran uno a uno', () => {
  assert.match(migration, /create table if not exists public\.order_groups/)
  assert.match(migration, /insert into public\.order_groups[\s\S]+select o\.id/)
  assert.match(migration, /alter table public\.orders alter column order_group_id set not null/)
  assert.match(migration, /orders_group_split_sequence_unique/)
})

test('la division mueve varias cantidades de forma atomica y protege revisiones concurrentes', () => {
  assert.match(migration, /create or replace function public\.move_restaurant_order_lines/)
  assert.match(migration, /jsonb_array_elements\(p_moves\)/)
  assert.match(migration, /order by o\.id for update/)
  assert.match(migration, /order by \(value ->> 'lineId'\)::uuid/)
  assert.match(migration, /order_row\.revision|source_order\.revision <> p_expected_source_revision/)
  assert.match(migration, /using errcode = '40001'/)
})

test('una division parcial conserva snapshots, mixer, nota y unidades servidas', () => {
  assert.match(migration, /moved_served := least\(line_row\.served_quantity, move_quantity\)/)
  for (const column of ['product_id', 'variant_id', 'product_name', 'variant_name', 'unit_price_cents', 'modifiers', 'mixer_product_id', 'mixer', 'note']) {
    assert.match(migration, new RegExp(column))
  }
  assert.match(migration, /split_from_line_id/)
  assert.match(migration, /if new\.split_from_line_id is null then[\s\S]+line_added/)
  assert.match(migration, /'line_moved'/)
})

test('cobrar una subcomanda solo libera las mesas al cerrar la ultima', () => {
  assert.match(migration, /where o\.order_group_id = order_row\.order_group_id and o\.status = 'open'/)
  assert.match(migration, /if remaining_orders = 0 then[\s\S]+set released_at = now\(\)/)
  assert.match(migration, /'nextOrderId'/)
  assert.match(app, /paymentResult\.nextOrderId/)
})

test('mapa, detalle y realtime trabajan por grupo de ocupacion', () => {
  assert.match(service, /orderByGroup/)
  assert.match(service, /tableIdsByGroup/)
  assert.match(service, /loadRestaurantOrderGroup/)
  assert.match(service, /\['order_groups', 'orders', 'order_tables', 'order_lines'\]/)
  assert.match(migration, /alter publication supabase_realtime add table public\.order_groups/)
})

test('la interfaz permite cantidades parciales, multiples lineas, destino nuevo o existente y cobro individual', () => {
  assert.match(modal, /setLineQuantity/)
  assert.match(modal, /Seleccionar todo/)
  assert.match(modal, /Nueva comanda/)
  assert.match(modal, /Mover productos/)
  assert.match(modal, /Comanda \{detail\.order\.splitSequence\}/)
  assert.match(modal, /Cobrada/)
  assert.match(modal, /Cobrar/)
  assert.match(modal, /h-\[100svh\]/)
  assert.match(modal, /sm:max-w-6xl/)
})
