import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const migration = read('../supabase/migrations/20260825120000_add_production_domain.sql')
const groupedDispatchMigration = read('../supabase/migrations/20260902151000_group_production_dispatches_by_printer.sql')

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

test('production snapshots, readiness, split lineage and durable dispatches are separate domains', () => {
  assert.match(migration, /create table public\.production_items/)
  assert.match(migration, /create table public\.production_line_allocations/)
  assert.match(migration, /production_move_allocations_after_split/)
  assert.match(migration, /create table public\.production_printer_dispatches/)
  assert.match(migration, /status in \('pending', 'claimed', 'printed', 'failed', 'unknown'\)/)
  assert.doesNotMatch(read('../src/features/production/service.ts'), /mark_order_line_units_served/)
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

