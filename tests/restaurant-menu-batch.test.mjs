import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as batch from '../src/features/restaurant/services/menuBatch.ts'
import { resolveCatalogItem, resolveSellableProduct } from '../src/features/catalog/domain/resolver.ts'
import * as builder from '../src/features/catalog/services/saleLineBuilder.ts'
import * as format from '../src/lib/format.ts'
import { createMenuCatalog } from './helpers/menu-catalog.mjs'
import { createCompiledHookRunner, expandedNodes, jsxRuntime, nodes } from './helpers/component-harness.mjs'
import { createRestaurantControllerHarness } from './helpers/restaurant-controller-harness.mjs'

const blank = { components: [], modifiers: [], mixerProductId: null, mixer: null }
function fixture() {
  const catalog = createMenuCatalog()
  catalog.selectionOptions.push({ ...catalog.selectionOptions[0], id: 'soup', productId: 'p4', variantId: 'v4', supplementCents: 125 })
  catalog.modifierGroups.push({ id: 'sides', tenantId: 'tenant', venueId: 'venue', name: 'Guarnición', sortOrder: 0, active: true })
  catalog.modifiers.push({ id: 'cheese', tenantId: 'tenant', venueId: 'venue', groupId: 'sides', name: 'Queso', supplementCents: 75, sortOrder: 0, active: true, isDefault: false })
  catalog.modifierAssignments.push({ id: 'side-assignment', tenantId: 'tenant', venueId: 'venue', productId: 'p2', groupId: 'sides', minSelection: 0, maxSelection: 1, appliesToAllVariants: true, variantIds: [], active: true, sortOrder: 0 })
  const item = resolveCatalogItem(catalog, 'placement0')
  return { catalog, item, groups: item.selectionGroups, sellable: item }
}
function add(data, draft, group, optionIndex, times) {
  for (let i = 0; i < times; i++) draft = batch.addMenuBatchChoice(data.catalog, draft, data.groups[group], data.groups[group].options[optionIndex])
  return draft
}
function lines(data, draft) {
  let id = 0
  return batch.buildRestaurantMenuBatchLines({ ...data, selections: draft.selections, context: { tenantId: 'tenant', venueId: 'venue' }, orderId: 'order', createLineId: () => `line${++id}`, timestamp: 'now' })
}

test('five menus accept all first courses, then all seconds, with independent prices and deferred desserts', () => {
  const data = fixture()
  let draft = batch.createMenuBatchDraft(blank, 5)
  draft = add(data, draft, 0, 0, 3)
  draft = add(data, draft, 0, 1, 2)
  const full = draft
  assert.equal(add(data, draft, 0, 0, 1), full, 'cannot order a sixth first course')
  draft = add(data, draft, 1, 0, 2)
  draft = add(data, draft, 1, 1, 3)
  const result = lines(data, draft)
  assert.equal(result.length, 5)
  assert.equal(new Set(result.map(line => line.id)).size, 5)
  assert.deepEqual(result.map(line => line.quantity), [1, 1, 1, 1, 1])
  assert.deepEqual(result.map(line => line.servedQuantity), [0, 0, 0, 0, 0])
  assert.deepEqual(result.map(line => line.components.length), [2, 2, 2, 2, 2])
  assert.equal(result.reduce((sum, line) => sum + line.unitPriceCents, 0), 7750)
  assert.ok(result.every(line => line.orderId === 'order' && line.tenantId === 'tenant' && line.venueId === 'venue'))
  assert.equal(batch.getMenuBatchGroupCount(draft.selections, 'g0'), 5)
  assert.equal(batch.getMenuBatchGroupCount(draft.selections, 'g1'), 5)
  assert.equal(batch.getMenuBatchGroupCount(draft.selections, 'g2'), 0)
})

test('removing a racion frees a place without touching other courses or personalised modifiers', () => {
  const data = fixture()
  let draft = add(data, batch.createMenuBatchDraft(blank, 3), 0, 0, 3)
  draft = add(data, draft, 1, 0, 3)
  draft = { ...draft, selections: draft.selections.map((selection, index) => index !== 0 ? selection : { ...selection, components: selection.components.map(component => component.productId === 'p2'
    ? { ...component, modifiers: [{ id: 'cheese', groupId: 'sides', name: 'untrusted', priceCents: 0 }] } : component) }) }
  draft = batch.removeMenuBatchChoice(draft, 'g0', data.groups[0].options[0].id)
  assert.equal(batch.getMenuBatchGroupCount(draft.selections, 'g0'), 2)
  draft = add(data, draft, 0, 1, 1)
  assert.equal(batch.getMenuBatchGroupCount(draft.selections, 'g1'), 3)
  assert.equal(lines(data, draft)[0].unitPriceCents, 1575, 'modifier price is canonicalized from the catalog')
  assert.equal(lines(data, draft)[2].unitPriceCents, 1625)
  assert.equal(lines(data, draft)[0].components.find(component => component.productId === 'p2').modifiers[0].name, 'Queso')
})

test('batch allocation respects multiple selections per course and per-option limits', () => {
  const data = fixture(), group = { ...data.groups[0], assignment: { ...data.groups[0].assignment, maxSelection: 2 } }
  let draft = batch.createMenuBatchDraft(blank, 2)
  for (let i = 0; i < 5; i++) draft = batch.addMenuBatchChoice(data.catalog, draft, group, group.options[0])
  assert.equal(batch.getMenuBatchGroupCount(draft.selections, 'g0'), 2, 'each diner can choose the option only once')
  for (let i = 0; i < 5; i++) draft = batch.addMenuBatchChoice(data.catalog, draft, group, group.options[1])
  assert.equal(batch.getMenuBatchGroupCount(draft.selections, 'g0'), 4)
  assert.ok(draft.selections.every(selection => selection.components.length === 2))
})

test('resizing retains previous choices, and new menus inherit non-course options without copying the first diner dishes', () => {
  const data = fixture()
  const seed = add(data, batch.createMenuBatchDraft(blank, 1), 0, 0, 1).selections[0]
  const draft = batch.createMenuBatchDraft(seed, 3)
  assert.equal(draft.selections[0], seed)
  assert.equal(draft.selections[1].components.length, 0)
  const grown = batch.resizeMenuBatch(draft, 5)
  assert.equal(grown.selections[0], seed)
  assert.equal(batch.resizeMenuBatch(grown, 3).selections.length, 3)
  for (const invalid of [0, -1, 1.5, 100, NaN]) assert.equal(batch.resizeMenuBatch(grown, invalid), grown)
})

test('the batch controller validates everything before one draft update, and preserves existing lines', () => {
  const data = fixture(), existing = { id: 'existing', quantity: 1, unitPriceCents: 330, components: [], catalogSnapshot: {} }
  let counter = 0
  const h = createRestaurantControllerHarness({ currentOrder: { order: { id: 'order', status: 'open', revision: 7 }, lines: [existing], tables: [] }, idFactory: () => `new${++counter}` })
  h.options.catalog = data.catalog
  const feedback = []; h.options.onAddFeedback = input => feedback.push(input)
  const draft = add(data, batch.createMenuBatchDraft(blank, 5), 0, 0, 5)
  assert.equal(h.render().addMenuBatch(data.sellable, [...draft.selections.slice(0, 4), { ...blank, components: [{ id: 'unassigned', selectionGroupId: 'g0', quantity: 1 }] }], data.item), false)
  assert.equal(h.calls.drafts.length, 0)
  assert.equal(h.order.lines.length, 1)
  assert.equal(h.render().addMenuBatch(data.sellable, draft.selections, data.item), true)
  assert.equal(h.calls.drafts.length, 1)
  assert.equal(h.order.lines.length, 6)
  assert.equal(h.order.lines[0], existing)
  assert.equal(feedback.length, 1)
  assert.equal(new Set(h.order.lines.map(line => line.id)).size, 6)
})

for (const restriction of ['offline', 'busy', 'permission', 'closed', 'other tenant', 'other venue', 'non-menu', 'empty']) {
  test(`batch addition respects ${restriction} restrictions`, () => {
    const data = fixture(), h = createRestaurantControllerHarness({ currentOrder: { order: { id: 'order', status: restriction === 'closed' ? 'paid' : 'open' }, lines: [], tables: [] } })
    h.options.catalog = data.catalog
    if (restriction === 'offline') h.options.isOnline = false
    if (restriction === 'busy') h.options.isBusy = true
    if (restriction === 'permission') h.options.context.canTakeOrders = false
    if (restriction === 'other tenant') h.options.context.tenantId = 'other'
    if (restriction === 'other venue') h.options.context.venueId = 'other'
    const sellable = restriction === 'non-menu' ? resolveSellableProduct(data.catalog, 'p1', 'v1') : data.sellable
    assert.equal(h.render().addMenuBatch(sellable, restriction === 'empty' ? [] : [blank], data.item), false)
    assert.equal(h.calls.drafts.length, 0)
  })
}

const empty = () => null
const Button = props => jsxRuntime.jsx('button', props)
const text = node => node == null ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props?.children) : String(node)
const button = (tree, label) => expandedNodes(tree).find(node => node.type === Button && text(node) === label)
function dialogRunner(data) {
  let draft = batch.createMenuBatchDraft(blank, 5)
  const calls = []
  const runner = createCompiledHookRunner(readFileSync(new URL('../src/components/modals/MenuBatchDialog.tsx', import.meta.url), 'utf8'), 'MenuBatchDialog', {
    'react/jsx-runtime': jsxRuntime, 'lucide-react': Object.fromEntries(['ChevronRight', 'Minus', 'Pencil', 'Plus', 'X'].map(name => [name, empty])),
    '../../features/catalog/services/saleLineBuilder': builder, '../../features/restaurant/services/menuBatch': batch,
    '../../lib/format': format, '../pos/MenuEntryMode': { MenuEntryMode: empty },
    './MenuBatchOptionCard': { MenuBatchOptionCard: props => jsxRuntime.jsx('button', { 'aria-label': `Pedir ${props.option.product.name}`, disabled: props.disabled || batch.getMenuBatchChoiceCapacity(props.draft.selections, props.group, props.option) === 0, onClick: () => props.onChange(batch.addMenuBatchChoice(props.catalog, props.draft, props.group, props.option)) }) }, '../ui': { Button, AppModal: props => props.children, Input: 'input' },
  })
  const props = { ...data, disabled: false, onChange: next => { draft = next }, onIndividual() {}, onCancel: () => calls.push('close'),
    onAdd: selections => { calls.push(selections); return true }, renderEditor: (selection, onSave, onCancel) => ({ props: { selection, onSave, onCancel } }) }
  return { calls, props, get draft() { return draft }, render: () => runner.render({ ...props, draft }) }
}

test('course dialog advances once per course, permits deferred desserts and prevents repeated add taps', () => {
  const h = dialogRunner(fixture())
  let tree = h.render()
  for (let i = 0; i < 5; i++) {
    expandedNodes(tree).find(node => node.props['aria-label'] === 'Pedir Ensalada').props.onClick()
    tree = h.render()
  }
  assert.equal(expandedNodes(tree).find(node => node.props['aria-label'] === 'Pedir Ensalada').props.disabled, true)
  button(tree, 'Segundo').props.onClick()
  tree = h.render()
  assert.ok(nodes(tree).some(node => node.props['aria-label'] === 'Elegir Segundo'))
  assert.equal(button(tree, 'Añadir 5 menús').props.disabled, false)
  button(tree, 'Añadir 5 menús').props.onClick({ currentTarget: null })
  button(tree, 'Añadir 5 menús').props.onClick({ currentTarget: null })
  assert.equal(h.calls.length, 2, 'one batch and one close, even if the button is tapped twice')
  assert.equal(h.calls[0].length, 5)
})

test('reducing menu count requests explicit choice before losing selected dishes', () => {
  const h = dialogRunner(fixture())
  for (let i = 0; i < 5; i++) expandedNodes(h.render()).find(node => node.props['aria-label'] === 'Pedir Ensalada').props.onClick()
  nodes(h.render()).find(node => node.props['aria-label'] === 'Un menú menos').props.onClick()
  assert.equal(h.draft.selections.length, 5)
  let tree = h.render()
  assert.ok(nodes(tree).some(node => node.props.role === 'alert'))
  button(tree, 'Mantener 5').props.onClick()
  assert.equal(h.draft.selections.length, 5)
  nodes(h.render()).find(node => node.props['aria-label'] === 'Un menú menos').props.onClick()
  tree = h.render()
  button(tree, 'Reducir a 4').props.onClick()
  assert.equal(h.draft.selections.length, 4)
})

test('personalizing a single menu keeps all other diners unchanged and cancel preserves the draft', () => {
  const h = dialogRunner(fixture())
  nodes(h.render()).find(node => node.props['aria-label'] === 'Personalizar menú 3').props.onClick()
  let editor = h.render()
  const selection = { ...blank, modifiers: [] }
  editor.props.onSave(selection)
  assert.equal(h.draft.selections[2], selection)
  const before = h.draft
  nodes(h.render()).find(node => node.props['aria-label'] === 'Personalizar menú 1').props.onClick()
  editor = h.render()
  editor.props.onCancel()
  assert.equal(h.draft, before)
})
