import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildNewMenuBatch, getMenuCompleteness } from '../src/features/crm/catalog/services/menuEditorModel.ts'

const row = (id, overrides = {}) => ({
  id, tenantId: 'tenant', venueId: 'venue', active: true, sortOrder: 0,
  createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
  ...overrides,
})

function catalog() {
  const menu = row('menu', { type: 'menu', name: 'Menú', description: null, image: null, vatRate: 10 })
  const child = row('child', { type: 'standard', name: 'Ensalada', description: null, image: null, vatRate: 10 })
  return {
    tenantId: 'tenant', venueId: 'venue', mode: 'crm', loadedAt: '2026-08-15T00:00:00.000Z',
    products: [menu, child],
    variants: [
      row('menu-default', { productId: menu.id, formatId: 'format', name: 'Completo', priceCents: 1500, sku: null, isDefault: true }),
      row('menu-evening', { productId: menu.id, formatId: 'format', name: 'Noche', priceCents: 1800, sku: null, isDefault: false }),
      row('child-variant', { productId: child.id, formatId: 'format', name: 'Ración', priceCents: 500, sku: null, isDefault: true }),
    ],
    saleFormats: [row('format', { name: 'Menú', inventoryConsumptionQuantity: null, inventoryConsumptionUnitId: null })],
    tabs: [row('tab', { key: 'food', label: 'Comida', icon: null })], categories: [], tabCategories: [], placements: [],
    selectionGroups: [row('course', { name: 'Primer plato', type: 'menu_component' })],
    selectionOptions: [row('option', { groupId: 'course', productId: child.id, variantId: null, supplementCents: 0, defaultQuantity: 0, maxQuantity: 1 })],
    selectionAssignments: [row('assignment', { productId: menu.id, groupId: 'course', displayName: null, minSelection: 1, maxSelection: 1, appliesToAllVariants: false, variantIds: ['menu-default'] })],
    modifierGroups: [], modifiers: [], modifierAssignments: [],
  }
}

test('un menú solo está completo si cada variante activa tiene al menos un curso aplicable', () => {
  const data = catalog()
  const incomplete = getMenuCompleteness(data, data.products[0])
  assert.equal(incomplete.complete, false)
  assert.ok(incomplete.issues.some((issue) => issue.includes('Noche')))
  data.selectionAssignments[0].appliesToAllVariants = true
  data.selectionAssignments[0].variantIds = []
  assert.equal(getMenuCompleteness(data, data.products[0]).complete, true)
})

test('la creación publica el menú solo después de guardar cursos locales sin selecciones predeterminadas', () => {
  const data = catalog()
  let nextId = 0
  const plan = buildNewMenuBatch({
    catalog: data, productId: 'new-menu', variantId: 'new-variant', formatId: 'format',
    name: 'Menú del día', description: '', priceCents: 1400, vatRate: 10,
    tabId: 'tab', categoryId: '',
    courses: [{ id: 'local-course', name: 'Principal', minSelection: 1, maxSelection: 1, options: [{ productId: 'child', supplementCents: 275 }] }],
    createId: () => `generated-${++nextId}`,
  })
  assert.equal(plan.batch[0].command, 'create_product')
  assert.equal(plan.batch[0].payload.active, false)
  const option = plan.batch.find((command) => command.command === 'save_selection_option')
  assert.equal(option.payload.defaultQuantity, 0)
  assert.equal(option.payload.supplementCents, 275)
  const publishIndex = plan.batch.findIndex((command) => command.command === 'set_product_active')
  const assignmentIndex = plan.batch.findIndex((command) => command.command === 'save_assignment')
  const placementIndex = plan.batch.findIndex((command) => command.command === 'create_placement')
  assert.ok(publishIndex > assignmentIndex)
  assert.ok(placementIndex > publishIndex)
})

test('el ciclo queda protegido en POS, pagos, publicación, realtime, ticket detallado y edición guiada', async () => {
  const [dialog, quickSale, posPage, printing, migration, realtime, groupsPage, productEditor, resolver, navigation, triggerHotfix, crmSelect, menuEditor] = await Promise.all([
    readFile(new URL('../src/components/modals/ProductDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/quick-sale/hooks/useQuickSale.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/local-printing/services/ticketPrintMapper.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260815150000_harden_menu_lifecycle.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/catalog/data/catalog-realtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/catalog/pages/CatalogGroupsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/catalog/forms/CatalogProductEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/catalog/domain/resolver.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/routing/crmNavigation.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260815160000_fix_menu_dependency_trigger.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/shared/components/CrmSelect.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/catalog/forms/CatalogMenuEditor.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(quickSale, /item\.product\.type === 'menu'/)
  assert.match(dialog, /resolvedGroup\.group\.type !== "menu_component" && option\.defaultQuantity > 0/)
  assert.match(posPage, /quickSale\.editLine/)
  assert.match(printing, /component\.type === 'menu_component'/)
  assert.match(migration, /source_order_line_id/)
  assert.match(migration, /new\.default_quantity := 0/)
  assert.match(migration, /NESTED_MENU_NOT_ALLOWED/)
  assert.match(migration, /CATALOG_SELECTION_GROUP_SCOPE_INVALID/)
  assert.match(migration, /create trigger guard_selection_group_kind_scope/)
  assert.match(migration, /create trigger guard_product_type_selection_scope/)
  assert.match(migration, /delete from public\.products product[\s\S]*not public\.menu_is_publishable/)
  assert.match(migration, /delete from public\.selection_groups selection_group[\s\S]*selection_group\.kind = 'menu_component'/)
  assert.match(migration, /create constraint trigger guard_published_menu_option/)
  assert.match(migration, /create constraint trigger guard_published_menu_assignment_variant/)
  assert.match(migration, /create constraint trigger guard_published_menu_product/)
  assert.match(migration, /set_catalog_product_published/)
  assert.match(migration, /to_regclass\(format\('public\.%I', table_name\)\) is not null/)
  assert.match(migration, /c\."priceDeltaCents"/)
  assert.doesNotMatch(migration, /greatest\(c\."priceDeltaCents"/)
  for (const table of ['products', 'product_variants', 'catalog_placements', 'selection_group_options', 'product_selection_group_assignments']) {
    assert.ok(realtime.includes(`'${table}'`))
  }
  assert.match(groupsPage, /catalog\.selectionGroups\.filter\(\(group\) => group\.type === 'mixer'\)/)
  assert.doesNotMatch(groupsPage, /menu_component/)
  assert.match(productEditor, /catalog\.selectionGroups\.filter\(\(group\) => group\.type === 'mixer'\)/)
  assert.match(resolver, /\(product\.type === 'menu'\) !== \(group\.type === 'menu_component'\)/)
  assert.match(navigation, /label: 'Mixers'/)
  assert.match(triggerHotfix, /create or replace function public\.guard_published_menu_dependencies/)
  assert.doesNotMatch(triggerHotfix, /\b(?:new|old)\.(?:group_id|product_id|assignment_id)\b/i)
  assert.match(triggerHotfix, /to_jsonb\(new\)/)
  assert.match(crmSelect, /searchPlaceholder/)
  assert.match(crmSelect, /filterOptions/)
  assert.match(crmSelect, /option\.filterValues\?\.includes\(filterValue\)/)
  assert.match(menuEditor, /searchPlaceholder="Buscar producto\.\.\."/)
  assert.match(menuEditor, /filterPlaceholder="Categorías"/)
  assert.match(menuEditor, /Suplemento/)
  assert.match(menuEditor, /supplementCents/)
})
