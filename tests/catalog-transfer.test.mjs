import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildCatalogImportIds,
  catalogExportCollections,
  getCatalogImportSummary,
  parseCatalogExportJson,
} from '../src/features/crm/catalog/services/catalogTransferDocument.ts'

const migration = readFileSync(new URL('../supabase/migrations/20260724171616_complete_catalog_import_export.sql', import.meta.url), 'utf8')
const page = readFileSync(new URL('../src/features/crm/catalog/pages/CatalogTransferPage.tsx', import.meta.url), 'utf8')
const service = readFileSync(new URL('../src/features/crm/catalog/services/catalogTransferService.ts', import.meta.url), 'utf8')
const progressBar = readFileSync(new URL('../src/features/crm/shared/components/ProgressBar.tsx', import.meta.url), 'utf8')

function documentFixture() {
  const catalog = Object.fromEntries(catalogExportCollections.map((collection) => [collection, []]))
  catalog.categories.push({ ref: 'category-1', name: 'Bebidas', isActive: true, sortOrder: 0, unused: false })
  catalog.saleFormats.push({ ref: 'format-1', name: 'Unidad', isActive: true, sortOrder: 0 })
  catalog.tabs.push({ ref: 'tab-1', key: 'barra', label: 'Barra', icon: 'cocktail', isActive: true, sortOrder: 0 })
  catalog.tabCategories.push({ ref: 'tab-category-1', tabRef: 'tab-1', categoryRef: 'category-1', isActive: true, sortOrder: 0 })
  catalog.products.push({ ref: 'product-1', type: 'standard', name: 'Agua', isActive: true, sortOrder: 0 })
  catalog.variants.push({ ref: 'variant-1', productRef: 'product-1', saleFormatRef: 'format-1', name: 'Unidad', priceCents: 200, isDefault: true, isActive: true, sortOrder: 0 })
  catalog.placements.push({ ref: 'placement-1', tabRef: 'tab-1', categoryRef: 'category-1', productRef: 'product-1', variantRef: null, featured: false, isActive: true, sortOrder: 0 })
  return { format: 'club-pos-catalog-export', schemaVersion: 4, metadata: {}, catalog }
}

test('el JSON propio valida referencias y resume el catálogo completo', () => {
  const parsed = parseCatalogExportJson(JSON.stringify(documentFixture()))
  assert.deepEqual(getCatalogImportSummary(parsed), {
    categories: 1,
    formats: 1,
    images: 0,
    modifiers: 0,
    placements: 1,
    products: 1,
    selectionGroups: 0,
    tabs: 1,
    variants: 1,
  })
  let sequence = 0
  const ids = buildCatalogImportIds(parsed, () => `uuid-${++sequence}`)
  assert.equal(ids.products['product-1'], 'uuid-5')
  assert.notEqual(ids.products['product-1'], ids.variants['variant-1'])
})

test('el importador rechaza archivos ajenos, referencias rotas e imágenes incompletas', () => {
  const wrongFormat = documentFixture()
  wrongFormat.format = 'otro-formato'
  assert.throws(() => parseCatalogExportJson(JSON.stringify(wrongFormat)), /no es una exportación/)

  const brokenRef = documentFixture()
  brokenRef.catalog.variants[0].productRef = 'product-inexistente'
  assert.throws(() => parseCatalogExportJson(JSON.stringify(brokenRef)), /referencia inexistente/)

  const missingImage = documentFixture()
  missingImage.catalog.images.push({ ref: 'image-1', productRef: 'product-1', mimeType: 'image/webp', sizeBytes: 1, sha256: '0'.repeat(64), missing: false })
  assert.throws(() => parseCatalogExportJson(JSON.stringify(missingImage)), /dataBase64/)
})

test('la pestaña ofrece importación propia con confirmación de reemplazo', () => {
  assert.match(page, /Importar catálogo de la app/)
  assert.match(page, /Seleccionar JSON/)
  assert.match(page, /Importar y reemplazar/)
  assert.match(page, /No se modifican ventas, tickets ni datos fiscales históricos/)
  assert.match(service, /rpc\('import_catalog'/)
  assert.match(service, /dataBase64/)
  assert.match(service, /remove\(uploadedPaths\)/)
  assert.match(service, /Subiendo imágenes/)
  assert.match(service, /Guardando catálogo REVO/)
  assert.match(page, /<ImportProgress progress=\{ownProgress\}/)
  assert.match(page, /<ImportProgress progress=\{revoProgress\}/)
  assert.match(progressBar, /role="progressbar"/)
  assert.match(progressBar, /aria-valuenow/)
  assert.match(progressBar, /labelPosition === 'right'/)
})

test('la migración exporta formatos e imágenes y restringe el RPC al owner o admin', () => {
  assert.match(migration, /'schemaVersion',4/)
  assert.match(migration, /'saleFormats'/)
  assert.match(migration, /'saleFormatRef'/)
  assert.match(migration, /delete from public\.catalog_sale_formats where venue_id=p_venue_id/i)
  assert.match(migration, /not public\.user_is_tenant_admin\(v_tenant\).*CATALOG_IMPORT_FORBIDDEN/i)
  assert.match(migration, /grant execute on function public\.import_catalog\(uuid, text, jsonb\) to authenticated/i)
})