import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'
import { createEditableProductCatalog } from '../helpers/editable-product-catalog.mjs'
import * as resolver from '../../src/features/catalog/domain/resolver'
import * as saleLineBuilder from '../../src/features/catalog/services/saleLineBuilder'
import * as menuCourses from '../../src/features/restaurant/services/menuCourses'
import * as menuBatch from '../../src/features/restaurant/services/menuBatch'
import * as format from '../../src/lib/format'
import { cx } from '../../src/utils/cx'

const source = readFileSync(new URL('../../src/components/modals/ProductDialog.tsx', import.meta.url), 'utf8')
const empty = () => null
const Button = () => null
const PosMixerCard = () => null
const modules = {
  'react/jsx-runtime': jsxRuntime,
  'lucide-react': { Minus: empty, Plus: empty, X: empty },
  '../../features/catalog/domain/resolver': resolver,
  '../../features/catalog/services/saleLineBuilder': saleLineBuilder,
  '../../lib/format': format,
  '../../utils/cx': { cx },
  '../ui': { AppModal: empty, Button },
  '../pos/PosMixerCard': { PosMixerCard },
  '../../features/restaurant/services/menuCourses': menuCourses,
  '../../features/restaurant/services/menuBatch': menuBatch,
  '../pos/MenuEntryMode': { MenuEntryMode: empty },
  './MenuBatchDialog': { MenuBatchDialog: empty },
  './MenuDialogLayout': { MenuDialogLayout: empty },
}
const text = (node: unknown): string => {
  if (node == null) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'object' && 'props' in node) return text((node.props as { children?: unknown }).children)
  return String(node)
}

function setup(withModifiers = true) {
  const catalog = createEditableProductCatalog()
  if (!withModifiers) catalog.modifierAssignments = []
  const item = resolver.resolveCatalogItem(catalog, 'placement1')
  const initialSelection = saleLineBuilder.buildSaleLine('line', catalog, item, {
    modifiers: withModifiers ? [{ id: 'with-ice', groupId: 'ice', name: 'Con hielo', priceCents: 0 }] : [],
    components: [{ id: 'mixer2', selectionGroupId: 'mixers', quantity: 1, modifiers: [] }],
    mixerProductId: null, mixer: null,
  }, item)
  const onAdd = vi.fn(() => true)
  const onCancel = vi.fn()
  const runner = createCompiledHookRunner(source, 'ProductDialog', modules)
  const props = { allowVariantSelection: true, catalog, item, initialSelection, initialVariantId: 'v1', isBusy: false, onAdd, onCancel }
  const render = () => runner.render(props)
  const buttons = () => nodes(render()).filter(node => node.type === Button)
  const button = (label: string) => buttons().find(node => text(node).includes(label))
  return { props, onAdd, onCancel, render, button, buttons }
}

it('preselects the existing variant, mixer and modifiers when editing', () => {
  const fixture = setup()
  expect(fixture.button('Normal').props.active).toBe(true)
  expect(fixture.button('Con hielo').props.active).toBe(true)
  expect(nodes(fixture.render()).find(node => node.type === PosMixerCard && node.props.label === 'Cola').props.selected).toBe(true)
  expect(fixture.onAdd).not.toHaveBeenCalled()
})

it('changes variant, modifier and mixer and submits once only after saving', () => {
  const fixture = setup()
  fixture.button('Grande').props.onClick({ currentTarget: null })
  expect(fixture.button('Grande').props.active).toBe(true)
  expect(fixture.button('Con hielo').props.active).toBe(true)
  fixture.button('Sin hielo').props.onClick()
  nodes(fixture.render()).find(node => node.type === PosMixerCard && node.props.label === 'Tónica').props.onSelect(null)
  expect(fixture.onAdd).not.toHaveBeenCalled()
  fixture.button('Guardar cambios').props.onClick({ currentTarget: null })
  const [sellable, selection] = fixture.onAdd.mock.calls[0]
  expect(sellable.variant.id).toBe('large')
  expect(selection.modifiers.map(modifier => modifier.id)).toEqual(['without-ice'])
  expect(selection.mixerProductId).toBe('p3')
  expect(fixture.onCancel).toHaveBeenCalledOnce()
})

it('allows cancelling changes without committing and never auto-saves mixer removal', () => {
  const fixture = setup(false)
  nodes(fixture.render()).find(node => node.type === PosMixerCard && node.props.selected === false && node.props.label === 'Sin mixer').props.onSelect(null)
  expect(fixture.onAdd).not.toHaveBeenCalled()
  fixture.buttons().find(node => node.props['aria-label'] === 'Cerrar').props.onClick()
  expect(fixture.onCancel).toHaveBeenCalledOnce()
  expect(fixture.onAdd).not.toHaveBeenCalled()
})

it('does not auto-submit when editing a product whose new variant has no options', () => {
  const fixture = setup()
  fixture.props.catalog.modifierAssignments[0].appliesToAllVariants = false
  fixture.props.catalog.modifierAssignments[0].variantIds = ['v1']
  fixture.props.catalog.selectionAssignments.find(assignment => assignment.id === 'mixer-assignment').appliesToAllVariants = false
  fixture.props.catalog.selectionAssignments.find(assignment => assignment.id === 'mixer-assignment').variantIds = ['v1']
  fixture.button('Grande').props.onClick({ currentTarget: null })
  expect(fixture.onAdd).not.toHaveBeenCalled()
  expect(fixture.button('Guardar cambios').props.disabled).toBe(false)
})
