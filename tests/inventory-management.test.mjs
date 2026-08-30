import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  calculateStockUnitConsumption,
  inventoryQuantityStep,
  parseInventoryQuantity,
  parsePositiveInventoryQuantity,
  validateInventoryDecimalPlaces,
} from '../src/features/crm/inventory/inventoryModel.ts'
import {
  getSectionTitle,
  inventoryNavItems,
  inventorySections,
} from '../src/features/crm/routing/crmNavigation.ts'

const migrationPath = new URL(
  '../supabase/migrations/20260727200000_add_inventory_management.sql',
  import.meta.url,
)
const migration = readFileSync(migrationPath, 'utf8')
const packagingMigration = readFileSync(
  new URL('../supabase/migrations/20260727210000_add_inventory_packaging_recipes.sql', import.meta.url),
  'utf8',
)
const automaticConsumptionMigration = readFileSync(
  new URL('../supabase/migrations/20260727220000_move_inventory_consumption_to_formats.sql', import.meta.url),
  'utf8',
)
const stockUpsertRepairMigration = readFileSync(
  new URL('../supabase/migrations/20260727230000_fix_inventory_product_stock_upsert.sql', import.meta.url),
  'utf8',
)
const selfContainedStockMigration = readFileSync(
  new URL('../supabase/migrations/20260727240000_make_inventory_stock_rpc_self_contained.sql', import.meta.url),
  'utf8',
)
const unitCapacityMigration = readFileSync(
  new URL('../supabase/migrations/20260727250000_move_inventory_capacity_to_units.sql', import.meta.url),
  'utf8',
)
const negativeStockMigration = readFileSync(
  new URL('../supabase/migrations/20260804120000_allow_negative_inventory_stock.sql', import.meta.url),
  'utf8',
)
const warehouseRoutingMigration = readFileSync(
  new URL('../supabase/migrations/20260804210000_add_inventory_warehouse_routing.sql', import.meta.url),
  'utf8',
)
const inventoryToggleMigration = readFileSync(
  new URL('../supabase/migrations/20260804220000_add_inventory_control_toggle.sql', import.meta.url),
  'utf8',
)
const warehouseDeletionMigration = readFileSync(
  new URL('../supabase/migrations/20260804230000_delete_inventory_warehouse_with_transfer.sql', import.meta.url),
  'utf8',
)
const nonBlockingConsumptionMigration = readFileSync(
  new URL('../supabase/migrations/20260811120000_prevent_inventory_from_rejecting_sales.sql', import.meta.url),
  'utf8',
)
const packagedConsumptionFixMigration = readFileSync(
  new URL('../supabase/migrations/20260811130000_fix_packaged_inventory_consumption.sql', import.meta.url),
  'utf8',
)
const consolidatedDatabase = readFileSync(
  new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url),
  'utf8',
)
const shell = readFileSync(new URL('../src/features/crm/layout/CrmSidebar.tsx', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/features/crm/routing/CrmSectionContent.tsx', import.meta.url), 'utf8')
const stockPage = readFileSync(new URL('../src/features/crm/inventory/pages/InventoryStockPage.tsx', import.meta.url), 'utf8')
const itemsPage = readFileSync(new URL('../src/features/crm/inventory/pages/InventoryItemsPage.tsx', import.meta.url), 'utf8')
const preparationsPage = readFileSync(new URL('../src/features/crm/inventory/pages/InventoryPreparationsPage.tsx', import.meta.url), 'utf8')
const warehousesPage = readFileSync(new URL('../src/features/crm/inventory/pages/InventoryWarehousesPage.tsx', import.meta.url), 'utf8')
const settingsPage = readFileSync(new URL('../src/features/crm/inventory/pages/InventorySettingsPage.tsx', import.meta.url), 'utf8')
const formatsPage = readFileSync(new URL('../src/features/crm/catalog/pages/CatalogFormatsPage.tsx', import.meta.url), 'utf8')

test('expone los seis conceptos del nuevo inventario en el submenu', () => {
  assert.deepEqual(
    inventoryNavItems.map(({ id, label }) => ({ id, label })),
    [
      { id: 'inventory-stock', label: 'Stock' },
      { id: 'inventory-items', label: 'Artículos' },
      { id: 'inventory-preparations', label: 'Elaboraciones' },
      { id: 'inventory-warehouses', label: 'Almacenes' },
      { id: 'inventory-units', label: 'Unidades' },
      { id: 'inventory-settings', label: 'Configuración' },
    ],
  )
  assert.deepEqual([...inventorySections], inventoryNavItems.map((item) => item.id))
  assert.equal(getSectionTitle('inventory-stock'), 'Stock del local')
  assert.match(shell, /label="Inventario"/)
  assert.match(shell, /inventoryNavItems/)
  assert.match(routes, /case 'inventory-stock':/)
  assert.match(routes, /case 'inventory-items':/)
  assert.match(routes, /case 'inventory-preparations':/)
  assert.match(routes, /case 'inventory-warehouses':/)
  assert.match(routes, /case 'inventory-units':/)
  assert.match(routes, /case 'inventory-settings':/)
})

test('las cantidades admiten unidades completas y consumos fraccionarios controlados', () => {
  assert.equal(parseInventoryQuantity('70', 0), 70)
  assert.equal(parseInventoryQuantity('70,5', 1), 70.5)
  assert.equal(parseInventoryQuantity('0.125', 3), 0.125)
  assert.equal(inventoryQuantityStep(0), '1')
  assert.equal(inventoryQuantityStep(3), '0.001')
  assert.throws(() => parseInventoryQuantity('-1', 2), /cantidad válida|negativa/)
  assert.throws(() => parseInventoryQuantity('0.001', 2), /máximo 2 decimales/)
  assert.equal(parsePositiveInventoryQuantity('700', 0, 'El contenido'), 700)
  assert.equal(parsePositiveInventoryQuantity('80', 0, 'El consumo'), 80)
  assert.throws(() => parsePositiveInventoryQuantity('0', 0, 'El consumo'), /mayor que cero/)
  assert.throws(() => validateInventoryDecimalPlaces(7), /entre 0 y 6/)
})

test('calcula cubatas, chupitos y mixers en la unidad fisica de stock', () => {
  assert.equal(calculateStockUnitConsumption(80, 1, 700), 0.114286)
  assert.equal(calculateStockUnitConsumption(45, 1, 700), 0.064286)
  assert.equal(calculateStockUnitConsumption(1, 1, 24), 0.041667)
  assert.equal(calculateStockUnitConsumption(1, 1, 24, 12), 0.5)
  assert.equal(calculateStockUnitConsumption(1, 1, 1), 1)
  assert.equal(calculateStockUnitConsumption(1, 2, 1), 2)
})

test('la base de datos aisla el inventario por tenant y local', () => {
  const tables = [
    'inventory_units',
    'inventory_warehouses',
    'inventory_product_settings',
    'inventory_stock_levels',
  ]
  for (const table of tables) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`))
    for (const sql of [migration, consolidatedDatabase]) {
      assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`))
    }
  }

  for (const sql of [migration, consolidatedDatabase]) {
    assert.match(sql, /quantity numeric\(18, 6\)/)
    assert.match(sql, /create or replace function public\.set_inventory_product_stock/)
  }
  assert.match(migration, /public\.user_is_tenant_admin\(p_tenant_id\)/)
  assert.match(migration, /INVENTORY_UNIT_CHANGE_WITH_STOCK/)
  assert.match(migration, /grant execute on function public\.set_inventory_product_stock/)
  assert.doesNotMatch(migration, /after insert on public\.(?:sales|tickets|ticket_lines)/i)
})

test('conserva la migracion historica de envases por producto y consumos por formato', () => {
  for (const sql of [packagingMigration, consolidatedDatabase]) {
    assert.match(sql, /content_quantity numeric\(18, 6\)/)
    assert.match(sql, /content_unit_id uuid/)
    assert.match(sql, /inventory_product_format_consumptions/)
    assert.match(sql, /p_content_quantity numeric/)
    assert.match(sql, /p_content_unit_id uuid/)
    assert.match(sql, /p_consumptions jsonb/)
    assert.match(sql, /pv\.catalog_sale_format_id = f\.id/)
    assert.match(sql, /INVENTORY_PACKAGE_CHANGE_WITH_STOCK/)
  }
  assert.match(packagingMigration, /revoke execute on function public\.set_inventory_product_stock\([\s\S]*jsonb[\s\S]*\) from authenticated/)
})

test('el consumo se configura en Formatos y no por cada producto de Stock', () => {
  assert.match(formatsPage, /inventoryConsumptionQuantity/)
  assert.match(formatsPage, /inventoryConsumptionUnitId/)
  assert.match(formatsPage, /Cantidad consumida por/)
  assert.match(formatsPage, /Unidad consumida por/)
  assert.doesNotMatch(stockPage, /formatsByProduct/)
  assert.doesNotMatch(stockPage, /Consumo de \$\{product\.name\}/)
})

test('cada linea vendida descuenta producto principal y mixer de forma atomica', () => {
  for (const sql of [automaticConsumptionMigration, consolidatedDatabase]) {
    assert.match(sql, /inventory_consumption_quantity numeric\(18, 6\)/)
    assert.match(sql, /create (?:table if not exists|table) public\.inventory_stock_movements/i)
    assert.match(sql, /create or replace function public\.consume_inventory_product/)
    assert.match(sql, /create or replace function public\.consume_ticket_line_inventory/)
    assert.match(sql, /coalesce\(new\.allocated_quantity, new\.quantity::numeric\)/)
    assert.match(sql, /v_component\.component_type = 'mixer'/)
    assert.match(sql, /\^mixer:/)
    assert.match(sql, /order by w\.sort_order, w\.name, w\.id/)
    assert.match(sql, /after insert on public\.ticket_lines/)
  }
  assert.match(automaticConsumptionMigration, /INVENTORY_INSUFFICIENT_STOCK/)
})

test('un fallo de inventario conserva la venta y revierte el consumo parcial de la linea', () => {
  for (const sql of [nonBlockingConsumptionMigration, consolidatedDatabase]) {
    assert.match(sql, /create table (?:if not exists )?public\.inventory_consumption_failures/)
    assert.match(sql, /create or replace function public\.consume_ticket_line_inventory\(\)/)
    assert.match(sql, /exception\s+when others then\s+get stacked diagnostics/i)
    assert.match(sql, /insert into public\.inventory_consumption_failures/)
    assert.match(sql, /raise warning 'INVENTORY_CONSUMPTION_FAILED/)
    assert.match(sql, /return new;\s+end;/)
  }
})

test('convierte formatos y envases compatibles antes de descontar el stock', () => {
  for (const sql of [packagedConsumptionFixMigration, consolidatedDatabase]) {
    assert.match(sql, /join public\.inventory_units format_unit/)
    assert.match(sql, /join public\.inventory_units format_base/)
    assert.match(sql, /join public\.inventory_units stock_base/)
    assert.match(sql, /v_units_compatible := v_stock_base_unit_id = v_format_base_unit_id/)
    assert.match(
      sql,
      /v_format_quantity\s+\* v_format_unit_content_quantity\s+\* p_sold_quantity[\s\S]*\/ v_stock_content_quantity/,
    )
    assert.match(sql, /v_stock_base_decimal_places = 0[\s\S]*v_format_base_decimal_places = 0/)
  }
  assert.doesNotMatch(
    packagedConsumptionFixMigration,
    /if v_content_unit_id <> v_format_unit_id/,
  )
})

test('las ventas permiten agotar el stock y continuar en negativo', () => {
  assert.match(
    negativeStockMigration,
    /drop constraint if exists inventory_stock_levels_quantity_check/,
  )
  assert.match(
    negativeStockMigration,
    /drop constraint if exists inventory_stock_movements_delta_check/,
  )

  for (const sql of [negativeStockMigration, consolidatedDatabase]) {
    assert.match(sql, /v_overflow_warehouse_id uuid/)
    assert.match(sql, /insert into public\.inventory_stock_levels[\s\S]*on conflict \(warehouse_id, product_id\) do nothing/)
    assert.match(sql, /set quantity = quantity - v_remaining/)
    assert.match(sql, /v_overflow_quantity - v_remaining/)
  }

  assert.doesNotMatch(negativeStockMigration, /INVENTORY_INSUFFICIENT_STOCK/)
  assert.doesNotMatch(consolidatedDatabase, /stock_quantity_after >= 0/)
  assert.doesNotMatch(
    consolidatedDatabase,
    /constraint inventory_stock_levels_quantity_check check \(quantity >= 0\)/,
  )
})

test('el consumo respeta almacenes habilitados por producto y la prioridad de cada TPV', () => {
  for (const sql of [warehouseRoutingMigration, consolidatedDatabase]) {
    assert.match(sql, /add column if not exists is_enabled boolean not null default true/)
    assert.match(sql, /create table if not exists public\.inventory_device_warehouses/)
    assert.match(sql, /create or replace function public\.set_inventory_device_warehouses/)
    assert.match(sql, /select t\.venue_id, t\.device_id/)
    assert.match(sql, /l\.is_enabled = true/)
    assert.match(sql, /not v_has_device_config or coalesce\(dw\.is_enabled, false\)/)
    assert.match(sql, /case when v_has_device_config then dw\.priority else w\.sort_order end/)
    assert.match(sql, /v_overflow_quantity - v_remaining/)
  }
  assert.match(warehouseRoutingMigration, /INVENTORY_DUPLICATE_PRIORITY/)
  assert.match(warehouseRoutingMigration, /grant execute on function public\.set_inventory_device_warehouses/)
})

test('el interruptor general desactiva todo consumo de stock por local', () => {
  for (const sql of [inventoryToggleMigration, consolidatedDatabase]) {
    assert.match(sql, /add column if not exists inventory_enabled boolean not null default true/)
    assert.match(sql, /create or replace function public\.set_venue_inventory_enabled/)
    assert.match(sql, /select t\.venue_id, t\.device_id, v\.inventory_enabled/)
    assert.match(sql, /if not v_inventory_enabled then\s+return new;/)
  }
  assert.ok(
    inventoryToggleMigration.indexOf('if not v_inventory_enabled then')
      < inventoryToggleMigration.indexOf('perform public.consume_inventory_product'),
  )
  assert.match(inventoryToggleMigration, /grant execute on function public\.set_venue_inventory_enabled/)
})

test('el borrado de almacenes transfiere atomicamente cualquier stock restante', () => {
  for (const sql of [warehouseDeletionMigration, consolidatedDatabase]) {
    assert.match(sql, /create or replace function public\.delete_inventory_warehouse/)
    assert.match(sql, /for update/)
    assert.match(sql, /INVENTORY_WAREHOUSE_TRANSFER_REQUIRED/)
    assert.match(sql, /insert into public\.inventory_stock_levels as destination/)
    assert.match(sql, /destination\.quantity \+ excluded\.quantity/)
    assert.match(sql, /delete from public\.inventory_warehouses/)
  }
  assert.ok(
    warehouseDeletionMigration.indexOf('insert into public.inventory_stock_levels as destination')
      < warehouseDeletionMigration.indexOf('delete from public.inventory_warehouses'),
  )
  assert.match(warehouseDeletionMigration, /grant execute on function public\.delete_inventory_warehouse/)
})

test('guarda la unidad de contenido antes de crear los niveles de stock', () => {
  const completeSettingInsert = stockUpsertRepairMigration.indexOf(
    'insert into public.inventory_product_settings',
  )
  const delegatedStockSave = stockUpsertRepairMigration.indexOf(
    'perform public.set_inventory_product_stock',
  )
  assert.ok(completeSettingInsert >= 0)
  assert.ok(delegatedStockSave > completeSettingInsert)
  assert.match(
    stockUpsertRepairMigration,
    /unit_id,\s*content_quantity,\s*content_unit_id[\s\S]*p_content_quantity::numeric\(18, 6\),\s*p_content_unit_id/,
  )
  assert.match(stockUpsertRepairMigration, /INVENTORY_PRODUCT_RECIPES_DEPRECATED/)
})

test('el RPC definitivo de stock no delega en la sobrecarga antigua', () => {
  assert.match(
    selfContainedStockMigration,
    /create or replace function public\.set_inventory_product_stock\([\s\S]*p_content_unit_id uuid,[\s\S]*p_levels jsonb/,
  )
  assert.doesNotMatch(
    selfContainedStockMigration,
    /perform public\.set_inventory_product_stock/,
  )
  assert.match(
    selfContainedStockMigration,
    /insert into public\.inventory_product_settings[\s\S]*content_unit_id[\s\S]*insert into public\.inventory_stock_levels/,
  )
})

test('la capacidad pertenece a la unidad reutilizable y no al producto', () => {
  for (const sql of [unitCapacityMigration, consolidatedDatabase]) {
    assert.match(
      sql,
      /alter table public\.inventory_units[\s\S]*content_quantity numeric\(18, 6\)[\s\S]*content_unit_id uuid/,
    )
    assert.match(sql, /create or replace function public\.validate_inventory_unit_equivalence/)
    assert.match(sql, /INVENTORY_BASE_UNIT_MUST_EQUAL_ONE/)
    assert.match(sql, /INVENTORY_CONTENT_UNIT_MUST_BE_BASE_UNIT/)
  }
  assert.match(unitCapacityMigration, /Preserve existing product-specific definitions/)
  assert.match(
    unitCapacityMigration,
    /select u\.content_quantity, u\.content_unit_id[\s\S]*from public\.inventory_units u/,
  )
  assert.match(
    unitCapacityMigration,
    /select s\.unit_id, u\.content_quantity, u\.content_unit_id[\s\S]*from public\.inventory_product_settings s[\s\S]*join public\.inventory_units u/,
  )
  assert.doesNotMatch(
    unitCapacityMigration,
    /create or replace function public\.set_inventory_product_stock\([\s\S]*p_content_quantity numeric/,
  )
})

test('las pantallas separan artículos físicos, stock y elaboraciones', () => {
  assert.match(stockPage, /snapshot\.items/)
  assert.match(stockPage, /snapshot\.warehouses\.map/)
  assert.match(stockPage, /saveInventoryItemStock/)
  assert.match(stockPage, /parseInventoryQuantity/)
  assert.match(itemsPage, /saveInventoryItem/)
  assert.match(itemsPage, /Nuevo artículo/)
  assert.match(itemsPage, /Ruta de almacenes/)
  assert.match(preparationsPage, /saveInventoryProductionRecipe/)
  assert.match(preparationsPage, /Almacén de producción/)
  assert.match(preparationsPage, /La salida solo define proporciones/)
  assert.match(warehousesPage, /Nuevo almacén/)
  assert.match(settingsPage, /Nueva unidad/)
  assert.match(settingsPage, /decimalPlaces/)
  assert.match(settingsPage, /Equivalencia de contenido/)
  assert.match(settingsPage, /Botella 70 cl/)
  assert.match(settingsPage, /contentQuantity/)
  assert.match(settingsPage, /contentUnitId/)
})

test('el listado de stock abre el detalle por artículo físico', () => {
  assert.match(stockPage, /placeholder="Buscar artículo físico"/)
  assert.match(stockPage, /aria-label="Buscar artículo"/)
  assert.match(stockPage, /onClick=\{\(\) => open\(row\.item\.id\)\}/)
  assert.match(stockPage, /<CrmModal label=\{`Stock de \$\{selected\.name\}`\}/)
  assert.match(stockPage, /Existencias por artículo y almacén/)
  assert.match(stockPage, /El stock negativo está permitido/)
  assert.match(stockPage, /<DataTable aria-label="Stock por artículo"/)
  assert.match(stockPage, /<thead>[\s\S]*<tbody>/)
  assert.match(stockPage, /<tr aria-label=\{`Editar stock de \$\{row\.item\.name\}`\}/)
  assert.doesNotMatch(stockPage, /catalog\.products/)
})

test('el listado de artículos reutiliza el modelo de tabla del proyecto', () => {
  assert.match(itemsPage, /<DataTable aria-label="Artículos de inventario"/)
  assert.match(itemsPage, /<thead>[\s\S]*<tbody>/)
  assert.match(itemsPage, />Artículo<\/th>/)
  assert.match(itemsPage, />Unidad<\/th>/)
  assert.match(itemsPage, />Stock<\/th>/)
  assert.match(itemsPage, />Ruta principal<\/th>/)
  assert.doesNotMatch(itemsPage, /sm:grid-cols-2 xl:grid-cols-3/)
})

test('cada artículo define su propia ruta de consumo independiente del TPV', () => {
  assert.match(itemsPage, /routes: Record/)
  assert.match(itemsPage, /Ruta de almacenes/)
  assert.match(itemsPage, /La ruta define de dónde se consume, no el TPV/)
  assert.match(itemsPage, /Prioridad \$\{warehouse\.name\}/)
  assert.match(warehousesPage, /Acceso operativo por TPV/)
  assert.match(warehousesPage, /saveInventoryDeviceWarehouses/)
  assert.doesNotMatch(warehousesPage, /prioridad de consumo por TPV/i)
})

test('la pagina Stock conserva el interruptor general del local', () => {
  assert.match(stockPage, /Control de inventario activo/)
  assert.match(stockPage, /setVenueInventoryEnabled/)
  assert.match(stockPage, /inventoryEnabled \? <>/)
  assert.match(stockPage, /Activa el control de inventario para gestionar existencias/)
  assert.match(shell, /inventoryEnabled \|\| item\.id === 'inventory-stock'/)
  assert.match(routes, /Control de stock desactivado/)
})

test('la pagina de almacenes confirma el borrado y solicita destino cuando queda stock', () => {
  assert.match(warehousesPage, /deleteInventoryWarehouse/)
  assert.match(warehousesPage, /loadInventoryWarehouseStockSummaries/)
  assert.match(warehousesPage, /Eliminar almacén/)
  assert.match(warehousesPage, /Almacén de destino/)
  assert.match(warehousesPage, /Selecciona dónde transferir sus cantidades antes de eliminarlo/)
})
