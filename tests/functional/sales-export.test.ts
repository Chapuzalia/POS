import { strFromU8, unzipSync } from 'fflate'
import { beforeEach, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({ calls: [] as Array<[number, number]>, requests: [] as Array<{ name: string; args: Record<string, unknown> }>, total: 0, cap: 1000 }))
vi.mock('../../src/lib/supabase.ts', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpc.requests.push({ name, args })
      return {
        range: async (from: number, to: number) => {
          rpc.calls.push([from, to])
          const end = Math.min(to + 1, from + rpc.cap, rpc.total)
          return { data: Array.from({ length: Math.max(0, end - from) }, (_, index) => ({ ticket_id: String(from + index) })), error: null }
        },
      }
    },
  },
}))

const { loadAccountingTickets } = await import('../../src/features/crm/sales/services/accountingExportService')
const { buildXls, buildXlsx } = await import('../../src/lib/spreadsheet')

const filters = { categoryQuery: '', dateFrom: '2026-10-01', dateTo: '2026-10-31', timeZone: 'Europe/Madrid', discountFilter: 'all', productQuery: '' }
const context = { tenantId: 't', venueId: 'v', userId: 'u', role: 'owner' } as never

beforeEach(() => {
  rpc.calls.length = 0
  rpc.requests.length = 0
  rpc.total = 0
  rpc.cap = 1000
})

it.each([
  ['2026-10-01', '2026-10-31', 'Europe/Madrid', '2026-09-30T22:00:00.000Z', '2026-10-31T23:00:00.000Z'],
  ['2026-12-01', '2026-12-31', 'Europe/Madrid', '2026-11-30T23:00:00.000Z', '2026-12-31T23:00:00.000Z'],
  ['2026-03-29', '2026-03-29', 'Europe/Madrid', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z'],
  ['2026-10-25', '2026-10-25', 'Europe/Madrid', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],
  ['2026-07-01', '2026-07-31', 'Atlantic/Canary', '2026-06-30T23:00:00.000Z', '2026-07-31T23:00:00.000Z'],
])('exports calendar dates %s through %s in %s', async (dateFrom, dateTo, timeZone, from, to) => {
  const selected = { ...filters, dateFrom, dateTo, timeZone, productQuery: 'cafe', categoryQuery: 'bebidas', discountFilter: 'with' }
  await loadAccountingTickets(context, selected)
  expect(rpc.requests[0]).toEqual({ name: 'get_accounting_tickets_export', args: {
    p_tenant_id: 't', p_venue_id: 'v', p_from: from, p_to: to,
    p_product_query: 'cafe', p_category_query: 'bebidas', p_discount_filter: 'with',
  } })
})

it('includes the first midnight and excludes the following month even during the same operational night', async () => {
  await loadAccountingTickets(context, filters)
  const { p_from, p_to } = rpc.requests[0].args as { p_from: string; p_to: string }
  const tickets = [
    ['before', '2026-09-30T23:59:59.999+02:00'],
    ['first-midnight', '2026-10-01T00:00:00+02:00'],
    ['first-night', '2026-10-01T02:00:00+02:00'],
    ['last-instant', '2026-10-31T23:59:59.999+01:00'],
    ['next-midnight', '2026-11-01T00:00:00+01:00'],
    ['next-night', '2026-11-01T02:00:00+01:00'],
  ]
  expect(tickets.filter(([, at]) => new Date(at) >= new Date(p_from) && new Date(at) < new Date(p_to)).map(([id]) => id))
    .toEqual(['first-midnight', 'first-night', 'last-instant'])
})

it('exports every ticket of a long range instead of stopping at the PostgREST row cap', async () => {
  rpc.calls.length = 0
  rpc.total = 2500
  rpc.cap = 1000
  const rows = await loadAccountingTickets(context, filters)
  expect(rows).toHaveLength(2500)
  expect(new Set(rows.map((row) => row.ticket_id)).size).toBe(2500)
})

it('keeps paging when the server cap is lower than the page size', async () => {
  rpc.calls.length = 0
  rpc.total = 1200
  rpc.cap = 500
  expect(await loadAccountingTickets(context, filters)).toHaveLength(1200)
})

it('builds an XLSX workbook with numeric amounts and text codes', () => {
  const files = unzipSync(buildXlsx(['Ticket', 'Total', 'Cliente'], [['000123', '12.50', 'A & <B>']]))
  expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']))
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
  expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">000123</t></is></c>')
  expect(sheet).toContain('<c r="B2"><v>12.50</v></c>')
  expect(sheet).toContain('A &amp; &lt;B&gt;')
})

it('builds an XLS (SpreadsheetML) document with escaped text', () => {
  const xls = buildXls(['Total', 'Cliente'], [['-3.10', 'Bar "Pepe"']])
  expect(xls).toContain('<Data ss:Type="Number">-3.10</Data>')
  expect(xls).toContain('Bar &quot;Pepe&quot;')
})
