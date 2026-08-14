import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20260814120000_add_session_virtual_restaurant_tables.sql', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8')
const mapView = await readFile(new URL('../src/features/tables/components/TableMapView.tsx', import.meta.url), 'utf8')
const mobileChrome = await readFile(new URL('../src/features/tables/components/MobileTableMapChrome.tsx', import.meta.url), 'utf8')

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
  assert.match(mapView, /<option value="">Virtual<\/option>/)
  assert.match(mapView, /map\.areas\.filter\(\(area\) => !area\.id\.startsWith\("virtual:"\)\)/)
  assert.match(mapView, /Solo estará disponible durante la sesión de caja actual/)
  assert.match(mobileChrome, /aria-label="Crear mesa virtual"/)
  assert.match(mobileChrome, /className="flex items-center justify-end gap-2"[\s\S]*onClick=\{onCreateVirtual\}[\s\S]*onClick=\{onEditToggle\}/)
})
