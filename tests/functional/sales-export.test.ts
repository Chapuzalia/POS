import { strFromU8, unzipSync } from 'fflate'
import { expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({ calls: [] as Array<[number, number]>, total: 0, cap: 1000 }))
vi.mock('../../src/lib/supabase.ts', () => ({
  supabase: {
    rpc: () => ({
      range: async (from: number, to: number) => {
        rpc.calls.push([from, to])
        const end = Math.min(to + 1, from + rpc.cap, rpc.total)
        return { data: Array.from({ length: Math.max(0, end - from) }, (_, index) => ({ ticket_id: String(from + index) })), error: null }
      },
    }),
  },
}))

const { loadAccountingTickets } = await import('../../src/features/crm/sales/services/accountingExportService')
const { buildXls, buildXlsx } = await import('../../src/lib/spreadsheet')

const filters = { categoryQuery: '', dateFromIso: '2026-10-01T04:00:00.000Z', dateToIso: '2026-11-01T04:00:00.000Z', discountFilter: 'all', productQuery: '' }
const context = { tenantId: 't', venueId: 'v', userId: 'u', role: 'owner' } as never

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
