import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveCatalogItem } from '../src/features/catalog/domain/resolver.ts'
import {
  buildSaleLine,
  calculateSaleLineTotals,
  getSaleLineConsumption,
  validateProductLineSelection,
  wouldCreateMenuCycle,
} from '../src/features/catalog/services/saleLineBuilder.ts'

const row = (id, overrides = {}) => ({
  id,
  tenantId: 'tenant',
  venueId: 'venue',
  active: true,
  sortOrder: 0,
  createdAt: '2026-07-22T00:00:00Z',
  updatedAt: '2026-07-22T00:00:00Z',
  ...overrides,
})

function catalogFixture(groupType = 'mixer') {
  const product = row('product', { type: groupType === 'menu_component' ? 'menu' : 'standard', name: 'Bacardi', description: null, image: null, vatRate: 21 })
  const component = row('component-product', { type: 'standard', name: groupType === 'mixer' ? 'Coca-Cola' : 'Ensalada', description: null, image: null, vatRate: 10 })
  const variant = row('variant', { productId: product.id, name: 'Normal', priceCents: 800, sku: null, isDefault: true })
  const componentVariant = row('component-variant', { productId: component.id, name: 'Normal', priceCents: 200, sku: null, isDefault: true })
  const tab = row('tab', { key: 'main', label: 'Principal', icon: null })
  const category = row('category', { name: 'Bebidas', icon: null, unused: false })
  const group = row('group', { name: groupType === 'mixer' ? 'Mixers' : 'Primer plato', type: groupType })
  return {
    tenantId: 'tenant', venueId: 'venue', mode: 'pos', loadedAt: '2026-07-22T00:00:00Z',
    products: [product, component],
    variants: [variant, componentVariant],
    tabs: [tab],
    categories: [category],
    tabCategories: [row('tab-category', { tabId: tab.id, categoryId: category.id })],
    placements: [row('placement', { productId: product.id, tabId: tab.id, categoryId: category.id, pinnedVariantId: null, featured: true })],
    selectionGroups: [group],
    selectionOptions: [row('option', { groupId: group.id, productId: component.id, variantId: null, supplementCents: groupType === 'mixer' ? 150 : 400, defaultQuantity: 0, maxQuantity: 1 })],
    selectionAssignments: [row('assignment', { productId: product.id, groupId: group.id, displayName: null, minSelection: 1, maxSelection: 1, appliesToAllVariants: true, variantIds: [] })],
    modifierGroups: [], modifiers: [], modifierAssignments: [],
  }
}

function selectedComponent(type, supplementCents) {
  return {
    id: 'option', type, selectionGroupId: 'group', selectionGroupName: type === 'mixer' ? 'Mixers' : 'Primer plato',
    productId: 'component-product', variantId: 'component-variant', productName: type === 'mixer' ? 'Coca-Cola' : 'Ensalada',
    variantName: 'Normal', quantity: 1, priceDeltaCents: supplementCents, sortOrder: 0, modifiers: [],
  }
}

test('la carga POS entra directamente por el repositorio definitivo y no proyecta catálogo legacy', () => {
  const loader = readFileSync(new URL('../src/features/catalog/data/load-pos-catalog.ts', import.meta.url), 'utf8')
  const repository = readFileSync(new URL('../src/features/catalog/data/repository.ts', import.meta.url), 'utf8')
  const posService = readFileSync(new URL('../src/services/posService.ts', import.meta.url), 'utf8')
  assert.match(loader, /catalogRepository\.getCatalog\(context\.venueId, 'pos', force\)/)
  assert.match(repository, /rpc\('get_catalog', \{ p_venue_id: venueId, p_mode: mode \}\)/)
  assert.match(posService, /return loadPosCatalog\(context, force\)/)
  assert.doesNotMatch(loader + posService, /projectCatalogForCurrentUi|loadCurrentCatalog|sale_formats|selection_group_items|variant_selection_groups/)
})

test('el suplemento del mixer es contextual, usa pricing único y crea snapshot completo', () => {
  const catalog = catalogFixture('mixer')
  const item = resolveCatalogItem(catalog, 'placement')
  const component = selectedComponent('mixer', 150)
  const selection = { modifiers: [], components: [component], mixerProductId: 'component-product', mixer: null }
  validateProductLineSelection(catalog, item, selection)
  const line = buildSaleLine('line', catalog, item, selection, item)
  assert.equal(line.unitPriceCents, 950)
  assert.deepEqual(line.modifiers, [])
  assert.equal(line.components[0].productId, 'component-product')
  assert.equal(line.catalogSnapshot.placementId, 'placement')
  assert.equal(line.catalogSnapshot.productId, 'product')
  assert.equal(line.catalogSnapshot.variantId, 'variant')
  assert.equal(line.catalogSnapshot.basePriceCents, 800)
  assert.equal(line.catalogSnapshot.vatRate, 21)
})

test('menús validan mínimos, calculan una vez y proyectan consumo sin doble decremento', () => {
  const catalog = catalogFixture('menu_component')
  const item = resolveCatalogItem(catalog, 'placement')
  assert.throws(() => validateProductLineSelection(catalog, item, { modifiers: [], components: [], mixerProductId: null, mixer: null }), /Primer plato/)
  const component = selectedComponent('menu_component', 400)
  const selection = { modifiers: [], components: [component], mixerProductId: null, mixer: null }
  const line = buildSaleLine('line', catalog, item, selection, item)
  assert.deepEqual(calculateSaleLineTotals(item.variant, [component], []), { basePriceCents: 800, componentDeltaCents: 400, modifierDeltaCents: 0, grossBeforeDiscountCents: 1200 })
  assert.equal(line.unitPriceCents, 1200)
  assert.deepEqual(getSaleLineConsumption(line), [{ productId: 'product', quantity: 1 }, { productId: 'component-product', quantity: 1 }])
})

test('la validación de menús impide ciclos directos e indirectos', () => {
  assert.equal(wouldCreateMenuCycle('menu-a', 'menu-a', new Map()), true)
  assert.equal(wouldCreateMenuCycle('menu-a', 'menu-b', new Map([['menu-b', ['menu-c']], ['menu-c', ['menu-a']]])), true)
  assert.equal(wouldCreateMenuCycle('menu-a', 'standard', new Map()), false)
})
