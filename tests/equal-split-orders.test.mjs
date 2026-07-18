import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/22.equal-order-splits-migration.sql', import.meta.url), 'utf8')
const completeDatabase = await readFile(new URL('../supabase/0.complete-database.sql', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const bar = await readFile(new URL('../src/features/tables/components/TableOrderBar.tsx', import.meta.url), 'utf8')
const modal = await readFile(new URL('../src/features/tables/components/EqualSplitOrderModal.tsx', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8')

test('la division a partes iguales persiste el progreso y cada cobro por separado', () => {
  assert.match(migration, /create table if not exists public\.restaurant_order_equal_splits/)
  assert.match(migration, /create table if not exists public\.restaurant_order_equal_split_payments/)
  assert.match(migration, /create or replace function public\.configure_restaurant_order_equal_split/)
  assert.match(migration, /create or replace function public\.pay_restaurant_order_equal_part/)
  assert.match(migration, /insert into public\.tickets/)
  assert.match(migration, /insert into public\.sales/)
  assert.match(migration, /insert into public\.sale_payments/)
  assert.match(migration, /unique \(split_id, part_number\)/)
})

test('los centimos se reparten exactamente y la mesa solo se libera con la ultima parte', () => {
  assert.match(migration, /base_amount := split_row\.total_cents \/ split_row\.part_count/)
  assert.match(migration, /remainder := mod\(split_row\.total_cents, split_row\.part_count\)/)
  assert.match(migration, /part_amount := base_amount \+ case when part_number <= remainder then 1 else 0 end/)
  assert.match(migration, /status = case when s\.paid_parts \+ 1 = s\.part_count then 'completed'/)
  assert.match(migration, /if remaining_orders = 0 then[\s\S]+released_at = now\(\)/)
  assert.match(migration, /'nextOrderId'/)
})

test('tras el primer pago no se puede alterar el contenido que sustenta el reparto', () => {
  assert.match(migration, /guard_paid_equal_split_order_lines/)
  assert.match(migration, /s\.status = 'open' and s\.paid_parts > 0/)
  assert.match(migration, /No se puede modificar una comanda con partes ya cobradas/)
  assert.match(migration, /guard_equal_split_order_close/)
})

test('el dropdown ofrece las dos estrategias y el modal comunica importe y progreso', () => {
  assert.match(bar, /Por ítems/)
  assert.match(bar, /A partes iguales/)
  assert.match(bar, /role="menu"/)
  assert.match(modal, /Número de comensales/)
  assert.match(modal, /Por comensal/)
  assert.match(modal, /Han pagado/)
  assert.match(modal, /Queda por cobrar/)
  assert.match(modal, /role="progressbar"/)
  assert.match(modal, /<PaymentPanel allowDiscount=\{false\}/)
})

test('app, mapa y realtime recuperan la division desde cualquier dispositivo', () => {
  assert.match(app, /openEqualSplitOrder/)
  assert.match(app, /payEqualSplitPart/)
  assert.match(service, /loadRestaurantEqualSplit/)
  assert.match(service, /restaurant_order_equal_splits/)
  assert.match(service, /restaurant_order_equal_split_payments/)
  assert.match(service, /Math\.max\(0, \(totals\.get\(groupId\)/)
  assert.match(migration, /alter publication supabase_realtime add table public\.restaurant_order_equal_splits/)
})

test('la migracion esta incorporada en la base completa', () => {
  assert.match(completeDatabase, /create table if not exists public\.restaurant_order_equal_splits/)
  assert.match(completeDatabase, /create or replace function public\.pay_restaurant_order_equal_part/)
})
