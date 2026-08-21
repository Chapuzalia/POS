import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [migration, reservationService, tableService, editor] = await Promise.all([
  readFile(new URL('../supabase/migrations/20260821120000_preserve_table_names_on_delete.sql', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/services/reservationService.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/table-management/TableManagementPage.tsx', import.meta.url), 'utf8'),
])

test('las comandas y reservas guardan una copia del nombre de la mesa', () => {
  assert.match(migration, /alter table public\.order_tables[\s\S]*table_name text/i)
  assert.match(migration, /alter table public\.reservation_tables[\s\S]*table_name text/i)
  assert.match(migration, /snapshot_restaurant_table_reference/i)
  assert.match(migration, /new\.table_name := snapshot_name/i)
  assert.match(migration, /alter column table_name set not null/gi)
})

test('el borrado desacopla la referencia viva y conserva la fila histórica', () => {
  assert.match(migration, /foreign key \(table_id\) references public\.restaurant_tables\(id\) on delete set null/gi)
  assert.match(migration, /order_tables_table_idx[\s\S]*where table_id is not null/i)
  assert.match(migration, /revoke delete on public\.restaurant_tables from authenticated/i)
  assert.match(migration, /grant execute on function public\.delete_restaurant_table\(uuid\) to authenticated/i)
})

test('sustituye las claves primarias antes de permitir referencias nulas y se puede reejecutar', () => {
  const orderPrimaryKey = migration.indexOf('drop constraint if exists order_tables_pkey')
  const orderNullable = migration.indexOf('alter table public.order_tables alter column table_id drop not null')
  const reservationPrimaryKey = migration.indexOf('drop constraint if exists reservation_tables_pkey')
  const reservationNullable = migration.indexOf('alter table public.reservation_tables alter column table_id drop not null')
  assert.ok(orderPrimaryKey >= 0 && orderPrimaryKey < orderNullable)
  assert.ok(reservationPrimaryKey >= 0 && reservationPrimaryKey < reservationNullable)
  assert.match(migration, /drop constraint if exists order_tables_order_table_key/i)
  assert.match(migration, /drop constraint if exists reservation_tables_reservation_table_key/i)
})

test('solo una comanda abierta o una reserva vigente bloquean el borrado', () => {
  assert.match(migration, /TABLE_HAS_OPEN_ORDER/)
  assert.match(migration, /TABLE_HAS_ACTIVE_RESERVATION/)
  assert.match(migration, /history\.released_at is null/)
  assert.match(migration, /reservation\.status in \('arrived', 'seated'\)/)
  assert.match(tableService, /rpc\('delete_restaurant_table'/)
  assert.match(editor, /Su nombre se conservará en el histórico de comandas y reservas/)
})

test('las reservas muestran el nombre guardado cuando la mesa ya no existe', () => {
  assert.match(reservationService, /table_name: string/)
  assert.match(reservationService, /assignment\.table_name/)
  assert.match(reservationService, /areaName: 'Mesa eliminada'/)
  assert.match(migration, /left join public\.restaurant_tables/)
  assert.match(migration, /btrim\(assignment\.table_name\)/)
})
