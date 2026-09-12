import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { compileComponent, createCompiledHookRunner, expandedNodes, jsxRuntime } from './helpers/component-harness.mjs'
import { flush } from './helpers/restaurant-controller-harness.mjs'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [cashServiceSource, noticeSource, migration, releasedTablesMigration] = await Promise.all([
  read('src/features/cash-registers/service.ts'),
  read('src/features/restaurant/components/CarryoverNotice.tsx'),
  read('supabase/migrations/20260908135354_auto_recover_restaurant_carryovers.sql'),
  read('supabase/migrations/20260908141159_release_unloaded_carryover_tables.sql'),
])

function queryResult(result) {
  const query = {
    eq() { return query },
    order() { return Promise.resolve(result) },
    select() { return query },
  }
  return query
}

test('abrir caja usa el servicio real y no expone la sesión hasta recargarla', async () => {
  const calls = []
  const supabase = {
    from(table) {
      if (table === 'cash_registers') return queryResult({ data: [{ id: 'register-1', tenant_id: 'tenant', venue_id: 'venue', name: 'Principal', is_active: true, sort_order: 1 }], error: null })
      return queryResult({ data: [{ id: 'session-new', tenant_id: 'tenant', venue_id: 'venue', cash_register_id: 'register-1', opened_by_device_id: 'device', opened_by: 'user', opened_at: '2026-09-12T00:00:00Z', opening_float_cents: 1000 }], error: null })
    },
    async rpc(name, params) {
      calls.push([name, params])
      return { data: 'session-new', error: null }
    },
  }
  const { openCashRegisterSession } = compileComponent(cashServiceSource, {
    '../../lib/observability.ts': { reportOperationError() {} },
    '../../lib/supabase': { supabase },
    '../local-printing/schemas/printSchemas': { cashClosingPrintDocumentSchema: { parse: (value) => value } },
  })
  const context = { deviceId: 'device', tenantId: 'tenant', userId: 'user', venueId: 'venue' }

  const session = await openCashRegisterSession(context, 'register-1', 1000)

  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'open_cash_register_session_with_carryovers')
  assert.equal(calls[0][1].p_cash_register_id, 'register-1')
  assert.equal(calls[0][1].p_device_id, 'device')
  assert.equal(calls[0][1].p_opening_float_cents, 1000)
  assert.equal(session.id, 'session-new')
  assert.equal(session.cashRegisterName, 'Principal')
})

test('deshacer el arrastre ejecuta una sola descarga y refresca el mapa', async () => {
  const calls = { load: 0, recovered: 0, unload: [] }
  const carryover = {
    carried_at: '2026-09-12T00:00:00Z',
    from_cash_session_id: 'session-old',
    id: 'carryover-1',
    order_group_id: 'group-1',
    order_ids: ['order-1'],
    recovery_undo_expires_at: new Date(Date.now() + 5_000).toISOString(),
  }
  const runner = createCompiledHookRunner(noticeSource, 'CarryoverNotice', {
    'react/jsx-runtime': jsxRuntime,
    '../../../components/ui': { Button: 'button' },
    '../../../utils/errors': { getReadableError: (error) => error?.message ?? String(error) },
    '../services/carryovers': {
      loadRecoveredRestaurantCarryovers: async () => { calls.load += 1; return [carryover] },
      unloadRestaurantCarryovers: async (_context, sessionId, ids) => { calls.unload.push([sessionId, ids]); return 1 },
    },
  }, {
    window: { clearInterval() {}, setInterval() { return 1 } },
  })
  const props = {
    context: { canTakeOrders: true, deviceId: 'device', tenantId: 'tenant', venueId: 'venue' },
    disabled: false,
    isOnline: true,
    onRecovered: async () => { calls.recovered += 1 },
    session: { id: 'session-new' },
  }

  runner.render(props)
  await flush()
  const button = expandedNodes(runner.render(props)).find((node) => node.type === 'button')
  button.props.onClick()
  button.props.onClick()
  await flush()
  await flush()

  assert.equal(calls.load, 1)
  assert.deepEqual(calls.unload, [['session-new', ['carryover-1']]])
  assert.equal(calls.recovered, 1)
  assert.equal(runner.render(props), null)
})

test('las garantías SQL del arrastre y su ventana de deshacer conservan su protección actual', () => {
  assert.match(migration, /opened_session_id := public\.open_cash_register_session\(/)
  assert.match(migration, /perform public\.recover_restaurant_carryovers\(opened_session_id, p_device_id, pending_ids\)/)
  assert.match(migration, /recovered_by_device_id is distinct from device_row\.id/)
  assert.match(migration, /clock_timestamp\(\) >= transfer_row\.recovery_undo_expires_at/)
  assert.match(migration, /status = 'carried_forward'/)
  assert.match(migration, /recovery_history = recovery_history \|\| jsonb_build_array/)
})

test('la liberación SQL de mesas descargadas conserva su protección actual', () => {
  assert.match(releasedTablesMigration, /recovery_history -> -1 ->> 'event' = 'unloaded'/)
  assert.match(releasedTablesMigration, /update public\.order_tables set released_at = unloaded_at_value/)
  assert.match(releasedTablesMigration, /released_at = \(transfer_row\.recovery_history -> -1 ->> 'at'\)::timestamptz/)
  assert.match(releasedTablesMigration, /ot\.order_group_id <> transfer_row\.order_group_id/)
  assert.match(releasedTablesMigration, /then continue; end if/)
  assert.match(releasedTablesMigration, /parked_table_ids = transfer_row\.recovery_table_ids/)
})
