import { normalizeText } from '../../../../lib/format'
import { requireSupabase } from '../../shared/services/crmServiceSupport'
import { type CrmSalesReportAggregate, type CrmSalesReports, type CrmSalesReportTicket, type HistoricalPaymentMethod, type TenantContext } from '../../../../types'

export type CrmSalesReportFilters = {
  categoryQuery: string
  dateFromIso: string | null
  dateToIso: string | null
  discountFilter: string
  productQuery: string
}

export type CrmSalesReportSummary = {
  paidTicketCount: number
  subtotalCents: number
  taxAmountCents: number
  totalCents: number
}

export type CrmSalesReportPage = {
  summary: CrmSalesReportSummary
  tickets: CrmSalesReportTicket[]
  totalResults: number
}

export type CrmSalesReportFilterOptions = {
  categories: string[]
  discounts: Array<{ id: string; name: string }>
  products: string[]
}

type SalesReportPageRow = {
  paid_ticket_count: number | string
  summary_subtotal_cents: number | string
  summary_tax_amount_cents: number | string
  summary_total_cents: number | string
  ticket_id: string
  total_count: number | string
}

const emptyFilters: CrmSalesReportFilters = {
  categoryQuery: '',
  dateFromIso: null,
  dateToIso: null,
  discountFilter: 'all',
  productQuery: '',
}

const ticketSelect = `
  id,
  status,
  subtotal_cents,
  discount_id,
  discount_name,
  discount_type,
  discount_value_type,
  discount_value,
  discount_rounding_increment_cents,
  discount_amount_cents,
  total_cents,
  local_created_at,
  ticket_lines (
    id,
    product_id,
    variant_id,
    product_name,
    variant_name,
    sale_format_id,
    sale_format_name_snapshot,
    category_id_snapshot,
    category_name_snapshot,
    catalog_tab_id_snapshot,
    catalog_tab_name_snapshot,
    quantity,
    allocated_quantity,
    unit_price_cents,
    modifiers,
    line_total_cents,
    tax_rate,
    taxable_base_cents,
    tax_amount_cents,
    ticket_line_components (
      id, component_type, selection_group_id, selection_group_name_snapshot,
      product_id, variant_id, product_name_snapshot, variant_name_snapshot,
      quantity, price_delta_cents, sort_order, metadata
    )
  ),
  sales (
    payment_method
  ),
  fiscal_invoices (
    id, provider, environment, invoice_type, series, number, status,
    external_uuid, external_code, qr_base64, verification_url,
    error_code, error_message, attempts, sent_at, confirmed_at
  )
`

export type SalesReportLineRow = {
  id: string
  line_total_cents: number
  tax_amount_cents: number | null
  tax_rate: number | null
  taxable_base_cents: number | null
  modifiers: Array<{
    name?: string
    priceCents?: number
    price_cents?: number
  }> | null
  product_id: string | null
  variant_id: string | null
  product_name: string
  sale_format_id: string | null
  sale_format_name_snapshot: string | null
  category_id_snapshot: string | null
  category_name_snapshot: string | null
  catalog_tab_id_snapshot: string | null
  catalog_tab_name_snapshot: string | null
  ticket_line_components: Array<{
    id: string
    component_type: 'mixer' | 'menu_component'
    selection_group_id: string | null
    selection_group_name_snapshot: string
    product_id: string | null
    variant_id: string | null
    product_name_snapshot: string
    variant_name_snapshot: string
    quantity: number
    price_delta_cents: number
    sort_order: number
    metadata: { modifiers?: Array<{ id: string; groupId: string; name: string; priceCents: number }> } | null
  }> | null
  quantity: number
  allocated_quantity: number | null
  unit_price_cents: number
  variant_name: string
}

export type SalesReportTicketRow = {
  id: string
  local_created_at: string
  sales: Array<{ payment_method: HistoricalPaymentMethod | null }> | null
  status: 'paid' | 'void'
  subtotal_cents: number
  discount_id: string | null
  discount_name: string | null
  discount_type: 'percentage' | 'fixed' | 'manual' | null
  discount_value_type: 'percentage' | 'fixed' | null
  discount_value: number | string | null
  discount_rounding_increment_cents: 5 | 10 | 50 | 100 | null
  discount_amount_cents: number | null
  ticket_lines: SalesReportLineRow[] | null
  total_cents: number
  fiscal_invoices: Array<{
    id: string
    provider: 'verifactu' | 'ticketbai'
    environment: 'test' | 'production'
    invoice_type: 'normal' | 'simplified' | 'corrective'
    series: string
    number: string
    status: 'pending' | 'accepted' | 'accepted_with_errors' | 'rejected' | 'cancelled' | 'error'
    external_uuid: string | null
    external_code: string | null
    qr_base64: string | null
    verification_url: string | null
    error_code: string | null
    error_message: string | null
    attempts: number
    sent_at: string | null
    confirmed_at: string | null
  }> | null
}

export type MutableSalesReportAggregate = CrmSalesReportAggregate & {
  ticketIds: Set<string>
}

export type NameRow = {
  id: string
  name: string
}

export function addSalesReportLine(
  report: Map<string, MutableSalesReportAggregate>,
  id: string,
  label: string,
  ticketId: string,
  line: SalesReportLineRow,
) {
  const current = report.get(id) ?? {
    id,
    label,
    quantity: 0,
    ticketCount: 0,
    ticketIds: new Set<string>(),
    totalCents: 0,
  }

  current.quantity += Number(line.allocated_quantity ?? line.quantity)
  current.totalCents += line.line_total_cents
  current.ticketIds.add(ticketId)
  current.ticketCount = current.ticketIds.size
  report.set(id, current)
}

export function finalizeSalesReport(report: Map<string, MutableSalesReportAggregate>): CrmSalesReportAggregate[] {
  return [...report.values()]
    .map((item) => ({
      id: item.id,
      label: item.label,
      quantity: item.quantity,
      ticketCount: item.ticketCount,
      totalCents: item.totalCents,
    }))
    .sort((a, b) => b.totalCents - a.totalCents || b.quantity - a.quantity || a.label.localeCompare(b.label, 'es'))
}

function addNamedAggregate(report: Map<string, MutableSalesReportAggregate>, id: string, label: string, ticketId: string, quantity: number, totalCents: number) {
  const current = report.get(id) ?? { id, label, quantity: 0, ticketCount: 0, ticketIds: new Set<string>(), totalCents: 0 }
  current.quantity += quantity
  current.totalCents += totalCents
  current.ticketIds.add(ticketId)
  current.ticketCount = current.ticketIds.size
  report.set(id, current)
}

function pageRpcArgs(
  context: TenantContext,
  venueId: string | undefined,
  filters: CrmSalesReportFilters,
  page: number,
  pageSize: number,
  sortKey: string,
  sortDirection: 'asc' | 'desc',
  includeSummary: boolean,
) {
  return {
    p_category_query: filters.categoryQuery || null,
    p_date_from: filters.dateFromIso,
    p_date_to: filters.dateToIso,
    p_discount_filter: filters.discountFilter,
    p_page: page,
    p_page_size: pageSize,
    p_include_summary: includeSummary,
    p_product_query: filters.productQuery || null,
    p_sort_direction: sortDirection,
    p_sort_key: sortKey,
    p_tenant_id: context.tenantId,
    p_venue_id: venueId || null,
  }
}

async function loadSalesReportPageRows(
  context: TenantContext,
  venueId: string | undefined,
  filters: CrmSalesReportFilters,
  page: number,
  pageSize: number,
  sortKey: string,
  sortDirection: 'asc' | 'desc',
  includeSummary = true,
) {
  const { data, error } = await requireSupabase().rpc(
    'crm_sales_report_ticket_page',
    pageRpcArgs(context, venueId, filters, page, pageSize, sortKey, sortDirection, includeSummary),
  )
  if (error) throw error
  return (data ?? []) as SalesReportPageRow[]
}

async function loadTicketRows(context: TenantContext, venueId: string | undefined, ticketIds: string[]) {
  if (!ticketIds.length) return []

  let query = requireSupabase()
    .from('tickets')
    .select(ticketSelect)
    .eq('tenant_id', context.tenantId)
    .in('id', ticketIds)

  if (venueId) query = query.eq('venue_id', venueId)

  const { data, error } = await query
  if (error) throw error

  const rowsById = new Map(((data ?? []) as SalesReportTicketRow[]).map((row) => [row.id, row]))
  return ticketIds.map((ticketId) => rowsById.get(ticketId)).filter((row): row is SalesReportTicketRow => Boolean(row))
}

function mapSalesReportTicket(ticket: SalesReportTicketRow): CrmSalesReportTicket {
  return {
    id: ticket.id,
    createdAt: ticket.local_created_at,
    lineCount: ticket.ticket_lines?.length ?? 0,
    lines: (ticket.ticket_lines ?? []).map((line) => {
      const categoryId = line.category_id_snapshot

      return {
        categoryId,
        categoryName: line.category_name_snapshot ?? 'Sin categoría',
        saleFormatId: line.sale_format_id,
        saleFormatName: line.sale_format_name_snapshot ?? line.variant_name,
        catalogTabId: line.catalog_tab_id_snapshot,
        catalogTabName: line.catalog_tab_name_snapshot ?? '',
        id: line.id,
        lineTotalCents: line.line_total_cents,
        modifiers: (line.modifiers ?? []).map((modifier) => ({
          name: modifier.name?.trim() || 'Modificador',
          priceCents: modifier.priceCents ?? modifier.price_cents ?? 0,
        })),
        productId: line.product_id,
        productName: line.product_name,
        variantId: line.variant_id,
        quantity: Number(line.allocated_quantity ?? line.quantity),
        unitPriceCents: line.unit_price_cents,
        variantName: line.variant_name,
        components: (line.ticket_line_components ?? []).map((component) => ({
          id: component.id,
          type: component.component_type,
          selectionGroupId: component.selection_group_id,
          selectionGroupName: component.selection_group_name_snapshot,
          productId: component.product_id ?? '',
          variantId: component.variant_id,
          productName: component.product_name_snapshot,
          variantName: component.variant_name_snapshot,
          quantity: component.quantity,
          priceDeltaCents: component.price_delta_cents,
          sortOrder: component.sort_order,
          modifiers: component.metadata?.modifiers ?? [],
        })),
        fiscalSnapshot: line.tax_rate === null
          || line.taxable_base_cents === null
          || line.tax_amount_cents === null
          ? null
          : {
              taxRate: Number(line.tax_rate),
              taxableBaseCents: line.taxable_base_cents,
              taxAmountCents: line.tax_amount_cents,
              grossTotalCents: line.line_total_cents,
            },
      }
    }),
    discountAmountCents: ticket.discount_amount_cents ?? 0,
    discountId: ticket.discount_id,
    discountName: ticket.discount_name,
    discountType: ticket.discount_type,
    discountValue: ticket.discount_value === null ? null : ticket.discount_value_type === 'fixed'
      ? Math.round(Number(ticket.discount_value) * 100) : Number(ticket.discount_value),
    discountValueType: ticket.discount_value_type,
    discountRoundingIncrementCents: ticket.discount_rounding_increment_cents,
    paymentMethod: ticket.sales?.[0]?.payment_method ?? null,
    quantity: (ticket.ticket_lines ?? []).reduce((total, line) => total + Number(line.allocated_quantity ?? line.quantity), 0),
    status: ticket.status,
    subtotalCents: ticket.subtotal_cents,
    totalCents: ticket.total_cents,
    fiscal: ticket.fiscal_invoices?.[0] ? {
      id: ticket.fiscal_invoices[0].id,
      provider: ticket.fiscal_invoices[0].provider,
      environment: ticket.fiscal_invoices[0].environment,
      invoiceType: ticket.fiscal_invoices[0].invoice_type,
      series: ticket.fiscal_invoices[0].series,
      number: ticket.fiscal_invoices[0].number,
      status: ticket.fiscal_invoices[0].status,
      externalUuid: ticket.fiscal_invoices[0].external_uuid,
      externalCode: ticket.fiscal_invoices[0].external_code,
      qrBase64: ticket.fiscal_invoices[0].qr_base64,
      verificationUrl: ticket.fiscal_invoices[0].verification_url,
      errorCode: ticket.fiscal_invoices[0].error_code,
      errorMessage: ticket.fiscal_invoices[0].error_message,
      attempts: ticket.fiscal_invoices[0].attempts,
      sentAt: ticket.fiscal_invoices[0].sent_at,
      confirmedAt: ticket.fiscal_invoices[0].confirmed_at,
    } : null,
  }
}

export async function loadCrmSalesReportPage(
  context: TenantContext,
  venueId: string | undefined,
  filters: CrmSalesReportFilters,
  page: number,
  pageSize: number,
  sortKey: string,
  sortDirection: 'asc' | 'desc',
): Promise<CrmSalesReportPage> {
  let pageRows = await loadSalesReportPageRows(context, venueId, filters, page, pageSize, sortKey, sortDirection)
  if (!pageRows.length && page > 1) {
    pageRows = await loadSalesReportPageRows(context, venueId, filters, 1, pageSize, sortKey, sortDirection)
  }
  const firstRow = pageRows[0]
  const ticketRows = await loadTicketRows(context, venueId, pageRows.map((row) => row.ticket_id))

  return {
    summary: {
      paidTicketCount: Number(firstRow?.paid_ticket_count ?? 0),
      subtotalCents: Number(firstRow?.summary_subtotal_cents ?? 0),
      taxAmountCents: Number(firstRow?.summary_tax_amount_cents ?? 0),
      totalCents: Number(firstRow?.summary_total_cents ?? 0),
    },
    tickets: ticketRows.map(mapSalesReportTicket),
    totalResults: Number(firstRow?.total_count ?? 0),
  }
}

export async function loadCrmSalesReportFilterOptions(context: TenantContext, venueId?: string): Promise<CrmSalesReportFilterOptions> {
  const { data, error } = await requireSupabase().rpc('crm_sales_report_filter_options', {
    p_tenant_id: context.tenantId,
    p_venue_id: venueId || null,
  })
  if (error) throw error

  const value = (data ?? {}) as Partial<CrmSalesReportFilterOptions>
  return {
    categories: Array.isArray(value.categories) ? value.categories.filter((item): item is string => typeof item === 'string') : [],
    discounts: Array.isArray(value.discounts)
      ? value.discounts.filter((item): item is { id: string; name: string } => Boolean(item && typeof item.id === 'string' && typeof item.name === 'string'))
      : [],
    products: Array.isArray(value.products) ? value.products.filter((item): item is string => typeof item === 'string') : [],
  }
}

export async function loadCrmSalesReports(
  context: TenantContext,
  venueId?: string,
  filters: CrmSalesReportFilters = emptyFilters,
): Promise<CrmSalesReports> {
  const rows: SalesReportTicketRow[] = []
  const batchSize = 200
  let page = 1

  while (true) {
    const pageRows = await loadSalesReportPageRows(context, venueId, filters, page, batchSize, 'createdAt', 'desc', false)
    const batch = await loadTicketRows(context, venueId, pageRows.map((row) => row.ticket_id))
    rows.push(...batch)
    if (pageRows.length < batchSize) break
    page += 1
  }

  const tickets = rows
  const byProduct = new Map<string, MutableSalesReportAggregate>()
  const byCategory = new Map<string, MutableSalesReportAggregate>()
  const byFormat = new Map<string, MutableSalesReportAggregate>()
  const byVariant = new Map<string, MutableSalesReportAggregate>()
  const byCatalogTab = new Map<string, MutableSalesReportAggregate>()
  const byMixer = new Map<string, MutableSalesReportAggregate>()
  const byMenuComponent = new Map<string, MutableSalesReportAggregate>()
  const byModifier = new Map<string, MutableSalesReportAggregate>()

  tickets.forEach((ticket) => {
    if (ticket.status !== 'paid') return

    ;(ticket.ticket_lines ?? []).forEach((line) => {
      const productId = line.product_id ?? `deleted:${normalizeText(line.product_name)}`
      const categoryId = line.category_id_snapshot
      const categoryName = line.category_name_snapshot
      const formatName = line.sale_format_name_snapshot?.trim() || line.variant_name.trim() || 'Sin formato'

      addSalesReportLine(byProduct, productId, line.product_name, ticket.id, line)
      addSalesReportLine(byCategory, categoryId ?? 'uncategorized', categoryName ?? 'Sin categoría', ticket.id, line)
      addSalesReportLine(byFormat, line.sale_format_id ?? (normalizeText(formatName) || 'sin-formato'), formatName, ticket.id, line)
      addSalesReportLine(byVariant, line.variant_id ?? `deleted:${normalizeText(line.variant_name)}`, line.variant_name || 'Sin variante', ticket.id, line)
      addSalesReportLine(byCatalogTab, line.catalog_tab_id_snapshot ?? 'sin-pestana', line.catalog_tab_name_snapshot ?? 'Sin pestaña histórica', ticket.id, line)
      for (const component of line.ticket_line_components ?? []) {
        const target = component.component_type === 'mixer' ? byMixer : byMenuComponent
        const lineQuantity = Number(line.allocated_quantity ?? line.quantity)
        addNamedAggregate(target, component.product_id ?? component.id, component.product_name_snapshot, ticket.id, component.quantity * lineQuantity, component.price_delta_cents * component.quantity * lineQuantity)
        for (const modifier of component.metadata?.modifiers ?? []) {
          const name = modifier.name?.trim() || 'Modificador'
          addNamedAggregate(byModifier, normalizeText(name), name, ticket.id, component.quantity * Number(line.allocated_quantity ?? line.quantity), modifier.priceCents * component.quantity * Number(line.allocated_quantity ?? line.quantity))
        }
      }
      for (const modifier of line.modifiers ?? []) {
        const name = modifier.name?.trim() || 'Modificador'
        addNamedAggregate(byModifier, normalizeText(name), name, ticket.id, Number(line.allocated_quantity ?? line.quantity), (modifier.priceCents ?? modifier.price_cents ?? 0) * Number(line.allocated_quantity ?? line.quantity))
      }
    })
  })

  return {
    byCategory: finalizeSalesReport(byCategory),
    byFormat: finalizeSalesReport(byFormat),
    byProduct: finalizeSalesReport(byProduct),
    byVariant: finalizeSalesReport(byVariant),
    byCatalogTab: finalizeSalesReport(byCatalogTab),
    byMixer: finalizeSalesReport(byMixer),
    byMenuComponent: finalizeSalesReport(byMenuComponent),
    byModifier: finalizeSalesReport(byModifier),
    tickets: tickets.map(mapSalesReportTicket),
  }
}
