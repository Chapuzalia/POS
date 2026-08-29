import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20260814120000_add_session_virtual_restaurant_tables.sql', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8')
const mapView = await readFile(new URL('../src/features/tables/components/TableMapView.tsx', import.meta.url), 'utf8')
const virtualModal = await readFile(new URL('../src/features/tables/components/VirtualTableModal.tsx', import.meta.url), 'utf8')
const mobileChrome = await readFile(new URL('../src/features/tables/components/MobileTableMapChrome.tsx', import.meta.url), 'utf8')
const deletionMigration = await readFile(new URL('../supabase/migrations/20260821150000_auto_save_quick_sales_and_delete_virtual_tables.sql', import.meta.url), 'utf8')
const cleanupMigration = await readFile(new URL('../supabase/migrations/20260829200000_cleanup_free_virtual_room_tables.sql', import.meta.url), 'utf8')
const controller = await readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8')

test('las mesas virtuales quedan vinculadas a una sesión y conservan el historial al cerrar', () => {
  assert.match(migration, /add column if not exists cash_session_id uuid references public\.cash_sessions\(id\) on delete restrict/i)
  assert.match(migration, /create function public\.deactivate_closed_session_virtual_tables|create or replace function public\.deactivate_closed_session_virtual_tables/i)
  assert.match(migration, /update public\.restaurant_tables[\s\S]*set is_active = false[\s\S]*where cash_session_id = new\.id/i)
  assert.doesNotMatch(migration, /delete from public\.restaurant_tables[\s\S]*cash_session_id/i)
})

test('una mesa virtual no puede utilizarse desde otra sesión de caja', () => {
  assert.match(migration, /create or replace function public\.validate_order_table_virtual_session/i)
  assert.match(migration, /order_session_id is distinct from table_session_id/i)
  assert.match(migration, /La mesa virtual pertenece a otra sesión de caja/i)
})

test('la distribución solo incluye mesas permanentes y virtuales de la sesión activa', () => {
  const scopedLayoutFilters = migration.match(/rt\.cash_session_id is null or rt\.cash_session_id = session_row\.id/g) ?? []
  assert.ok(scopedLayoutFilters.length >= 3)
  assert.match(service, /cash_session_id\.is\.null,cash_session_id\.eq\.\$\{cashSessionId\}/)
  assert.match(service, /id: `virtual:\$\{cashSessionId\}`[\s\S]*name: 'Virtual'/)
})

test('el mapa permite crear la mesa en Virtual o en una zona existente también en móvil', () => {
  assert.match(mapView, /Mesa virtual/)
  assert.match(mapView, /<VirtualTableModal/)
  assert.match(virtualModal, /<option value="">Virtual<\/option>/)
  assert.match(virtualModal, /areas\.filter\(\(area\) => !area\.id\.startsWith\('virtual:'\)\)/)
  assert.match(virtualModal, /Solo estará disponible durante la sesión de caja actual/)
  assert.match(mobileChrome, /aria-label="Crear mesa virtual"/)
  assert.match(mobileChrome, /className="flex items-center justify-end gap-2"[\s\S]*onClick=\{onCreateVirtual\}[\s\S]*onClick=\{onEditToggle\}/)
})

test('el editor permite eliminar mesas temporales del turno y cancela solo comandas sin cobros', () => {
  assert.match(mapView, /if \(table\?\.isVirtual\)[\s\S]*setSelectedTableId\(table\.id\)/)
  assert.match(mapView, /Eliminar mesa temporal/)
  assert.match(mapView, /await onDeleteVirtual\(selectedTable\.id\)/)
  assert.match(service, /rpc\('delete_session_virtual_restaurant_table'/)
  assert.match(deletionMigration, /create or replace function public\.delete_session_virtual_restaurant_table/)
  assert.match(deletionMigration, /selected_table\.cash_session_id is distinct from session_row\.id/)
  assert.match(deletionMigration, /VIRTUAL_TABLE_HAS_PAYMENTS/)
  assert.match(deletionMigration, /set status = 'cancelled'/)
  assert.match(deletionMigration, /tables = \([\s\S]*layout\.tables - selected_table\.id::text/)
  assert.match(deletionMigration, /delete from public\.restaurant_tables/)
})

test('solo las mesas libres de la sala Virtual se eliminan automáticamente', () => {
  assert.match(cleanupMigration, /create or replace function public\.cleanup_virtual_room_restaurant_table/)
  assert.match(cleanupMigration, /if selected_table\.area_id is not null then return false/)
  assert.match(cleanupMigration, /if exists \([\s\S]*public\.order_lines[\s\S]*return false/)
  assert.match(cleanupMigration, /delete from public\.restaurant_tables[\s\S]*tables\.area_id is null/)
  assert.match(service, /rpc\('cleanup_virtual_room_restaurant_table'/)
  assert.match(controller, /table\.isVirtual && table\.areaId\.startsWith\('virtual:'\)/)
})

test('la limpieza se ejecuta al vaciar, cobrar o mover la comanda', () => {
  const cleanupCalls = controller.match(/await cleanupVirtualRoomTable\(/g) ?? []
  assert.ok(cleanupCalls.length >= 6)
  assert.match(controller, /cancelEmptyRestaurantOrder[\s\S]*cleanupVirtualRoomTable\(saved, false\)/)
  assert.match(controller, /moveRestaurantOrder\(moveOrderId, tableId\)[\s\S]*cleanupVirtualRoomTable\(sourceOrder, false\)/)
  assert.match(controller, /saved\.lines\.length === 1[\s\S]*cleanupVirtualRoomTable\(saved, false\)/)
  assert.match(controller, /selectionContainsAllOrderLines\(saved\.lines, moves\)[\s\S]*cleanupVirtualRoomTable\(saved, true\)/)
})
