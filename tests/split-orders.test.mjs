import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/21.split-restaurant-orders-migration.sql', import.meta.url), 'utf8')
const partialPaymentMigration = await readFile(new URL('../supabase/24.partial-order-item-payments-migration.sql', import.meta.url), 'utf8')
const completeDatabase = await readFile(new URL('../supabase/0.complete-database.sql', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8')
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
  assert.match(app, /result\.nextOrderId/)
})

test('mapa, detalle y realtime trabajan por grupo de ocupacion', () => {
  assert.match(service, /orderByGroup/)
  assert.match(service, /tableIdsByGroup/)
  assert.match(service, /loadRestaurantOrderGroup/)
  assert.match(service, /\['order_groups', 'orders', 'order_tables', 'order_lines'/)
  assert.match(migration, /alter publication supabase_realtime add table public\.order_groups/)
})

test('por items selecciona cantidades y cobra directamente sin crear subcomandas', () => {
  assert.match(modal, /setLineQuantity/)
  assert.match(modal, /Seleccionar visibles/)
  assert.match(modal, /Buscar productos de la comanda/)
  assert.match(modal, /Marca las unidades que quieras cobrar/)
  assert.match(modal, /Cobrar ítems seleccionados/)
  assert.match(modal, /<PaymentPanel/)
  assert.match(modal, /CashPaymentModal/)
  assert.match(modal, /DiscountModal/)
  assert.match(modal, /Total a cobrar/)
  assert.doesNotMatch(modal, /Nueva comanda|Mover productos|Crear y mover|onMove|onOpenOrder/)
  assert.match(app, /paySelectedOrderItems/)
  assert.match(service, /rpc\('pay_restaurant_order_items'/)
})

test('el cobro parcial es atomico, descuenta solo la seleccion y mantiene abierta la comanda', () => {
  assert.match(partialPaymentMigration, /create or replace function public\.pay_restaurant_order_items/)
  assert.match(partialPaymentMigration, /order by o\.id for update/)
  assert.match(partialPaymentMigration, /p_expected_revision/)
  assert.match(partialPaymentMigration, /using errcode = '40001'/)
  assert.match(partialPaymentMigration, /insert into public\.tickets/)
  assert.match(partialPaymentMigration, /insert into public\.ticket_lines/)
  assert.match(partialPaymentMigration, /delete from public\.order_lines/)
  assert.match(partialPaymentMigration, /quantity = ol\.quantity - selected\.quantity/)
  assert.match(partialPaymentMigration, /update public\.orders o set revision = o\.revision \+ 1/)
  assert.doesNotMatch(partialPaymentMigration, /update public\.orders o set status = 'paid'/)
  assert.doesNotMatch(partialPaymentMigration, /update public\.order_tables set released_at/)
  assert.match(completeDatabase, /create(?: or replace)? function public\.pay_restaurant_order_items/i)
})
