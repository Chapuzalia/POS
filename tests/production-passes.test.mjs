import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const migration = read('../supabase/migrations/20260921120100_add_production_passes.sql')
const uuidMinFix = read('../supabase/migrations/20260921120300_fix_production_batch_uuid_min.sql')
const types = read('../src/features/production/types.ts')
const panel = read('../src/features/tables/components/RestaurantOrderPanel.tsx')
const controls = read('../src/features/production/components/ProductionControls.tsx')
const kds = read('../src/features/production/components/KdsPage.tsx')
const crm = read('../src/features/crm/production/pages/ProductionPage.tsx')

test('passes persist venue configuration and product-over-category fallback', () => {
  assert.match(migration, /create table public\.production_passes/)
  assert.match(migration, /production_product_pass_routes/)
  assert.match(migration, /production_category_pass_routes/)
  assert.match(migration, /coalesce\([\s\S]*route\.pass_id[\s\S]*route\.pass_id[\s\S]*fallback\.id/)
  assert.match(migration, /'Directo'/)
  assert.match(migration, /create trigger production_seed_default_pass_after_venue_insert/)
  assert.match(migration, /routed\.is_active where route\.tenant_id = p_tenant_id/)
})

test('menu components have independent pass assignments and component selections', () => {
  assert.match(migration, /order_line_production_passes/)
  assert.match(migration, /source_component_id/)
  assert.match(migration, /entry ->> 'componentId'/)
  assert.match(types, /componentId\?: string \| null/)
})

test('sending a pass is incremental, idempotent and revision-protected', () => {
  assert.match(migration, /where venue_id = order_row\.venue_id and request_id = p_request_id/)
  assert.match(migration, /order_row\.revision <> p_expected_revision/)
  assert.match(migration, /selected_pass_id is not null and pass_snapshot\.pass_id <> selected_pass_id then continue/)
  assert.match(migration, /unsent_quantity := greatest\(0, line_row\.quantity - greatest\(sent_quantity, line_row\.served_quantity\)\)/)
})

test('production batch pass fallback aggregates UUIDs through text', () => {
  assert.match(uuidMinFix, /create or replace function public\.send_production_batch/)
  assert.match(uuidMinFix, /min\(item\.pass_id::text\)::uuid/)
  assert.doesNotMatch(uuidMinFix, /min\(item\.pass_id\)/)
})

test('POS groups by pass and retains manual partial selection', () => {
  assert.match(panel, /productionPasses/)
  assert.match(panel, /Enviar \{pass\.name\}/)
  assert.match(panel, /lines\.map\(\(line\) => renderLine\(line, getPendingQuantity\(line\)\)\)/)
  assert.doesNotMatch(panel, /pass\.entries\.map\(\(entry\) => <div/)
  assert.match(controls, /entry\.unsentQuantity - \(line\?\.servedQuantity \?\? 0\)/)
  assert.match(controls, /componentId: entry\.componentId/)
  assert.match(controls, /entry\.unsentQuantity > 0/)
})

test('KDS displays the pass snapshot and CRM distinguishes passes from destinations', () => {
  assert.match(kds, /item\.snapshot\.passName/)
  assert.match(crm, /El destino indica dónde se prepara; el pase indica cuándo se envía/)
  assert.match(crm, /Pases por categoría/)
  assert.match(crm, /Excepciones de pase por producto/)
})
