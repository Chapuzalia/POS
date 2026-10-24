import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as format from '../src/lib/format.ts'
import * as menuModel from '../src/features/tables/menu-service-model.ts'
import * as routing from '../src/features/production/routing.ts'
import * as orderProgress from '../src/features/production/order-progress.ts'
import * as serviceStatus from '../src/features/tables/service-status.ts'
import { resolveCatalogItem } from '../src/features/catalog/domain/resolver.ts'
import { buildSaleLine } from '../src/features/catalog/services/saleLineBuilder.ts'
import { createMenuCatalog } from './helpers/menu-catalog.mjs'
import { compileComponent, createHookHarness, expandedNodes, jsxRuntime, nodes } from './helpers/component-harness.mjs'
import { createRestaurantControllerHarness, flush } from './helpers/restaurant-controller-harness.mjs'

const source = name => readFileSync(new URL(`../src/features/tables/${name}`, import.meta.url), 'utf8')
const icons = Object.fromEntries(['Check', 'CheckCheck', 'ChevronDown', 'ChevronRight', 'Minus', 'MoreHorizontal', 'Pencil', 'Plus', 'Trash2', 'X'].map(name => [name, () => null]))
const Button = props => {
  const buttonProps = { ...props }
  delete buttonProps.key
  return jsxRuntime.jsx('button', buttonProps)
}
const empty = () => null
const text = node => node == null ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props?.children) : String(node)

function fixture() {
  const catalog = createMenuCatalog()
  const item = resolveCatalogItem(catalog, 'placement0')
  const components = item.selectionGroups.map(group => ({ id: group.options[0].id, selectionGroupId: group.group.id, quantity: 1, modifiers: [] }))
  const line = { ...buildSaleLine('menu1', catalog, item, { components, modifiers: [], mixerProductId: null, mixer: null }, item), servedQuantity: 0, note: null }
  const entries = routing.buildOptimisticProductionEntries([line], catalog, catalog.productionRouting)
  return { catalog, line, entries }
}

const rowModules = { 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons, '../../../components/ui': { Button }, '../../../lib/format': format, '../menu-service-model': menuModel, '../hooks/useOrderLineLongPress': { useOrderLineLongPress: () => ({}) }, './OrderLineActionsModal': { OrderLineActionsModal: () => null } }
const { MenuCourseRow } = compileComponent(source('components/MenuCourseRow.tsx'), rowModules)
const { MenuDetailsModal } = compileComponent(source('components/MenuDetailsModal.tsx'), {
  ...rowModules, '../../../components/ui': { Button, AppModal: props => props.children },
  '../../../components/ui/NativeSelect': { NativeSelect: props => jsxRuntime.jsx('select', props) },
})
function cardRunner() {
  const hooks = createHookHarness()
  const { MenuOrderCard } = compileComponent(source('components/MenuOrderCard.tsx'), {
    ...rowModules, react: hooks.react, './MenuCourseRow': { MenuCourseRow }, './MenuDetailsModal': { MenuDetailsModal },
  })
  return props => hooks.render(MenuOrderCard, props)
}
function cardProps(fixtureData) {
  return { ...fixtureData, number: 1, disabled: false, productionEnabled: true, onEdit() {}, onSend() {}, onServe() {}, onIncrement() {}, onDecrement() {}, onRemove() {}, onOpenQuantity() {}, onOpenPrice() {} }
}

test('each course has one next action, and serving the first leaves the second pending without production', () => {
  const { line, entries } = fixture()
  const first = { ...entries[0], servedQuantity: 1 }
  assert.equal(menuModel.getMenuCourseService(line, first, false).status, 'Servido')
  assert.equal(menuModel.getMenuCourseService(line, entries[1], false).action, 'serve')
  assert.equal(menuModel.getMenuCourseService(line, entries[1], true).action, 'send')
  assert.equal(menuModel.getMenuCourseService(line, { ...entries[1], sentQuantity: 1 }, true).action, 'serve')
  assert.equal(menuModel.getMenuCourseService(line, { ...entries[1], sentQuantity: 1 }, true).status, 'En cocina')
  assert.equal(menuModel.getMenuCourseService(line, { ...entries[1], hasProductionDestination: false }, true).action, 'serve')
  const partial = menuModel.getMenuCourseService({ quantity: 2, servedQuantity: 0 }, { ...entries[1], sentQuantity: 0.5, readyQuantity: 0.5 }, true)
  assert.equal(partial.action, 'serve', 'ready dishes can be served before sending the remaining units')
  assert.equal(partial.serveQuantity, 0.5)
  assert.equal(menuModel.isMenuServiceComplete(line, [first, ...entries.slice(1)], 0), false)
  assert.equal(menuModel.isMenuServiceComplete(line, entries.map(entry => ({ ...entry, servedQuantity: 1 })), 1), false, 'an undecided dessert cannot complete the menu')
  const undecidedFirst = menuModel.getMenuCourseGroups({ ...line, components: line.components.slice(1) }, fixture().catalog)
  assert.equal(undecidedFirst[0].name, 'Primero')
  assert.equal(undecidedFirst[0].remaining, 1)
})

test('a dish row sends or serves only its own component and hides redundant catalog metadata', () => {
  const { line, entries } = fixture()
  const sent = [], served = []
  const props = { line, component: line.components[1], entry: entries[1], productionEnabled: true, disabled: false,
    onEdit() {}, onSend: selection => sent.push(selection), onServe: (...args) => served.push(args) }
  let tree = MenuCourseRow(props)
  let actions = nodes(tree).filter(node => node.type === Button)
  assert.equal(actions.length, 1)
  assert.equal(text(actions[0]), 'Enviar')
  actions[0].props.onClick()
  assert.equal(sent[0][0].componentId, line.components[1].id)
  tree = MenuCourseRow({ ...props, productionEnabled: false })
  actions = nodes(tree).filter(node => node.type === Button)
  assert.equal(actions.length, 1)
  assert.equal(text(actions[0]), 'Servir')
  actions[0].props.onClick()
  assert.deepEqual(served, [[line.id, line.components[1].id, 1]])
  assert.doesNotMatch(text(tree), /Incluido|Normal|Menú diario/)
  assert.equal(nodes(MenuCourseRow({ ...props, entry: { ...entries[1], servedQuantity: 1 } })).filter(node => node.type === Button).length, 0)
})

test('the completed menu is collapsed by default and expands its dishes in the same single card', () => {
  const data = fixture(), render = cardRunner()
  const props = cardProps({ ...data, line: { ...data.line, servedQuantity: 1 } })
  let tree = render(props)
  assert.equal(nodes(tree).filter(node => node.type === MenuCourseRow).length, 0)
  assert.equal(text(tree).split(format.formatMoney(1500)).length - 1, 1)
  const expand = nodes(tree).find(node => node.props['aria-expanded'] === false)
  assert.equal(text(expand).includes('Ver platos'), true)
  expand.props.onClick()
  tree = render(props)
  assert.equal(nodes(tree).filter(node => node.type === MenuCourseRow).length, 3)
  assert.equal(nodes(tree).filter(node => node.type === 'article').length, 1)
})

test('menu choices stay visible while secondary price and quantity controls live in details', () => {
  const data = fixture(), render = cardRunner(), edits = [], prices = []
  const props = { ...cardProps(data), line: { ...data.line, components: data.line.components.slice(0, 2) }, onEdit: line => edits.push(line.id), onOpenPrice: () => prices.push(true) }
  let tree = render(props)
  assert.equal(nodes(tree).some(node => node.props['aria-label'] === 'Editar cantidad del menú'), false)
  const choose = nodes(tree).find(node => node.props['aria-label'] === 'Elegir Postre de Menú diario · 1')
  choose.props.onClick()
  assert.deepEqual(edits, [data.line.id])
  nodes(tree).find(node => node.props['aria-label'] === 'Detalles de Menú diario · 1').props.onClick()
  tree = render(props)
  assert.equal(expandedNodes(tree).some(node => node.props['aria-label'] === 'Editar cantidad del menú'), true)
  expandedNodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Editar precio unitario del menú').props.onClick()
  assert.equal(prices.length, 1)
  assert.equal(nodes(render(props)).some(node => node.props['aria-label'] === 'Editar cantidad del menú'), false)
})

test('menu details omit kitchen rows when all courses are served and keep price, edit and removal actions', () => {
  const data = fixture(), calls = []
  const props = { ...cardProps(data), label: 'Menú diario · 1', line: { ...data.line, servedQuantity: 1 }, routing: data.catalog.productionRouting,
    onClose: () => calls.push('close'), onEdit: line => calls.push(`edit:${line.id}`), onRemove: id => calls.push(`remove:${id}`) }
  let tree = MenuDetailsModal(props)
  assert.equal(nodes(tree).some(node => node.type === 'details'), false, 'served dishes have no empty kitchen options')
  assert.doesNotMatch(text(tree), /Ensalada|Pollo|Flan/)
  nodes(tree).find(node => node.type === Button && text(node).includes('Cambiar elecciones')).props.onClick()
  assert.deepEqual(calls, ['close', `edit:${data.line.id}`])
  calls.length = 0
  nodes(tree).find(node => node.type === Button && text(node).includes('Eliminar menú')).props.onClick()
  assert.deepEqual(calls, ['close', `remove:${data.line.id}`], 'removal still uses the confirmation controller')
  tree = MenuDetailsModal({ ...props, disabled: true })
  assert.ok(nodes(tree).filter(node => node.type === Button || node.type === 'button').every(node => node.props.disabled === true))
})

test('pending kitchen options keep pass changes and manual service; serving one course leaves the others unchanged', () => {
  const data = fixture(), calls = []
  const props = { ...cardProps(data), label: 'Menú diario · 1', routing: data.catalog.productionRouting, onClose: () => calls.push('close'),
    onServe: (...args) => calls.push(args), onChangePass: input => calls.push(input) }
  const tree = MenuDetailsModal(props)
  assert.equal(nodes(tree).filter(node => node.type === 'details').length, 1)
  const select = nodes(tree).find(node => node.props['aria-label'] === 'Pase de Pollo')
  select.props.onChange({ target: { value: 'pass2' } })
  assert.deepEqual({ ...calls[0] }, { lineId: data.line.id, componentId: data.line.components[1].id, passId: 'pass2' })
  calls.length = 0
  nodes(tree).find(node => node.type === Button && text(node) === 'Servir sin enviar').props.onClick()
  assert.deepEqual(calls, ['close', [data.line.id, data.line.components[0].id, 1]])
})

function panelRunner() {
  const hooks = createHookHarness()
  const { RestaurantOrderPanel } = compileComponent(source('components/RestaurantOrderPanel.tsx'), {
    ...rowModules, react: hooks.react, 'react-dom': { createPortal: node => node },
    '../../../components/ui/NativeSelect': { NativeSelect: empty }, '../../../lib/mixers': { getLineAdditionNames: () => [] },
    '../service-status': serviceStatus, '../../../components/pos/MenuComponentDetails': { MenuComponentDetails: empty },
    '../../../components/pos/InvoiceTicketNotice': { InvoiceTicketNotice: empty }, '../../../components/ui/NumericKeypadModal': { NumericKeypadModal: empty },
    '../../production/components/ProductionControls': { ProductionControls: empty }, '../../production/routing': routing,
    '../../production/order-progress': orderProgress, './MenuOrderCard': { MenuOrderCard: props => jsxRuntime.jsx('article', { 'data-menu-id': props.line.id, children: props.number }) },
  })
  return props => hooks.render(RestaurantOrderPanel, props)
}

test('the panel includes each menu once and keeps batch sending separate from menu contents', () => {
  const data = fixture(), render = panelRunner()
  const sent = []
  const completed = { ...data.line, id: 'completed', servedQuantity: 1 }
  const tree = render({ order: { lines: [completed, data.line] }, isBusy: false, lineDiscounts: {}, catalog: data.catalog,
    productionState: { effective: true, entries: data.entries, lines: [], warnings: [] }, productionRouting: data.catalog.productionRouting,
    onSendToProduction: selection => sent.push(selection) })
  const cards = expandedNodes(tree).filter(node => node.type === 'article' && node.props['data-menu-id'])
  assert.deepEqual(cards.map(node => node.props['data-menu-id']), [data.line.id, completed.id])
  assert.deepEqual(cards.map(text), ['2', '1'], 'menu numbers keep their identity when completed menus move below pending work')
  assert.doesNotMatch(text(tree), /Sin envío a cocina|Menús · elecciones/)
  nodes(tree).find(node => typeof node.props.onClick === 'function' && text(node) === 'Enviar Segundos · 1').props.onClick()
  assert.equal(sent[0].length, 1)
  assert.equal(sent[0][0].componentId, data.line.components[1].id)
})

test('an unrouted Espetec appears only in its default pass and cannot be included in the kitchen batch', () => {
  const data = fixture(), render = panelRunner(), sent = []
  const direct = { id: 'pass0', name: 'Directo', sortOrder: 0 }
  const productionRouting = { ...data.catalog.productionRouting, defaultPass: direct,
    passes: [direct, ...data.catalog.productionRouting.passes.slice(1)] }
  const base = { quantity: 1, servedQuantity: 0, unitPriceCents: 330, modifiers: [], components: [], catalogSnapshot: {} }
  const espetec = { ...base, id: 'espetec', productId: 'p0', productName: 'Espetec' }
  const bull = { ...base, id: 'bull', productId: 'p1', productName: 'Bull' }
  const entry = { lineId: espetec.id, componentId: null, productName: espetec.productName, quantity: 1, sentQuantity: 0, readyQuantity: 0, unsentQuantity: 1,
    passId: direct.id, passName: direct.name, passSortOrder: 0, hasProductionDestination: false }
  const entries = [entry, { ...entry, lineId: bull.id, productName: bull.productName, hasProductionDestination: true }]
  const tree = render({ order: { lines: [espetec, bull] }, isBusy: false, lineDiscounts: {}, productionRouting,
    productionState: { effective: true, entries, lines: [], warnings: [] }, onSendToProduction: selection => sent.push(selection) })
  assert.equal(nodes(tree).filter(node => node.props.line?.id === espetec.id).length, 1)
  assert.equal(nodes(tree).filter(node => node.props.line?.id === bull.id).length, 1)
  assert.deepEqual(nodes(tree).filter(node => node.type === 'h2').map(text), ['Directo · 1 nuevos'])
  nodes(tree).find(node => typeof node.props.onClick === 'function' && text(node) === 'Enviar Directo · 1').props.onClick()
  assert.equal(sent[0].length, 1)
  assert.equal(sent[0][0].lineId, bull.id)
})

for (const effective of [true, false, undefined]) {
  test(`missing production entries use the configured default pass once (production: ${effective})`, () => {
    const data = fixture(), render = panelRunner()
    const line = { id: 'espetec', productName: 'Espetec', productId: 'unrouted', quantity: 1, servedQuantity: 0, unitPriceCents: 330,
      modifiers: [], components: [], catalogSnapshot: {} }
    const productionRouting = { ...data.catalog.productionRouting, defaultPass: data.catalog.productionRouting.passes[2] }
    const tree = render({ order: { lines: [line] }, isBusy: false, lineDiscounts: {}, productionRouting,
      productionState: effective === undefined ? null : { effective, entries: [], lines: [], warnings: [] } })
    assert.equal(nodes(tree).filter(node => node.props.line?.id === line.id).length, 1)
    assert.deepEqual(nodes(tree).filter(node => node.type === 'h2').map(text), ['Postres'], 'the configured default can differ from the first pass')
  })
}

test('a missing routing cache falls back to Directo and multiple component passes cannot duplicate the commercial row', () => {
  const render = panelRunner()
  const line = { id: 'espetec', productName: 'Espetec', quantity: 1, servedQuantity: 0, unitPriceCents: 330, modifiers: [], components: [], catalogSnapshot: {} }
  const baseProps = { order: { lines: [line] }, isBusy: false, lineDiscounts: {} }
  let tree = render(baseProps)
  assert.deepEqual(nodes(tree).filter(node => node.type === 'h2').map(text), ['Directo'])
  const entry = { lineId: line.id, componentId: 'mixer1', productName: 'Mixer', quantity: 1, sentQuantity: 0, readyQuantity: 0, unsentQuantity: 1,
    passId: 'direct', passName: 'Directo', passSortOrder: 0, hasProductionDestination: false }
  tree = render({ ...baseProps, order: { lines: [{ ...line, components: [{ id: 'mixer1', type: 'mixer' }, { id: 'mixer2', type: 'mixer' }] }] },
    productionState: { effective: true, lines: [], warnings: [], entries: [entry, { ...entry, componentId: 'mixer2', passId: 'second', passName: 'Segundos' }] } })
  assert.equal(nodes(tree).filter(node => node.props.line?.id === line.id).length, 1)
  assert.deepEqual(nodes(tree).filter(node => node.type === 'h2').map(text), ['Directo'])
})

test('the controller loads and persists independent course service without the production capability', async () => {
  const data = fixture(), served = [], reads = []
  let server = { effective: false, entries: data.entries, lines: [], warnings: [] }
  const h = createRestaurantControllerHarness({ currentOrder: { order: { id: 'order', revision: 1, status: 'open' }, lines: [data.line], tables: [] },
    tableService: { loadRestaurantEqualSplit: async () => null },
    productionService: {
      loadOrderProductionState: async orderId => { reads.push(orderId); return server }, subscribeToOrderProduction: () => () => {},
      serveMenuComponent: async input => { served.push(input); server = { ...server, entries: server.entries.map(entry => entry.componentId === input.componentId ? { ...entry, servedQuantity: input.quantity } : entry) } },
    },
  })
  await h.render().openExistingOrder('order')
  h.render()
  await flush()
  assert.equal(h.render().productionState.effective, false)
  await h.render().serveComponent(data.line.id, data.line.components[0].id, 1)
  assert.equal(served.length, 1)
  assert.equal(served[0].deviceId, 'device')
  assert.equal(served[0].expectedRevision, 1)
  const result = h.render().productionState
  assert.equal(result.entries[0].servedQuantity, 1)
  assert.equal(result.entries[1].servedQuantity ?? 0, 0)
  assert.ok(reads.length >= 2)
})
