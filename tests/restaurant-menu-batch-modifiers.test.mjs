import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as batch from '../src/features/restaurant/services/menuBatch.ts'
import * as resolver from '../src/features/catalog/domain/resolver.ts'
import * as builder from '../src/features/catalog/services/saleLineBuilder.ts'
import * as format from '../src/lib/format.ts'
import { createMenuCatalog } from './helpers/menu-catalog.mjs'
import { createCompiledHookRunner, jsxRuntime, nodes } from './helpers/component-harness.mjs'

const blank = { components: [], modifiers: [], mixerProductId: null, mixer: null }
function fixture({ required = false, maximum = 2, defaults = false } = {}) {
  const catalog = createMenuCatalog()
  catalog.modifierGroups = [{ id: 'extras', tenantId: 'tenant', venueId: 'venue', name: 'Extras', active: true, sortOrder: 0 }]
  catalog.modifiers = ['Queso', 'Cebolla', 'Salsa'].map((name, index) => ({ id: `m${index}`, groupId: 'extras', tenantId: 'tenant', venueId: 'venue', name,
    active: true, sortOrder: index, supplementCents: [75, 25, 50][index], isDefault: defaults && index === 0 }))
  catalog.modifierAssignments = [{ id: 'assign', tenantId: 'tenant', venueId: 'venue', groupId: 'extras', productId: 'p2', minSelection: required ? 1 : 0,
    maxSelection: maximum, appliesToAllVariants: true, variantIds: [], active: true, sortOrder: 0 }]
  const item = resolver.resolveCatalogItem(catalog, 'placement0'), group = item.selectionGroups[1], option = group.options[0]
  const modifier = id => ({ id, groupId: 'extras', name: 'untrusted', priceCents: 9999 })
  return { catalog, item, group, option, modifier, draft: batch.createMenuBatchDraft(blank, 5) }
}
function add(data, draft, ids, quantity) { return batch.addMenuBatchPreparation(data.catalog, draft, data.group, data.option, ids.map(data.modifier), quantity) }
function rows(data, draft) { return batch.getMenuBatchPreparations(draft, data.group.group.id, data.option.id) }

test('different preparations allocate separate diners and price only the actual modifiers, while desserts remain deferred', () => {
  const data = fixture()
  let draft = add(data, data.draft, ['m0'], 2)
  draft = add(data, draft, [], 1)
  draft = add(data, draft, ['m1'], 2)
  assert.deepEqual(rows(data, draft).map(row => [row.quantity, row.modifiers.map(modifier => modifier.name)]), [[2, ['Queso']], [1, []], [2, ['Cebolla']]])
  let id = 0
  const lines = batch.buildRestaurantMenuBatchLines({ catalog: data.catalog, sellable: data.item, item: data.item, selections: draft.selections,
    context: { tenantId: 'tenant', venueId: 'venue' }, orderId: 'order', timestamp: 'now', createLineId: () => String(++id) })
  assert.deepEqual(lines.map(line => line.unitPriceCents), [1575, 1575, 1500, 1525, 1525])
  assert.equal(lines.reduce((sum, line) => sum + line.unitPriceCents, 0), 7700)
  assert.ok(lines.every(line => line.components.length === 1))
  assert.throws(() => add(data, draft, ['m0'], 1), /suficientes raciones/)
})

test('repeating, removing and editing a preparation affect only that combination', () => {
  const data = fixture()
  let draft = add(data, data.draft, ['m0'], 2)
  draft = add(data, draft, ['m1'], 1)
  const cheese = rows(data, draft)[0]
  draft = batch.removeMenuBatchChoice(draft, data.group.group.id, data.option.id, cheese.key)
  assert.deepEqual(rows(data, draft).map(row => row.quantity), [1, 1])
  draft = batch.addMenuBatchChoice(data.catalog, draft, data.group, data.option, cheese.modifiers)
  assert.deepEqual(rows(data, draft).map(row => row.quantity), [2, 1])
  draft = batch.replaceMenuBatchPreparation(data.catalog, draft, data.group, data.option, cheese.key, [])
  assert.deepEqual(rows(data, draft).map(row => [row.quantity, row.modifiers.map(modifier => modifier.id)]), [[2, []], [1, ['m1']]])
  assert.equal(batch.getMenuBatchGroupCount(draft.selections, data.group.group.id), 3)
})

test('canonical modifier rules reject missing required choices, excessive selections, unassigned and repeated modifiers without a partial batch', () => {
  const data = fixture({ required: true, maximum: 1 }), draft = data.draft
  for (const ids of [[], ['m0', 'm1'], ['unknown'], ['m0', 'm0']]) assert.throws(() => add(data, draft, ids, 2))
  assert.equal(batch.getMenuBatchGroupCount(draft.selections, data.group.group.id), 0)
  assert.equal(rows(data, add(data, draft, ['m0'], 5))[0].quantity, 5)
  for (const quantity of [0, -1, 1.5, 6]) assert.throws(() => add(data, draft, ['m0'], quantity))
})

test('modifier order does not split a preparation, and different preparations never overwrite a multi-unit menu component', () => {
  const data = fixture()
  let draft = add(data, data.draft, ['m0', 'm1'], 1)
  draft = add(data, draft, ['m1', 'm0'], 1)
  assert.equal(rows(data, draft).length, 1)
  const group = { ...data.group, assignment: { ...data.group.assignment, maxSelection: 2 } }
  const option = { ...data.option, maxQuantity: 2 }
  let one = batch.createMenuBatchDraft(blank, 1)
  one = batch.addMenuBatchChoice(data.catalog, one, group, option, [data.modifier('m0')])
  assert.equal(batch.getMenuBatchChoiceCapacity(one.selections, group, option, []), 0)
  assert.equal(batch.addMenuBatchChoice(data.catalog, one, group, option, []), one)
  assert.equal(batch.getMenuBatchChoiceCapacity(one.selections, group, option, [data.modifier('m0')]), 1)
})

const empty = () => null
const Button = props => jsxRuntime.jsx('button', props)
const text = node => node == null ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props?.children) : String(node)
const button = (tree, label) => nodes(tree).find(node => node.type === Button && text(node) === label)
const labelled = (tree, label) => nodes(tree).find(node => node.props['aria-label'] === label)
function cardRunner(data) {
  let draft = data.draft, configuring = false
  const runner = createCompiledHookRunner(readFileSync(new URL('../src/components/modals/MenuBatchOptionCard.tsx', import.meta.url), 'utf8'), 'MenuBatchOptionCard', {
    'react/jsx-runtime': jsxRuntime, 'lucide-react': Object.fromEntries(['Minus', 'Pencil', 'Plus', 'X'].map(name => [name, empty])),
    '../../features/catalog/domain/resolver': resolver, '../../features/catalog/services/saleLineBuilder': builder,
    '../../features/restaurant/services/menuBatch': batch, '../../lib/format': format, '../ui/Button': { Button },
  })
  const props = { ...data, disabled: false, onConfigure: () => { configuring = true }, onCloseConfiguration: () => { configuring = false }, onChange: next => { draft = next } }
  return { props, get draft() { return draft }, render: () => runner.render({ ...props, draft, configuring }) }
}

test('the first dish tap opens its modifier choices before adding; multiple equal rations are added together', () => {
  const data = fixture(), h = cardRunner(data)
  labelled(h.render(), 'Pedir Pollo').props.onClick()
  assert.equal(rows(data, h.draft).length, 0)
  let tree = h.render()
  assert.ok(labelled(tree, 'Preparar Pollo'))
  labelled(tree, 'Elegir Queso para Pollo').props.onClick()
  tree = h.render()
  labelled(tree, 'Una ración más').props.onClick()
  tree = h.render()
  button(tree, 'Añadir 2 raciones').props.onClick()
  tree = h.render()
  assert.equal(labelled(tree, 'Preparar Pollo'), undefined)
  assert.equal(rows(data, h.draft)[0].quantity, 2)
  assert.equal(rows(data, h.draft)[0].modifiers[0].name, 'Queso')
  labelled(tree, 'Pedir Pollo').props.onClick()
  tree = h.render()
  assert.equal(labelled(tree, 'Elegir Queso para Pollo').props.active, false, 'a new preparation starts with catalog defaults, not the last customization')
  button(tree, 'Añadir 1 ración').props.onClick()
  tree = h.render()
  assert.deepEqual(rows(data, h.draft).map(row => row.quantity), [2, 1])
  assert.ok(labelled(tree, 'Preparación de Pollo: Sin extras'))
  labelled(tree, 'Repetir Pollo: Queso').props.onClick()
  assert.equal(rows(data, h.draft)[0].quantity, 3)
})

test('required single-choice modifiers block adding until selected and replace the previous choice in one tap', () => {
  const data = fixture({ required: true, maximum: 1 }), h = cardRunner(data)
  labelled(h.render(), 'Pedir Pollo').props.onClick()
  let tree = h.render()
  assert.equal(button(tree, 'Añadir 1 ración').props.disabled, true)
  labelled(tree, 'Elegir Queso para Pollo').props.onClick()
  tree = h.render()
  assert.equal(button(tree, 'Añadir 1 ración').props.disabled, false)
  labelled(tree, 'Elegir Cebolla para Pollo').props.onClick()
  tree = h.render()
  assert.equal(labelled(tree, 'Elegir Queso para Pollo').props.active, false)
  assert.equal(labelled(tree, 'Elegir Cebolla para Pollo').props.active, true)
  button(tree, 'Todas (5)').props.onClick()
  tree = h.render()
  button(tree, 'Añadir 5 raciones').props.onClick()
  assert.deepEqual(rows(data, h.draft).map(row => [row.quantity, row.modifiers[0].id]), [[5, 'm1']])
})

test('editing targets the displayed preparation, works at full capacity, and cancellation preserves all rations', () => {
  const data = fixture({ defaults: true }), h = cardRunner(data)
  labelled(h.render(), 'Pedir Pollo').props.onClick()
  let tree = h.render()
  assert.equal(labelled(tree, 'Elegir Queso para Pollo').props.active, true)
  button(tree, 'Todas (5)').props.onClick()
  button(h.render(), 'Añadir 5 raciones').props.onClick()
  tree = h.render()
  assert.equal(labelled(tree, 'Pedir Pollo').props.disabled, true)
  labelled(tree, 'Editar Pollo: Queso').props.onClick()
  tree = h.render()
  assert.match(text(tree), /Se aplicará a las 5 raciones/)
  labelled(tree, 'Elegir Queso para Pollo').props.onClick()
  tree = h.render()
  button(tree, 'Cancelar').props.onClick()
  assert.equal(rows(data, h.draft)[0].modifiers[0].id, 'm0')
  labelled(h.render(), 'Editar Pollo: Queso').props.onClick()
  labelled(h.render(), 'Elegir Queso para Pollo').props.onClick()
  button(h.render(), 'Guardar preparación').props.onClick()
  assert.deepEqual(rows(data, h.draft).map(row => [row.quantity, row.modifiers.length]), [[5, 0]])
})

test('dishes without modifiers retain single-tap addition, and optional multi-choice groups enforce their maximum', () => {
  const data = fixture(), plain = { ...data, option: data.item.selectionGroups[0].options[0], group: data.item.selectionGroups[0] }, h = cardRunner(plain)
  labelled(h.render(), 'Pedir Ensalada').props.onClick()
  assert.equal(batch.getMenuBatchGroupCount(h.draft.selections, plain.group.group.id), 1)
  const custom = cardRunner(data)
  labelled(custom.render(), 'Pedir Pollo').props.onClick()
  labelled(custom.render(), 'Elegir Queso para Pollo').props.onClick()
  labelled(custom.render(), 'Elegir Cebolla para Pollo').props.onClick()
  assert.equal(labelled(custom.render(), 'Elegir Salsa para Pollo').props.disabled, true)
  labelled(custom.render(), 'Elegir Queso para Pollo').props.onClick()
  assert.equal(labelled(custom.render(), 'Elegir Salsa para Pollo').props.disabled, false)
})
