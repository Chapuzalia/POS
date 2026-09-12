import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { compileComponent, createHookHarness, expandedNodes, jsxRuntime } from './helpers/component-harness.mjs'
import { createRestaurantControllerHarness } from './helpers/restaurant-controller-harness.mjs'

const [panelSource, migration] = await Promise.all([
  readFile(new URL('../src/features/tables/components/RestaurantOrderPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260831130000_preserve_restaurant_order_line_prices.sql', import.meta.url), 'utf8'),
])

function panelHarness() {
  const hooks = createHookHarness()
  const { RestaurantOrderPanel } = compileComponent(panelSource, {
    react: hooks.react,
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': { Check: 'check', CheckCheck: 'check-check', Minus: 'minus', Pencil: 'pencil', Plus: 'plus', Trash2: 'trash' },
    '../../../lib/format': {
      centsToInput: (cents) => String(cents / 100),
      formatMoney: String,
      parseMoneyToCents: (value) => Math.round(Number(String(value).replace(',', '.')) * 100),
    },
    '../../../lib/mixers': { getLineAdditionNames: () => [] },
    '../../../components/ui': { Button: 'button' },
    '../service-status': {
      canDecreaseLineQuantity: () => true,
      getOrderPendingUnits: (lines) => lines.reduce((total, line) => total + line.quantity - line.servedQuantity, 0),
      getPendingQuantity: (line) => line.quantity - line.servedQuantity,
    },
    '../../../components/pos/MenuComponentDetails': { MenuComponentDetails: 'menu-components' },
    '../../../components/pos/InvoiceTicketNotice': { InvoiceTicketNotice: 'invoice-notice' },
    '../../../components/ui/NumericKeypadModal': { NumericKeypadModal: 'numeric-keypad' },
    '../../production/components/ProductionControls': { ProductionControls: 'production-controls' },
  })
  const calls = { quantities: [], prices: [] }
  const line = {
    components: [], id: 'line-1', mixer: null, modifiers: [], productId: 'product-1', productName: 'Producto',
    quantity: 2, servedQuantity: 1, unitPriceCents: 600, variantId: 'variant-1',
  }
  const props = {
    isBusy: false,
    lineDiscounts: {},
    onDecrement() {}, onEdit() {}, onIncrement() {}, onRemove() {}, onServeAll() {}, onServeAllOrder() {}, onServeOne() {},
    onSetQuantity: (...args) => calls.quantities.push(args),
    onSetUnitPrice: (...args) => calls.prices.push(args),
    order: { lines: [line], order: { id: 'order-1' }, tables: [] },
  }
  return { calls, render: () => hooks.render(RestaurantOrderPanel, props) }
}

test('los editores entregan la cantidad y el precio confirmados a la comanda', () => {
  const harness = panelHarness()
  const dialogTriggers = expandedNodes(harness.render()).filter((node) => node.type === 'button' && node.props['aria-haspopup'] === 'dialog')

  dialogTriggers[0].props.onClick()
  let keypad = expandedNodes(harness.render()).find((node) => node.type === 'numeric-keypad')
  assert.equal(keypad.props.allowDecimal, true)
  keypad.props.onConfirm('7,50')

  const quantityTrigger = expandedNodes(harness.render()).filter((node) => node.type === 'button' && node.props['aria-haspopup'] === 'dialog')[1]
  quantityTrigger.props.onClick()
  keypad = expandedNodes(harness.render()).find((node) => node.type === 'numeric-keypad')
  assert.equal(keypad.props.allowDecimal, false)
  keypad.props.onConfirm('5')

  assert.deepEqual(harness.calls.prices, [['line-1', 750]])
  assert.deepEqual(harness.calls.quantities, [['line-1', 5]])
  assert.equal(expandedNodes(harness.render()).some((node) => node.type === 'numeric-keypad'), false)
})

test('el controlador rechaza valores inválidos y solo modifica la línea elegida', () => {
  const untouched = { id: 'line-2', productId: 'product-2', quantity: 1, servedQuantity: 0, unitPriceCents: 300 }
  const harness = createRestaurantControllerHarness({
    currentOrder: {
      lines: [
        { id: 'line-1', productId: 'product-1', quantity: 3, servedQuantity: 2, unitPriceCents: 600 },
        untouched,
      ],
      order: { id: 'order-1', revision: 1, status: 'open' },
      tables: [{ areaId: 'area', id: 'table', isVirtual: false }],
    },
  })
  const controller = harness.render()

  controller.setLineQuantity('line-1', 1)
  controller.setLineUnitPrice('line-1', -1)
  assert.equal(harness.order.lines[0].quantity, 3)
  assert.equal(harness.order.lines[0].unitPriceCents, 600)
  assert.equal(harness.calls.errors.length, 2)

  controller.setLineQuantity('line-1', 4)
  controller.setLineUnitPrice('line-1', 750)
  assert.equal(harness.order.lines[0].quantity, 4)
  assert.equal(harness.order.lines[0].unitPriceCents, 750)
  assert.strictEqual(harness.order.lines[1], untouched)
})

test('la persistencia SQL del precio manual mantiene su protección actual', () => {
  assert.match(migration, /rename to save_catalog_order_lines_canonical/i)
  assert.match(migration, /saved_order := public\.save_catalog_order_lines_canonical\(p_order_id, p_expected_revision, p_lines\)/i)
  assert.match(migration, /set unit_price_cents = \(submitted\.line ->> 'unitPriceCents'\)::integer/i)
  assert.match(migration, /order_line\.order_id = p_order_id/i)
  assert.match(migration, /ORDER_LINE_INVALID_UNIT_PRICE/i)
  assert.match(migration, /grant execute on function public\.save_catalog_order_lines\(uuid, integer, jsonb\) to authenticated/i)
})
