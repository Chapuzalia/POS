import test from 'node:test'
import assert from 'node:assert/strict'
import { accountDefinitions, buildRows, demoId, scenarios, seedSql, target } from '../scripts/staging-demo-data.mjs'
import { parseArgs } from '../scripts/seed-staging-demos.mjs'

const accounts = accountDefinitions().map(a => ({ ...a, id: demoId(`test-auth/${a.key}`) }))
const rows = buildRows(accounts)

test('demo runner rejects production, arbitrary destinations and missing explicit mode', () => {
  for (const args of [[], ['--apply'], ['--apply', 'dbdtluvsdqycxl5tecuwljie'], ['--apply', 'fyjgmysthygtwoinwnow'], ['--apply', target.project, '--host', 'production'], ['--reset', target.project]]) {
    assert.throws(() => parseArgs(args), /Destino fijo/)
  }
  assert.equal(parseArgs(['--check', target.project]), '--check')
  assert.equal(parseArgs(['--apply', target.project]), '--apply')
  assert.equal(parseArgs(['--rotate-passwords', target.project]), '--rotate-passwords')
  assert.throws(() => parseArgs(['--rotate-passwords', 'dbdtluvsdqycxl5tecuwljie']), /Destino fijo/)
})

test('three independent demos preserve all tenant/venue references', () => {
  assert.equal(new Set(scenarios.map(s => s.id)).size, 3)
  const tenants = new Map(rows.filter(r => r.table === 'tenants').map(r => [r.row.id, r.row]))
  const venues = new Map(rows.filter(r => r.table === 'venues').map(r => [r.row.id, r.row]))
  const ids = new Map(rows.filter(r => r.row.id).map(r => [`${r.table}/${r.row.id}`, r.row]))
  assert.equal(venues.size, 5)
  for (const { row } of rows) {
    if (row.tenant_id) assert.ok(tenants.has(row.tenant_id))
    if (row.venue_id) assert.equal(venues.get(row.venue_id).tenant_id, row.tenant_id)
    for (const [key, table] of Object.entries({ product_id: 'products', variant_id: 'product_variants', category_id: 'categories', tab_id: 'catalog_tabs', area_id: 'dining_areas', destination_id: 'production_destinations', production_destination_id: 'production_destinations', group_id: 'modifier_groups', inventory_item_id: 'inventory_items', warehouse_id: 'inventory_warehouses', recipe_id: 'inventory_recipes', base_unit_id: 'inventory_units', content_unit_id: 'inventory_units', unit_id: 'inventory_units' })) {
      if (!row[key]) continue
      const related = ids.get(`${table}/${row[key]}`)
      assert.ok(related, `Missing ${table}/${row[key]}`)
      assert.equal(related.tenant_id, row.tenant_id)
      assert.equal(related.venue_id, row.venue_id)
    }
  }
})

test('bar has no tables, restaurant has twelve, group has three equipped venues', () => {
  const by = (table, key) => rows.filter(r => r.table === table && r.row.tenant_id === demoId(key))
  assert.equal(by('restaurant_tables', 'bar').length, 0)
  assert.equal(by('devices', 'bar').length, 1)
  assert.equal(by('restaurant_tables', 'restaurante').length, 12)
  assert.equal(by('restaurant_tables', 'grupo').length, 36)
  assert.equal(by('production_destinations', 'grupo').length, 3)
  assert.equal(by('inventory_warehouses', 'grupo').length, 3)
  assert.equal(by('inventory_items', 'grupo').length, 12)
  assert.equal(by('suppliers', 'grupo').length, 6)
  assert.equal(by('manager_venue_assignments', 'grupo').length, 1)
})

test('no demo enables Cashlogy or fiscal services, and all prices use integer cents', () => {
  for (const scenario of scenarios) assert.ok(!scenario.features.some(f => /cashlogy|verifact|ticketbai/i.test(f)))
  for (const { table, row } of rows) {
    if (table === 'venue_addon_assignments' && row.addon_key === 'cashlogy') assert.equal(row.is_enabled, false)
    if (table === 'fiscal_integration_settings') {
      assert.equal(row.enabled, false)
      assert.equal(row.automatic_submission, false)
      assert.equal(row.webhooks_enabled, false)
    }
    assert.ok(!['tenant_verifactu_integrations', 'fiscal_pos_bridge_settings', 'sales', 'tickets', 'cash_sessions'].includes(table))
    if (table === 'product_variants') assert.ok(Number.isSafeInteger(row.price_cents) && row.price_cents > 0)
  }
})

test('device users each have exactly one assignment and non-cash devices cannot take payments', () => {
  assert.equal(accounts.length, 17)
  const devices = rows.filter(r => r.table === 'devices').map(r => r.row)
  assert.equal(devices.length, 13)
  assert.equal(new Set(accounts.map(a => a.email)).size, accounts.length)
  for (const account of accounts.filter(a => a.deviceId)) {
    const assignments = rows.filter(r => r.table === 'device_user_assignments' && r.row.user_id === account.id)
    assert.equal(assignments.length, 1)
    assert.equal(assignments[0].row.device_id, account.deviceId)
  }
  for (const device of devices.filter(d => ['satellite', 'kds'].includes(d.device_mode))) {
    for (const key of ['can_take_payments', 'can_open_cash_session', 'can_close_cash_session', 'can_manage_cash']) assert.equal(device[key], false)
    if (device.device_mode === 'kds') {
      assert.equal(device.can_take_orders, false)
      assert.ok(device.production_destination_id)
    }
  }
})

test('seed is repeatable without resetting edited prices, stock or passwords', () => {
  const sql = seedSql(accounts)
  assert.ok(sql.startsWith('begin;'))
  assert.ok(sql.endsWith('commit;'))
  assert.ok(seedSql(accounts, { rollback: true }).endsWith('rollback;'))
  assert.match(sql, /pg_advisory_xact_lock/)
  assert.match(sql, /STAGING_DEMO_TARGET_REQUIRED/)
  assert.doesNotMatch(sql, /auth\.users|truncate|drop table|password|do update/i)
  assert.doesNotMatch(sql, /update public\.(inventory_stock_levels|products|product_variants)/)
  assert.throws(() => seedSql(accountDefinitions()), /Falta el ID de Auth/)
})
