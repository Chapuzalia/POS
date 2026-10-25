import { UserFacingError } from '../src/utils/UserFacingError.ts'
import * as observability from '../src/lib/observability.ts'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { getReadableError } from '../src/utils/errors.ts'

// Run the actual hooks with isolated React state, browser events and timers.
// No database connection or additional test dependencies are needed.
const sources = Object.fromEntries(await Promise.all(['useRestaurantRealtime', 'useRestaurantController'].map(async (name) => [
  name,
  ts.transpileModule(await readFile(new URL(`../src/features/restaurant/hooks/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText,
])))

function hookRunner(name, modules, globals = {}) {
  const slots = []
  let cursor = 0
  let effects = []
  const react = {
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, (value) => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value }]
    },
    useRef(initial) {
      const index = cursor++
      return slots[index] ??= { current: initial }
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (!slots[index] || deps.some((dep, i) => !Object.is(dep, slots[index].deps[i]))) slots[index] = { callback, deps }
      return slots[index].callback
    },
    useEffect(callback, deps) {
      const index = cursor++
      if (!slots[index] || deps.some((dep, i) => !Object.is(dep, slots[index].deps[i]))) {
        effects.push(() => {
          slots[index]?.cleanup?.()
          slots[index] = { deps, cleanup: callback() }
        })
      }
    },
  }
  const exports = {}
  vm.runInNewContext(sources[name], {
    exports,
    require: (id) => id === 'react' ? react : id === '../../../utils/errors' ? { getReadableError } : (id.endsWith('/UserFacingError.ts') ? { UserFacingError } : id.endsWith('/observability.ts') ? observability : modules[id] ?? {}),
    ...globals,
  })
  return {
    render(options) {
      cursor = 0
      effects = []
      const result = exports[name](options)
      effects.forEach((effect) => effect())
      return result
    },
    unmount() { slots.forEach((slot) => slot.cleanup?.()) },
  }
}

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
  const runner = hookRunner('useRestaurantRealtime', {
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
