import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { defaultSaleFormats, getProductVariantForSaleFormat } from '../src/lib/catalog.ts'
import { getCatalogPlacements, getCatalogTabs, getProductSaleOptions, getVariantSelectionGroups } from '../src/features/catalog/services/catalogAccess.ts'
import { buildSaleLine, calculateSaleLineTotals, getSaleLineConsumption, validateProductLineSelection, wouldCreateMenuCycle } from '../src/features/catalog/services/saleLineBuilder.ts'

const ids = {
  product: '10000000-0000-4000-8000-000000000001',
  cola: '10000000-0000-4000-8000-000000000002',
  cubata: '20000000-0000-4000-8000-000000000001',
  copa: '20000000-0000-4000-8000-000000000002',
  shot: '20000000-0000-4000-8000-000000000003',
  group: '30000000-0000-4000-8000-000000000001',
  item: '40000000-0000-4000-8000-000000000001',
}

function product(overrides = {}) {
  const variants = [
    { id: ids.cubata, productId: ids.product, name: 'Opcion A', priceCents: 800, sku: null, saleFormatId: defaultSaleFormats[0].id, saleFormatKey: 'cubata', isDefault: true, isActive: true, sortOrder: 0 },
    { id: ids.copa, productId: ids.product, name: 'Opcion B', priceCents: 600, sku: null, saleFormatId: defaultSaleFormats[1].id, saleFormatKey: 'copa', isDefault: false, isActive: true, sortOrder: 10 },
    { id: ids.shot, productId: ids.product, name: 'Opcion C', priceCents: 300, sku: null, saleFormatId: defaultSaleFormats[2].id, saleFormatKey: 'shot', isDefault: false, isActive: true, sortOrder: 20 },
  ]
  return {
    id: ids.product, tenantId: 'tenant', venueId: 'venue', categoryId: 'category', name: 'Bacardi', productType: 'standard',
    description: null, imagePath: null, imageUrl: null, kind: 'alcohol', saleFormats: ['cubata', 'copa', 'shot'],
    canSellStandalone: true, canUseAsMixer: false, isFeatured: true, mixerSupplementCents: 0, taxRate: 21,
    isActive: true, sortOrder: 0, variants, modifierGroups: [], variantSelectionGroups: [], ...overrides,
  }
}

function legacyCatalog() {
  return {
    catalogProfile: 'bar_classic', tabs: [], placements: [], selectionGroups: [], usesLegacyFallback: true,
    categories: [{ id: 'category', tenantId: 'tenant', name: 'Ron', kind: 'alcohol', icon: 'wine', isActive: true, sortOrder: 0 }],
    discounts: [], manualDiscountEnabled: false, products: [product()], saleFormats: defaultSaleFormats,
    updatedAt: '2026-01-01T00:00:00Z', source: 'cache',
  }
}

test('la capa de acceso no sintetiza tabs ni placements desde formatos legacy', () => {
  const catalog = legacyCatalog()
  assert.deepEqual(getCatalogTabs(catalog), [])
  assert.deepEqual(getCatalogPlacements(catalog), [])
  assert.equal(getProductVariantForSaleFormat(catalog.products[0], 'cubata').id, ids.cubata)
  assert.equal(getProductSaleOptions(catalog.products[0]).length, 3)
})

test('la carga de catalogo entra por el repositorio final y filtra por local explicitamente', () => {
  const loader = readFileSync(new URL('../src/features/catalog/data/load-current-catalog.ts', import.meta.url), 'utf8')
  const repository = readFileSync(new URL('../src/features/catalog/data/repository.ts', import.meta.url), 'utf8')
  const posService = readFileSync(new URL('../src/services/posService.ts', import.meta.url), 'utf8')
  assert.match(loader, /repository\.getCatalog\(context\.venueId, 'pos'\)/)
  assert.match(repository, /rpc\('get_catalog', \{ p_venue_id: venueId, p_mode: mode \}\)/)
  assert.match(posService, /return loadCurrentCatalog\(context\)/)
  assert.doesNotMatch(posService, /from\('sale_formats'\)|selection_group_items|variant_selection_groups/)
})

test('el suplemento del mixer es contextual y no se convierte en modificador', () => {
  const group = {
    id: ids.group, tenantId: 'tenant', venueId: 'venue', kind: 'mixer', name: 'Mixers', minSelect: 1, maxSelect: 1,
    isActive: true, sortOrder: 0,
    items: [{ id: ids.item, groupId: ids.group, productId: ids.cola, variantId: null, priceDeltaCents: 150, isDefault: false, isActive: true, sortOrder: 0 }],
  }
  const bacardi = product({ variantSelectionGroups: [{ variantId: ids.cubata, selectionGroupId: ids.group, sortOrder: 0, group }] })
  const components = [{ id: ids.item, type: 'mixer', selectionGroupId: ids.group, selectionGroupName: 'Mixers', productId: ids.cola, variantId: null, productName: 'Coca-Cola', variantName: '', quantity: 1, priceDeltaCents: 150, sortOrder: 0 }]
  const selection = { modifiers: [], components, mixerProductId: ids.cola, mixer: { productId: ids.cola, name: 'Coca-Cola', priceCents: 150 } }
  assert.equal(getVariantSelectionGroups(bacardi, ids.cubata).length, 1)
  const line = buildSaleLine('line', bacardi, bacardi.variants[0], selection)
  assert.equal(line.unitPriceCents, 950)
  assert.deepEqual(line.modifiers, [])
  assert.equal(line.components[0].productId, ids.cola)
})

test('menus validan minimos, calculan una vez y proyectan consumo sin doble decremento', () => {
  const group = {
    id: ids.group, tenantId: 'tenant', venueId: 'venue', kind: 'menu_component', name: 'Primer plato', minSelect: 1, maxSelect: 1,
    isActive: true, sortOrder: 0, items: [],
  }
  const menu = product({ productType: 'menu', variantSelectionGroups: [{ variantId: ids.cubata, selectionGroupId: ids.group, sortOrder: 0, group }] })
  assert.throws(() => validateProductLineSelection(menu, menu.variants[0], { modifiers: [], components: [], mixerProductId: null, mixer: null }), /Primer plato/)
  const component = { id: ids.item, type: 'menu_component', selectionGroupId: ids.group, selectionGroupName: 'Primer plato', productId: ids.cola, variantId: null, productName: 'Ensalada', variantName: '', quantity: 1, priceDeltaCents: 400, sortOrder: 0, modifiers: [{ id: 'component-extra', groupId: 'coccion', name: 'Muy hecho', priceCents: 75 }] }
  const selection = { modifiers: [{ id: 'extra', groupId: 'extras', name: 'Queso', priceCents: 100 }], components: [component], mixerProductId: null, mixer: null }
  group.items = [{ id: ids.item, groupId: ids.group, productId: ids.cola, variantId: null, priceDeltaCents: 400, isDefault: false, isActive: true, sortOrder: 0 }]
  const line = buildSaleLine('line', menu, menu.variants[0], selection)
  assert.deepEqual(calculateSaleLineTotals(menu.variants[0], [component], selection.modifiers), { basePriceCents: 800, componentDeltaCents: 400, modifierDeltaCents: 175, grossBeforeDiscountCents: 1375 })
  assert.equal(line.unitPriceCents, 1375)
  assert.deepEqual(getSaleLineConsumption(line), [{ productId: ids.product, quantity: 1 }, { productId: ids.cola, quantity: 1 }])
})

test('la validacion de menus impide ciclos directos e indirectos', () => {
  assert.equal(wouldCreateMenuCycle('menu-a', 'menu-a', new Map()), true)
  assert.equal(wouldCreateMenuCycle('menu-a', 'menu-b', new Map([['menu-b', ['menu-c']], ['menu-c', ['menu-a']]])), true)
  assert.equal(wouldCreateMenuCycle('menu-a', 'standard', new Map()), false)
})
