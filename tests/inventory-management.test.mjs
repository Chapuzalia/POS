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
const consolidatedDatabase = readFileSync(
  new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url),
  'utf8',
)
const shell = readFileSync(new URL('../src/features/crm/layout/CrmShell.tsx', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/features/crm/routing/CrmSectionContent.tsx', import.meta.url), 'utf8')
const stockPage = readFileSync(new URL('../src/features/crm/inventory/pages/InventoryStockPage.tsx', import.meta.url), 'utf8')
const warehousesPage = readFileSync(new URL('../src/features/crm/inventory/pages/InventoryWarehousesPage.tsx', import.meta.url), 'utf8')
const settingsPage = readFileSync(new URL('../src/features/crm/inventory/pages/InventorySettingsPage.tsx', import.meta.url), 'utf8')
const formatsPage = readFileSync(new URL('../src/features/crm/catalog/pages/CatalogFormatsPage.tsx', import.meta.url), 'utf8')

test('expone Inventario como submenu con sus tres paginas', () => {
  assert.deepEqual(
    inventoryNavItems.map(({ id, label }) => ({ id, label })),
    [
      { id: 'inventory-stock', label: 'Stock' },
      { id: 'inventory-warehouses', label: 'Almacenes' },
      { id: 'inventory-settings', label: 'Configuración' },
    ],
  )
  assert.deepEqual([...inventorySections], inventoryNavItems.map((item) => item.id))
  assert.equal(getSectionTitle('inventory-stock'), 'Stock del local')
  assert.match(shell, /crm-inventory-submenu/)
  assert.match(shell, />Inventario</)
  assert.match(routes, /case 'inventory-stock':/)
  assert.match(routes, /case 'inventory-warehouses':/)
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
    assert.match(sql, /INVENTORY_INSUFFICIENT_STOCK/)
    assert.match(sql, /after insert on public\.ticket_lines/)
  }
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

test('las pantallas permiten crear configuracion y editar stock por almacen', () => {
  assert.match(stockPage, /catalog\.products\.filter\(\(product\) => product\.active\)/)
  assert.match(stockPage, /snapshot\.warehouses\.map/)
  assert.match(stockPage, /saveInventoryProductStock/)
  assert.match(stockPage, /parseInventoryQuantity/)
  assert.match(stockPage, /unit\.contentQuantity/)
  assert.match(stockPage, /unit\.contentUnitId/)
  assert.doesNotMatch(stockPage, /Contenido por unidad/)
  assert.doesNotMatch(stockPage, /draft\.contentQuantity/)
  assert.match(warehousesPage, /Nuevo almacén/)
  assert.match(settingsPage, /Nueva unidad/)
  assert.match(settingsPage, /decimalPlaces/)
  assert.match(settingsPage, /Equivalencia de contenido/)
  assert.match(settingsPage, /Botella 70 cl/)
  assert.match(settingsPage, /contentQuantity/)
  assert.match(settingsPage, /contentUnitId/)
})
