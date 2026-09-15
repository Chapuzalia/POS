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

export function loadAccountingClosures(context: TenantContext, from: string, to: string) {
  return callRpc<AccountingClosureRow>('get_accounting_closures_export', {
    p_tenant_id: context.tenantId,
    p_venue_id: context.venueId,
    p_from: from,
    p_to: to,
  })
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
