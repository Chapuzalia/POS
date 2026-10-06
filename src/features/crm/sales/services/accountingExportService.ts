import { supabase } from '../../../../lib/supabase'
import type { TenantContext } from '../../../../types'
import type { CrmSalesReportFilters } from './salesReportsService'

export type AccountingTax = { rate: number | string | null; baseCents: number | string; taxCents: number | string }

export type AccountingClosureRow = {
  cash_session_id: string
  opened_at: string
  closed_at: string
  venue_name: string
  cash_register_name: string
  shift_label: string
  first_ticket_number: number | string | null
  last_ticket_number: number | string | null
  first_ticket_code: string | null
  last_ticket_code: string | null
  ticket_count: number | string
  tax_breakdown: AccountingTax[]
  total_sales_cents: number | string
  cash_cents: number | string
  card_cents: number | string
  other_payment_cents: number | string
  refunds_cents: number | string
  discounts_cents: number | string
  tips_cents: number | string
}

export type AccountingTicketRow = {
  ticket_id: string
  ticket_number: number | string
  local_created_at: string
  venue_name: string
  cash_register_name: string
  status: string
  total_cents: number | string
  discount_cents: number | string
  payment_cash_cents: number | string
  payment_card_cents: number | string
  payment_other_cents: number | string
  tax_breakdown: AccountingTax[]
  is_invoice: boolean
  invoice_series: string | null
  invoice_number: string | null
  invoice_type: string | null
  customer_name: string | null
  customer_tax_id: string | null
  tip_cents: number | string
}

async function callRpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw error
  return (data ?? []) as T[]
}

type AccountingClosureSummaryRow = Omit<AccountingClosureRow, 'first_ticket_code' | 'last_ticket_code'>

type ClosureTicketRow = {
  cash_session_id: string
  ticket_number: number | string
  fiscal_local_records: Array<{
    record_kind: 'alta' | 'anulacion'
    invoice_snapshot: Record<string, unknown>
  }> | null
}

export async function loadAccountingClosures(context: TenantContext, from: string, to: string) {
  const rows = await callRpc<AccountingClosureSummaryRow>('get_accounting_closures_export', {
    p_tenant_id: context.tenantId,
    p_venue_id: context.venueId,
    p_from: from,
    p_to: to,
  })
  if (!supabase) throw new Error('Supabase no está configurado.')

  const codes = new Map<string, string>()
  // Fetch only each closure's boundary tickets, keeping GET URLs below gateway limits.
  const batchSize = 20
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const filters = rows.slice(offset, offset + batchSize).flatMap((row) => {
      const numbers = [...new Set([row.first_ticket_number, row.last_ticket_number].filter((number) => number !== null))]
      return numbers.length ? [`and(cash_session_id.eq.${row.cash_session_id},ticket_number.in.(${numbers.join(',')}))`] : []
    })
    if (!filters.length) continue

    const { data, error } = await supabase.from('tickets')
      .select('cash_session_id, ticket_number, fiscal_local_records (record_kind, invoice_snapshot)')
      .eq('tenant_id', context.tenantId)
      .eq('venue_id', context.venueId)
      .or(filters.join(','))
    if (error) throw error

    for (const ticket of (data ?? []) as unknown as ClosureTicketRow[]) {
      const invoice = ticket.fiscal_local_records?.find((record) => record.record_kind === 'alta')?.invoice_snapshot
      if (!invoice || typeof invoice.series !== 'string' || !invoice.series || typeof invoice.number !== 'number') {
        throw new Error('No se ha encontrado el código fiscal de un ticket del cierre.')
      }
      codes.set(`${ticket.cash_session_id}:${ticket.ticket_number}`, `${invoice.series}/${invoice.number}`)
    }
  }

  function ticketCode(sessionId: string, number: number | string | null) {
    if (number === null) return null
    const code = codes.get(`${sessionId}:${number}`)
    if (!code) throw new Error('No se ha encontrado el código fiscal de un ticket del cierre.')
    return code
  }

  return rows.map((row): AccountingClosureRow => ({
    ...row,
    first_ticket_code: ticketCode(row.cash_session_id, row.first_ticket_number),
    last_ticket_code: ticketCode(row.cash_session_id, row.last_ticket_number),
  }))
}

export function loadAccountingTickets(
  context: TenantContext,
  filters: CrmSalesReportFilters,
) {
  return callRpc<AccountingTicketRow>('get_accounting_tickets_export', {
    p_tenant_id: context.tenantId,
    p_venue_id: context.venueId,
    p_from: filters.dateFromIso,
    p_to: filters.dateToIso,
    p_product_query: filters.productQuery || null,
    p_category_query: filters.categoryQuery || null,
    p_discount_filter: filters.discountFilter,
  })
}
