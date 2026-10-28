import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as format from '../src/lib/format.ts'
import * as routing from '../src/features/production/routing.ts'
import * as orderProgress from '../src/features/production/order-progress.ts'
import * as serviceStatus from '../src/features/tables/service-status.ts'
import * as menuServiceModel from '../src/features/tables/menu-service-model.ts'
import { createCompiledHookRunner, jsxRuntime, nodes } from './helpers/component-harness.mjs'
import { createRestaurantControllerHarness, flush } from './helpers/restaurant-controller-harness.mjs'

const source = readFileSync(new URL('../src/features/tables/components/RestaurantOrderPanel.tsx', import.meta.url), 'utf8')
const empty = () => null
const Button = props => jsxRuntime.jsx('button', props)
const modules = {
  'react/jsx-runtime': jsxRuntime,
  'react-dom': { createPortal: node => node },
  'lucide-react': Object.fromEntries(['Check', 'CheckCheck', 'Minus', 'Pencil', 'Plus', 'Trash2'].map(name => [name, empty])),
  '../../../components/ui': { Button },
  '../../../components/ui/NativeSelect': { NativeSelect: empty },
  '../../../lib/format': format,
  '../../../lib/mixers': { getLineAdditionNames: () => [] },
  '../service-status': serviceStatus,
  '../../../components/pos/MenuComponentDetails': { MenuComponentDetails: empty },
  '../../../components/pos/InvoiceTicketNotice': { InvoiceTicketNotice: empty },
  '../../../components/ui/NumericKeypadModal': { NumericKeypadModal: empty },
  '../../production/components/ProductionControls': { ProductionControls: empty },
  '../../production/routing': routing,
  '../../production/order-progress': orderProgress,
  './MenuOrderCard': { MenuOrderCard: empty },
    './OrderLineActionsModal': { OrderLineActionsModal: empty },
    '../hooks/useOrderLineLongPress': { isOrderLineActionTarget: () => false, useOrderLineLongPress: () => ({ onPointerDown() {}, onPointerMove() {}, onPointerUp: () => false, onPointerCancel() {} }) },
  '../menu-service-model': menuServiceModel,
}
const line = { id: 'served-line', productName: 'Cafe', quantity: 2, servedQuantity: 2, unitPriceCents: 150, modifiers: [], components: [], catalogSnapshot: {} }
const order = { order: { id: 'order', revision: 7, status: 'open' }, lines: [line], tables: [] }
const text = node => node == null ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props?.children) : String(node)

function swipeRow(props, distance = 90) {
  const runner = createCompiledHookRunner(`${source}\nexport { OrderLineRow }`, 'OrderLineRow', modules, {
    Element: class {},
    window: { setTimeout: () => 1, clearTimeout() {} },
  })
  const article = () => nodes(runner.render(props)).find(node => node.type === 'article')
  const event = { button: 0, clientX: 200, clientY: 20, pointerId: 1, target: null,
    currentTarget: { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} } }
  article().props.onPointerDown(event)
  article().props.onPointerMove({ ...event, clientX: 200 - distance })
  article().props.onPointerUp({ ...event, clientX: 200 - distance })
}

for (const scenario of [
  { name: 'fully served', servedQuantity: 2, isBusy: false, expectedRequests: 1 },
  { name: 'partially served completed copy', servedQuantity: 1, isBusy: false, expectedRequests: 0 },
  { name: 'busy', servedQuantity: 2, isBusy: true, expectedRequests: 0 },
  { name: 'short swipe', servedQuantity: 2, isBusy: false, distance: 40, expectedRequests: 0 },
]) {
  test(`completed line removal: ${scenario.name}`, () => {
    const requests = []
    const runner = createCompiledHookRunner(source, 'RestaurantOrderPanel', modules)
    const tree = runner.render({ order: { ...order, lines: [{ ...line, servedQuantity: scenario.servedQuantity }] },
      isBusy: scenario.isBusy, lineDiscounts: {}, onRemove: id => requests.push(id) })
    const completed = nodes(tree).find(node => node.type === 'details' && text(node).startsWith('Completados'))
    const row = nodes(completed).find(node => node.props.line?.id === line.id)
    assert.ok(row, 'served line is visible in Completados')
    swipeRow(row.props, scenario.distance)
    assert.deepEqual(requests, scenario.expectedRequests ? [line.id] : [])
  })
}

test('served line requests confirmation, cancellation preserves it, and only confirmation uses the confirmed removal RPC', async () => {
  const removed = []
  const saved = []
  const harness = createRestaurantControllerHarness({ currentOrder: order, tableService: {
    removeRestaurantOrderLineConfirmed: async (...args) => removed.push(args),
    saveRestaurantOrderLines: async (...args) => saved.push(args),
    loadRestaurantOrder: async () => ({ ...order, lines: [] }),
  } })
  harness.render().requestLineRemoval(line.id)
  assert.equal(harness.render().pendingLineRemoval.id, line.id)
  assert.deepEqual(removed, [])
  assert.deepEqual(saved, [])

  const modalSource = readFileSync(new URL('../src/features/tables/components/RemoveOrderLineModal.tsx', import.meta.url), 'utf8')
  const modal = createCompiledHookRunner(modalSource, 'RemoveOrderLineModal', {
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': { Trash2: empty, X: empty },
    '../../../components/ui': { AppModal: props => props.children, Button },
  })
  const renderModal = () => modal.render({ line, isBusy: false, sentQuantity: 2,
    onCancel: () => harness.render().setPendingLineRemoval(null),
    onConfirm: () => harness.render().confirmLineRemoval() })
  nodes(renderModal()).find(node => text(node) === 'Cancelar').props.onClick()
  assert.equal(harness.render().pendingLineRemoval, null)
  assert.deepEqual(removed, [])
  assert.equal(harness.order.lines.length, 1)

  harness.render().requestLineRemoval(line.id)
  nodes(renderModal()).find(node => node.type === Button && text(node).includes('Eliminar')).props.onClick()
  await flush()
  assert.deepEqual(removed, [[line.id, 7]])
  assert.deepEqual(saved, [], 'confirmed served lines must not use the ordinary save path')
  assert.equal(harness.render().pendingLineRemoval, null)
  assert.equal(harness.order.lines.length, 0)
  assert.ok(harness.calls.errors.every(error => error === null), JSON.stringify(harness.calls.errors))
})
