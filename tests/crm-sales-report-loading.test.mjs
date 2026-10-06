import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileComponent, createCompiledHookRunner, nodes } from './helpers/component-harness.mjs'

const serviceSource = readFileSync(new URL('../src/features/crm/sales/services/salesReportsService.ts', import.meta.url), 'utf8')
const context = { tenantId: 'tenant-a' }
const filters = { dateFromIso: '2026-10-01T04:00:00Z', dateToIso: '2026-10-08T04:00:00Z', productQuery: '', categoryQuery: '', discountFilter: 'all' }
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture({ rpcData, rows = [], rpcHook } = {}) {
  const calls = []
  const supabase = {
    rpc(name, args) {
      const call = { name, args }
      calls.push(call)
      return {
        abortSignal(signal) { call.signal = signal; return this },
        async then(resolve, reject) {
          try {
            await rpcHook?.(call)
            return resolve({ data: rpcData ?? [{ ticket_id: 'ticket-a', total_count: 1 }], error: null })
          } catch (error) { return reject(error) }
        },
      }
    },
    from(table) {
      const call = { table, scope: {} }
      calls.push(call)
      return {
        select(columns) { call.columns = columns; return this },
        eq(column, value) { call.scope[column] = value; return this },
        in(column, ids) { call.ids = ids; return this },
        abortSignal(signal) { call.signal = signal; return this },
        then(resolve) { return Promise.resolve(resolve({ data: rows.filter(row => call.ids.includes(row.id)), error: null })) },
      }
    },
  }
  return { ...compileComponent(serviceSource, { '../../shared/services/crmServiceSupport': { requireSupabase: () => supabase } }), calls }
}

function row(id = 'ticket-a') {
  return {
    id, ticket_number: 32, local_created_at: '2026-10-05T12:00:00Z', status: 'paid',
    total_cents: 1200, subtotal_cents: 1000, discount_name: 'Promo', discount_amount_cents: 100,
    discount_value: null, sales: [{ payment_method: 'card' }],
    ticket_lines: [{ quantity: 2, allocated_quantity: 0.5, product_name: 'Café', variant_name: 'Normal', modifiers: [], ticket_line_components: [], tax_rate: 21, taxable_base_cents: 1000, tax_amount_cents: 200, line_total_cents: 1200 }],
    refund_requests: [{ id: 'refund-a', total_cents: 300, refund_lines: [], fiscal_local_records: [] }],
    fiscal_local_records: [{ record_kind: 'alta', series: 'S-2026', number: 9, issued_at: '2026-10-05', invoice_snapshot: { series: 'S-2026', number: 9, issuedAt: '2026-10-05' } }],
  }
}

test('ticket list fetches only table data and preserves scope, fiscal identity, allocated quantity and net refund totals', async () => {
  const api = fixture({ rows: [row('ticket-b'), row()], rpcData: [{ ticket_id: 'ticket-a', total_count: 2 }, { ticket_id: 'ticket-b', total_count: 2 }] })
  const page = await api.loadCrmSalesReportPage(context, 'venue-a', filters, 1, 12, 'createdAt', 'desc')
  assert.equal(api.calls.length, 2)
  assert.equal(api.calls[0].args.p_include_summary, false)
  assert.deepEqual(api.calls[1].scope, { tenant_id: 'tenant-a', venue_id: 'venue-a' })
  assert.doesNotMatch(api.calls[1].columns, /customer_snapshot|refund_lines|refund_payments|record_envelope|canonical_record|modifiers|ticket_line_components/)
  assert.deepEqual(Array.from(page.tickets, ticket => ticket.id), ['ticket-a', 'ticket-b'])
  const ticket = page.tickets[0]
  assert.equal(ticket.netTotalCents, 900)
  assert.equal(ticket.totalCents, 1200)
  assert.equal(ticket.quantity, 0.5)
  assert.equal(ticket.lineCount, 1)
  assert.equal(ticket.linkedDocumentRole, 'original')
  assert.equal(ticket.fiscal.series, 'S-2026')
  assert.equal(ticket.fiscal.number, '9')
  assert.equal(ticket.lines, undefined)
})

test('opening one ticket fetches its full historical detail, scoped to tenant and venue', async () => {
  const api = fixture({ rows: [row(), row('other-ticket')] })
  const ticket = await api.loadCrmSalesReportTicketDetail(context, 'venue-a', 'ticket-a')
  assert.equal(api.calls.length, 1)
  assert.deepEqual(api.calls[0].scope, { tenant_id: 'tenant-a', venue_id: 'venue-a' })
  assert.deepEqual(Array.from(api.calls[0].ids), ['ticket-a'])
  assert.match(api.calls[0].columns, /customer_snapshot/)
  assert.equal(ticket.lines[0].productName, 'Café')
  assert.equal(ticket.refundDocuments[0].totalCents, -300)
  assert.equal(ticket.fiscal.number, '9')
  assert.equal(await api.loadCrmSalesReportTicketDetail(context, 'venue-a', 'missing'), null)
})

test('aborting the page before IDs arrive prevents the follow-up table query', async () => {
  const controller = new AbortController()
  const api = fixture({ rpcHook: () => controller.abort() })
  await assert.rejects(api.loadCrmSalesReportPage(context, 'venue-a', filters, 1, 12, 'createdAt', 'desc', controller.signal), { name: 'AbortError' })
  assert.equal(api.calls.length, 1)
  assert.equal(api.calls[0].signal, controller.signal)
})

test('empty pages do not fetch ticket detail and large pages retain bounded URL batches', async () => {
  const empty = fixture({ rpcData: [] })
  assert.equal((await empty.loadCrmSalesReportPage(context, 'venue-a', filters, 1, 12, 'createdAt', 'desc')).tickets.length, 0)
  assert.equal(empty.calls.length, 1)
  const api = fixture({ rpcData: Array.from({ length: 60 }, (_, i) => ({ ticket_id: String(i), total_count: 60 })) })
  await api.loadCrmSalesReportPage(context, 'venue-a', filters, 1, 60, 'createdAt', 'desc')
  assert.deepEqual(api.calls.slice(1).map(call => call.ids.length), [50, 10])
})

test('suggestion requests carry the selected period, text, tenant and venue with cancellation', async () => {
  const api = fixture({ rpcData: { products: ['Café'], categories: ['Bebidas'], discounts: [] } })
  const controller = new AbortController()
  await api.loadCrmSalesReportFilterOptions(context, 'venue-a', { ...filters, productQuery: 'cafe', categoryQuery: 'beb' }, controller.signal)
  const call = api.calls[0]
  assert.equal(call.name, 'crm_sales_report_filter_suggestions')
  assert.deepEqual({ ...call.args }, { p_tenant_id: 'tenant-a', p_venue_id: 'venue-a', p_date_from: filters.dateFromIso, p_date_to: filters.dateToIso, p_product_query: 'cafe', p_category_query: 'beb' })
  assert.equal(call.signal, controller.signal)
})

test('summary requests its dedicated RPC without preparing a page or downloading ticket details', async () => {
  const api = fixture({ rpcData: [{ paid_ticket_count: '5', summary_subtotal_cents: '1800', summary_tax_amount_cents: '310', summary_total_cents: '2110' }] })
  const controller = new AbortController()
  const summary = await api.loadCrmSalesReportSummary(context, 'venue-a', filters, controller.signal)
  assert.equal(api.calls.length, 1)
  assert.equal(api.calls[0].name, 'crm_sales_report_summary')
  assert.equal(api.calls[0].args.p_tenant_id, 'tenant-a')
  assert.equal(api.calls[0].args.p_venue_id, 'venue-a')
  assert.equal(api.calls[0].args.p_date_from, filters.dateFromIso)
  assert.equal(api.calls[0].args.p_page, undefined)
  assert.equal(api.calls[0].args.p_sort_key, undefined)
  assert.equal(api.calls[0].signal, controller.signal)
  assert.deepEqual({ ...summary }, { paidTicketCount: 5, subtotalCents: 1800, taxAmountCents: 310, totalCents: 2110 })
})

test('suggestion hook cancels old periods, ignores stale results, waits for debounce and stops on close', async () => {
  const source = readFileSync(new URL('../src/features/crm/sales/hooks/useSalesReportSuggestions.ts', import.meta.url), 'utf8')
  const calls = []
  const runner = createCompiledHookRunner(source, 'useSalesReportSuggestions', {
    '../services/salesReportsService': { loadCrmSalesReportFilterOptions(ctx, venue, range, signal) { return new Promise(resolve => calls.push({ ctx, venue, range, signal, resolve })) } },
    '../../../../utils/errors': { getReadableError() {} },
  }, { AbortController })
  runner.render(context, 'venue-a', filters, false, 0)
  assert.equal(calls.length, 0)
  runner.render(context, 'venue-a', filters, true, 0)
  const changed = { ...filters, dateToIso: '2026-10-09T04:00:00Z' }
  runner.render(context, 'venue-a', changed, true, 0)
  assert.equal(calls[0].signal.aborted, true)
  calls[0].resolve({ products: ['Old'], categories: [], discounts: [] })
  await flush()
  assert.equal(runner.render(context, 'venue-a', changed, true, 0).options, null)
  calls[1].resolve({ products: ['Current'], categories: [], discounts: [] })
  await flush()
  assert.equal(runner.render(context, 'venue-a', changed, true, 0).options.products[0], 'Current')
  runner.render(context, 'venue-a', changed, false, 0)
  assert.equal(calls[1].signal.aborted, true)
  runner.unmount()
})

test('summary waits for settled filters and cancels superseded requests without reporting errors', async () => {
  const source = readFileSync(new URL('../src/features/crm/sales/hooks/useSalesReportSummary.ts', import.meta.url), 'utf8')
  const calls = [], errors = []
  const runner = createCompiledHookRunner(source, 'useSalesReportSummary', {
    '../services/salesReportsService': { loadCrmSalesReportSummary(ctx, venue, range, signal) { return new Promise((resolve, reject) => calls.push({ signal, resolve, reject })) } },
    '../../../../utils/errors': { getReadableError(error) { errors.push(error) } },
  }, { AbortController })
  runner.render(context, 'venue-a', filters, 0, false)
  assert.equal(calls.length, 0)
  runner.render(context, 'venue-a', filters, 0, true)
  runner.render(context, 'venue-a', filters, 0, false)
  assert.equal(calls[0].signal.aborted, true)
  calls[0].reject(new Error('Aborted'))
  await flush()
  assert.equal(errors.length, 0)
  runner.unmount()
})

function pageHarness(exportName = 'SalesReportsCrm') {
  const source = readFileSync(new URL('../src/features/crm/sales/pages/SalesReportsPage.tsx', import.meta.url), 'utf8')
  const timers = new Map(), calls = [], errors = []
  let timerId = 0
  const stub = () => null
  const modules = Object.fromEntries(Array.from(source.matchAll(/from '([^']+)'/g), ([, path]) => [path, new Proxy({}, { get: () => stub })]))
  const Table = () => null, Pagination = () => null
  modules['react/jsx-runtime'] = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) }
  modules['../../shared/components/CrmPagination'] = { CRM_PAGE_SIZE: 12, CrmPagination: Pagination }
  modules['../../../../components/ui/DataTable'] = { DataTable: Table }
  modules['../../../../lib/format'] = { normalizeText: value => value.toLowerCase(), formatMoney: value => String(value), formatTicketNumber: value => String(value) }
  modules['../../../../lib/operationalDay'] = compileComponent(readFileSync(new URL('../src/lib/operationalDay.ts', import.meta.url), 'utf8'), {})
  modules['../services/salesReportModel'] = { salesReportTabs: [{ id: 'tickets', label: 'Tickets' }], crmReportDateTimeFormatter: { format: () => 'Fecha' }, paymentLabels: {} }
  modules['../hooks/useSalesReportSummary'] = { useSalesReportSummary: () => ({ summary: null, error: null, isLoading: false }) }
  modules['../hooks/useSalesReportSuggestions'] = { useSalesReportSuggestions: () => ({ options: null, error: null, isLoading: false }) }
  modules['../../../../utils/errors'] = { getReadableError: error => errors.push(error) }
  modules['../services/salesReportsService'] = {
    loadCrmSalesReportPage(...args) { return new Promise(resolve => calls.push({ kind: 'page', args, resolve })) },
    loadCrmSalesReportTicketDetail(...args) { return new Promise((resolve, reject) => calls.push({ kind: 'detail', args, resolve, reject })) },
  }
  const runner = createCompiledHookRunner(source, exportName, modules, {
    AbortController, Date, Map,
    window: { setTimeout(callback) { timers.set(++timerId, callback); return timerId }, clearTimeout(id) { timers.delete(id) } },
  })
  const props = { tenantContext: context, selectedVenueId: 'venue-a', timeZone: 'Europe/Madrid', dayChangeTime: '06:00', disabled: false, runAction: async action => { try { await action() } catch (error) { errors.push(error) } } }
  return { runner, props, calls, errors, Pagination, render: () => runner.render(props), settleTimers() { for (const callback of timers.values()) callback(); timers.clear() } }
}

test('typing on page 2 waits for debounce before loading page 1 with the new filter and cancels the old page', async () => {
  const h = pageHarness()
  h.render()
  assert.equal(h.calls.length, 1)
  assert.ok(h.calls[0].args[2].dateFromIso)
  assert.ok(h.calls[0].args[2].dateToIso)
  h.calls[0].resolve({ tickets: [], totalResults: 36 })
  await flush()
  const page = h.render()
  nodes(page).find(node => node.type === h.Pagination).props.onPageChange(2)
  h.render()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].args[3], 2)
  nodes(h.render()).find(node => node.props?.['aria-controls'] === 'crm-sales-report-filters').props.onClick()
  const filtersOpen = h.render()
  nodes(filtersOpen).find(node => node.props?.placeholder === 'Buscar producto').props.onChange({ target: { value: 'cafe' } })
  h.render()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].args[7].aborted, true)
  h.settleTimers()
  h.render()
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[2].args[3], 1)
  assert.equal(h.calls[2].args[2].productQuery, 'cafe')
  h.calls[1].resolve({ tickets: [row('obsolete')], totalResults: 36 })
  await flush()
  assert.equal(h.errors.length, 0)
  h.runner.unmount()
  assert.equal(h.calls[2].args[7].aborted, true)
})

test('ticket modal shows loading and retry, and cancels detail on close', async () => {
  const h = pageHarness('SalesReportTicketDetail')
  const props = { tenantContext: context, venueId: 'venue-a', ticketId: 'ticket-a', onClose() {} }
  let tree = h.runner.render(props)
  assert.ok(nodes(tree).some(node => node.props?.role === 'status' && node.props.children === 'Cargando ticket…'))
  assert.equal(h.calls[0].args[2], 'ticket-a')
  h.calls[0].resolve(null)
  await flush()
  tree = h.runner.render(props)
  assert.ok(nodes(tree).some(node => node.props?.role === 'alert'))
  nodes(tree).find(node => node.props?.children === 'Reintentar').props.onClick()
  h.runner.render(props)
  assert.equal(h.calls.length, 2)
  h.runner.unmount()
  assert.equal(h.calls[1].args[3].aborted, true)
  h.calls[1].reject(new Error('Aborted'))
  await flush()
  assert.equal(h.errors.length, 0)
})
