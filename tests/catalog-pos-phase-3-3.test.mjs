import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import { normalizeCatalogSnapshot } from '../src/features/catalog/services/catalogSnapshots.ts'

const removedModules = [
  '../src/features/catalog/compatibility/project-current-ui.ts',
  '../src/features/catalog/data/load-current-catalog.ts',
  '../src/features/catalog/services/catalogAccess.ts',
  '../src/features/catalog/services/saleLineBuilder-base.ts',
]

test('phase 3.3 removes every temporary POS catalog module', async () => {
  for (const relative of removedModules) {
    await assert.rejects(access(new URL(relative, import.meta.url)))
  }
})

test('the POS runtime consumes CatalogData and resolved items without sale-format compatibility', async () => {
  const [loader, panel, dialog, quickSale, restaurant, appShell] = await Promise.all([
    readFile(new URL('../src/features/catalog/data/load-pos-catalog.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/pos/CatalogPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/modals/ProductDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/quick-sale/hooks/useQuickSale.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/AppShell.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(loader, /catalogRepository\.getCatalog\(context\.venueId, 'pos', force\)/)
  assert.match(panel, /resolveSellableCatalog/)
  assert.match(dialog, /resolveSellableProduct/)
  assert.match(appShell, /useState<CatalogData \| null>/)
  assert.match(quickSale, /getDefaultProductLineSelection\(options\.catalog, item\)/)
  assert.match(restaurant, /buildSaleLine\(createId\(\), options\.catalog, sellable, selection, item\)/)
  for (const source of [loader, panel, dialog, quickSale, restaurant, appShell]) {
    assert.doesNotMatch(source, /projectCatalogForCurrentUi|loadCurrentCatalog|getProductVariantForSaleFormat|SaleFormat|usesLegacyFallback/)
  }
})

test('new quick sales and table orders share the definitive line builder and one pricing source', async () => {
  const [ticketLines, restaurant, builder, pricing] = await Promise.all([
    readFile(new URL('../src/features/quick-sale/services/ticketLines.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/catalog/services/saleLineBuilder.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/catalog/domain/pricing.ts', import.meta.url), 'utf8'),
  ])
  assert.match(ticketLines, /buildSaleLine/)
  assert.match(restaurant, /buildSaleLine/)
  assert.match(builder, /calculateCatalogPrice/)
  assert.doesNotMatch(pricing, /saleLineBuilder|calculateSaleLineTotals/)
})

test('the offline catalog cache is venue-scoped and cannot deserialize the legacy key', async () => {
  const source = await readFile(new URL('../src/lib/offlineStore.ts', import.meta.url), 'utf8')
  assert.match(source, /catalog-domain:\$\{context\.tenantId\}:\$\{context\.venueId\}/)
  assert.doesNotMatch(source, /return `\$\{prefix\}:catalog:\$\{tenantId\}`/)
})

test('historical snapshots normalize without consulting a live product', () => {
  const snapshot = normalizeCatalogSnapshot({ categoryName: 'Histórica', saleFormatName: 'Copa' }, {
    productId: 'deleted-product',
    productName: 'Nombre histórico',
    variantId: 'deleted-variant',
    variantName: 'Copa',
    basePriceCents: 700,
  })
  assert.equal(snapshot.productName, 'Nombre histórico')
  assert.equal(snapshot.categoryName, 'Histórica')
  assert.equal(snapshot.basePriceCents, 700)
  assert.equal(snapshot.placementId, null)
})
