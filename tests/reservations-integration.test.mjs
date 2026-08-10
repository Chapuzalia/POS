import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const schemaUrl = new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url)
const migrationUrl = new URL('../supabase/migrations/20260726220000_add_restaurant_reservations.sql', import.meta.url)
const controllerUrl = new URL('../src/features/reservations/hooks/useReservationsController.ts', import.meta.url)
const [schema, migration, controller] = await Promise.all([
  readFile(schemaUrl, 'utf8'),
  readFile(migrationUrl, 'utf8'),
  readFile(controllerUrl, 'utf8'),
])

test('crea reservas persistentes y asignaciones de cero, una o varias mesas', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /create table (?:if not exists )?public\.reservations/i)
    assert.match(sql, /create table (?:if not exists )?public\.reservation_tables/i)
    assert.match(sql, /primary key \(reservation_id, table_id\)/i)
    assert.match(sql, /party_size > 0/i)
    assert.match(sql, /ends_at > starts_at/i)
    assert.match(sql, /reservation_tables_reservation_scope_fk/i)
    assert.match(sql, /reservation_tables_table_scope_fk/i)
    assert.match(sql, /v\.timezone/i)
    assert.doesNotMatch(sql, /v\.time_zone/i)
  }
})

test('la migración puede reanudarse tras una ejecución parcial sin borrar datos', () => {
  assert.match(migration, /create table if not exists public\.reservations/i)
  assert.match(migration, /create table if not exists public\.reservation_tables/i)
  assert.match(migration, /pg_constraint[\s\S]*restaurant_tables_scope_unique/i)
  assert.doesNotMatch(migration, /^do \$$|^end \$;/im)
  assert.match(migration, /^do \$\$/im)
  assert.match(migration, /create index if not exists reservations_venue_starts_at_idx/i)
  assert.match(migration, /drop trigger if exists set_reservations_updated_at/i)
  assert.match(migration, /drop policy if exists reservations_select/i)
})

test('activa RLS, permisos de local, índices y realtime', () => {
  assert.match(migration, /alter table public\.reservations enable row level security/i)
  assert.match(migration, /alter table public\.reservation_tables enable row level security/i)
  assert.match(migration, /user_can_manage_reservations/i)
  assert.match(migration, /reservations_active_date_idx/i)
  assert.match(migration, /reservations_phone_idx/i)
  assert.match(migration, /reservation_tables_overlap_idx/i)
  assert.match(migration, /publication supabase_realtime add table public\.reservations/i)
})

test('las RPC cubren conflicto con override, cancelación, ámbito e idempotencia al sentar', () => {
  assert.match(migration, /create or replace function public\.save_reservation/i)
  assert.match(migration, /r\.starts_at < p_ends_at[\s\S]*r\.ends_at > p_starts_at/i)
  assert.match(migration, /RESERVATION_CONFLICT/i)
  assert.match(migration, /not p_allow_conflict/i)
  assert.match(migration, /RESERVATION_TABLE_SCOPE_OR_INACTIVE/i)
  assert.match(migration, /create or replace function public\.change_reservation_status/i)
  assert.match(migration, /create or replace function public\.seat_reservation/i)
  assert.match(migration, /v_reservation\.status = 'seated' and v_reservation\.order_id is not null[\s\S]*return v_reservation\.order_id/i)
  assert.match(migration, /v_order_id := public\.open_restaurant_order/i)
  assert.match(migration, /set status = 'seated', order_id = v_order_id/i)
})

test('la comanda finalizada completa su reserva y el modelo no depende de la caja', () => {
  assert.match(migration, /complete_reservation_from_order/i)
  assert.match(migration, /set status = 'completed'/i)
  const reservationTable = migration.match(/create table public\.reservations \(([\s\S]*?)\n\);/i)?.[1] ?? ''
  assert.doesNotMatch(reservationTable, /cash_session_id/i)
  assert.match(migration, /Legacy reservation field/i)
})

test('el refresco conserva la reserva seleccionada y descarta respuestas antiguas', () => {
  assert.match(controller, /const refresh = useCallback\(async \(requestedDetailId = detailIdRef\.current\)/)
  assert.match(controller, /requestId !== refreshSequenceRef\.current/)
  assert.match(controller, /reconcileReservationDetail\(current, requestedDetailId, refreshedDetail\)/)
  assert.match(controller, /refresh\(result\.reservation\.id\)/)
  assert.doesNotMatch(controller, /\}, \[date, detail\?\.id, timeZone\]\)/)
})

test('la integración incluye menú, pantalla, mapa operativo y un único SQL raíz', async () => {
  const [header, page, tableMap, tableTypes] = await Promise.all([
    readFile(new URL('../src/components/layout/AppHeader.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/reservations/components/ReservationsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/components/TableMapView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/types.ts', import.meta.url), 'utf8'),
  ])
  assert.match(header, />Reservas</)
  assert.match(header, /sr-only sm:not-sr-only/)
  assert.match(header, /hidden sm:block[\s\S]*<PrintAgentStatusBadge \/>/)
  assert.match(page, /Nueva reserva/)
  assert.match(tableMap, /ReservationTableBadge/)
  assert.match(tableTypes, /nextReservation: RestaurantTableReservation \| null/)
  const entries = await readdir(new URL('../supabase/', import.meta.url), { withFileTypes: true })
  assert.deepEqual(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).map((entry) => entry.name), ['0.Complete_Database_24-07-26.sql'])
})
