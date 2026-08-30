import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { allocateInventoryByRoute, resolveEffectiveInventoryRecipe, scaleInventoryProduction } from '../src/features/inventory/inventoryRecipeMath.ts'

const migrationPath = new URL('../supabase/migrations/20260830120000_add_inventory_items_recipes_and_preparations.sql', import.meta.url)
const migration = await readFile(migrationPath, 'utf8')

test('consumo directo hereda el formato y permite override por variante', () => {
  const inherited = { inventoryItemId: 'brugal', quantity: null, unitId: null, usesFormatDefault: true, formatId: 'copa' }
  assert.deepEqual(resolveEffectiveInventoryRecipe({ recipes: [{ multiplier: 1, lines: [inherited] }], formatDefaults: { copa: { quantity: 80, unitId: 'ml' } } }), [{ inventoryItemId: 'brugal', quantity: 80, unitId: 'ml' }])
  assert.deepEqual(resolveEffectiveInventoryRecipe({ recipes: [{ multiplier: 1, lines: [{ inventoryItemId: 'brugal', quantity: 70, unitId: 'ml' }] }], formatDefaults: { copa: { quantity: 80, unitId: 'ml' } } }), [{ inventoryItemId: 'brugal', quantity: 70, unitId: 'ml' }])
})

test('un cambio de formato solo cambia las variantes heredadas', () => {
  const defaults = { copa: { quantity: 75, unitId: 'ml' } }
  const result = resolveEffectiveInventoryRecipe({ recipes: [
    { multiplier: 1, lines: [{ inventoryItemId: 'normal', quantity: null, unitId: null, usesFormatDefault: true, formatId: 'copa' }] },
    { multiplier: 1, lines: [{ inventoryItemId: 'reserva', quantity: 70, unitId: 'ml' }] },
  ], formatDefaults: defaults })
  assert.deepEqual(result, [{ inventoryItemId: 'normal', quantity: 75, unitId: 'ml' }, { inventoryItemId: 'reserva', quantity: 70, unitId: 'ml' }])
})

test('escandallo agrupa y multiplica por cantidad vendida', () => {
  assert.deepEqual(resolveEffectiveInventoryRecipe({ recipes: [{ multiplier: 2, lines: [
    { inventoryItemId: 'carne', quantity: 180, unitId: 'g' },
    { inventoryItemId: 'pan', quantity: 1, unitId: 'ud' },
    { inventoryItemId: 'queso', quantity: 40, unitId: 'g' },
  ] }] }), [
    { inventoryItemId: 'carne', quantity: 360, unitId: 'g' },
    { inventoryItemId: 'pan', quantity: 2, unitId: 'ud' },
    { inventoryItemId: 'queso', quantity: 80, unitId: 'g' },
  ])
})

test('modificadores aplican REMOVE antes de ADD y REMOVE ausente es no-op', () => {
  const result = resolveEffectiveInventoryRecipe({
    recipes: [{ multiplier: 1, lines: [{ inventoryItemId: 'bacon', quantity: 30, unitId: 'g' }, { inventoryItemId: 'queso', quantity: 40, unitId: 'g' }] }],
    effects: [
      { operation: 'ADD', inventoryItemId: 'bacon', quantity: 30, unitId: 'g' },
      { operation: 'REMOVE', inventoryItemId: 'bacon' },
      { operation: 'REMOVE', inventoryItemId: 'queso' },
      { operation: 'REMOVE', inventoryItemId: 'inexistente' },
    ],
  })
  assert.deepEqual(result, [{ inventoryItemId: 'bacon', quantity: 30, unitId: 'g' }])
})

test('un menú consume las recetas independientes de sus componentes', () => {
  const result = resolveEffectiveInventoryRecipe({ recipes: [
    { multiplier: 1, lines: [{ inventoryItemId: 'carne', quantity: 180, unitId: 'g' }] },
    { multiplier: 1, lines: [{ inventoryItemId: 'patata', quantity: 150, unitId: 'g' }] },
    { multiplier: 1, lines: [{ inventoryItemId: 'coca', quantity: 1, unitId: 'ud' }] },
  ] })
  assert.equal(result.length, 3)
})

test('una elaboración de 3,7 L escala una referencia de 1 L', () => {
  const result = scaleInventoryProduction(1, 3.7, [
    { inventoryItemId: 'mayonesa', quantity: 0.8, unitId: 'l' },
    { inventoryItemId: 'mostaza', quantity: 0.1, unitId: 'l' },
    { inventoryItemId: 'pepinillo', quantity: 80, unitId: 'g' },
    { inventoryItemId: 'vinagre', quantity: 20, unitId: 'ml' },
  ])
  assert.deepEqual(result.map((line) => Math.round(line.quantity * 1000) / 1000), [2.96, 0.37, 296, 74])
})

test('la ruta por artículo agota prioridades y permite negativo sin fabricar', () => {
  const result = allocateInventoryByRoute(500, [
    { warehouseId: 'cocina', priority: 1, quantity: 200 },
    { warehouseId: 'camara', priority: 2, quantity: 0 },
  ])
  assert.deepEqual(result, [{ warehouseId: 'cocina', priority: 1, quantity: -300 }, { warehouseId: 'camara', priority: 2, quantity: 0 }])
})

test('la migración sustituye la identidad product_id y mantiene el fallo no bloqueante', () => {
  assert.match(migration, /create table public\.inventory_items/i)
  assert.match(migration, /foreign key \(variant_id\)[\s\S]*references public\.product_variants\(id\)/i)
  assert.match(migration, /foreign key \(modifier_id\)[\s\S]*references public\.modifiers\(id\)/i)
  assert.doesNotMatch(migration, /references public\.(?:product_variants|modifiers)\(id, tenant_id, venue_id\)/i)
  assert.match(migration, /alter table public\.inventory_stock_levels drop column product_id/i)
  assert.match(migration, /drop table public\.inventory_product_settings/i)
  assert.match(migration, /inventory_stock_movements_v2_identity_check[\s\S]*inventory_item_id is null[\s\S]*product_id is not null/i)
  assert.doesNotMatch(migration, /alter table public\.inventory_stock_movements[\s\S]*?alter column inventory_item_id set not null/i)
  assert.match(migration, /inventory_item_warehouse_routes[\s\S]*order by route\.priority/i)
  assert.match(migration, /delete from pg_temp\.inventory_resolved_line[\s\S]*operation = 'REMOVE'[\s\S]*operation = 'ADD'/i)
  assert.match(migration, /exception[\s\S]*inventory_consumption_failures[\s\S]*return new/i)
  assert.match(migration, /'availableStock'[\s\S]*'sufficient'/i)
  assert.match(migration, /INVENTORY_UNIT_CHANGE_WITH_STOCK/i)
  assert.match(migration, /INVENTORY_PRODUCTION_SELF_REFERENCE/i)
  assert.match(migration, /on conflict \(venue_id, request_id\) do nothing/i)
  assert.match(migration, /revoke all on function public\.set_inventory_item_stock[\s\S]*from public, anon, authenticated[\s\S]*grant execute on function public\.set_inventory_item_stock/i)
  assert.doesNotMatch(migration, /record_inventory_production[\s\S]*device_id[\s\S]*production_warehouse_id\s*=\s*p_device_id/i)
})
