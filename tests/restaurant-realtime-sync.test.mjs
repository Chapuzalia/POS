import { UserFacingError } from '../src/utils/UserFacingError.ts'
import * as observability from '../src/lib/observability.ts'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createCompiledHookRunner } from './helpers/component-harness.mjs'
import { getReadableError } from '../src/utils/errors.ts'

const source = await readFile(new URL('../src/features/restaurant/hooks/useRestaurantRealtime.ts', import.meta.url), 'utf8')

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function realtimeHarness(overrides = {}) {
  const window = new EventTarget()
  const document = new EventTarget()
  document.visibilityState = 'visible'
  const timers = new Map()
  let timerId = 0
  let now = 0
  for (const [method, repeat] of [['setTimeout', false], ['setInterval', true]]) {
    window[method] = (callback, delay) => {
      const id = ++timerId
      timers.set(id, { callback, delay, repeat, at: now + delay })
      return id
    }
  }
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id)
  const calls = { maps: 0, orders: 0, errors: [], views: [], replaced: [] }
  let databaseMap = { areas: [{ id: 'area' }], tables: [{ id: 'table', occupied: false }], layoutRevision: 0 }
  let databaseOrder = { order: { id: 'order', status: 'open' }, tables: [{ areaId: 'area' }] }
  const channels = []
  const options = {
    context: { tenantId: 'tenant', venueId: 'venue' }, enabled: true, isOnline: true,
    posView: { type: 'table_map' }, saveState: 'saved',
    onError: (error) => calls.errors.push(error),
    setPosView: (view) => calls.views.push(view),
    replaceOrder: (order) => calls.replaced.push(order),
    setEqualSplit() {},
    setSplitOrderGroup() {},
    ...overrides,
  }
  const runner = createCompiledHookRunner(source, 'useRestaurantRealtime', {
    '../../../lib/observability.ts': observability,
    '../../../lib/offlineStore': {},
    '../../../utils/UserFacingError.ts': { UserFacingError },
    '../../../utils/errors': { getReadableError },
    '../../tables/layout-service': { subscribeToVenueTableLayout: () => () => {} },
    '../../tables/service': {
      loadVenueTablesEnabled: async () => true,
      loadRestaurantMap: async () => { calls.maps++; return databaseMap },
      loadRestaurantOrder: async () => { calls.orders++; return databaseOrder },
      subscribeToRestaurantMap: (_context, change, status) => {
        channels.push({ change, status })
        return () => status('CLOSED') // Supabase may emit CLOSED during cleanup.
      },
    },
    '../../../lib/diagnostics': { addDiagnosticBreadcrumb() {} },
  }, { window, document, console: { warn() {} } })
  runner.render(options)
  await flush()
  return {
    calls, options, timers, channels, window, document,
    result: () => runner.render(options),
    occupy() { databaseMap = { ...databaseMap, tables: [{ id: 'table', occupied: true }] } },
    carryForward() { databaseOrder = { ...databaseOrder, order: { ...databaseOrder.order, status: 'carried_forward' } } },
    async rerender(patch) { Object.assign(options, patch); runner.render(options); await flush() },
    async tick(ms) {
      const end = now + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        now = timer.at
        if (timer.repeat) timer.at += timer.delay
        else timers.delete(id)
        timer.callback()
        await flush()
      }
      now = end
    },
    unmount: runner.unmount,
  }
}

test('offline limpia la suscripcion y online refresca sin reinicializar la vista', async () => {
  const h = await realtimeHarness()
  await h.rerender({ isOnline: false })
  assert.equal(h.timers.size, 0)
  h.window.dispatchEvent(new Event('focus'))
  await h.tick(20000)
  assert.equal(h.calls.maps, 1)
  h.occupy()
  await h.rerender({ isOnline: true })
  assert.equal(h.result().map.tables[0].occupied, true)
  assert.equal(h.calls.views.length, 1)
  h.unmount()
})

test('el polling actualiza el mapa sin reemplazar una comanda con cambios pendientes', async () => {
  const h = await realtimeHarness({ posView: { type: 'table_order', orderId: 'order' }, saveState: 'dirty' })
  h.occupy()
  await h.tick(18250)
  assert.equal(h.result().map.tables[0].occupied, true)
  assert.equal(h.calls.orders, 0)
  assert.equal(h.calls.replaced.length, 0)
  h.unmount()
})
