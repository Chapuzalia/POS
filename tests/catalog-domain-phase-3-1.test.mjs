import assert from 'node:assert/strict'
import test from 'node:test'
import { CatalogCache } from '../src/features/catalog/data/cache.ts'
import { CatalogCommandService } from '../src/features/catalog/data/command-service.ts'
import { CatalogRepository } from '../src/features/catalog/data/repository.ts'
import { CatalogDomainError } from '../src/features/catalog/domain/errors.ts'
import { calculateCatalogPrice } from '../src/features/catalog/domain/pricing.ts'
import { normalizeCatalogSnapshot } from '../src/features/catalog/services/catalogSnapshots.ts'

import { resolveSellableProduct } from '../src/features/catalog/domain/resolver.ts'

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

test('rechaza default inactiva, ausencia de default y producto sin variante vendible', () => {
  const catalog = catalogFixture()
  const inactiveDefault = { ...catalog.variants[0], active: false }
  assert.throws(() => resolveSellableProduct({ ...catalog, variants: [inactiveDefault] }, 'product-1'), (error) => error instanceof CatalogDomainError && error.code === 'CATALOG_PRODUCT_NOT_SELLABLE')
  const noDefault = { ...catalog.variants[0], isDefault: false }
  assert.throws(() => resolveSellableProduct({ ...catalog, variants: [noDefault] }, 'product-1'), /predeterminada activa/)
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

test('los snapshots históricos sobreviven sin consultar el producto vivo', () => {
  const normalized = normalizeCatalogSnapshot(
    { productName: 'Nombre histórico', variantName: 'Normal', categoryName: 'Histórica' },
    { productId: 'deleted-product', productName: '', variantId: null, variantName: '', basePriceCents: 700 },
  )
  assert.equal(normalized.productName, 'Nombre histórico')
  assert.equal(normalized.variantName, 'Normal')
  assert.equal(normalized.categoryName, 'Histórica')
  assert.equal(normalized.basePriceCents, 700)
})
