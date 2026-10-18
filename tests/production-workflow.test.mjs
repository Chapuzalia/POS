import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as format from '../src/lib/format.ts'
import * as routing from '../src/features/production/routing.ts'
import * as kdsQueue from '../src/features/production/kds-queue.ts'
import * as orderProgress from '../src/features/production/order-progress.ts'
import * as serviceStatus from '../src/features/tables/service-status.ts'
import { compileComponent, createCompiledHookRunner, createHookHarness, expandedNodes, jsxRuntime, nodes } from './helpers/component-harness.mjs'

const source = path => readFileSync(new URL(`../src/features/${path}`, import.meta.url), 'utf8')
const icon = () => null
const icons = Object.fromEntries(['Beaker', 'Check', 'CheckCheck', 'ListChecks', 'LogOut', 'RefreshCw', 'TriangleAlert', 'WifiOff', 'X', 'Minus', 'Pencil', 'Plus', 'Trash2', 'Send'].map(name => [name, icon]))
const Button = props => jsxRuntime.jsx('button', props)
const empty = () => null
const entry = { lineId: 'line', componentId: null, productName: 'Absolut', quantity: 5, sentQuantity: 4, readyQuantity: 0, unsentQuantity: 1, passId: 'pass', passName: 'Directo', passSortOrder: 0, hasProductionDestination: true }
const line = { id: 'line', productName: 'Absolut', quantity: 5, servedQuantity: 4, unitPriceCents: 600, modifiers: [], components: [], catalogSnapshot: {} }
const state = { effective: true, entries: [entry], lines: [{ ...entry, hasProductionDestination: true }], warnings: [] }
const text = node => node == null ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props?.children) : String(node)

test('new units remain sendable after serving, including a local increment before Realtime', () => {
  assert.equal(routing.getProductionUnsentQuantity(entry, line), 1)
  assert.equal(routing.getProductionUnsentQuantity({ ...entry, quantity: 4, unsentQuantity: 0 }, line), 1)
  assert.equal(routing.getProductionUnsentQuantity({ ...entry, sentQuantity: 1, skippedQuantity: 4 }, line), 0)
  assert.equal(routing.getProductionUnsentQuantity({ ...entry, sentQuantity: 1, skippedQuantity: 4 }, { quantity: 5.5, servedQuantity: 4 }), 0.5)
  assert.equal(routing.getProductionUnsentQuantity(entry, { ...line, servedQuantity: 5 }), 0)
})

test('POS shows 1 on both sides of the pending row, 4 in completed, sends only 1 and edits the pending quantity', () => {
  const harness = createHookHarness()
  const sent = []
  const quantities = []
  const modules = {
    react: harness.react, 'react/jsx-runtime': jsxRuntime, 'react-dom': { createPortal: node => node },
    'lucide-react': icons, '../../../components/ui': { Button },
    '../../../components/ui/NativeSelect': { NativeSelect: empty },
    '../../../lib/format': format, '../../../lib/mixers': { getLineAdditionNames: () => [] },
    '../service-status': serviceStatus,
    '../../../components/pos/MenuComponentDetails': { MenuComponentDetails: empty },
    '../../../components/pos/InvoiceTicketNotice': { InvoiceTicketNotice: empty },
    '../../../components/ui/NumericKeypadModal': { NumericKeypadModal: empty },
    '../../production/components/ProductionControls': { ProductionControls: empty },
    '../../production/routing': routing,
    '../../production/order-progress': orderProgress,
  }
  const { RestaurantOrderPanel } = compileComponent(source('tables/components/RestaurantOrderPanel.tsx'), modules)
  const props = { order: { lines: [line] }, isBusy: false, lineDiscounts: {}, productionState: state,
    onSendToProduction: selection => sent.push(selection), onSetQuantity: (...args) => quantities.push(args) }
  let tree = harness.render(RestaurantOrderPanel, props)
  const rendered = expandedNodes(tree)
  const quantityButtons = rendered.filter(node => node.type === 'button' && node.props['aria-label'] === 'Editar cantidad de Absolut')
  assert.deepEqual(quantityButtons.map(node => text(node)), ['1', '4'])
  assert.equal(quantityButtons[1].props.disabled, true)
  assert.match(text(tree), /Directo · 1 nuevos/)
  const send = nodes(tree).find(node => text(node) === 'Enviar Directo · 1')
  send.props.onClick()
  assert.equal(sent[0][0].quantity, 1)
  quantityButtons[0].props.onClick()
  tree = harness.render(RestaurantOrderPanel, props)
  const keypad = nodes(tree).find(node => node.props.initialValue === '1')
  assert.ok(keypad)
  keypad.props.onConfirm('2')
  assert.deepEqual(quantities, [['line', 6]])
})

test('manual production selection uses the same single remaining unit', () => {
  const sent = []
  const runner = createCompiledHookRunner(source('production/components/ProductionControls.tsx'), 'ProductionControls', {
    'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
    '../../../components/ui': { AppModal: props => props.children, Button },
    '../../../lib/format': format, '../routing': routing,
  })
  const props = { order: { lines: [line] }, state, disabled: false, onSend: selection => sent.push(selection) }
  let tree = runner.render(props)
  tree.props.children[0].props.onClick()
  tree = runner.render(props)
  nodes(tree).find(node => text(node) === ' Enviar 1').props.onClick()
  assert.equal(sent[0][0].quantity, 1)
  assert.equal(runner.render({ ...props, state: { ...state, entries: [{ ...entry, sentQuantity: 5, unsentQuantity: 0 }] } }), null)
})

const item = (id, overrides = {}) => ({ id, batchId: 'batch1', batchSequence: 1, orderId: 'order1', tableName: 'Mesa 7', quantity: 1, readyQuantity: 0, cancelledQuantity: 0, snapshot: { productName: id, passName: 'Directo' }, sentAt: '2026-10-17T11:56:00Z', ...overrides })

test('five products form one card, subsequent sends queue separately and tables with the same sequence stay distinct', () => {
  const items = [item('second', { batchId: 'batch2', batchSequence: 2, sentAt: '2026-10-17T12:00:00Z' }),
    ...Array.from({ length: 5 }, (_, i) => item(`product${i}`)), item('other', { orderId: 'order2', batchId: 'other' }),
    item('ready', { readyQuantity: 1 }), item('cancelled', { cancelledQuantity: 1 })]
  const groups = kdsQueue.groupKdsItems(items)
  assert.equal(groups.length, 3)
  assert.equal(groups[0].items.length, 6, 'ready rows remain visible alongside pending dishes')
  assert.equal(groups[2].sequence, 2)
  assert.equal(kdsQueue.getKdsRemainingQuantity(item('fraction', { quantity: 1.2, readyQuantity: 1 })), 0.2)
})

test('KDS accepts new sends, keeps ready dishes grey, moves to completed and retires only after service', async () => {
  let queue = { items: [item('burger', { quantity: 3 }), item('bravas', { quantity: 0.5 })], events: [{ id: 'event', event_type: 'cancelled', quantity: 1, created_at: '2026-10-17T10:00:00Z', payload: { productName: 'Old item' } }] }
  const calls = []
  const runner = createCompiledHookRunner(source('production/components/KdsPage.tsx'), 'KdsPage', {
    'react/jsx-runtime': jsxRuntime, 'lucide-react': icons, '../../../components/ui': { Button },
    '../../../utils/errors': { getReadableError: error => error.message }, '../../../lib/format': format,
    '../service': {
      acknowledgeKdsEvent: async (...args) => { calls.push(['ack', ...args]); queue = { ...queue, events: [] } },
      acceptKdsBatch: async (...args) => { calls.push(['accept', ...args]); queue = { ...queue, items: queue.items.map(item => ({ ...item, acceptedAt: '2026-10-17T12:00:00Z' })) } },
      markKdsItemReady: async (...args) => calls.push(['one', ...args]),
      markKdsItemQuantityReady: async (...args) => { calls.push(['ready', ...args]); queue = { ...queue, items: queue.items.map(item => item.id === args[1] ? { ...item, readyQuantity: item.readyQuantity + args[2] } : item) } },
    },
    '../kds-queue': kdsQueue, '../useKdsQueue': { useKdsQueue: () => ({ queue, error: null, refresh: async () => {} }) },
    '../../inventory': { InventoryPreparationsPanel: empty }, '../../platform/tenantFeatureAccess': { hasTenantCapability: () => false },
  })
  const props = { context: { deviceId: 'device' }, isOnline: true }
  let tree = runner.render(props)
  assert.deepEqual(nodes(tree).filter(node => node.type === 'h2').map(text), ['Nuevos pedidos', 'En preparación', 'Completados'])
  assert.equal(nodes(tree).filter(node => node.type === 'h3').length, 1)
  const passGroup = nodes(tree).filter(node => node.type === 'section' && node.props['aria-label'] === 'Pase Directo')
  assert.equal(passGroup.length, 1, 'products in the same pass share a visual group')
  assert.deepEqual(nodes(passGroup[0]).filter(node => node.type === 'h4').map(text), ['Directo'])
  assert.deepEqual(nodes(passGroup[0]).filter(node => node.type === 'h5').map(text), ['3x burger', '0,5x bravas'])
  assert.equal(nodes(tree).some(node => node.props['aria-label'] === 'Marcar 0,5 de bravas listo'), false)
  await nodes(tree).find(node => node.props['aria-label'] === 'Reconocer y cerrar aviso').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = runner.render(props)
  assert.equal(nodes(tree).some(node => node.props['aria-label'] === 'Reconocer y cerrar aviso'), false)
  await nodes(tree).find(node => node.type === Button && text(node) === 'Aceptar pedido').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = runner.render(props)
  await nodes(tree).find(node => node.props['aria-label'] === 'Marcar 0,5 de bravas listo').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = runner.render(props)
  const readyRow = nodes(tree).find(node => node.type === 'section' && node.props['aria-label'] === 'bravas')
  assert.match(readyRow.props.className, /surface-secondary/)
  await nodes(tree).find(node => node.type === Button && text(node) === ' Envío listo').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [['ack', 'device', 'event'], ['accept', 'device', 'batch1'], ['ready', 'device', 'bravas', 0.5], ['ready', 'device', 'burger', 3]])
  tree = runner.render(props)
  const completed = nodes(tree).find(node => node.type === 'section' && node.props['aria-label'] === 'Completados')
  assert.equal(nodes(completed).filter(node => node.type === 'h3').length, 1)
  assert.equal(nodes(completed).some(node => node.type === Button), false)
  queue = { ...queue, items: queue.items.map(item => ({ ...item, servedQuantity: item.quantity })) }
  assert.equal(nodes(runner.render(props)).filter(node => node.type === 'h3').length, 0)
})

function browserTimers() {
  const window = new EventTarget()
  const document = new EventTarget()
  document.visibilityState = 'visible'
  const timers = new Map()
  let sequence = 0
  for (const method of ['setTimeout', 'setInterval']) window[method] = (callback, delay) => {
    const id = ++sequence
    timers.set(id, { callback, delay, repeat: method === 'setInterval' })
    return id
  }
  window.clearTimeout = window.clearInterval = id => timers.delete(id)
  return { window, document, timers, tick(delay) {
    for (const [id, timer] of [...timers]) if (timer.delay === delay && timers.has(id)) {
      if (!timer.repeat) timers.delete(id)
      timer.callback()
    }
  } }
}

test('Realtime coalesces events, refreshes on subscribe, falls back on failure and recovers after focus/online', () => {
  const browser = browserTimers()
  const handlers = []
  let status
  let changes = 0
  let recoveries = 0
  let removed = false
  const channel = { on: (_, filter, callback) => { handlers.push({ filter, callback }); return channel }, subscribe: callback => { status = callback; return channel } }
  const { subscribeToKds, subscribeToOrderProduction } = compileComponent(source('production/service.ts'), {
    '../../lib/observability.ts': { reportOperationError() {} },
    '../../lib/supabase': { supabase: { channel: () => channel, removeChannel: () => { removed = true } }, recoverSupabaseRealtimeConnection: async () => { recoveries++ } },
  }, browser)
  const unsubscribe = subscribeToKds({ tenantId: 'tenant', venueId: 'venue' }, 'destination', () => changes++)
  assert.equal(handlers.length, 6)
  assert.ok(handlers.slice(0, 2).every(({ filter }) => filter.filter === 'destination_id=eq.destination'))
  assert.ok(handlers.slice(2).every(({ filter }) => filter.filter === 'venue_id=eq.venue'))
  assert.deepEqual(handlers.slice(2).map(({ filter }) => filter.table), ['order_lines', 'orders', 'production_line_allocations', 'production_component_allocations'])
  status('SUBSCRIBED'); handlers[0].callback(); handlers[1].callback(); browser.tick(100)
  assert.equal(changes, 1)
  status('TIMED_OUT'); browser.tick(100); browser.tick(3000); browser.tick(100)
  assert.equal(changes, 3)
  status('SUBSCRIBED'); browser.tick(100)
  assert.equal([...browser.timers.values()].some(timer => timer.delay === 3000), false)
  browser.tick(15000); browser.tick(100)
  browser.window.dispatchEvent(new Event('focus')); browser.window.dispatchEvent(new Event('online')); browser.document.dispatchEvent(new Event('visibilitychange')); browser.tick(100)
  assert.equal(recoveries, 3)
  const beforePayment = changes
  handlers.find(({ filter }) => filter.table === 'orders').callback()
  browser.tick(100)
  assert.equal(changes, beforePayment + 1, 'payment-only order changes refresh KDS without line updates')
  unsubscribe(); status('CLOSED'); handlers[0].callback()
  assert.equal(browser.timers.size, 0)
  assert.equal(removed, true)
  handlers.length = 0
  const unsubscribeOrder = subscribeToOrderProduction({ tenantId: 'tenant', venueId: 'venue' }, 'order', () => changes++)
  const order = handlers.find(({ filter }) => filter.table === 'orders')
  assert.equal(order.filter.filter, 'id=eq.order')
  order.callback(); browser.tick(100)
  assert.equal(changes, beforePayment + 2)
  unsubscribeOrder()
  assert.equal(browser.timers.size, 0)
})

test('KDS loads its authoritative destination, serializes refresh and ignores obsolete device responses', async () => {
  const browser = browserTimers()
  const pending = []
  const subscriptions = []
  const runner = createCompiledHookRunner(source('production/useKdsQueue.ts'), 'useKdsQueue', {
    '../../utils/errors': { getReadableError: error => error.message },
    './service': { loadKdsQueue: device => new Promise(resolve => pending.push({ device, resolve })),
      subscribeToKds: (context, destination, onChange) => { const sub = { context, destination, onChange, closed: false }; subscriptions.push(sub); return () => { sub.closed = true } } },
  }, browser)
  const context = { tenantId: 'tenant', venueId: 'venue', deviceId: 'old' }
  runner.render(context, true)
  assert.equal(pending.length, 1)
  browser.tick(3000)
  assert.equal(pending.length, 1)
  pending.shift().resolve({ destinationId: 'server-destination', items: [], events: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subscriptions[0].destination, 'server-destination')
  assert.equal(pending.length, 1)
  const obsolete = pending.shift()
  runner.render({ ...context, deviceId: 'new' }, true)
  assert.equal(subscriptions[0].closed, true)
  obsolete.resolve({ destinationId: 'old', items: [item('obsolete')], events: [] })
  pending.shift().resolve({ destinationId: 'new', items: [item('current')], events: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runner.render({ ...context, deviceId: 'new' }, true).queue.items[0].id, 'current')
  assert.equal(runner.render({ ...context, deviceId: 'new' }, false).queue.items.length, 0)
  runner.unmount()
  assert.equal(browser.timers.size, 0)
})

test('KDS retries an initial backend failure automatically and subscribes after recovery', async () => {
  const browser = browserTimers()
  let available = false
  let subscribed = false
  const runner = createCompiledHookRunner(source('production/useKdsQueue.ts'), 'useKdsQueue', {
    '../../utils/errors': { getReadableError: error => error.message },
    './service': {
      loadKdsQueue: async () => {
        if (!available) throw new Error('Backend unavailable')
        return { destinationId: 'destination', items: [], events: [] }
      },
      subscribeToKds: () => { subscribed = true; return () => {} },
    },
  }, browser)
  const context = { tenantId: 'tenant', venueId: 'venue', deviceId: 'device' }
  runner.render(context, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runner.render(context, true).error, 'Backend unavailable')
  available = true
  browser.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runner.render(context, true).error, null)
  assert.equal(subscribed, true)
  assert.equal(browser.timers.size, 0)
  runner.unmount()
})
