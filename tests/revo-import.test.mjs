import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { toCatalogDomainError } from '../src/features/catalog/domain/errors.ts'
import { parseRevoItemsCsv } from '../src/lib/revoImport.ts'
import {
  buildRevoCatalogImportPlan,
  splitRevoCatalogImportPlan,
} from '../src/features/crm/catalog/services/revoCatalogImportPlan.ts'

const header = 'id;category.group.name;category.name;name;active;item_format_id;sellingFormatId;sellingFormat;barcode;price;tax'
const representativeCsv = [
  header,
  '114;Begudes;Cervezas;Turia Tirador;1;33;1;Gran;gran-114;2,30;10,00',
  '114;Begudes;Cervezas;Turia Tirador;1;34;2;Petit;petit-114;1,70;10,00',
  '385;vino;blanco;Marido de mi amiga;1;125;6;botella;;12,00;10,00',
  '385;vino;blanco;Marido de mi amiga;1;126;7;copa;;2,50;10,00',
  '50;Cafe;Café;Infusions;1;;;;;1,90;10,00',
].join('\n')

function emptyCatalog() {
  return {
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    mode: 'admin',
    products: [],
    saleFormats: [],
    variants: [],
    placements: [],
    tabs: [],
    categories: [],
    tabCategories: [],
    selectionGroups: [],
    selectionOptions: [],
    selectionAssignments: [],
    modifierGroups: [],
    modifiers: [],
    modifierAssignments: [],
    loadedAt: '',
  }
}

function sequenceIds() {
  let sequence = 0
  return () => `uuid-${++sequence}`
}

test('el CSV REVO conserva grupos, categorías y todos sus formatos reutilizables', () => {
  const parsed = parseRevoItemsCsv(representativeCsv)

  assert.equal(parsed.products.length, 3)
  assert.equal(parsed.products.reduce((total, product) => total + product.variants.length, 0), 5)
  assert.equal(parsed.skippedRows, 0)
  assert.deepEqual([...new Set(parsed.products.map((product) => product.tabName))].sort(), ['Begudes', 'Cafe', 'vino'])
  assert.deepEqual([...new Set(parsed.products.map((product) => product.categoryName))].sort(), ['Café', 'Cervezas', 'blanco'])
  assert.deepEqual(
    [...new Set(parsed.products.flatMap((product) => product.variants.map((variant) => variant.formatName)))].sort(),
    ['Botella', 'Copa', 'Gran', 'Petit', 'Unidad'],
  )

  const beer = parsed.products.find((product) => product.name === 'Turia Tirador')
  assert.deepEqual(beer?.variants.map((variant) => [variant.name, variant.priceCents, variant.sku]), [
    ['Gran', 230, 'gran-114'],
    ['Petit', 170, 'petit-114'],
  ])
  assert.equal(beer?.vatRate, 10)
})

test('el parser usa el ID REVO para agrupar variantes y valida la cabecera y los precios', () => {
  const quoted = [
    header,
    '7;Menjar;Tapas;"Patatas; bravas";1;;;;;4.25;10',
  ].join('\n')
  const parsed = parseRevoItemsCsv(quoted)
  assert.equal(parsed.products[0].name, 'Patatas; bravas')
  assert.equal(parsed.products[0].variants[0].priceCents, 425)

  assert.throws(
    () => parseRevoItemsCsv('id;name;price\n1;Agua;2,00'),
    /columnas requeridas/,
  )

  const invalid = parseRevoItemsCsv([header, '8;Menjar;Tapas;Croquetas;1;;;;;precio;10'].join('\n'))
  assert.equal(invalid.products.length, 0)
  assert.equal(invalid.skippedRows, 1)
  assert.match(invalid.warnings[0], /precio no válido/)
})

test('el plan REVO crea pestañas, categorías, formatos y variantes con los datos del CSV', () => {
  const parsed = parseRevoItemsCsv(representativeCsv)
  const plan = buildRevoCatalogImportPlan(emptyCatalog(), parsed.products, sequenceIds())

  assert.deepEqual(plan.result, {
    categories: 3,
    categoryLinks: 3,
    formats: 5,
    placements: 3,
    placementsUpdated: 0,
    products: 3,
    productsUpdated: 0,
    tabs: 3,
    variants: 5,
    variantsUpdated: 0,
  })
  assert.deepEqual(plan.formatSaves.map((format) => format.name).sort(), ['Botella', 'Copa', 'Gran', 'Petit', 'Unidad'])
  assert.deepEqual(
    plan.batch.filter((item) => item.command === 'save_tab').map((item) => item.payload.label).sort(),
    ['Begudes', 'Cafe', 'vino'],
  )
  assert.deepEqual(
    plan.batch.filter((item) => item.command === 'save_category').map((item) => item.payload.name).sort(),
    ['Café', 'Cervezas', 'blanco'],
  )
  assert.equal(plan.variantFormats.length, 5)

  const wine = plan.batch.find((item) => item.command === 'create_product' && item.payload.name === 'Marido de mi amiga')
  assert.equal(wine?.payload.vatRate, 10)
  assert.deepEqual(
    wine?.payload.variants.map((variant) => variant.name),
    ['Botella', 'Copa'],
  )
})

test('el plan reutiliza entidades actuales por formato y ubicación sin duplicarlas', () => {
  const parsed = parseRevoItemsCsv([
    header,
    '114;Begudes;Cervezas;Turia Tirador;1;33;1;Gran;;2,40;10,00',
    '114;Begudes;Cervezas;Turia Tirador;1;34;2;Petit;;1,80;10,00',
  ].join('\n'))
  const catalog = {
    ...emptyCatalog(),
    products: [{
      id: 'product-1', tenantId: 'tenant-1', venueId: 'venue-1', type: 'standard', name: 'Turia Tirador',
      description: null, image: null, vatRate: null, active: true, sortOrder: 0, createdAt: '', updatedAt: '',
    }],
    saleFormats: [{
      id: 'format-gran', tenantId: 'tenant-1', venueId: 'venue-1', name: 'Gran',
      inventoryConsumptionQuantity: null, inventoryConsumptionUnitId: null,
      active: true, sortOrder: 0, createdAt: '', updatedAt: '',
    }],
    variants: [{
      id: 'variant-gran', tenantId: 'tenant-1', venueId: 'venue-1', productId: 'product-1',
      formatId: 'format-gran', name: 'Gran', priceCents: 230, sku: null,
      active: true, isDefault: true, sortOrder: 0, createdAt: '', updatedAt: '',
    }],
    tabs: [{
      id: 'tab-begudes', tenantId: 'tenant-1', venueId: 'venue-1', key: 'begudes', label: 'Begudes',
      icon: 'receipt', active: true, sortOrder: 0, createdAt: '', updatedAt: '',
    }],
    categories: [{
      id: 'category-cervezas', tenantId: 'tenant-1', venueId: 'venue-1', name: 'Cervezas',
      icon: null, unused: false, active: true, sortOrder: 0, createdAt: '', updatedAt: '',
    }],
    tabCategories: [{
      id: 'relation-1', tenantId: 'tenant-1', venueId: 'venue-1', tabId: 'tab-begudes',
      categoryId: 'category-cervezas', active: true, sortOrder: 0, createdAt: '', updatedAt: '',
    }],
    placements: [{
      id: 'placement-1', tenantId: 'tenant-1', venueId: 'venue-1', productId: 'product-1',
      tabId: 'tab-begudes', categoryId: 'category-cervezas', pinnedVariantId: null,
      featured: false, active: true, sortOrder: 0, createdAt: '', updatedAt: '',
    }],
  }
  const plan = buildRevoCatalogImportPlan(catalog, parsed.products, sequenceIds())

  assert.equal(plan.result.products, 0)
  assert.equal(plan.result.productsUpdated, 1)
  assert.equal(plan.result.variants, 1)
  assert.equal(plan.result.variantsUpdated, 1)
  assert.equal(plan.result.tabs, 0)
  assert.equal(plan.result.categories, 0)
  assert.equal(plan.result.placements, 0)
  assert.deepEqual(plan.formatSaves.map((format) => format.name), ['Petit'])
  assert.equal(plan.batch.filter((item) => item.command === 'update_product').length, 1)
  assert.equal(plan.batch.filter((item) => item.command === 'update_variant').length, 1)
  assert.equal(plan.batch.filter((item) => item.command === 'create_variant').length, 1)
})

test('el plan REVO no reactiva dos variantes predeterminadas de datos antiguos', () => {
  const parsed = parseRevoItemsCsv([
    header,
    '114;Sin alcohol;Refrescos;Agua;1;33;1;Botella;;2,40;10,00',
    '114;Sin alcohol;Refrescos;Agua;1;34;2;Copa;;1,80;10,00',
  ].join('\n'))
  const catalog = {
    ...emptyCatalog(),
    products: [{
      id: 'product-1', tenantId: 'tenant-1', venueId: 'venue-1', type: 'standard', name: 'Agua',
      description: null, image: null, vatRate: null, active: true, sortOrder: 0, createdAt: '', updatedAt: '',
    }],
    saleFormats: [
      { id: 'format-botella', tenantId: 'tenant-1', venueId: 'venue-1', name: 'Botella', inventoryConsumptionQuantity: null, inventoryConsumptionUnitId: null, active: true, sortOrder: 0, createdAt: '', updatedAt: '' },
      { id: 'format-copa', tenantId: 'tenant-1', venueId: 'venue-1', name: 'Copa', inventoryConsumptionQuantity: null, inventoryConsumptionUnitId: null, active: true, sortOrder: 10, createdAt: '', updatedAt: '' },
    ],
    variants: [
      { id: 'variant-botella', tenantId: 'tenant-1', venueId: 'venue-1', productId: 'product-1', formatId: 'format-botella', name: 'Botella', priceCents: 200, sku: null, active: true, isDefault: true, sortOrder: 0, createdAt: '', updatedAt: '' },
      { id: 'variant-copa', tenantId: 'tenant-1', venueId: 'venue-1', productId: 'product-1', formatId: 'format-copa', name: 'Copa', priceCents: 150, sku: null, active: false, isDefault: true, sortOrder: 10, createdAt: '', updatedAt: '' },
    ],
  }
  const plan = buildRevoCatalogImportPlan(catalog, parsed.products, sequenceIds())
  const variantCommands = plan.batch.filter((item) => item.command === 'update_variant')

  assert.equal(variantCommands.filter((item) => item.payload.isDefault === true).length, 1)
  assert.equal(variantCommands.find((item) => item.payload.id === 'variant-copa')?.payload.isDefault, false)
  const tabKey = plan.batch.find((item) => item.command === 'save_tab')?.payload.key
  assert.match(tabKey, /^[a-z0-9_]+$/)
})

test('la migración permite insertar formatos nuevos con el UUID generado por el cliente', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20260812120000_fix_catalog_batch_format_upsert.sql', import.meta.url),
    'utf8',
  )
  assert.match(migration, /insert into public\.catalog_sale_formats\s*\(\s*id,/i)
  assert.match(migration, /on conflict \(id\) do update/i)
  assert.match(migration, /catalog_command_batch\(p_venue_id, p_commands\)/i)
  assert.match(migration, /catalog_sale_format_id = \(v_item ->> 'formatId'\)::uuid/i)
  assert.match(migration, /grant execute on function public\.catalog_command_batch_with_formats[\s\S]*to authenticated, service_role/i)
})

test('la importación materializa formatos y divide catálogos grandes en lotes acotados', async () => {
  const parsed = parseRevoItemsCsv(representativeCsv)
  const plan = buildRevoCatalogImportPlan(emptyCatalog(), parsed.products, sequenceIds())
  const chunks = splitRevoCatalogImportPlan(plan, 3)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.batch.length <= 3))
  assert.equal(chunks.reduce((total, chunk) => total + chunk.batch.length, 0), plan.batch.length)
  assert.equal(chunks.reduce((total, chunk) => total + chunk.variantFormats.length, 0), plan.variantFormats.length)

  const service = await readFile(
    new URL('../src/features/crm/catalog/services/catalogTransferService.ts', import.meta.url),
    'utf8',
  )
  assert.match(service, /materializeRevoSaleFormats/)
  assert.match(service, /saveSaleFormat/)
  assert.match(service, /splitRevoCatalogImportPlan/)
  assert.match(service, /Guardando catálogo REVO \(\$\{index \+ 1\}\/\$\{chunks\.length\}\)/)
})

test('los errores de catálogo desconocidos conservan el detalle útil de Supabase', () => {
  const unknown = toCatalogDomainError({ code: '23505', message: 'duplicate key value violates unique constraint' })
  assert.match(unknown.message, /Detalle: duplicate key value/)
  assert.equal(unknown.details.databaseCode, '23505')

  const known = toCatalogDomainError({ message: 'CATALOG_SALE_FORMAT_NOT_FOUND' })
  assert.equal(known.code, 'CATALOG_SALE_FORMAT_INVALID')
  assert.match(known.message, /formatos de venta/)

  const invalidDefault = toCatalogDomainError({ code: 'P0001', message: 'INVALID_ACTIVE_DEFAULT_VARIANT_COUNT product 123, count 2' })
  assert.match(invalidDefault.message, /exactamente una variante predeterminada activa/)
  assert.match(invalidDefault.details.databaseMessage, /INVALID_ACTIVE_DEFAULT_VARIANT_COUNT/)
})

test('la zona de peligro borra solo el catálogo del local y exige confirmación explícita', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20260812130000_clear_catalog.sql', import.meta.url),
    'utf8',
  )
  assert.match(migration, /create or replace function public\.clear_catalog\(p_venue_id uuid\)/i)
  assert.match(migration, /delete from public\.products where venue_id = p_venue_id/i)
  assert.match(migration, /delete from public\.catalog_sale_formats where venue_id = p_venue_id/i)
  assert.match(migration, /delete from public\.categories where venue_id = p_venue_id/i)
  assert.doesNotMatch(migration, /delete from public\.(venues|orders|tickets|inventory_stock_movements)/i)
  assert.match(migration, /grant execute on function public\.clear_catalog\(uuid\) to authenticated, service_role/i)

  const page = await readFile(
    new URL('../src/features/crm/catalog/pages/CatalogTransferPage.tsx', import.meta.url),
    'utf8',
  )
  assert.match(page, /Zona de peligro/)
  assert.match(page, /BORRAR \$\{venueName\}/)
  assert.match(page, /No elimina el local/)
})
