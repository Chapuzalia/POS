import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const migration = read('../supabase/migrations/20260825120000_add_production_domain.sql')
const groupedDispatchMigration = read('../supabase/migrations/20260902151000_group_production_dispatches_by_printer.sql')
const decimalQuantityMigration = read('../supabase/migrations/20260916130100_decimal_order_production_quantities.sql')
const decimalPrintContextMigration = read('../supabase/migrations/20260922120000_fix_decimal_production_print_context.sql')

test('production is opt-in at tenant and venue level', () => {
  assert.match(migration, /'production'.*false, 150/s)
  assert.match(migration, /production_enabled boolean not null default false/)
  assert.match(migration, /production_is_effective/)
  assert.match(migration, /tenant_feature_assignments/)
  assert.match(read('../src/features/platform/tenantFeatureAccess.ts'), /'production'/)
})

test('send is atomic, revision checked, incremental and idempotent', () => {
  assert.match(migration, /create or replace function public\.send_production_batch/)
  assert.match(migration, /where venue_id = order_row\.venue_id and request_id = p_request_id/)
  assert.match(migration, /order_row\.revision <> p_expected_revision/)
  assert.match(migration, /for update/)
  assert.match(migration, /unsent_quantity := greatest\(0, line_row\.quantity - sent_quantity\)/)
  assert.match(migration, /production_product_routes[\s\S]*production_category_routes/)
})

test('production state exposes only lines with a resolved KDS or printer destination as sendable', () => {
  const routingMigration = read('../supabase/migrations/20260916120000_exclude_unroutable_production_lines.sql')
  const controls = read('../src/features/production/components/ProductionControls.tsx')
  assert.match(routingMigration, /'hasProductionDestination'/)
  assert.match(routingMigration, /public\.production_resolve_destination/)
  assert.match(routingMigration, /jsonb_array_elements\(line\.components\)/)
  assert.match(controls, /productionLine\?\.hasProductionDestination && productionLine\.unsentQuantity > 0/)
})

test('production snapshots, readiness, split lineage and durable dispatches are separate domains', () => {
  assert.match(migration, /create table public\.production_items/)
  assert.match(migration, /create table public\.production_line_allocations/)
  assert.match(migration, /production_move_allocations_after_split/)
  assert.match(migration, /create table public\.production_printer_dispatches/)
  assert.match(migration, /status in \('pending', 'claimed', 'printed', 'failed', 'unknown'\)/)
  assert.doesNotMatch(read('../src/features/production/service.ts'), /mark_order_line_units_served/)
})

test('decimal production quantities reach the print context without integer overload resolution failures', () => {
  assert.match(decimalQuantityMigration, /production_items[\s\S]*numeric\(18,3\)/)
  assert.match(decimalQuantityMigration, /send_production_batch[\s\S]*selected_quantity numeric\(18,3\)/)
  assert.match(groupedDispatchMigration, /production_item_print_context\(item_row\.snapshot, item_row\.quantity\)/)
  assert.match(groupedDispatchMigration, /create or replace function public\.production_item_print_context\(p_snapshot jsonb, p_quantity integer\)/)
  assert.match(decimalPrintContextMigration, /create function public\.production_item_print_context\(p_snapshot jsonb, p_quantity numeric\)/)
  assert.match(decimalPrintContextMigration, /'quantity', p_quantity/)
  assert.match(decimalPrintContextMigration, /create function public\.production_item_lines\(p_snapshot jsonb, p_quantity numeric\)/)
})

test('physical dispatches group batch destinations by printer without changing logical routing', () => {
  assert.match(groupedDispatchMigration, /group by scoped\.tenant_id, scoped\.venue_id, scoped\.agent_id, scoped\.printer_id/)
  assert.match(groupedDispatchMigration, /destination_ids uuid\[\]/)
  assert.match(groupedDispatchMigration, /'name', upper\(destination_row\.name\)/)
  assert.match(groupedDispatchMigration, /print_render_template/)
  assert.doesNotMatch(groupedDispatchMigration, /update public\.production_items[\s\S]*set destination_id/i)
  assert.doesNotMatch(groupedDispatchMigration, /production_product_routes[\s\S]*delete/i)
})

test('two destinations on the same physical printer become one dispatch', () => {
  const dispatches = groupPhysicalTargets([
    { agentId: 'agent-a', printerId: 'epson-kitchen', destinationId: 'kitchen' },
    { agentId: 'agent-a', printerId: 'epson-kitchen', destinationId: 'grill' },
  ])
  assert.deepEqual(dispatches, [{ agentId: 'agent-a', printerId: 'epson-kitchen', destinationIds: ['kitchen', 'grill'] }])
})

test('destinations on different printers remain separate physical dispatches', () => {
  const dispatches = groupPhysicalTargets([
    { agentId: 'agent-a', printerId: 'epson-kitchen', destinationId: 'kitchen' },
    { agentId: 'agent-a', printerId: 'epson-bar', destinationId: 'bar' },
  ])
  assert.equal(dispatches.length, 2)
  assert.deepEqual(dispatches.map((dispatch) => dispatch.destinationIds), [['kitchen'], ['bar']])
})

test('KDS is a real online-only non-cash device and Realtime consumer', () => {
  const shell = read('../src/app/AppShell.tsx')
  const kds = read('../src/features/production/components/KdsPage.tsx')
  assert.match(migration, /device_mode in \('satellite', 'checkout', 'hybrid', 'kds'\)/)
  assert.match(migration, /not can_take_orders[\s\S]*active_cash_session_id is null/)
  assert.match(shell, /context\.deviceMode === 'kds'/)
  assert.match(shell, /getCachedContext\(\)\?\.deviceMode !== 'kds'/)
  assert.match(kds, /subscribeToKds/)
  assert.match(kds, /Todo listo/)
})

function groupPhysicalTargets(targets) {
  const grouped = new Map()
  for (const target of targets) {
    const key = `${target.agentId}:${target.printerId}`
    const current = grouped.get(key) ?? { agentId: target.agentId, printerId: target.printerId, destinationIds: [] }
    current.destinationIds.push(target.destinationId)
    grouped.set(key, current)
  }
  return [...grouped.values()]
}

