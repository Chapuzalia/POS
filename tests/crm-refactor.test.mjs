import assert from 'node:assert/strict'
import test from 'node:test'
import { canAccessCrm, canAccessCrmSection } from '../src/features/crm/routing/crmPermissions.ts'
import { readFileSync } from 'node:fs'
import { resolveSelectedVenueId } from '../src/features/crm/venues/services/venueSelection.ts'
import { buildProductCreationBatch, validateVariantDrafts } from '../src/features/crm/catalog/services/catalogAdminModel.ts'
import { buildSalesReportAggregates, buildSalesReportTicketTotals, buildSalesReportTotals, compareSalesReportValues } from '../src/features/crm/sales/services/salesReportModel.ts'

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

test('product form guards preserve definitive variant and atomic quick-create rules', () => {
  assert.match(validateVariantDrafts([], true), /variante/)
  assert.match(validateVariantDrafts([
    { name: 'Copa', priceCents: 1234, active: true, isDefault: true },
    { name: 'Botella', priceCents: 2500, active: true, isDefault: true },
  ], true), /única/)
  assert.equal(validateVariantDrafts([
    { name: 'Copa', priceCents: 1234, active: true, isDefault: true },
  ], true), null)
  const batch = buildProductCreationBatch({
    productId: 'p1', venueId: 'v1', type: 'standard', name: 'Copa', description: null,
    vatRate: 21, active: true, sortOrder: 0,
    variants: [{ id: 'pv1', name: 'Normal', priceCents: 1234, active: true, isDefault: true, sortOrder: 0 }],
    placement: { id: 'pl1', tabId: 't1', categoryId: 'c1', pinnedVariantId: null, sortOrder: 0 },
  })
  assert.deepEqual(batch.map((item) => item.command), ['create_product', 'create_placement'])
  assert.equal(batch[0].payload.variants[0].priceCents, 1234)
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

test('ticket report totals expose subtotal, fiscal snapshots and discounted total with the same filters', () => {
  const vodka = {
    productName: 'Vodka', categoryName: 'Licores', quantity: 1, lineTotalCents: 1210,
    fiscalSnapshot: { taxRate: 21, taxableBaseCents: 1000, taxAmountCents: 210, grossTotalCents: 1210 },
  }
  const mixer = {
    productName: 'Tónica', categoryName: 'Refrescos', quantity: 1, lineTotalCents: 200,
    fiscalSnapshot: { taxRate: 10, taxableBaseCents: 182, taxAmountCents: 18, grossTotalCents: 200 },
  }
  const paid = { id: 'paid', status: 'paid', totalCents: 1310, lines: [vodka, mixer] }
  const voidTicket = { id: 'void', status: 'void', totalCents: 1210, lines: [vodka] }

  assert.deepEqual(buildSalesReportTotals([paid, voidTicket], '', ''), {
    subtotalCents: 1098,
    taxAmountCents: 212,
    totalCents: 1310,
  })
  assert.deepEqual(buildSalesReportTotals([paid], 'vodka', ''), {
    subtotalCents: 929,
    taxAmountCents: 195,
    totalCents: 1124,
  })
  assert.deepEqual(buildSalesReportTicketTotals({ ...paid, totalCents: 1410 }), {
    subtotalCents: 1182,
    taxAmountCents: 228,
    totalCents: 1410,
  })
  assert.deepEqual(buildSalesReportTicketTotals({
    id: 'beer-ticket', status: 'paid', totalCents: 1750, lines: [{
      productName: 'Estrella Damm', categoryName: 'Cervezas', quantity: 5, lineTotalCents: 1750,
      fiscalSnapshot: { taxRate: 10, taxableBaseCents: 1591, taxAmountCents: 159, grossTotalCents: 1750 },
    }],
  }), {
    subtotalCents: 1591,
    taxAmountCents: 159,
    totalCents: 1750,
  })
})

test('venue settings persist the three fiscal ticket fields per venue', () => {
  const settings = readFileSync(new URL('../src/features/crm/venues/pages/VenueSettingsPage.tsx', import.meta.url), 'utf8')
  const service = readFileSync(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8')
  const migration = readFileSync(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
  assert.match(settings, /name="legalName"/)
  assert.match(settings, /name="taxId"/)
  assert.match(settings, /name="address"/)
  assert.match(service, /legal_name: legalName \|\| null/)
  assert.match(service, /tax_id: taxId \|\| null/)
  assert.match(service, /address: address \|\| null/)
  assert.match(migration, /create table public\.venues[\s\S]*address text,[\s\S]*legal_name text,[\s\S]*tax_id text,/i)
})
