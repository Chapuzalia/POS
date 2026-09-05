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
    require: (id) => id === 'react' ? react : id === '../../../utils/errors' ? { getReadableError } : modules[id] ?? {},
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
  const channels = []
  const options = {
    context: { tenantId: 'tenant', venueId: 'venue' }, enabled: true, isOnline: true,
    posView: { type: 'table_map' }, saveState: 'saved',
    onError: (error) => calls.errors.push(error),
    setPosView: (view) => calls.views.push(view),
    replaceOrder: (order) => calls.replaced.push(order),
    ...overrides,
  }
  const runner = hookRunner('useRestaurantRealtime', {
    '../../tables/service': {
      loadVenueTablesEnabled: async () => true,
      loadRestaurantMap: async () => { calls.maps++; return databaseMap },
      loadRestaurantOrder: async () => { calls.orders++; return { order: { id: 'order', status: 'open' } } },
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

for (const event of ['visibilitychange', 'focus', 'online']) {
  test(`el mapa recupera cambios perdidos al recibir ${event}`, async () => {
    const h = await realtimeHarness()
    h.occupy()
    if (event === 'visibilitychange') {
      h.document.visibilityState = 'hidden'
      h.document.dispatchEvent(new Event(event))
      await h.tick(250)
      assert.equal(h.calls.maps, 1)
      h.document.visibilityState = 'visible'
    }
    const target = event === 'visibilitychange' ? h.document : h.window
    target.dispatchEvent(new Event(event))
    await h.tick(250)
    assert.equal(h.calls.maps, 2)
    assert.equal(h.result().map.tables[0].occupied, true)
    assert.equal(h.calls.views.length, 1, 'no reinicializa la vista al refrescar')
    h.unmount()
  })
}

test('SUBSCRIBED mantiene Realtime y polling de seguridad cada 18 segundos', async () => {
  const h = await realtimeHarness()
  h.channels[0].status('SUBSCRIBED')
  await h.tick(250)
  h.occupy()
  await h.tick(18000)
  assert.equal(h.calls.maps, 3)
  assert.equal(h.result().map.tables[0].occupied, true)
  h.channels[0].change()
  await h.tick(250)
  assert.equal(h.calls.maps, 4)
  h.unmount()
})

for (const status of ['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT']) {
  test(`${status} activa fallback; SUBSCRIBED recupera solo el polling lento`, async () => {
    const h = await realtimeHarness()
    h.channels[0].status(status)
    h.channels[0].status(status)
    assert.equal(h.timers.size, 2, 'no duplica el fallback')
    h.occupy()
    await h.tick(3250)
    assert.equal(h.calls.maps, 2)
    assert.equal(h.result().map.tables[0].occupied, true)
    h.channels[0].status('SUBSCRIBED')
    await h.tick(250)
    await h.tick(3250)
    assert.equal(h.calls.maps, 3, 'el fallback rapido se ha detenido')
    assert.equal(h.timers.size, 1, 'se conserva la comprobacion lenta')
    h.unmount()
  })
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

test('el desmontaje limpia listeners y timers incluso si el canal emite CLOSED', async () => {
  const h = await realtimeHarness()
  h.channels[0].status('CLOSED')
  h.channels[0].change()
  h.unmount()
  h.channels[0].status('CLOSED')
  h.channels[0].change()
  for (const event of ['focus', 'online']) h.window.dispatchEvent(new Event(event))
  h.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(h.timers.size, 0)
  await h.tick(20000)
  assert.equal(h.calls.maps, 1)
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

for (const [message, refreshFails, expectedRefreshes] of [
  ['Una de las mesas ya no esta disponible', false, 1],
  ['Una de las mesas ya no está disponible', true, 1],
  ['La caja o el dispositivo no son validos', false, 0],
]) {
  test(`apertura rechazada: ${message}, fallo de refresco: ${refreshFails}`, async () => {
    const errors = []
    const busy = []
    let refreshes = 0
    const runner = hookRunner('useRestaurantController', {
      '../../tables/service': { openRestaurantOrder: async () => { throw { message, code: 'P0001' } } },
      './useRestaurantDraft': { useRestaurantDraft: () => ({ replaceOrder() {}, saveState: 'saved' }) },
      './useRestaurantRealtime': { useRestaurantRealtime: () => ({
        refreshMap: async () => { refreshes++; if (refreshFails) throw new Error('offline') },
      }) },
      '../../platform/tenantFeatureAccess': { hasTenantFeature: () => false },
    })
    const result = runner.render({
      context: { canTakeOrders: true, deviceId: 'device' }, cashSession: { id: 'session' },
      enabled: true, isOnline: true, isBusy: false,
      syncPendingEvents: async () => {}, onError: (error) => errors.push(error), setBusy: (value) => busy.push(value),
      setAppliedDiscount: () => assert.fail('no debe continuar una apertura rechazada'),
    })
    await result.openTableOrder(['table'], 2)
    assert.equal(refreshes, expectedRefreshes)
    assert.deepEqual(errors, [null, `${message} - Código: P0001`])
    assert.deepEqual(busy, [true, false])
    runner.unmount()
  })
}
