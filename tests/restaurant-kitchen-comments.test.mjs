import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import * as menuModel from '../src/features/tables/menu-service-model.ts'
import { createCompiledHookRunner, jsxRuntime, nodes } from './helpers/component-harness.mjs'
import { createRestaurantControllerHarness, deferred } from './helpers/restaurant-controller-harness.mjs'

const source = name => readFileSync(new URL(`../src/features/tables/${name}`, import.meta.url), 'utf8')
const text = node => node == null ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props?.children) : String(node)
const empty = () => null
const Button = props => jsxRuntime.jsx('button', props)
const line = { id: 'line', productId: 'product', productName: 'Espetec', quantity: 2, servedQuantity: 0, unitPriceCents: 330, note: null, modifiers: [], components: [], catalogSnapshot: {} }
const order = { order: { id: 'order', status: 'open', revision: 7 }, lines: [line], tables: [] }

function modalRunner() {
  const runner = createCompiledHookRunner(source('components/OrderLineActionsModal.tsx'), 'OrderLineActionsModal', {
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': Object.fromEntries(['ArrowRightLeft', 'ChevronRight', 'MessageSquare', 'X'].map(name => [name, empty])),
    '../../../components/ui': { AppModal: props => props.children, Button, TextArea: 'textarea' },
    '../../../components/ui/NativeSelect': { NativeSelect: 'select' }, '../menu-service-model': menuModel,
  })
  return props => runner.render({ line, entries: [], disabled: false, onClose() {}, ...props })
}
const button = (tree, label) => nodes(tree).find(node => node.type === Button && text(node) === label)

test('the hold menu offers a kitchen comment even with no route; saving failures retain editable text', async () => {
  const render = modalRunner(), saved = [], closes = []
  let succeeds = false
  const props = { onClose: () => closes.push(true), onSetNote: async (...args) => { saved.push(args); return succeeds } }
  let tree = render(props)
  assert.ok(button(tree, 'Añadir comentario'))
  assert.equal(button(tree, 'Cambiar pase'), undefined)
  button(tree, 'Añadir comentario').props.onClick()
  tree = render(props)
  nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Sin sal\nSalsa aparte' } })
  tree = render(props)
  button(tree, 'Guardar comentario').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = render(props)
  assert.deepEqual(saved, [['line', 'Sin sal\nSalsa aparte']])
  assert.equal(closes.length, 0)
  assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, 'Sin sal\nSalsa aparte')
  assert.match(text(nodes(tree).find(node => node.props.role === 'alert')), /No se ha guardado/)
  succeeds = true
  button(tree, 'Guardar comentario').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closes.length, 1)
})

test('editing starts with the saved comment, cancel never saves, and clearing explicitly removes it', async () => {
  const saves = [], closes = [], render = modalRunner()
  const props = { line: { ...line, note: 'Sin sal' }, initialMode: 'note', onSetNote: async (...args) => { saves.push(args); return true }, onClose: () => closes.push(true) }
  let tree = render(props)
  assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, 'Sin sal')
  button(tree, 'Cancelar').props.onClick()
  assert.deepEqual(saves, [])
  assert.equal(closes.length, 1)
  nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: '' } })
  tree = render(props)
  button(tree, 'Guardar comentario').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(saves, [['line', '']])
})

test('an in-flight save prevents duplicate submission and dismissal; thrown errors allow retry', async () => {
  const pending = deferred(), render = modalRunner(), saved = []
  const props = { initialMode: 'note', onSetNote: async () => { saved.push(true); return pending.promise } }
  let tree = render(props)
  button(tree, 'Guardar comentario').props.onClick()
  tree = render(props)
  assert.equal(tree.props.dismissDisabled, true)
  assert.equal(nodes(tree).find(node => node.type === 'textarea').props.disabled, true)
  assert.equal(button(tree, 'Guardando…').props.disabled, true)
  button(tree, 'Guardando…').props.onClick()
  assert.equal(saved.length, 1)
  pending.reject(new Error('network'))
  await new Promise(resolve => setImmediate(resolve))
  tree = render(props)
  assert.equal(tree.props.dismissDisabled, false)
  assert.ok(nodes(tree).find(node => node.props.role === 'alert'))
})

test('pass selection remains restricted to this line and wholly unsent entries; menu comments describe their scope', () => {
  const render = modalRunner(), changes = []
  const entry = { lineId: 'line', componentId: 'first', productName: 'Bull', passId: 'direct', unsentQuantity: 1, sentQuantity: 0 }
  const props = { line: { ...line, catalogSnapshot: { productType: 'menu' } }, entries: [entry, { ...entry, componentId: 'second', sentQuantity: 1 }, { ...entry, lineId: 'another' }],
    routing: { passes: [{ id: 'direct', name: 'Directo' }, { id: 'seconds', name: 'Segundos' }] }, onChangePass: input => changes.push(input), onSetNote: async () => true }
  let tree = render(props)
  button(tree, 'Cambiar pase').props.onClick()
  tree = render(props)
  const selects = nodes(tree).filter(node => node.type === 'select')
  assert.equal(selects.length, 1)
  selects[0].props.onChange({ target: { value: 'direct' } })
  assert.equal(changes.length, 0)
  selects[0].props.onChange({ target: { value: 'seconds' } })
  assert.deepEqual({ ...changes[0] }, { lineId: 'line', componentId: 'first', passId: 'seconds' })
  const noteTree = modalRunner()({ ...props, initialMode: 'note' })
  assert.match(text(noteTree), /se aplica a todo el menú/)
  tree = modalRunner()({ ...props, entries: [{ ...entry, sentQuantity: 1 }] })
  assert.equal(button(tree, 'Cambiar pase').props.disabled, true)
  assert.equal(button(tree, 'Añadir comentario').props.disabled, false)
})

test('comment saves preserve quantities, selections and prices; normalize text, remove it, and retry failed saves', async () => {
  const h = createRestaurantControllerHarness({ currentOrder: order })
  let flushes = 0, success = false
  h.draft.flush = async () => { flushes++; return success ? h.order : null }
  assert.equal(await h.render().setLineNote('line', '  Sin sal\r\nSalsa aparte\x1b  '), false)
  assert.equal(h.order.lines[0].note, 'Sin sal\nSalsa aparte')
  assert.equal(h.order.lines[0].unitPriceCents, 330)
  assert.equal(h.order.lines[0].quantity, 2)
  assert.equal(h.order.lines[0].components, line.components)
  success = true
  assert.equal(await h.render().setLineNote('line', 'Sin sal\nSalsa aparte'), true)
  assert.equal(flushes, 2, 'retry flushes even if the local text matches the unsaved draft')
  assert.equal(h.calls.drafts.length, 1, 'retry does not manufacture another edit')
  assert.equal(await h.render().setLineNote('line', '  \n'), true)
  assert.equal(h.order.lines[0].note, null)
})

for (const restricted of ['offline', 'busy', 'permission', 'closed', 'missing']) {
  test(`comments respect ${restricted} restrictions`, async () => {
    const h = createRestaurantControllerHarness({ currentOrder: restricted === 'closed' ? { ...order, order: { ...order.order, status: 'paid' } } : order })
    if (restricted === 'offline') h.options.isOnline = false
    if (restricted === 'busy') h.options.isBusy = true
    if (restricted === 'permission') h.options.context.canTakeOrders = false
    assert.equal(await h.render().setLineNote(restricted === 'missing' ? 'missing' : 'line', 'Sin sal'), false)
    assert.equal(h.calls.drafts.length, 0)
  })
}

function gestureRunner() {
  const timers = new Map(), opens = []
  class Element { closest(selector) { return selector === '[data-order-line-hold="true"]' ? this.allowHold : this.interactive } }
  const runner = createCompiledHookRunner(source('hooks/useOrderLineLongPress.ts'), 'useOrderLineLongPress', {}, {
    Element, window: { setTimeout: (callback, delay) => { assert.equal(delay, 600); timers.set(1, callback); return 1 }, clearTimeout: id => timers.delete(id) },
  })
  return { runner, timers, opens, Element, render: (disabled = false) => runner.render(disabled, () => opens.push(true)), fire() { for (const callback of timers.values()) callback(); timers.clear() } }
}
const pointer = { button: 0, isPrimary: true, clientX: 10, clientY: 10, target: null }

test('holding opens once after 600 ms, suppresses the following edit click, and context menus do not double-open', () => {
  const h = gestureRunner()
  let handlers = h.render()
  handlers.onPointerDown(pointer)
  assert.equal(h.opens.length, 0)
  handlers = h.render()
  h.fire()
  assert.equal(h.opens.length, 1)
  handlers.onContextMenu({ target: null, preventDefault() {} })
  assert.equal(h.opens.length, 1)
  assert.equal(handlers.onPointerUp(), true)
  const consumed = []
  handlers.onClickCapture({ preventDefault: () => consumed.push('prevent'), stopPropagation: () => consumed.push('stop') })
  assert.deepEqual(consumed, ['prevent', 'stop'])
  handlers.onContextMenu({ target: null, preventDefault() {} })
  assert.equal(h.opens.length, 2)
  handlers.onPointerDownCapture()
  handlers.onClickCapture({ preventDefault() { assert.fail('a fresh button press must remain clickable') }, stopPropagation() {} })
})

for (const gesture of ['tap', 'scroll', 'swipe', 'cancel', 'unmount', 'disabled', 'button']) {
  test(`${gesture} does not accidentally open the long-press menu`, () => {
    const h = gestureRunner(), handlers = h.render(gesture === 'disabled')
    const target = new h.Element(); target.interactive = gesture === 'button'
    handlers.onPointerDown({ ...pointer, target })
    if (gesture === 'tap') handlers.onPointerUp()
    if (gesture === 'scroll') handlers.onPointerMove({ ...pointer, clientY: 30 })
    if (gesture === 'swipe') handlers.onPointerMove({ ...pointer, clientX: 30 })
    if (gesture === 'cancel') handlers.onPointerCancel()
    if (gesture === 'unmount') h.runner.unmount()
    h.fire()
    assert.equal(h.opens.length, 0)
  })
}

const migration = readFileSync(new URL('../supabase/migrations/20261024203609_kitchen_order_comments.sql', import.meta.url), 'utf8')
test('kitchen comment migration preserves expansion safety', () => assert.deepEqual(analyzeMigration(migration), []))
test('printed modifications include multiline comments and removal, while old notices keep their lines', async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('create table production_events(id uuid primary key, event_type text, quantity numeric, payload jsonb)')
  await db.exec(migration)
  const id = '00000000-0000-4000-8000-000000000001'
  const render = async (type, payload) => {
    await db.query('insert into production_events values($1,$2,1,$3) on conflict(id) do update set event_type=excluded.event_type,payload=excluded.payload', [id, type, payload])
    return (await db.query('select production_render_event_lines($1) lines', [id])).rows[0].lines
  }
  const payload = { tableName: '15', productName: 'Bull', detail: 'Cambio' }
  const original = ['******** MODIFICACIÓN ********', 'MESA 15', '1x Bull', 'Cambio', '****************************']
  assert.deepEqual(await render('modified', payload), original)
  assert.deepEqual(await render('modified', { ...payload, note: 'Sin sal\nSalsa aparte' }), [...original.slice(0, -1), 'NOTA: Sin sal\nSalsa aparte', original.at(-1)])
  assert.ok((await render('modified', { ...payload, note: null })).includes('NOTA: SIN COMENTARIO'))
  assert.deepEqual(await render('cancelled', { ...payload, note: 'Sin sal' }), ['******** ANULACIÓN ********', ...original.slice(1)])
  assert.deepEqual(await render('table_moved', payload), ['******* CAMBIO DE MESA *******', 'MESA 15', 'Cambio', original.at(-1)])
})
