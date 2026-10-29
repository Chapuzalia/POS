import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'
import { createMenuCatalog } from '../helpers/menu-catalog.mjs'
import * as resolver from '../../src/features/catalog/domain/resolver'
import * as saleLineBuilder from '../../src/features/catalog/services/saleLineBuilder'
import * as menuCourses from '../../src/features/restaurant/services/menuCourses'
import * as menuBatch from '../../src/features/restaurant/services/menuBatch'
import * as format from '../../src/lib/format'
import { cx } from '../../src/utils/cx'

const source = (path: string) => readFileSync(new URL(`../../src/components/${path}.tsx`, import.meta.url), 'utf8')
const empty = () => null
const Button = () => null
const Input = () => null
const MenuCountControl = () => null
const MenuOptionCard = () => null
const MenuBatchDialog = () => null
const MenuBatchOptionCard = () => null
const MenuDialogLayout = () => null
const modules = {
  'react/jsx-runtime': jsxRuntime,
  'lucide-react': { Minus: empty, Plus: empty, X: empty, ChevronRight: empty, Pencil: empty },
  '../../features/catalog/domain/resolver': resolver,
  '../../features/catalog/services/saleLineBuilder': saleLineBuilder,
  '../../features/restaurant/services/menuCourses': menuCourses,
  '../../features/restaurant/services/menuBatch': menuBatch,
  '../../lib/format': format,
  '../../utils/cx': { cx },
  '../ui': { AppModal: empty, Button, Input, MenuDialogLayout },
  '../pos/PosMixerCard': { PosMixerCard: empty },
  '../pos/MenuCountControl': { MenuCountControl },
  '../pos/MenuOptionCard': { MenuOptionCard },
  './MenuBatchDialog': { MenuBatchDialog },
  './MenuBatchOptionCard': { MenuBatchOptionCard },
}
const text = (node: unknown): string => {
  if (node == null) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'object' && 'props' in node) return text((node.props as { children?: unknown }).children)
  return String(node)
}

function setup(withPreparation = false) {
  const catalog = createMenuCatalog()
  if (withPreparation) {
    const row = (id: string, extra = {}) => ({ id, tenantId: 'tenant', venueId: 'venue', active: true, sortOrder: 0, ...extra })
    catalog.modifierGroups.push(row('dressing', { name: 'Aliño' }))
    catalog.modifiers.push(row('oil', { groupId: 'dressing', name: 'Con aceite', supplementCents: 25, isDefault: false }))
    catalog.modifierAssignments.push(row('dressing-assignment', { productId: 'p1', groupId: 'dressing', minSelection: 0, maxSelection: 1, appliesToAllVariants: true, variantIds: [] }))
  }
  const item = resolver.resolveCatalogItem(catalog, 'placement0')
  const onAdd = vi.fn(() => true), onAddMenus = vi.fn(() => true), onCancel = vi.fn()
  const runner = createCompiledHookRunner(source('modals/ProductDialog'), 'ProductDialog', modules)
  let batchRunner: ReturnType<typeof createCompiledHookRunner> | null = null
  const props = { catalog, item, allowVariantSelection: false, allowDeferredMenu: true, isBusy: false, onAdd, onAddMenus, onCancel }
  const root = () => runner.render(props)
  const render = () => {
    const tree = root()
    if (tree.type !== MenuBatchDialog) { batchRunner = null; return tree }
    batchRunner ??= createCompiledHookRunner(source('modals/MenuBatchDialog'), 'MenuBatchDialog', modules)
    return batchRunner.render(tree.props)
  }
  const all = () => {
    const tree = render()
    return nodes([tree.props.controls, tree.props.children, tree.props.footer])
  }
  const counter = () => all().find(node => node.type === MenuCountControl)
  const button = (label: string) => all().find(node => node.type === Button && text(node) === label)
  const card = (name: string) => all().find(node => node.type === MenuOptionCard && node.props.name === name)
  return { catalog, item, props, root, render, all, counter, button, card, onAdd, onAddMenus, onCancel }
}

it('uses the count to switch from individual to courses and back without committing', () => {
  const f = setup()
  expect(f.counter().props.count).toBe(1)
  f.card('Ensalada').props.onSelect()
  f.counter().props.onChange(2)
  expect(f.counter().props.count).toBe(2)
  expect(f.root().props.draft.selections[0].components[0].productName).toBe('Ensalada')
  f.counter().props.onChange(3)
  expect(f.counter().props.count).toBe(3)
  f.counter().props.onChange(1)
  expect(f.counter().props.count).toBe(1)
  expect(f.card('Ensalada').props.selected).toBe(true)
  expect(f.onAdd).not.toHaveBeenCalled()
  expect(f.onAddMenus).not.toHaveBeenCalled()
  f.card('Ensalada').props.onSelect()
  f.counter().props.onChange(2)
  expect(f.root().props.draft.selections[0].components).toEqual([])
})

it('confirms removal of configured menus and keeps the first menu with its preparation', () => {
  const f = setup(true)
  f.counter().props.onChange(2)
  const batch = f.root()
  const preparation = [{ id: 'oil', groupId: 'dressing', name: 'Con aceite', priceCents: 25 }]
  let draft = menuBatch.addMenuBatchChoice(f.catalog, batch.props.draft, f.item.selectionGroups[0], f.item.selectionGroups[0].options[0], preparation)
  draft = menuBatch.addMenuBatchChoice(f.catalog, draft, f.item.selectionGroups[0], f.item.selectionGroups[0].options[0])
  batch.props.onChange(draft)
  f.counter().props.onChange(1)
  expect(f.counter().props.count).toBe(2)
  expect(f.counter().props.disabled).toBe(true)
  expect(f.all().some(node => node.props.role === 'alert')).toBe(true)
  f.button('Mantener 2').props.onClick()
  expect(f.counter().props.disabled).toBe(false)
  expect(f.root().props.draft.selections).toEqual(draft.selections)
  f.counter().props.onChange(1)
  f.button('Reducir a 1').props.onClick()
  expect(f.counter().props.count).toBe(1)
  expect(f.card('Ensalada').props.selected).toBe(true)
  f.button('Añadir menú').props.onClick({ currentTarget: null })
  expect(f.onAdd.mock.calls[0][1].components).toMatchObject(draft.selections[0].components)
  expect(f.onAddMenus).not.toHaveBeenCalled()
})

it('submits the exact number of menus once and blocks resizing while busy', () => {
  const f = setup()
  f.counter().props.onChange(4)
  f.props.isBusy = true
  expect(f.counter().props.disabled).toBe(true)
  expect(f.button('Añadir 4 menús').props.disabled).toBe(true)
  f.props.isBusy = false
  const add = f.button('Añadir 4 menús')
  add.props.onClick({ currentTarget: null })
  add.props.onClick({ currentTarget: null })
  expect(f.onAddMenus).toHaveBeenCalledOnce()
  expect(f.onAddMenus.mock.calls[0][1]).toHaveLength(4)
  expect(f.onCancel).toHaveBeenCalledOnce()
  expect(f.onAdd).not.toHaveBeenCalled()
})

it('keeps editing an existing menu individual and hides batch entry outside restaurant orders', () => {
  const f = setup()
  f.props.onAddMenus = undefined
  expect(f.counter()).toBeUndefined()
  const editRunner = createCompiledHookRunner(source('modals/ProductDialog'), 'ProductDialog', modules)
  const tree = editRunner.render({ ...f.props, onAddMenus: f.onAddMenus, initialSelection: { components: [], modifiers: [], mixerProductId: null, mixer: null } })
  expect(tree.type).toBe(MenuDialogLayout)
  expect(tree.props.controls).toBeNull()
})

it('validates typed menu counts and respects the lower and upper button limits', () => {
  const onChange = vi.fn()
  const runner = createCompiledHookRunner(source('pos/MenuCountControl'), 'MenuCountControl', modules)
  const props = { count: 1, disabled: false, onChange }
  const all = () => nodes(runner.render(props))
  const input = () => all().find(node => node.type === Input)
  const minus = () => all().find(node => node.props['aria-label'] === 'Un menú menos')
  const plus = () => all().find(node => node.props['aria-label'] === 'Un menú más')
  expect(minus().props.disabled).toBe(true)
  plus().props.onClick()
  expect(onChange).toHaveBeenLastCalledWith(2)
  onChange.mockClear()
  for (const value of ['', '0', '-1', '1.5', '100', 'NaN']) {
    input().props.onChange({ target: { value } })
    input().props.onBlur({ currentTarget: { value } })
    expect(input().props.value).toBe('1')
  }
  expect(onChange).not.toHaveBeenCalled()
  input().props.onBlur({ currentTarget: { value: '12' } })
  expect(onChange).toHaveBeenLastCalledWith(12)
  props.count = 99
  expect(plus().props.disabled).toBe(true)
  props.disabled = true
  expect(minus().props.disabled).toBe(true)
  expect(input().props.disabled).toBe(true)
})
