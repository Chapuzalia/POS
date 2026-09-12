import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createRestaurantControllerHarness, deferred, flush } from './helpers/restaurant-controller-harness.mjs'

const migration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const partialPaymentMigration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const completeDatabase = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8')
const partialPaymentFunction = partialPaymentMigration.match(
  /CREATE FUNCTION public\.pay_restaurant_order_items\([\s\S]*?\r?\n\$\$;/i,
)?.[0] ?? ''

test('cada ocupacion tiene un grupo y las comandas existentes se migran uno a uno', () => {
  assert.match(migration, /create table public\.order_groups/i)
  assert.match(migration, /create table public\.orders[\s\S]*order_group_id uuid not null/i)
  assert.match(migration, /orders_group_split_sequence_unique/)
})

test('la division mueve varias cantidades de forma atomica y protege revisiones concurrentes', () => {
  assert.match(migration, /create function public\.move_restaurant_order_lines/i)
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
  assert.match(migration, /'order_groups'/)
  assert.match(migration, /alter publication supabase_realtime add table public\.%I/i)
})

test('dos intentos simultáneos de cobro por ítems ejecutan una sola acción', async () => {
  const rpc = deferred()
  const cashlogyTransaction = { changeCents: 0, id: 'cashlogy-tx', receivedCents: 600, requestId: 'cashlogy-request', requestedAmountCents: 600 }
  let payments = 0
  let serviceTransaction
  const harness = createRestaurantControllerHarness({ cashlogyTransaction, tableService: {
    payRestaurantOrderItems: async (...args) => { payments += 1; serviceTransaction = args.at(-1); return rpc.promise },
  } })
  const controller = harness.render()
  const first = controller.paySelectedOrderItems([{ lineId: 'line', quantity: 1 }], 'cash', null, false, null)
  await flush()

  await assert.rejects(
    controller.paySelectedOrderItems([{ lineId: 'line', quantity: 1 }], 'cash', null, false, null),
    /cobro en curso/,
  )
  assert.equal(payments, 1)

  rpc.resolve({ paymentId: 'payment', requiresConfirmation: false, saleId: 'sale', subtotalCents: 600, ticketId: 'ticket', totalCents: 600 })
  harness.mapRefresh.resolve({ areas: [{ id: 'area' }], tables: [] })
  await first
  assert.equal(payments, 1)
  assert.strictEqual(serviceTransaction, cashlogyTransaction)
  assert.deepEqual(harness.calls.cashlogySettlements, [600])
  assert.deepEqual(harness.calls.cashlogyFinished, [cashlogyTransaction])
  assert.deepEqual(harness.calls.busy, [true, false])
})

test('el cobro parcial es atomico, descuenta solo la seleccion y mantiene abierta la comanda', () => {
  assert.notEqual(partialPaymentFunction, '')
  assert.match(partialPaymentFunction, /create function public\.pay_restaurant_order_items/i)
  assert.match(partialPaymentFunction, /order by o\.id for update/)
  assert.match(partialPaymentFunction, /p_expected_revision/)
  assert.match(partialPaymentFunction, /using errcode = '40001'/)
  assert.match(partialPaymentFunction, /insert into public\.tickets/)
  assert.match(partialPaymentFunction, /insert into public\.ticket_lines/)
  assert.match(partialPaymentFunction, /delete from public\.order_lines/)
  assert.match(partialPaymentFunction, /quantity = ol\.quantity - selected\.quantity/)
  assert.match(partialPaymentFunction, /update public\.orders o set revision = o\.revision \+ 1/)
  assert.doesNotMatch(partialPaymentFunction, /update public\.orders o set status = 'paid'/)
  assert.doesNotMatch(partialPaymentFunction, /update public\.order_tables set released_at/)
  assert.match(completeDatabase, /create(?: or replace)? function public\.pay_restaurant_order_items/i)
})
