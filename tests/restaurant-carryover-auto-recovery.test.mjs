import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [cashService, notice, carryoverService, migration, releasedTablesMigration] = await Promise.all([
  read('src/features/cash-registers/service.ts'),
  read('src/features/restaurant/components/CarryoverNotice.tsx'),
  read('src/features/restaurant/services/carryovers.ts'),
  read('supabase/migrations/20260908135354_auto_recover_restaurant_carryovers.sql'),
  read('supabase/migrations/20260908141159_release_unloaded_carryover_tables.sql'),
])

test('opening cash atomically recovers pending tables before exposing the session', () => {
  assert.match(cashService, /rpc\('open_cash_register_session_with_carryovers'/)
  assert.match(migration, /opened_session_id := public\.open_cash_register_session\(/)
  assert.match(migration, /perform public\.recover_restaurant_carryovers\(opened_session_id, p_device_id, pending_ids\)/)
})

test('the loaded notice offers a five-second circular undo and removes the old recovery prompt', () => {
  assert.match(notice, /Se han cargado las mesas pendientes del turno anterior\./)
  assert.match(notice, /'No cargar'/)
  assert.match(notice, /const UNDO_WINDOW_MS = 5_000/)
  assert.match(notice, /role="timer"/)
  assert.doesNotMatch(notice, /Recuperar las mesas|Hay consumos pendientes/)
})

test('undo is server-bounded, scoped to the recovering device and refreshes the table map', () => {
  assert.match(carryoverService, /rpc\('unload_restaurant_carryovers'/)
  assert.match(migration, /recovered_by_device_id is distinct from device_row\.id/)
  assert.match(migration, /clock_timestamp\(\) >= transfer_row\.recovery_undo_expires_at/)
  assert.match(migration, /status = 'carried_forward'/)
  assert.match(migration, /recovery_history = recovery_history \|\| jsonb_build_array/)
  assert.match(notice, /if \(unloaded > 0\) await onRecovered\(\)/)
})

test('undo releases the tables and later recovery reuses them only while they are free', () => {
  assert.match(releasedTablesMigration, /recovery_history -> -1 ->> 'event' = 'unloaded'/)
  assert.match(releasedTablesMigration, /update public\.order_tables set released_at = unloaded_at_value/)
  assert.match(releasedTablesMigration, /released_at = \(transfer_row\.recovery_history -> -1 ->> 'at'\)::timestamptz/)
  assert.match(releasedTablesMigration, /ot\.order_group_id <> transfer_row\.order_group_id/)
  assert.match(releasedTablesMigration, /then continue; end if/)
  assert.match(releasedTablesMigration, /parked_table_ids = transfer_row\.recovery_table_ids/)
})
