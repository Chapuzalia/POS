import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { getEffectiveInventoryItemCost } from '../src/features/crm/inventory/inventoryModel.ts'
import { resolveUnambiguousPurchaseCategories } from '../src/features/crm/purchases/purchaseCategoryModel.ts'

const migration = await readFile(new URL('../supabase/migrations/20260901234356_add_purchase_management_v1.sql', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/features/crm/purchases/services/purchaseService.ts', import.meta.url), 'utf8')
const overview = await readFile(new URL('../src/features/crm/purchases/pages/PurchasesOverviewPage.tsx', import.meta.url), 'utf8')
const invoices = await readFile(new URL('../src/features/crm/purchases/pages/PurchasesInvoicesPage.tsx', import.meta.url), 'utf8')
const review = await readFile(new URL('../src/features/crm/supplier-documents/pages/SupplierReceiptsPage.tsx', import.meta.url), 'utf8')
const inventoryItems = await readFile(new URL('../src/features/crm/inventory/pages/InventoryItemsPage.tsx', import.meta.url), 'utf8')
const supplierService = await readFile(new URL('../src/features/crm/supplier-documents/services/supplierDocumentService.ts', import.meta.url), 'utf8')
const edgeFunction = await readFile(new URL('../supabase/functions/process-supplier-document/index.ts', import.meta.url), 'utf8')
const stockChoiceMigration = await readFile(new URL('../supabase/migrations/20260902004127_persist_supplier_document_stock_choice.sql', import.meta.url), 'utf8')

const confirmation = migration.match(/create function public\.confirm_supplier_document\([\s\S]*?\nend;\n\$\$;/i)?.[0] ?? ''

test('factura o albarán con stock activado registra compra y aplica una entrada', () => {
  assert.match(confirmation, /coalesce\(p_affects_stock, true\)[\s\S]*perform public\.increment_inventory_item_stock/)
  assert.match(confirmation, /status = 'confirmed'/)
  assert.doesNotMatch(confirmation, /document_type\s*=\s*'invoice'[\s\S]{0,120}increment_inventory_item_stock/)
})

test('stock desactivado conserva la compra y no ejecuta el movimiento', () => {
  assert.match(confirmation, /if coalesce\(p_affects_stock, true\) then[\s\S]*increment_inventory_item_stock[\s\S]*end if;/i)
  assert.match(confirmation, /affects_stock = coalesce\(p_affects_stock, true\)/)
  assert.match(review, /Confirmar siempre registra la compra/)
})

test('la elección de stock se guarda al subir el documento y sobrevive al OCR', () => {
  assert.match(review, /Subir documento/)
  assert.doesNotMatch(review, /Recibir mercancía/)
  assert.match(review, /Actualizar stock al confirmar/)
  assert.match(review, /uploadSupplierDocument\([\s\S]*affectsStock/)
  assert.match(supplierService, /p_affects_stock: affectsStock/)
  assert.match(stockChoiceMigration, /p_affects_stock boolean/)
  assert.match(stockChoiceMigration, /set affects_stock = coalesce\(p_affects_stock, true\)/)
  assert.match(stockChoiceMigration, /if coalesce\(\(v_result ->> 'duplicate'\)::boolean, false\) then/)
})

test('abrir un confirmado muestra sus detalles en modo lectura y no la pantalla de éxito', () => {
  assert.match(review, /workspace\.document\.status === "confirmed"\) setScreen\("review"\)/)
  assert.match(review, /const isConfirmedDocument = detail\?\.document\.status === "confirmed"/)
  assert.match(review, /disabled=\{isConfirmedDocument\}/)
  assert.match(review, /!isConfirmedDocument \? <div className="fixed inset-x-0 bottom-0/)
})

test('los estados que requieren acción destacan en el listado de facturas', () => {
  assert.match(invoices, /review:[\s\S]*bg-amber-500[\s\S]*Pendiente de revisión/)
  assert.match(invoices, /processing:[\s\S]*bg-blue-600[\s\S]*Procesando/)
  assert.match(invoices, /error:[\s\S]*bg-red-600[\s\S]*Error/)
  assert.match(invoices, /PurchaseStatusBadge status=\{document\.status\}/)
})

test('una factura vinculada excluye el albarán del gasto y una independiente contabiliza normalmente', () => {
  assert.match(migration, /create table public\.supplier_document_links/)
  assert.match(service, /excludedDeliveryNotes\.has\(id\)/)
  assert.match(overview, /filter\(\(document\) => !document\.excludedFromSpend\)/)
})

test('document_date es obligatorio y gobierna estadísticas y exportación', () => {
  assert.match(confirmation, /if p_document_date is null[\s\S]*SUPPLIER_DOCUMENT_DATE_REQUIRED/)
  assert.match(review, /type="date"[\s\S]*value=\{documentDate\}/)
  assert.match(service, /gte\('document_date', startDate\)\.lte\('document_date', endDate\)/)
  assert.doesNotMatch(service, /gte\('created_at'/)
  assert.match(invoices, /exportPurchaseDocuments\(exportable, startDate, endDate\)/)
})

test('la exportación continúa sin originales y añade CSV de control', () => {
  assert.match(service, /if \(!document\.storageBucket \|\| !document\.storagePath\)[\s\S]*failures\.push/)
  assert.match(service, /files\['resumen\.csv'\]/)
  assert.match(service, /zipSync\(files/)
})

test('la confirmación bloqueada hace idempotente la aplicación de stock', () => {
  assert.match(confirmation, /for update;/)
  assert.ok(confirmation.indexOf("v_document.status = 'confirmed'") < confirmation.indexOf('increment_inventory_item_stock'))
  assert.match(confirmation, /'duplicate', true/)
})

test('coste medio solo cambia con stock y última compra cambia siempre', () => {
  const stockBlock = confirmation.match(/if coalesce\(p_affects_stock, true\) then[\s\S]*?perform public\.increment_inventory_item_stock[\s\S]*?end if;/i)?.[0] ?? ''
  assert.match(stockBlock, /apply_inventory_average_cost_entry/)
  assert.match(migration, /create or replace function public\.apply_inventory_average_cost_entry[\s\S]*average_cost = round/)
  assert.doesNotMatch(confirmation.slice(0, confirmation.indexOf('if coalesce(p_affects_stock, true) then')), /average_cost =/)
  assert.match(confirmation, /set last_purchase_cost = v_line\.normalized_unit_cost/)
})

test('el coste efectivo está centralizado y respeta la prioridad', () => {
  assert.deepEqual(getEffectiveInventoryItemCost({ averageCost: 2, lastPurchaseCost: 3, referenceCost: 4 }), { cost: 2, source: 'average' })
  assert.deepEqual(getEffectiveInventoryItemCost({ averageCost: null, lastPurchaseCost: 3, referenceCost: 4 }), { cost: 3, source: 'last_purchase' })
  assert.deepEqual(getEffectiveInventoryItemCost({ averageCost: null, lastPurchaseCost: null, referenceCost: 4 }), { cost: 4, source: 'reference' })
  assert.equal(getEffectiveInventoryItemCost({ averageCost: null, lastPurchaseCost: null, referenceCost: null }), null)
  assert.match(inventoryItems, /getEffectiveInventoryItemCost\(item\)/)
})

test('las correcciones añaden deltas trazables sin borrar movimientos', () => {
  assert.match(migration, /create function public\.correct_supplier_document_line/)
  assert.match(migration, /p_base_quantity - coalesce\(v_line\.base_quantity, 0\)/)
  assert.match(migration, /-v_line\.base_quantity[\s\S]*item_reassignment_out/)
  assert.match(migration, /p_base_quantity[\s\S]*item_reassignment_in/)
  assert.doesNotMatch(migration, /delete from public\.inventory_stock_movements/i)
})

test('vínculos y documentos mantienen tenant, venue, RLS e índices', () => {
  assert.match(migration, /tenant_id uuid not null[\s\S]*venue_id uuid not null/)
  assert.match(migration, /alter table public\.supplier_document_links enable row level security/)
  assert.match(migration, /supplier_document_links_read[\s\S]*user_has_venue_access/)
  assert.match(migration, /supplier_documents_purchase_period_idx/)
})

test('gasto por categoría reutiliza solo una categoría de catálogo inequívoca', () => {
  const resolved = resolveUnambiguousPurchaseCategories({
    recipes: [
      { id: 'recipe-a', variantId: 'variant-a' },
      { id: 'recipe-b', variantId: 'variant-b' },
      { id: 'recipe-c', variantId: 'variant-c' },
    ],
    recipeLines: [
      { recipeId: 'recipe-a', inventoryItemId: 'item-clear' },
      { recipeId: 'recipe-b', inventoryItemId: 'item-clear' },
      { recipeId: 'recipe-a', inventoryItemId: 'item-ambiguous' },
      { recipeId: 'recipe-c', inventoryItemId: 'item-ambiguous' },
      { recipeId: 'missing', inventoryItemId: 'item-unrelated' },
    ],
    products: [
      { id: 'product-a', active: true },
      { id: 'product-b', active: true },
      { id: 'product-c', active: true },
    ],
    variants: [
      { id: 'variant-a', productId: 'product-a', active: true },
      { id: 'variant-b', productId: 'product-b', active: true },
      { id: 'variant-c', productId: 'product-c', active: true },
    ],
    placements: [
      { productId: 'product-a', categoryId: 'drinks', active: true },
      { productId: 'product-b', categoryId: 'drinks', active: true },
      { productId: 'product-c', categoryId: 'food', active: true },
    ],
    categories: [
      { id: 'drinks', name: 'Bebidas', active: true },
      { id: 'food', name: 'Comida', active: true },
    ],
  })
  assert.deepEqual(resolved, { 'item-clear': 'Bebidas' })
  assert.match(overview, /itemCategories\[line\.inventoryItemId\] \?\? 'Otros'/)
  assert.doesNotMatch(overview, /values=\{\[\["Otros", stats\.spend\]\]\}/)
})

test('OCR se inicia en backend y el listado solo refresca su estado persistido', () => {
  assert.match(edgeFunction, /EdgeRuntime\.waitUntil\(processSupplierDocumentRequest\(backgroundRequest\)/)
  assert.match(edgeFunction, /return json\(\{ documentId, status: 'processing' \}, 202\)/)
  assert.match(supplierService, /await processDocument\(created\.documentId\)[\s\S]*return created/)
  assert.match(invoices, /hasProcessingDocuments[\s\S]*window\.setInterval[\s\S]*5_000/)
  assert.match(invoices, /processing:[\s\S]*label: 'Procesando'/)
  assert.match(review, /Reintentar procesamiento/)
})
