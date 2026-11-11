import { beforeEach, describe, expect, it, vi } from 'vitest'

const { client, requests, rows, rpc } = vi.hoisted(() => ({
  client: { from: vi.fn(), rpc: vi.fn() },
  requests: [] as Array<{ table: string; filters: Array<[string, unknown]>; range: number[] }>,
  rows: new Map<string, unknown[]>(),
  rpc: vi.fn(),
}))
vi.mock('../../src/services/backendService', () => ({ requireSupabase: () => client }))
vi.mock('../../src/lib/supabase', () => ({ supabase: client }))
vi.mock('../../src/lib/observability.ts', () => ({ reportOperationError: vi.fn() }))

import { loadCrmSalesReportPage, loadCrmSalesReportTicketDetail } from '../../src/features/crm/sales/services/salesReportsService'
import { loadCashClosingHistory } from '../../src/features/cash-registers/service'
import type { TenantContext } from '../../src/types'

const context = { tenantId: 'tenant', venueId: 'venue' } as TenantContext
const filters = { categoryQuery: '', dateFromIso: '2026-11-01T05:00:00Z', dateToIso: '2026-11-08T05:00:00Z', discountFilter: 'all', productQuery: '' }

beforeEach(() => {
  requests.length = 0
  rows.clear()
  client.rpc.mockImplementation(rpc)
  client.from.mockImplementation((table: string) => {
    const request = { table, filters: [] as Array<[string, unknown]>, range: [] as number[] }
    requests.push(request)
    const result = () => ({ data: rows.get(table) ?? [], error: null })
    const builder = {
      select: () => builder, order: () => builder, not: () => builder, abortSignal: () => builder,
      eq: (column: string, value: unknown) => { request.filters.push([column, value]); return builder },
      in: (column: string, value: unknown) => { request.filters.push([`in:${column}`, value]); return builder },
      gte: (column: string, value: unknown) => { request.filters.push([`gte:${column}`, value]); return builder },
      lt: (column: string, value: unknown) => { request.filters.push([`lt:${column}`, value]); return builder },
      range: (from: number, to: number) => {
        request.range = [from, to]
        return Promise.resolve({ data: (rows.get(table) ?? []).slice(from, to + 1), error: null })
      },
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    }
    return builder
  })
})

describe('CRM report queries on busy tenants', () => {
  it('keeps the stored issuer for original and corrective documents without enabling QR for local-only sales', async () => {
    const invoice = { series: 'F', number: 3, issuedAt: '2026-11-10T16:15:00Z', issuerName: 'Stored issuer', issuerNif: 'B00000000', issuerAddress: 'Stored address', transmissionMode: 'local-only', qrUrl: 'https://example.com/unused-qr' }
    rows.set('tickets', [{ id: 't1', ticket_number: 7, local_created_at: invoice.issuedAt, status: 'paid', total_cents: 500,
      sales: [], ticket_lines: [], fiscal_local_records: [{ record_kind: 'alta', invoice_snapshot: invoice }],
      refund_requests: [{ id: 'r1', total_cents: 100, created_at: invoice.issuedAt, refund_method: 'cash', refund_lines: [], fiscal_local_records: [{ invoice_snapshot: { ...invoice, issuerName: 'Corrective issuer' } }] }],
    }])
    const detail = await loadCrmSalesReportTicketDetail(context, 'venue', 't1')
    expect(detail?.fiscal).toMatchObject({ issuer: { name: 'Stored issuer', nif: 'B00000000', address: 'Stored address' }, verificationUrl: null, verifactuLegend: false })
    expect(detail?.refundDocuments[0]).toMatchObject({ issuer: { name: 'Corrective issuer', nif: 'B00000000', address: 'Stored address' }, verificationUrl: null })
  })

  it('scopes the ticket list embeds to the tenant and the fiscal alta record', async () => {
    rpc.mockResolvedValue({ data: [{ ticket_id: 't1', total_count: 1 }], error: null })
    rows.set('tickets', [{ id: 't1', ticket_number: 7, local_created_at: '2026-11-02T10:00:00Z', status: 'paid', total_cents: 500, discount_amount_cents: 0,
      sales: [], ticket_lines: [], refund_requests: [], fiscal_local_records: [{ record_kind: 'alta', series: 'A', number: 3, issued_at: '2026-11-02' }] }])
    const page = await loadCrmSalesReportPage(context, 'venue', filters, 1, 12, 'createdAt', 'desc')
    expect(page.tickets[0]).toMatchObject({ id: 't1', fiscal: { series: 'A', number: '3' } })
    expect(requests[0].filters).toEqual(expect.arrayContaining([
      ['tenant_id', 'tenant'], ['venue_id', 'venue'],
      ['fiscal_local_records.tenant_id', 'tenant'], ['fiscal_local_records.record_kind', 'alta'], ['refund_requests.tenant_id', 'tenant'],
    ]))
  })

  it('scopes every embed of the ticket detail to the tenant', async () => {
    await loadCrmSalesReportTicketDetail(context, 'venue', 't1')
    expect(requests[0].filters).toEqual(expect.arrayContaining([
      ['fiscal_local_records.tenant_id', 'tenant'], ['fiscal_local_records.record_kind', 'alta'], ['refund_requests.tenant_id', 'tenant'],
      ['refund_requests.refund_payments.tenant_id', 'tenant'], ['refund_requests.fiscal_local_records.tenant_id', 'tenant'], ['sales.sale_payments.tenant_id', 'tenant'],
    ]))
  })

  it('loads Z closings for the period in small batches', async () => {
    await loadCashClosingHistory(context, null, { fromIso: '2026-10-01T04:00:00Z', toIso: '2026-11-12T05:00:00Z' })
    expect(requests).toHaveLength(1)
    expect(requests[0].range).toEqual([0, 99])
    expect(requests[0].filters).toEqual(expect.arrayContaining([['gte:closed_at', '2026-10-01T04:00:00Z'], ['lt:closed_at', '2026-11-12T05:00:00Z']]))
  })
})
