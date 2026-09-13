import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createCompiledHookRunner, jsxRuntime, nodes } from './helpers/component-harness.mjs'
import * as model from '../src/features/crm/sales/services/salesReportModel.ts'
import * as format from '../src/lib/format.ts'

const source = readFileSync(new URL('../src/features/crm/sales/hooks/useSalesReportSummary.ts', import.meta.url), 'utf8')
const context = { tenantId: 'tenant' }
const filters = { categoryQuery: '', productQuery: '', dateFromIso: null, dateToIso: null, discountFilter: 'all' }
const totals = { totalCents: 379500, subtotalCents: 329696, taxAmountCents: 49804, paidTicketCount: 54 }
const flush = () => new Promise((resolve) => setImmediate(resolve))

function harness() {
  const pending = []
  const errors = []
  const runner = createCompiledHookRunner(source, 'useSalesReportSummary', {
    '../services/salesReportsService': { loadCrmSalesReportSummary: (...args) => new Promise((resolve, reject) => pending.push({ args, resolve, reject })) },
    '../../../../utils/errors': { getReadableError: (error) => errors.push(error) },
  })
  return { ...runner, pending, errors }
}

test('cards load on mount, keep totals on table-only renders, and reload on filters, venue or refresh', async () => {
  const h = harness()
  assert.equal(h.render(context, 'venue', filters, 0).isLoading, true)
  assert.equal(h.pending.length, 1)
  h.pending[0].resolve(totals)
  await flush()
  assert.equal(h.render(context, 'venue', filters, 0).summary, totals)
  // Paginating, sorting and changing the table view keep the summary inputs.
  h.render(context, 'venue', filters, 0)
  assert.equal(h.pending.length, 1)
  const nextFilters = { ...filters, productQuery: 'cafe' }
  const next = h.render(context, 'venue', nextFilters, 0)
  assert.equal(next.isLoading, true)
  assert.equal(next.summary, null)
  assert.equal(h.pending.length, 2)
  h.render(context, 'another-venue', nextFilters, 0)
  assert.equal(h.pending.length, 3)
  h.render(context, 'another-venue', nextFilters, 1)
  assert.equal(h.pending.length, 4)
  h.unmount()
})

test('a slow response from previous filters cannot overwrite the current cards', async () => {
  const h = harness()
  h.render(context, 'venue', filters, 0)
  const nextFilters = { ...filters, categoryQuery: 'cervezas' }
  h.render(context, 'venue', nextFilters, 0)
  const nextTotals = { ...totals, totalCents: 1500 }
  h.pending[1].resolve(nextTotals)
  await flush()
  h.pending[0].resolve(totals)
  await flush()
  assert.equal(h.render(context, 'venue', nextFilters, 0).summary, nextTotals)
  h.unmount()
})

test('summary failures stay local and retry independently; unmounted errors are ignored', async () => {
  const h = harness()
  h.render(context, 'venue', filters, 0)
  h.pending[0].reject(new Error('query failed'))
  await flush()
  const failed = h.render(context, 'venue', filters, 0)
  assert.equal(failed.isLoading, false)
  assert.equal(failed.summary, null)
  assert.match(failed.error, /No se pudo cargar el resumen/)
  assert.equal(h.errors.length, 1)
  assert.equal(h.render(context, 'venue', filters, 1).isLoading, true)
  h.pending[1].resolve(totals)
  await flush()
  assert.equal(h.render(context, 'venue', filters, 1).summary, totals)
  h.render(context, 'venue', filters, 2)
  h.unmount()
  h.pending[2].reject(new Error('late error'))
  await flush()
  assert.equal(h.errors.length, 1)
})

test('the page renders ticket results before cards complete and only refreshes cards for relevant changes', async () => {
  const pageSource = readFileSync(new URL('../src/features/crm/sales/pages/SalesReportsPage.tsx', import.meta.url), 'utf8')
  const summary = harness()
  const pages = []
  const aggregates = []
  const modules = Object.fromEntries(Array.from(pageSource.matchAll(/from '([^']+)'/g), ([, path]) => [path, new Proxy({}, { get: (_, name) => name })]))
  Object.assign(modules, {
    'react/jsx-runtime': jsxRuntime,
    '../../../../lib/format': format,
    '../services/salesReportModel': model,
    '../../shared/components/CrmPagination': { CRM_PAGE_SIZE: 12, CrmPagination: 'CrmPagination' },
    '../hooks/useSalesReportSummary': { useSalesReportSummary: (...args) => summary.render(...args) },
    '../services/salesReportsService': {
      loadCrmSalesReportPage: (...args) => new Promise((resolve) => pages.push({ args, resolve })),
      loadCrmSalesReportAggregatePage: (...args) => new Promise((resolve) => aggregates.push({ args, resolve })),
    },
  })
  const page = createCompiledHookRunner(pageSource, 'SalesReportsCrm', modules, {
    window: { setTimeout: () => 1, clearTimeout() {} },
  })
  const props = { tenantContext: context, selectedVenueId: 'venue', dayChangeTime: null, timeZone: 'Europe/Madrid', disabled: false, runAction: (action) => action() }
  let tree = page.render(props)
  assert.equal(pages.length, 1)
  assert.equal(summary.pending.length, 1)
  pages[0].resolve({ tickets: [], totalResults: 54 })
  await flush()
  tree = page.render(props)
  assert.equal(nodes(tree).find((node) => node.type?.name === 'SalesReportTicketsTable').props.isLoading, false)
  assert.equal(nodes(tree).find((node) => node.props?.['aria-label'] === 'Totales de ventas').props['aria-busy'], true)
  summary.pending[0].resolve(totals)
  await flush()
  tree = page.render(props)
  assert.equal(nodes(tree).find((node) => node.type === 'KpiCard' && node.props.label === 'Total').props.value, format.formatMoney(totals.totalCents))
  nodes(tree).find((node) => node.type === 'CrmPagination').props.onPageChange(2)
  tree = page.render(props)
  assert.equal(pages.length, 2)
  assert.equal(summary.pending.length, 1)
  assert.equal(pages[1].args[3], 2)
  nodes(tree).find((node) => node.type?.name === 'SalesReportTicketsTable').props.onSort('totalCents', 'asc')
  tree = page.render(props)
  assert.equal(pages.length, 3)
  assert.equal(summary.pending.length, 1)
  nodes(tree).find((node) => node.props?.['aria-label'] === 'Actualizar informes de ventas').props.onClick()
  tree = page.render(props)
  assert.equal(pages.length, 4)
  assert.equal(summary.pending.length, 2)
  tree = page.render({ ...props, selectedVenueId: 'another-venue' })
  assert.equal(pages.length, 5)
  assert.equal(summary.pending.length, 3)
  assert.equal(nodes(tree).find((node) => node.props?.['aria-label'] === 'Totales de ventas').props['aria-busy'], true)
  const nextProps = { ...props, selectedVenueId: 'another-venue' }
  nodes(tree).find((node) => node.props?.role === 'tab' && node.props.children === 'Por producto').props.onClick()
  tree = page.render(nextProps)
  assert.equal(aggregates.length, 1)
  assert.equal(aggregates[0].args[3], 'products')
  assert.equal(aggregates[0].args[4], 1)
  aggregates[0].resolve({ items: [{ id: 'one', label: 'Café', quantity: 2, ticketCount: 2, totalCents: 100 }], totalResults: 31 })
  await flush()
  tree = page.render(nextProps)
  assert.equal(nodes(tree).find((node) => node.type?.name === 'SalesReportAggregateTable').props.items.length, 1)
  nodes(tree).find((node) => node.type === 'CrmPagination').props.onPageChange(2)
  tree = page.render(nextProps)
  assert.equal(aggregates.length, 2)
  assert.equal(aggregates[1].args[4], 2)
  nodes(tree).find((node) => node.type?.name === 'SalesReportAggregateTable').props.onSort('label', 'asc')
  tree = page.render(nextProps)
  assert.equal(aggregates.length, 3)
  assert.equal(aggregates[2].args[4], 1)
  assert.equal(aggregates[2].args[5], 'label')
  assert.equal(summary.pending.length, 3)
  page.unmount()
  summary.unmount()
})
