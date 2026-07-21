import assert from 'node:assert/strict'
import test from 'node:test'
import { canAccessCrm, canAccessCrmSection } from '../src/features/crm/routing/crmPermissions.ts'
import { readFileSync } from 'node:fs'
import { resolveSelectedVenueId } from '../src/features/crm/venues/services/venueSelection.ts'
import { buildProductVariantInputs, getProductFormGuardError } from '../src/features/crm/catalog/forms/productFormModel.ts'
import { buildSalesReportAggregates, compareSalesReportValues } from '../src/features/crm/sales/services/salesReportModel.ts'

test('CRM permissions preserve owner/admin access and reject POS roles', () => {
  assert.equal(canAccessCrm('owner'), true)
  assert.equal(canAccessCrm('admin'), true)
  assert.equal(canAccessCrm('manager'), false)
  assert.equal(canAccessCrm('cashier'), false)
  assert.equal(canAccessCrmSection('owner', 'settings'), true)
  assert.equal(canAccessCrmSection('admin', 'reports'), true)
})

test('venue selection keeps an active venue and falls back deterministically', () => {
  const venues = [
    { id: 'closed', isActive: false },
    { id: 'main', isActive: true },
    { id: 'second', isActive: true },
  ]
  assert.equal(resolveSelectedVenueId(venues, 'second'), 'second')
  assert.equal(resolveSelectedVenueId(venues, 'closed'), 'main')
  assert.equal(resolveSelectedVenueId([], 'main'), '')
})

test('product form guards and conversion preserve prices and labels', () => {
  assert.equal(getProductFormGuardError({
    categoryId: '', name: 'Copa', priceInputs: { glass: '12,34' }, selectedSaleFormats: ['glass'], venueId: 'v1',
  }), 'missing-product-data')
  assert.equal(getProductFormGuardError({
    categoryId: 'c1', name: 'Copa', priceInputs: {}, selectedSaleFormats: ['glass'], venueId: 'v1',
  }), 'missing-sale-format-prices')
  assert.equal(getProductFormGuardError({
    categoryId: 'c1', name: ' Copa ', priceInputs: { glass: '12,34' }, selectedSaleFormats: ['glass'], venueId: 'v1',
  }), null)
  assert.deepEqual(buildProductVariantInputs(
    ['glass'],
    { glass: '12,34' },
    [{ key: 'glass', label: 'Copa premium', sortOrder: 1, isActive: true }],
  ), [{ format: 'glass', name: 'Copa premium', priceCents: 1234 }])
})

test('sales aggregates ignore cancelled tickets, allocate net totals and sort consistently', () => {
  const line = {
    productId: 'p1', productName: 'Vodka', categoryId: 'c1', categoryName: 'Licores',
    variantName: 'Copa', quantity: 2, lineTotalCents: 1000,
  }
  const paid = { id: 't1', status: 'paid', totalCents: 900, lines: [line] }
  const cancelled = { id: 't2', status: 'cancelled', totalCents: 500, lines: [line] }
  assert.deepEqual(buildSalesReportAggregates([paid, cancelled], 'products', '', ''), [{
    id: 'p1', label: 'Vodka', quantity: 2, ticketCount: 1, totalCents: 900,
  }])
  assert.ok(compareSalesReportValues('B', 'a', 'asc') > 0)
  assert.equal(compareSalesReportValues(5, 2, 'desc'), -3)
})

test('venue settings persist the three fiscal ticket fields per venue', () => {
  const settings = readFileSync(new URL('../src/features/crm/venues/pages/VenueSettingsPage.tsx', import.meta.url), 'utf8')
  const service = readFileSync(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8')
  const migration = readFileSync(new URL('../supabase/26.venue-ticket-fiscal-details-migration.sql', import.meta.url), 'utf8')
  assert.match(settings, /name="legalName"/)
  assert.match(settings, /name="taxId"/)
  assert.match(settings, /name="address"/)
  assert.match(service, /legal_name: legalName \|\| null/)
  assert.match(service, /tax_id: taxId \|\| null/)
  assert.match(service, /address: address \|\| null/)
  assert.match(migration, /alter table public\.venues/)
})
