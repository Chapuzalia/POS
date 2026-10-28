import assert from 'node:assert/strict'

import test from 'node:test'
import { hasTenantAddon, hasTenantCapability, hasTenantVenueCapability, normalizeTenantFeatures, updateTenantAddons } from '../src/features/platform/tenantFeatureAccess.ts'

test('tenant addons normalize legacy assignments and resolve commercial capabilities', () => {
  assert.deepEqual(normalizeTenantFeatures(['inventory_recipes', 'inventory', 'supplier_documents', 'supplier_document_scanning', 'discounts']), ['inventory', 'costing', 'purchases', 'document_ai', 'promotions'])
  assert.equal(hasTenantAddon({ features: [] }, 'promotions'), false)
  assert.equal(hasTenantCapability({ features: [] }, 'analytics_basic'), true)
  assert.equal(hasTenantCapability({ features: ['analytics_advanced', 'inventory', 'costing'] }, 'profitability'), true)
  assert.equal(hasTenantCapability({ features: ['document_ai', 'purchases', 'inventory'] }, 'document_ai'), true)
  assert.equal(hasTenantCapability({ features: ['reservations'] }, 'reservations'), false)
  assert.deepEqual(updateTenantAddons([], 'document_ai', true), ['inventory', 'purchases', 'document_ai'])
  assert.deepEqual(updateTenantAddons(['restaurant', 'reservations', 'production'], 'restaurant', false), [])
  assert.equal(hasTenantVenueCapability({ features: ['restaurant'], venue: { addonActivations: { restaurant: false }, inventoryEnabled: true, tablesEnabled: true, productionEnabled: false } }, 'restaurant'), false)
  assert.equal(hasTenantVenueCapability({ features: ['restaurant'], venue: { addonActivations: { restaurant: true }, inventoryEnabled: true, tablesEnabled: true, productionEnabled: false } }, 'restaurant'), true)
})
