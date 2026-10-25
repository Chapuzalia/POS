import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as format from '../src/lib/format.ts'
import * as menuModel from '../src/features/tables/menu-service-model.ts'
import * as routing from '../src/features/production/routing.ts'

import { resolveCatalogItem } from '../src/features/catalog/domain/resolver.ts'
import { buildSaleLine } from '../src/features/catalog/services/saleLineBuilder.ts'
import { createMenuCatalog } from './helpers/menu-catalog.mjs'
import { compileComponent, jsxRuntime, nodes } from './helpers/component-harness.mjs'

const source = name => readFileSync(new URL(`../src/features/tables/${name}`, import.meta.url), 'utf8')
const icons = Object.fromEntries(['Check', 'CheckCheck', 'ChevronDown', 'ChevronRight', 'Minus', 'MoreHorizontal', 'Pencil', 'Plus', 'Trash2', 'X'].map(name => [name, () => null]))
const Button = props => {
  const buttonProps = { ...props }
  delete buttonProps.key
  return jsxRuntime.jsx('button', buttonProps)
}

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

test('a dish row sends or serves only its own component and hides redundant catalog metadata', () => {
  const { line, entries } = fixture()
  const sent = [], served = []
  const props = { line, component: line.components[1], entry: entries[1], productionEnabled: true, disabled: false,
    onEdit() {}, onSend: selection => sent.push(selection), onServe: (...args) => served.push(args) }
  let tree = MenuCourseRow(props)
  let actions = nodes(tree).filter(node => node.type === Button)
  assert.equal(actions.length, 1)
  actions[0].props.onClick()
  assert.equal(sent[0][0].componentId, line.components[1].id)
  tree = MenuCourseRow({ ...props, productionEnabled: false })
  actions = nodes(tree).filter(node => node.type === Button)
  assert.equal(actions.length, 1)
  actions[0].props.onClick()
  assert.deepEqual(served, [[line.id, line.components[1].id, 1]])
  assert.equal(nodes(MenuCourseRow({ ...props, entry: { ...entries[1], servedQuantity: 1 } })).filter(node => node.type === Button).length, 0)
})
