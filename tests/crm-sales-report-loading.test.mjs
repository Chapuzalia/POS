import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { normalizeText } from '../src/lib/format.ts'
import { buildSalesReportAggregates } from '../src/features/crm/sales/services/salesReportModel.ts'
import { compileComponent } from './helpers/component-harness.mjs'

const source = readFileSync(new URL('../src/features/crm/sales/services/salesReportsService.ts', import.meta.url), 'utf8')
const tenantId = '00000000-0000-4000-8000-000000000001'
const venueId = '00000000-0000-4000-8000-000000000002'
const filters = { categoryQuery: 'bebidas', productQuery: 'cafe', discountFilter: 'all', dateFromIso: null, dateToIso: null }

function harness(count, failDetailRequest = 0) {
  const tickets = Array.from({ length: count }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    status: 'paid', local_created_at: '2026-09-13T10:00:00Z', subtotal_cents: 110, total_cents: 110,
    discount_value: null, sales: [{ payment_method: 'cash' }], fiscal_invoices: [],
    ticket_lines: [{ id: `line-${index}`, product_id: 'coffee', product_name: 'Café', variant_id: 'large', variant_name: 'Grande',
      category_id_snapshot: 'drinks', category_name_snapshot: 'Bebidas', quantity: 1, line_total_cents: 110,
      unit_price_cents: 110, tax_rate: 10, taxable_base_cents: 100, tax_amount_cents: 10,
      modifiers: [], ticket_line_components: [],
    }],
  }))
  const requests = { pages: [], details: [] }
  const client = createClient('https://crm-report-test.supabase.co', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/rpc/crm_sales_report_ticket_page')) {
        const args = JSON.parse(init.body)
        requests.pages.push(args)
        const offset = (args.p_page - 1) * args.p_page_size
        return Response.json(tickets.slice(offset, offset + args.p_page_size).map(({ id }) => ({
          ticket_id: id, total_count: count, paid_ticket_count: count,
          summary_subtotal_cents: count * 100, summary_tax_amount_cents: count * 10, summary_total_cents: count * 110,
        })))
      }
      assert.equal(url.pathname, '/rest/v1/tickets')
      requests.details.push(url)
      // Model a gateway rejecting an oversized request target before CORS headers
      // reach the browser, which surfaces as a transport error despite being online.
      if (url.href.length > 8192) throw new TypeError('Load failed')
      if (requests.details.length === failDetailRequest) return Response.json({ message: 'detail denied', code: '42501' }, { status: 403 })
      const ids = url.searchParams.get('id').slice(4, -1).split(',')
      return Response.json(tickets.filter(({ id }) => ids.includes(id)).reverse())
    } },
  })
  const service = compileComponent(source, {
    '../../../../lib/format': { normalizeText },
    '../../shared/services/crmServiceSupport': { requireSupabase: () => client },
  })
  return { service, requests, tickets }
}

test('grouped sales reports load multiple pages without oversized URLs or missing tickets', async () => {
  const { service, requests, tickets } = harness(401)
  const report = await service.loadCrmSalesReports({ tenantId }, venueId, filters)
  assert.deepEqual(Array.from(report.tickets, ({ id }) => id), tickets.map(({ id }) => id))
  for (const view of ['products', 'variants', 'categories']) {
    const groups = buildSalesReportAggregates(report.tickets, view, filters.productQuery, filters.categoryQuery)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].ticketCount, 401)
    assert.equal(groups[0].quantity, 401)
    assert.equal(groups[0].totalCents, 44110)
  }
  assert.ok(requests.pages.length > 1)
  for (const args of requests.pages) {
    assert.equal(args.p_product_query, 'cafe')
    assert.equal(args.p_category_query, 'bebidas')
    assert.equal(args.p_tenant_id, tenantId)
    assert.equal(args.p_venue_id, venueId)
  }
  for (const url of requests.details) {
    assert.ok(url.href.length < 8192)
    assert.equal(url.searchParams.get('tenant_id'), `eq.${tenantId}`)
    assert.equal(url.searchParams.get('venue_id'), `eq.${venueId}`)
  }
})

test('ticket pages preserve server ordering without calculating card totals', async () => {
  const { service, requests, tickets } = harness(25)
  const page = await service.loadCrmSalesReportPage({ tenantId }, venueId, filters, 2, 12, 'createdAt', 'desc')
  assert.deepEqual(Array.from(page.tickets, ({ id }) => id), tickets.slice(12, 24).map(({ id }) => id))
  assert.equal(page.totalResults, 25)
  assert.equal('summary' in page, false)
  assert.equal(requests.pages[0].p_include_summary, false)
  assert.equal(requests.details.length, 1)
})

test('cards request totals for the entire filtered set without downloading ticket detail', async () => {
  const { service, requests } = harness(401)
  const summary = await service.loadCrmSalesReportSummary({ tenantId }, venueId, filters)
  assert.equal(summary.paidTicketCount, 401)
  assert.equal(summary.totalCents, 44110)
  assert.equal(summary.subtotalCents, 40100)
  assert.equal(summary.taxAmountCents, 4010)
  assert.equal(requests.details.length, 0)
  assert.equal(requests.pages.length, 1)
  assert.equal(requests.pages[0].p_include_summary, true)
  assert.equal(requests.pages[0].p_page_size, 1)
  assert.equal(requests.pages[0].p_product_query, filters.productQuery)
  assert.equal(requests.pages[0].p_category_query, filters.categoryQuery)
})

test('cards return zero totals when filters have no matches', async () => {
  const { service, requests } = harness(0)
  const summary = await service.loadCrmSalesReportSummary({ tenantId }, venueId, filters)
  assert.equal(summary.paidTicketCount, 0)
  assert.equal(summary.totalCents, 0)
  assert.equal(requests.details.length, 0)
})

test('an empty report does not request ticket detail', async () => {
  const { service, requests } = harness(0)
  const report = await service.loadCrmSalesReports({ tenantId }, venueId, filters)
  assert.equal(report.tickets.length, 0)
  assert.equal(requests.details.length, 0)
})

test('failure in a later detail batch rejects the report instead of returning partial totals', async () => {
  const { service } = harness(201, 2)
  await assert.rejects(service.loadCrmSalesReports({ tenantId }, venueId, filters), { message: 'detail denied' })
})
