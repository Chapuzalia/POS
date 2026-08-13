import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { hasTenantFeature, normalizeTenantFeatures } from '../src/features/platform/tenantFeatureAccess.ts'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('tenant feature helpers normalize assignments and preserve legacy cached sessions', () => {
  assert.deepEqual(
    normalizeTenantFeatures(['inventory', 'unknown', 'discounts', 'inventory']),
    ['discounts', 'inventory'],
  )
  assert.equal(hasTenantFeature({}, 'discounts'), true)
  assert.equal(hasTenantFeature({ features: [] }, 'discounts'), false)
  assert.equal(hasTenantFeature({ features: ['discounts'] }, 'discounts'), true)
})

test('tenant sessions load feature assignments from the database', () => {
  const service = read('../src/services/posService.ts')
  const migration = read('../supabase/migrations/20260811230000_expose_tenant_features.sql')
  assert.match(service, /rpc\('get_current_tenant_features'/)
  assert.match(service, /features,/)
  assert.match(migration, /membership\.user_id = auth\.uid\(\)/)
  assert.match(migration, /tenant_feature_assignments/)
  assert.match(migration, /feature\.is_active = true/)
})

test('CRM and POS hide or disable every optional feature surface', () => {
  const appShell = read('../src/app/AppShell.tsx')
  const posPage = read('../src/app/PosPage.tsx')
  const crmPermissions = read('../src/features/crm/routing/crmPermissions.ts')
  const crmSidebar = read('../src/features/crm/layout/CrmSidebar.tsx')
  const formats = read('../src/features/crm/catalog/pages/CatalogFormatsPage.tsx')
  const tenantState = read('../src/features/session/services/loadTenantState.ts')
  const restaurantController = read('../src/features/restaurant/hooks/useRestaurantController.ts')
  const reservationsController = read('../src/features/reservations/hooks/useReservationsController.ts')

  assert.match(appShell, /hasTenantFeature\(context, 'restaurant'\)/)
  assert.match(appShell, /hasTenantFeature\(context, 'reservations'\)/)
  assert.match(appShell, /setInterval\(\(\) => void refreshFeatures\(\), 60_000\)/)
  assert.match(appShell, /addEventListener\('focus', handleFocus\)/)
  assert.match(posPage, /allowDiscount=\{discountsEnabled\}/)
  assert.match(posPage, /discountsEnabled && quickSale\.discountModalOpen/)
  assert.match(posPage, /reservationsEnabled && props\.reservations\.isOpen/)
  assert.match(posPage, /restaurantEnabled && restaurant\.pendingPayment/)
  assert.match(tenantState, /discounts: hasTenantFeature\(context, 'discounts'\) \? posCatalog\.discounts : \[\]/)
  assert.match(restaurantController, /if \(options\.enabled\) return[\s\S]*setPosView\(\{ type: 'quick_sale' \}\)/)
  assert.match(reservationsController, /if \(options\.enabled\) return[\s\S]*setIsOpen\(false\)/)
  assert.match(crmPermissions, /access: 'multi_device'/)
  assert.match(crmPermissions, /tables: 'restaurant'/)
  assert.match(crmPermissions, /'inventory-stock': 'inventory'/)
  assert.match(crmSidebar, /allowedInventoryItems\.length/)
  assert.match(formats, /inventoryFeatureEnabled \? <div/)
})
