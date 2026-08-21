import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildPreTicketPayload } from '../src/features/quick-sale/services/salePayload.ts'
import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'
import { printRequestSchema } from '../src/features/local-printing/schemas/printSchemas.ts'
import { buildCatalogOrderLinesPayload } from '../src/features/tables/order-line-payload.ts'

const printerLayout = { columns: 48, paperWidth: 80, characterSet: 'CP858' }

const context = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantName: 'Tenant',
  tenantSlug: 'tenant',
  venueId: '22222222-2222-4222-8222-222222222222',
  venueName: 'Restaurante',
  venueAddress: 'Calle Mayor 1',
  venueLegalName: 'Restaurante SL',
  venueTaxId: 'B12345678',
  venueDefaultTaxRate: 21,
  deviceId: '33333333-3333-4333-8333-333333333333',
  deviceName: 'TPV',
  userId: '44444444-4444-4444-8444-444444444444',
  userName: 'Camarero',
  role: 'cashier',
}
const cashSession = {
  id: '55555555-5555-4555-8555-555555555555',
  tenantId: context.tenantId,
  venueId: context.venueId,
  deviceId: context.deviceId,
  cashRegisterId: '66666666-6666-4666-8666-666666666666',
  cashRegisterName: 'Caja',
  userId: context.userId,
  openedAt: '2026-08-19T10:00:00.000Z',
  openingFloatCents: 10000,
  status: 'open',
}
const discount = {
  discountId: '77777777-7777-4777-8777-777777777777',
  name: 'Happy hour',
  type: 'percentage',
  calculationType: 'percentage',
  value: 10,
  fixedApplication: 'ticket',
  roundingIncrementCents: null,
  color: null,
  ruleKind: 'promotion',
  scope: 'general',
  automatic: true,
}
const lines = [{
  id: '88888888-8888-4888-8888-888888888888',
  productId: '99999999-9999-4999-8999-999999999999',
  productName: 'Combinado',
  variantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  variantName: 'Grande',
  basePriceCents: 1000,
  componentDeltaCents: 100,
  modifierDeltaCents: 50,
  unitPriceCents: 1150,
  quantity: 2,
  modifiers: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', groupId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Extra hielo', priceCents: 50 }],
  components: [{
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', type: 'mixer', selectionGroupId: null, selectionGroupName: 'Mixer',
    productId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', variantId: null, productName: 'Tónica', variantName: '', quantity: 1,
    priceDeltaCents: 100, sortOrder: 0,
  }],
  catalogSnapshot: {
    placementId: null, productType: 'standard', productId: '99999999-9999-4999-8999-999999999999', productName: 'Combinado',
    variantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', variantName: 'Grande', basePriceCents: 1000, vatRate: 21,
    categoryId: null, categoryName: 'Bebidas', catalogTabId: null, catalogTabName: 'Bar', saleFormatId: null, saleFormatName: '',
  },
  mixerProductId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  mixer: { productId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Tónica', priceCents: 100 },
}]

function buildPreview(activeDiscount) {
  const originalWindow = globalThis.window
  globalThis.window = { ...originalWindow, crypto: globalThis.crypto }
  try {
    return buildPreTicketPayload(context, cashSession, lines, activeDiscount)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
}

test('el pre-ticket reutiliza cálculos, variantes, extras, promoción e IVA sin datos de pago', () => {
  const original = structuredClone(lines)
  const preview = buildPreview(discount)
  const request = mapSaleToPrintRequest({ sale: preview, establishment: { name: context.venueName }, printerId: 'printer', printerLayout, isPreTicket: true })

  const text = request.lines.join('\n')
  assert.match(text, /PRE-TICKET/)
  assert.doesNotMatch(text, /PAGO|Entregado|Cambio/)
  assert.equal(request.options.openCashDrawer, false)
  assert.match(text, /Descuento[ ]+-2,30 €/)
  assert.match(text, /IVA 21 %/)
  assert.match(text, /Combinado Grande/)
  assert.match(text, /Tónica/)
  assert.match(text, /Extra hielo/)
  assert.deepEqual(lines, original)
  assert.match(printRequestSchema.parse(request).lines.join('\n'), /TOTAL[ ]+20,70 €/)
})

test('imprimir varias veces genera solicitudes independientes sin mutar ni crear una venta persistida', () => {
  const first = mapSaleToPrintRequest({ sale: buildPreview(null), establishment: { name: 'Local' }, printerId: 'printer', printerLayout, isPreTicket: true })
  const second = mapSaleToPrintRequest({ sale: buildPreview(null), establishment: { name: 'Local' }, printerId: 'printer', printerLayout, isPreTicket: true })
  assert.match(first.requestId, /^pre-ticket:/)
  assert.match(second.requestId, /^pre-ticket:/)
  assert.notEqual(first.requestId, second.requestId)
})

test('la transferencia conserva la selección completa de cada línea', () => {
  assert.deepEqual(buildCatalogOrderLinesPayload(lines), [{
    id: lines[0].id,
    productId: lines[0].productId,
    variantId: lines[0].variantId,
    modifierIds: [lines[0].modifiers[0].id],
    mixerProductId: lines[0].mixerProductId,
    components: lines[0].components,
    catalogSnapshot: lines[0].catalogSnapshot,
    quantity: 2,
    note: null,
  }])
})

test('el botón de pre-ticket respeta configuración, vacío, loading y feedback sin cobrar', async () => {
  const [button, printer, mapper] = await Promise.all([
    readFile(new URL('../src/features/local-printing/components/PreTicketButton.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/local-printing/services/printPreTicket.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/local-printing/services/ticketPrintMapper.ts', import.meta.url), 'utf8'),
  ])
  assert.match(button, /if \(!isConfigured\) return null/)
  assert.match(button, /lines\.length === 0/)
  assert.match(button, /isPrintingTicket/)
  assert.match(button, /sileo\.success/)
  assert.match(button, /sileo\.warning/)
  assert.match(printer, /state\.printTicket\(request\)/)
  assert.match(printer, /if \(activePreTicketPrint\) return activePreTicketPrint/)
  assert.doesNotMatch(printer, /persist|completePayment|enqueueOfflineEvent|syncPendingEvents/)
  assert.match(mapper, /openCashDrawer: isPreTicket \? false/)
})

test('Venta rápida solo ofrece guardar cuando hay mesas y productos, reutilizando el mismo modal', async () => {
  const [page, bar, mapView, modal] = await Promise.all([
    readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/components/TableOrderBar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/components/TableMapView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/components/VirtualTableModal.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(page, /restaurantEnabled && !props\.reservations\.isOpen && restaurant\.tablesEnabled/)
  assert.match(page, /canSaveQuickSale=\{Boolean\(props\.context\.canTakeOrders && quickSale\.lines\.length > 0\)\}/)
  assert.match(bar, /quickSale \? <UiButton[\s\S]*Guardar como mesa virtual/)
  assert.match(page, /defaultName="Virtual"/)
  assert.match(page, /requirePhysicalArea/)
  assert.match(mapView, /<VirtualTableModal/)
  assert.match(modal, /Zona de la mesa virtual/)
  assert.match(modal, /setName\(event\.target\.value\)/)
})

test('la conversión es atómica, selecciona sala y limpia Venta rápida únicamente tras éxito', async () => {
  const [migration, controller, page, service] = await Promise.all([
    readFile(new URL('../supabase/migrations/20260819130000_save_quick_sale_as_virtual_table.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8'),
  ])
  assert.match(migration, /create or replace function public\.save_quick_sale_as_virtual_table/)
  assert.match(migration, /if p_area_id is null/)
  assert.match(migration, /public\.create_virtual_restaurant_table[\s\S]*public\.open_restaurant_order[\s\S]*public\.save_catalog_order_lines/)
  assert.match(migration, /set draft_discount = p_discount/)
  assert.doesNotMatch(migration, /create table public\.(virtual_tables|virtual_orders|virtual_sales)/)
  assert.match(service, /p_lines: buildCatalogOrderLinesPayload\(input\.lines\)/)
  assert.match(controller, /await saveQuickSaleAsVirtualTable[\s\S]*setPosView\(\{ type: 'table_map', areaId: input\.areaId/)
  assert.match(page, /const created = await restaurant\.createVirtualTableFromQuickSale[\s\S]*if \(created\) \{[\s\S]*quickSale\.clear\(\)/)
})

test('la mesa resultante usa carga, realtime, cobro y ciclo de vida estándar', async () => {
  const [service, realtime, controller, migration] = await Promise.all([
    readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/restaurant/hooks/useRestaurantRealtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260814120000_add_session_virtual_restaurant_tables.sql', import.meta.url), 'utf8'),
  ])
  assert.match(service, /draftDiscount: row\.draft_discount/)
  assert.match(controller, /options\.setAppliedDiscount\(detail\.order\.draftDiscount\)/)
  assert.match(controller, /closeRestaurantOrder\(saved\.order\.id/)
  assert.match(realtime, /subscribeToRestaurantMap/)
  assert.match(realtime, /subscribeToSessionTableLayout/)
  assert.match(migration, /deactivate_closed_session_virtual_tables/)
})

test('volver desde Venta rápida la guarda automáticamente en una mesa temporal', async () => {
  const [page, controller, migration] = await Promise.all([
    readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260821150000_auto_save_quick_sales_and_delete_virtual_tables.sql', import.meta.url), 'utf8'),
  ])
  assert.match(page, /const returnFromQuickSale = async/)
  assert.match(page, /quickSale\.lines\.length === 0[\s\S]*restaurant\.returnToMap\(\)/)
  assert.match(page, /createVirtualTableFromQuickSale\(\{[\s\S]*areaId: null/)
  assert.doesNotMatch(page, /const areaId = sourceAreaId/)
  assert.match(page, /name: `Venta rápida \$\{sequence\}`[\s\S]*quickSale\.lines, quickSale\.discount/)
  assert.match(page, /onBack=\{\(\) => void returnFromQuickSale\(\)\}/)
  assert.match(page, /restaurant\.reset\(areaId\)/)
  assert.match(controller, /setPosView\(\{ type: 'table_map', areaId: input\.areaId \?\? `virtual:\$\{options\.cashSession\.id\}` \}\)/)
  assert.doesNotMatch(migration, /if p_area_id is null/)
  assert.match(migration, /public\.create_virtual_restaurant_table[\s\S]*public\.open_restaurant_order[\s\S]*public\.save_catalog_order_lines/)
})
