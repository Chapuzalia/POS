import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { normalizeText } from '../src/lib/format.ts'
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
  const requests = { pages: [], details: [], aggregates: [] }
  const client = createClient('https://crm-report-test.supabase.co', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/rpc/crm_sales_report_aggregate_page')) {
        const args = JSON.parse(init.body)
        requests.aggregates.push(args)
        return Response.json({
          items: tickets.slice((args.p_page - 1) * 12, args.p_page * 12).map(({ id }) => ({ id, label: 'Café', quantity: '2', ticketCount: '2', totalCents: '220' })),
          totalResults: count,
        })
      }
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

test('filtered tickets download only the twelve IDs returned by the requested page', async () => {
  const { service, requests, tickets } = harness(401)
  const page = await service.loadCrmSalesReportPage({ tenantId }, venueId, filters, 1, 12, 'createdAt', 'desc')
  assert.deepEqual(Array.from(page.tickets, ({ id }) => id), tickets.slice(0, 12).map(({ id }) => id))
  assert.equal(requests.pages.length, 1)
  assert.equal(requests.pages[0].p_product_query, 'cafe')
  assert.equal(requests.pages[0].p_category_query, 'bebidas')
  assert.equal(requests.details.length, 1)
  const url = requests.details[0]
  assert.equal(url.searchParams.get('id').slice(4, -1).split(',').length, 12)
  assert.equal(url.searchParams.get('tenant_id'), `eq.${tenantId}`)
  assert.equal(url.searchParams.get('venue_id'), `eq.${venueId}`)
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

test('grouped pages send all filters and sorting to the server without loading ticket detail', async () => {
  const { service, requests } = harness(401)
  const selected = { ...filters, dateFromIso: '2026-09-01T00:00:00Z', dateToIso: '2026-10-01T00:00:00Z', discountFilter: 'with' }
  for (const view of ['products', 'variants', 'categories', 'formats', 'tabs', 'mixers', 'menu-components', 'modifiers']) {
    const page = await service.loadCrmSalesReportAggregatePage({ tenantId }, venueId, selected, view, 2, 'quantity', 'asc')
    assert.equal(page.items.length, 12)
    assert.equal(page.totalResults, 401)
    assert.equal(page.items[0].quantity, 2)
    assert.equal(page.items[0].totalCents, 220)
    assert.deepEqual(requests.aggregates.at(-1), {
      p_tenant_id: tenantId, p_venue_id: venueId, p_view: view, p_page: 2, p_sort_key: 'quantity', p_sort_direction: 'asc',
      p_product_query: 'cafe', p_category_query: 'bebidas', p_date_from: selected.dateFromIso, p_date_to: selected.dateToIso, p_discount_filter: 'with',
    })
  }
  assert.equal(requests.aggregates.length, 8)
  assert.equal(requests.pages.length, 0)
  assert.equal(requests.details.length, 0)
})

test('an empty report does not request ticket detail', async () => {
  const { service, requests } = harness(0)
  const report = await service.loadCrmSalesReportPage({ tenantId }, venueId, filters, 1, 12, 'createdAt', 'desc')
  assert.equal(report.tickets.length, 0)
  assert.equal(requests.details.length, 0)
})

test('ticket detail failures reject the page instead of returning partial rows', async () => {
  const { service } = harness(201, 1)
  await assert.rejects(service.loadCrmSalesReportPage({ tenantId }, venueId, filters, 1, 12, 'createdAt', 'desc'), { message: 'detail denied' })
})
