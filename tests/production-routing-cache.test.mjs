import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const routing = read('../src/features/production/routing.ts')
const mapper = read('../src/features/catalog/data/mapper.ts')
const panel = read('../src/features/tables/components/RestaurantOrderPanel.tsx')
const controller = read('../src/features/restaurant/hooks/useRestaurantController.ts')
const realtime = read('../src/features/catalog/data/catalog-realtime.ts')
const migration = read('../supabase/migrations/20260921120200_add_catalog_production_routing.sql')
const unroutableLinesMigration = read('../supabase/migrations/20260923120000_filter_unroutable_production_lines.sql')
const catalogDestinationMigration = read('../supabase/migrations/20260923140000_include_production_destination_routing.sql')
const catalogAuthorizationMigration = read('../supabase/migrations/20260923150000_authorize_catalog_production_routing.sql')

test('catalog production routing remains optional for older offline caches', () => {
  assert.match(mapper, /productionRouting: productionRouting && Array\.isArray\(productionRouting\.passes\)/)
  assert.match(mapper, /: undefined/)
  assert.match(routing, /if \(!catalog \|\| !routing\) return \[\]/)
})

test('optimistic pass resolution follows product, category, then active default precedence', () => {
  assert.match(routing, /const passId = productPassId \?\? categoryPassId \?\? routing\.defaultPass\?\.id \?\? routing\.passes\[0\]\?\.id/)
  assert.match(routing, /sort\(\(left, right\) => left\.sortOrder - right\.sortOrder \|\| left\.id\.localeCompare\(right\.id\)\)/)
})

test('menu components resolve independently and use deterministic placement categories', () => {
  assert.match(routing, /line\.components\.flatMap/)
  assert.match(routing, /firstCategoryId\(catalog, component\.productId\)/)
  assert.match(routing, /placement\.productId === productId && placement\.active && placement\.categoryId/)
})

test('authoritative entries replace optimistic entries by line and component without duplicates', () => {
  assert.match(routing, /authoritativeKeys/)
  assert.match(routing, /\$\{entry\.lineId\}:\$\{entry\.componentId \?\? ''\}/)
  assert.match(panel, /mergeProductionEntries\(\s*productionState\?\.entries\s*\?\?\s*\[\]/)
  assert.match(panel, /localLines = order\.lines\.filter\(\s*\(line\)\s*=>\s*!persistedLineIds\.has\(line\.id\)/)
})

test('production state excludes entries without a destination and send keeps the general pass routable', () => {
  assert.match(unroutableLinesMigration, /public\.production_resolve_destination/)
  assert.match(unroutableLinesMigration, /'hasProductionDestination'/)
  assert.match(catalogDestinationMigration, /productDestinationRoutes/)
  assert.match(routing, /hasProductionDestination: hasProductionDestination\(routing, productId, categoryId\)/)
  assert.match(panel, /if \(!entry\.hasProductionDestination\) continue/)
  assert.match(controller, /if \(!serverEntry\?\.hasProductionDestination\) return \[\]/)
  assert.match(controller, /const routableEntries = authoritative\.entries/)
  assert.match(controller, /const effectiveSelection = selection \? \(reconciledSelection \?\? \[\]\) : routableEntries/)
})

test('send flushes and reconciles authoritative pass assignments before sending', () => {
  assert.match(controller, /const saved = await draft\.flush\(\)/)
  assert.match(controller, /const authoritative = await loadOrderProductionState\(saved\.order\.id\)/)
  assert.match(controller, /passId: serverEntry\.passId/)
  assert.match(controller, /new Map<string, ProductionSelection\[\]>/)
  assert.match(controller, /selection: reconciledPassSelection/)
})

test('catalog RPC scopes routing to tenant and venue while preserving existing execute grants', () => {
  assert.match(migration, /route\.tenant_id = v_tenant_id and route\.venue_id = p_venue_id/g)
  assert.match(migration, /pass\.tenant_id = v_tenant_id and pass\.venue_id = p_venue_id/g)
  assert.doesNotMatch(migration, /revoke\s+execute\s+on\s+function\s+public\.get_catalog/i)
  assert.match(catalogAuthorizationMigration, /auth\.role\(\) <> 'service_role'/)
  assert.match(catalogAuthorizationMigration, /not public\.user_is_tenant_admin\(v_tenant_id\)/)
  assert.match(catalogAuthorizationMigration, /not public\.user_has_venue_access\(v_tenant_id, p_venue_id\)/)
  assert.doesNotMatch(catalogAuthorizationMigration, /revoke\s+execute\s+on\s+function\s+public\.get_catalog/i)
})

test('routing changes refresh the existing catalog cache and production component allocations refresh order state', () => {
  assert.match(realtime, /'production_passes'/)
  assert.match(realtime, /'production_category_pass_routes'/)
  assert.match(realtime, /'production_product_pass_routes'/)
  assert.match(read('../src/features/production/service.ts'), /'production_component_allocations'/)
})
