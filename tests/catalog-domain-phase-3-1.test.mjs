import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CatalogCache } from '../src/features/catalog/data/cache.ts'
import { CatalogCommandService } from '../src/features/catalog/data/command-service.ts'
import { CatalogRepository } from '../src/features/catalog/data/repository.ts'
import { CatalogDomainError } from '../src/features/catalog/domain/errors.ts'
import { calculateCatalogPrice } from '../src/features/catalog/domain/pricing.ts'
import {
  getCategoriesForTab,
  resolveCatalogItem,
  resolveSellableCatalog,
  resolveSellableProduct,
} from '../src/features/catalog/domain/resolver.ts'

const venue = '11111111-1111-4111-8111-111111111111'
const otherVenue = '22222222-2222-4222-8222-222222222222'
const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const timestamp = '2026-07-22T12:00:00.000Z'

const row = (id, overrides = {}) => ({
  id,
  tenantId: tenant,
  venueId: venue,
  active: true,
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
})

function catalogFixture(overrides = {}) {
  const product = row('product-1', { type: 'standard', name: 'Base', description: null, image: null, vatRate: 21 })
  const variant = row('variant-1', { productId: product.id, name: 'Normal', priceCents: 1000, sku: null, isDefault: true })
  const tab = row('tab-1', { key: 'main', label: 'Principal', icon: null })
  const category = row('category-1', { name: 'Bebidas', icon: null, unused: false })
  const placement = row('placement-1', {
    productId: product.id, tabId: tab.id, categoryId: category.id,
    pinnedVariantId: null, featured: false,
  })
  return {
    tenantId: tenant,
    venueId: venue,
    mode: 'admin',
    products: [product],
    variants: [variant],
    placements: [placement],
    tabs: [tab],
    categories: [category],
    tabCategories: [row('tab-category-1', { tabId: tab.id, categoryId: category.id })],
    selectionGroups: [],
    selectionOptions: [],
    selectionAssignments: [],
    modifierGroups: [],
    modifiers: [],
    modifierAssignments: [],
    loadedAt: timestamp,
    ...overrides,
  }
}

function rawPayload(catalog = catalogFixture()) {
  const base = (value) => ({
    id: value.id, tenant_id: value.tenantId, venue_id: value.venueId,
    is_active: value.active, sort_order: value.sortOrder,
    created_at: value.createdAt, updated_at: value.updatedAt,
  })
  return {
    tenant_id: catalog.tenantId,
    venue_id: catalog.venueId,
    mode: catalog.mode,
    products: catalog.products.map((value) => ({ ...base(value), product_type: value.type, name: value.name, description: value.description, tax_rate: value.vatRate })),
    variants: catalog.variants.map((value) => ({ ...base(value), product_id: value.productId, name: value.name, price_cents: value.priceCents, sku: value.sku, is_default: value.isDefault })),
    placements: catalog.placements.map((value) => ({ ...base(value), product_id: value.productId, tab_id: value.tabId, category_id: value.categoryId, variant_id: value.pinnedVariantId, is_featured: value.featured })),
    tabs: catalog.tabs.map((value) => ({ ...base(value), key: value.key, label: value.label, icon: value.icon })),
    categories: catalog.categories.map((value) => ({ ...base(value), name: value.name, icon: value.icon, unused: value.unused })),
    tab_categories: catalog.tabCategories.map((value) => ({ ...base(value), tab_id: value.tabId, category_id: value.categoryId })),
    selection_groups: catalog.selectionGroups.map((value) => ({ ...base(value), name: value.name, kind: value.type })),
    selection_options: catalog.selectionOptions.map((value) => ({ ...base(value), group_id: value.groupId, product_id: value.productId, variant_id: value.variantId, supplement_cents: value.supplementCents, default_quantity: value.defaultQuantity, max_quantity: value.maxQuantity })),
    selection_assignments: catalog.selectionAssignments.map((value) => ({ ...base(value), product_id: value.productId, group_id: value.groupId, display_name: value.displayName, min_selection: value.minSelection, max_selection: value.maxSelection, applies_to_all_variants: value.appliesToAllVariants, variant_ids: value.variantIds })),
    modifier_groups: catalog.modifierGroups.map((value) => ({ ...base(value), name: value.name })),
    modifiers: catalog.modifiers.map((value) => ({ ...base(value), group_id: value.groupId, name: value.name, supplement_cents: value.supplementCents, is_default: value.isDefault })),
    modifier_assignments: catalog.modifierAssignments.map((value) => ({ ...base(value), product_id: value.productId, group_id: value.groupId, display_name: value.displayName, min_selection: value.minSelection, max_selection: value.maxSelection, applies_to_all_variants: value.appliesToAllVariants, variant_ids: value.variantIds })),
    images: [],
  }
}

test('resuelve variante fijada y conserva placements repetidos en tabs distintas', () => {
  const catalog = catalogFixture()
  const secondVariant = row('variant-2', { productId: 'product-1', name: 'Grande', priceCents: 1500, sku: null, isDefault: false, sortOrder: 1 })
  const secondTab = row('tab-2', { key: 'second', label: 'Segunda', icon: null, sortOrder: 1 })
  const secondPlacement = row('placement-2', { productId: 'product-1', tabId: secondTab.id, categoryId: 'category-1', pinnedVariantId: secondVariant.id, featured: true, sortOrder: 1 })
  const resolved = resolveSellableCatalog({ ...catalog, variants: [...catalog.variants, secondVariant], tabs: [...catalog.tabs, secondTab], placements: [...catalog.placements, secondPlacement] })
  assert.equal(resolved.items.length, 2)
  assert.equal(resolved.items[0].variant.id, 'variant-1')
  assert.equal(resolved.items[1].variant.id, 'variant-2')
  assert.equal(resolved.items[1].featured, true)
})

test('usa exclusivamente la default activa cuando el placement no fija variante', () => {
  const catalog = catalogFixture()
  const extra = row('variant-2', { productId: 'product-1', name: 'Extra', priceCents: 1200, sku: null, isDefault: false })
  assert.equal(resolveCatalogItem({ ...catalog, variants: [...catalog.variants, extra] }, 'placement-1').variant.id, 'variant-1')
})

test('rechaza default inactiva, ausencia de default y producto sin variante vendible', () => {
  const catalog = catalogFixture()
  const inactiveDefault = { ...catalog.variants[0], active: false }
  assert.throws(() => resolveSellableProduct({ ...catalog, variants: [inactiveDefault] }, 'product-1'), (error) => error instanceof CatalogDomainError && error.code === 'CATALOG_PRODUCT_NOT_SELLABLE')
  const noDefault = { ...catalog.variants[0], isDefault: false }
  assert.throws(() => resolveSellableProduct({ ...catalog, variants: [noDefault] }, 'product-1'), /predeterminada activa/)
})

test('excluye placements con producto o categoría inactivos sin ocultar categorías admin sin uso', () => {
  const catalog = catalogFixture()
  const unused = row('category-unused', { name: 'Sin uso', icon: null, unused: true, sortOrder: 2 })
  const inactiveProduct = { ...catalog.products[0], active: false }
  const inactiveCategory = { ...catalog.categories[0], active: false }
  assert.equal(resolveSellableCatalog({ ...catalog, products: [inactiveProduct], categories: [...catalog.categories, unused] }).items.length, 0)
  assert.equal(resolveSellableCatalog({ ...catalog, categories: [inactiveCategory, unused] }).items.length, 0)
  assert.equal(getCategoriesForTab({ ...catalog, categories: [...catalog.categories, unused] }, 'tab-1').length, 1)
})

test('conserva productos internos sin placement', () => {
  const catalog = catalogFixture({ placements: [] })
  const resolved = resolveSellableCatalog(catalog)
  assert.equal(resolved.items.length, 0)
  assert.deepEqual(resolved.internalProducts.map((product) => product.id), ['product-1'])
})

test('resuelve grupos reutilizables por producto y variante con precedencia única', () => {
  const catalog = catalogFixture()
  const optionProduct = row('product-option', { type: 'standard', name: 'Tónica', description: null, image: null, vatRate: 10, sortOrder: 1 })
  const optionVariant = row('variant-option', { productId: optionProduct.id, name: 'Normal', priceCents: 200, sku: null, isDefault: true, sortOrder: 1 })
  const group = row('group-1', { name: 'Mixer', type: 'mixer' })
  const option = row('option-1', { groupId: group.id, productId: optionProduct.id, variantId: null, supplementCents: -50, defaultQuantity: 1, maxQuantity: 1 })
  const assignment = row('assignment-1', { productId: 'product-1', groupId: group.id, displayName: null, minSelection: 1, maxSelection: 1, appliesToAllVariants: true, variantIds: ['variant-1'] })
  const result = resolveSellableProduct({ ...catalog, products: [...catalog.products, optionProduct], variants: [...catalog.variants, optionVariant], selectionGroups: [group], selectionOptions: [option], selectionAssignments: [assignment] }, 'product-1')
  assert.equal(result.selectionGroups.length, 1)
  assert.equal(result.selectionGroups[0].options[0].supplementCents, -50)
})

test('omite opciones y asignaciones inactivas y aplica grupos solo a variantes declaradas', () => {
  const catalog = catalogFixture()
  const group = row('group-1', { name: 'Menú', type: 'menu_component' })
  const assignment = row('assignment-1', { productId: 'product-1', groupId: group.id, displayName: null, minSelection: 0, maxSelection: 1, appliesToAllVariants: false, variantIds: ['variant-other'] })
  assert.equal(resolveSellableProduct({ ...catalog, selectionGroups: [group], selectionAssignments: [assignment] }, 'product-1').selectionGroups.length, 0)
  assert.equal(resolveSellableProduct({ ...catalog, selectionGroups: [{ ...group, active: false }], selectionAssignments: [{ ...assignment, appliesToAllVariants: true }] }, 'product-1').selectionGroups.length, 0)
})

test('calcula base, mixers, menú, modificadores, descuento e IVA solo con céntimos enteros', () => {
  const price = calculateCatalogPrice({
    baseVariantPriceCents: 1000,
    selections: [
      { type: 'mixer', supplementCents: -50, quantity: 1 },
      { type: 'menu_component', supplementCents: 125, quantity: 2 },
    ],
    modifiers: [{ supplementCents: 30, quantity: 2 }],
    discountCents: 60,
    vatRate: 21,
  })
  assert.deepEqual(price, {
    baseVariantPriceCents: 1000,
    selectionSupplementsCents: -50,
    modifierSupplementsCents: 60,
    menuSupplementsCents: 250,
    grossUnitPriceCents: 1260,
    discountCents: 60,
    netUnitPriceCents: 1200,
    vatRate: 21,
    taxableBaseCents: 992,
    taxAmountCents: 208,
    finalUnitPriceCents: 1200,
  })
})

test('admite precio final cero y rechaza negativo o dinero fraccional', () => {
  assert.equal(calculateCatalogPrice({ baseVariantPriceCents: 100, discountCents: 100, vatRate: 21 }).finalUnitPriceCents, 0)
  assert.throws(() => calculateCatalogPrice({ baseVariantPriceCents: 100, discountCents: 101, vatRate: 21 }), (error) => error instanceof CatalogDomainError && error.code === 'CATALOG_NEGATIVE_FINAL_PRICE')
  assert.throws(() => calculateCatalogPrice({ baseVariantPriceCents: 100.5, vatRate: 21 }), /entero en céntimos/)
})

test('el repositorio carga una vez por local y modo, ordena y expone productos internos', async () => {
  let reads = 0
  const data = rawPayload(catalogFixture({ placements: [] }))
  data.mode = 'pos'
  const client = {
    rpc: async (name, args) => { reads += 1; assert.equal(name, 'get_catalog'); assert.equal(args.p_venue_id, venue); return { data, error: null } },
    storage: { from: () => ({ getPublicUrl: (path) => ({ data: { publicUrl: `https://images/${path}` } }), remove: async () => ({ error: null }) }) },
  }
  const repository = new CatalogRepository(client, new CatalogCache())
  const [first, second] = await Promise.all([repository.getCatalog(venue, 'pos'), repository.getCatalog(venue, 'pos')])
  assert.equal(reads, 1)
  assert.equal(first, second)
  assert.deepEqual(repository.getInternalProducts(first).map((product) => product.id), ['product-1'])
})

test('rechaza una respuesta cross-venue aunque RLS exista', async () => {
  const data = rawPayload(); data.venue_id = otherVenue
  const client = {
    rpc: async () => ({ data, error: null }),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
  }
  const repository = new CatalogRepository(client, new CatalogCache())
  await assert.rejects(() => repository.getCatalog(venue), (error) => error instanceof CatalogDomainError && error.code === 'CATALOG_INCONSISTENT')
})

test('los comandos usan una RPC atómica, invalidan caché y limpian solo imágenes huérfanas', async () => {
  const calls = []
  const removed = []
  const data = rawPayload()
  const client = {
    rpc: async (name, args) => {
      calls.push([name, args])
      return name === 'get_catalog'
        ? { data, error: null }
        : { data: { result: 'SUCCESS', orphanedImagePaths: ['venue/image.webp'] }, error: null }
    },
    storage: { from: () => ({
      getPublicUrl: () => ({ data: { publicUrl: '' } }),
      remove: async (paths) => { removed.push(...paths); return { error: null } },
    }) },
  }
  const repository = new CatalogRepository(client, new CatalogCache())
  const commands = new CatalogCommandService(repository)
  await repository.getCatalog(venue)
  await commands.deleteProduct(venue, 'product-1')
  await repository.getCatalog(venue)
  assert.deepEqual(calls.map(([name]) => name), ['get_catalog', 'catalog_command', 'get_catalog'])
  assert.deepEqual(removed, ['venue/image.webp'])
})

test('prepara creación completa, cambio de default, reordenación y asignaciones sin escribir tablas legacy', async () => {
  const commandsSeen = []
  const repository = { executeCommand: async (_venueId, command, payload) => { commandsSeen.push([command, payload]); return { result: 'SUCCESS' } } }
  const commands = new CatalogCommandService(repository)
  await commands.createProduct(venue, { type: 'standard', name: 'Nuevo', sortOrder: 0, variants: [{ name: 'Normal', priceCents: 100, sortOrder: 0, isDefault: true }] })
  await commands.setDefaultVariant(venue, 'product-1', 'variant-1')
  await commands.reorder(venue, { entity: 'products', items: [{ id: 'product-1', sortOrder: 10 }] })
  await commands.saveAssignment(venue, { domain: 'selection', productId: 'product-1', groupId: 'group-1', minSelection: 0, maxSelection: 1, appliesToAllVariants: true, variantIds: [], sortOrder: 0 })
  assert.deepEqual(commandsSeen.map(([command]) => command), ['create_product', 'set_default_variant', 'reorder', 'save_assignment'])
})

test('los snapshots históricos sobreviven sin consultar el producto vivo', () => {
  const historicalLine = Object.freeze({ productId: 'deleted-product', productName: 'Nombre histórico', variantName: 'Normal', unitPriceCents: 700, catalogSnapshot: { categoryName: 'Histórica' } })
  const catalog = catalogFixture({ products: [], variants: [], placements: [] })
  assert.equal(resolveSellableCatalog(catalog).items.length, 0)
  assert.equal(historicalLine.productName, 'Nombre histórico')
  assert.equal(historicalLine.catalogSnapshot.categoryName, 'Histórica')
})

test('el esquema consolidado contiene lectura agregada, comandos finales, locks, alcance y hard delete seguro', () => {
  const sql = readFileSync(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
  assert.match(sql, /create function public\.get_catalog\(/i)
  assert.match(sql, /create function public\.catalog_command\(/i)
  assert.match(sql, /where .*venue_id = p_venue_id/i)
  assert.match(sql, /for update/)
  assert.match(sql, /orphanedImagePaths/)
  assert.doesNotMatch(sql, /insert into public\.(selection_group_items|variant_selection_groups|product_modifier_groups|sale_formats)/)
})
