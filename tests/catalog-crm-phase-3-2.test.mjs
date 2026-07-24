import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { resolveCatalogItem } from '../src/features/catalog/domain/resolver.ts'
import {
  buildProductCreationBatch,
  filterCatalogProducts,
  getCatalogProductSummaries,
  moveCatalogItem,
  toReorderItems,
  validateSelectionCapacity,
  validateVariantDrafts,
} from '../src/features/crm/catalog/services/catalogAdminModel.ts'

const base = (id, sortOrder = 0) => ({ id, tenantId: 'tenant', venueId: 'venue', sortOrder, createdAt: '', updatedAt: '' })
const catalog = {
  tenantId: 'tenant', venueId: 'venue', mode: 'admin', loadedAt: '',
  products: [
    { ...base('p-drink'), type: 'standard', name: 'Agua', description: null, image: null, vatRate: 10, active: true },
    { ...base('p-menu', 10), type: 'menu', name: 'Menú diario', description: 'Completo', image: null, vatRate: 10, active: true },
    { ...base('p-internal', 20), type: 'standard', name: 'Salsa interna', description: null, image: null, vatRate: 10, active: true },
  ],
  variants: [
    { ...base('v-drink'), productId: 'p-drink', name: 'Normal', priceCents: 200, sku: null, active: true, isDefault: true },
    { ...base('v-menu'), productId: 'p-menu', name: 'Mediodía', priceCents: 1500, sku: null, active: true, isDefault: true },
    { ...base('v-internal'), productId: 'p-internal', name: 'Ración', priceCents: 50, sku: null, active: true, isDefault: true },
  ],
  tabs: [{ ...base('tab'), key: 'principal', label: 'Principal', icon: null, active: true }],
  categories: [{ ...base('category'), name: 'Bebidas', icon: null, unused: false, active: true }],
  tabCategories: [{ ...base('tc'), tabId: 'tab', categoryId: 'category', active: true }],
  placements: [
    { ...base('pl-drink'), productId: 'p-drink', tabId: 'tab', categoryId: 'category', pinnedVariantId: null, featured: false, active: true },
    { ...base('pl-menu', 10), productId: 'p-menu', tabId: 'tab', categoryId: 'category', pinnedVariantId: 'v-menu', featured: true, active: true },
  ],
  selectionGroups: [{ ...base('sg'), name: 'Primeros', type: 'menu_component', active: true }],
  selectionOptions: [{ ...base('so'), groupId: 'sg', productId: 'p-drink', variantId: null, supplementCents: -25, defaultQuantity: 0, maxQuantity: 1, active: true }],
  selectionAssignments: [{ ...base('sa'), productId: 'p-menu', groupId: 'sg', displayName: null, minSelection: 1, maxSelection: 1, appliesToAllVariants: true, variantIds: [], active: true }],
  modifierGroups: [], modifiers: [], modifierAssignments: [],
}

test('CRM product summaries list menus, ranges, placements and internal products without N+1 reads', () => {
  const summaries = getCatalogProductSummaries(catalog)
  assert.equal(summaries.length, 3)
  assert.equal(summaries.find((item) => item.product.id === 'p-menu').placementCount, 1)
  assert.equal(summaries.find((item) => item.product.id === 'p-internal').internal, true)
  assert.equal(summaries.find((item) => item.product.id === 'p-drink').minPriceCents, 200)
})

test('CRM product search and business filters combine deterministically', () => {
  const summaries = getCatalogProductSummaries(catalog)
  const filters = { query: 'bebidas', status: 'all', type: 'standard', categoryId: 'category', tabId: 'tab', showInternal: false }
  assert.deepEqual(filterCatalogProducts(summaries, filters).map((item) => item.product.id), ['p-drink'])
  assert.deepEqual(filterCatalogProducts(summaries, { ...filters, query: '', categoryId: '', tabId: '', showInternal: true }).map((item) => item.product.id), ['p-drink', 'p-internal'])
})

test('variant and group guards reject double defaults, invalid active products and impossible capacity', () => {
  assert.match(validateVariantDrafts([
    { name: 'A', priceCents: 100, active: true, isDefault: true },
    { name: 'B', priceCents: 200, active: true, isDefault: true },
  ], true), /única/)
  assert.match(validateVariantDrafts([{ name: 'A', priceCents: -1, active: true, isDefault: true }], true), /no negativos/)
  assert.match(validateSelectionCapacity({ minSelection: 2, maxSelection: 1, required: true, availableOptions: 2 }), /superar/)
  assert.match(validateSelectionCapacity({ minSelection: 2, maxSelection: 2, required: true, availableOptions: 1 }), /suficientes/)
  assert.equal(validateSelectionCapacity({ minSelection: 1, maxSelection: 2, required: true, availableOptions: 2 }), null)
})

test('simple and advanced products are created as one atomic command batch using integer cents', () => {
  const batch = buildProductCreationBatch({
    productId: 'p', venueId: 'venue', type: 'menu', name: 'Menú', description: null, vatRate: 10,
    active: true, sortOrder: 0,
    variants: [
      { id: 'v1', name: 'Mediodía', priceCents: 1500, active: true, isDefault: true, sortOrder: 0 },
      { id: 'v2', name: 'Noche', priceCents: 2200, active: true, isDefault: false, sortOrder: 10 },
    ],
    placement: { id: 'pl', tabId: 'tab', categoryId: 'category', pinnedVariantId: null, sortOrder: 0 },
  })
  assert.deepEqual(batch.map((command) => command.command), ['create_product', 'create_placement'])
  assert.deepEqual(batch[0].payload.variants.map((variant) => variant.priceCents), [1500, 2200])
  assert.equal(JSON.stringify(batch).includes('sale_formats'), false)
})

test('all CRM reorder operations emit one collision-free deterministic payload', () => {
  const moved = moveCatalogItem([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'c', -1)
  assert.deepEqual(toReorderItems(moved), [{ id: 'a', sortOrder: 0 }, { id: 'c', sortOrder: 10 }, { id: 'b', sortOrder: 20 }])
})

test('the definitive POS resolver immediately reflects final CRM price, category, placement and group data', () => {
  const item = resolveCatalogItem({ ...catalog, mode: 'pos' }, 'pl-menu')
  assert.equal(item.variant.priceCents, 1500)
  assert.equal(item.category.id, 'category')
  assert.equal(item.placement.productId, 'p-menu')
  assert.equal(item.selectionGroups[0].group.name, 'Primeros')
})

test('phase 3.2 CRM code uses final RPCs and contains no legacy catalog writes', async () => {
  const [service, transfer, routing, migration] = await Promise.all([
    readFile(new URL('../src/features/crm/catalog/services/catalogAdminService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/catalog/services/catalogTransferService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/routing/CrmSectionContent.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
  ])
  const crmCode = service + transfer + routing
  for (const legacy of ['sale_formats', 'selection_group_items', 'variant_selection_groups', 'product_modifier_groups']) {
    assert.doesNotMatch(crmCode, new RegExp(String.raw`[.]from[(]['"]${legacy}`))
  }
  assert.match(service, /CatalogRepository/)
  assert.match(service, /CatalogCommandService/)
  assert.match(migration, /catalog_command_batch/)
  assert.match(migration, /catalog_image_command/)
  assert.match(migration, /catalog_tab_category_command/)
})
