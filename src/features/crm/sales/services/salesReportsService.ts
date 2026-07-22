import { normalizeText } from '../../../../lib/format'
import { requireSupabase } from '../../shared/services/crmServiceSupport'
import { type CrmSalesReportAggregate, type CrmSalesReports, type HistoricalPaymentMethod, type TenantContext } from '../../../../types'

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
}

export type SalesReportProductRow = {
  category_id: string
  id: string
}

export type SalesReportCategoryRow = {
  id: string
  name: string
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

export async function loadCrmSalesReports(context: TenantContext, venueId?: string): Promise<CrmSalesReports> {
  const client = requireSupabase()
  let productsQuery = client
    .from('products')
    .select('id, category_id')
    .eq('tenant_id', context.tenantId)

  if (venueId) {
    productsQuery = productsQuery.eq('venue_id', venueId)
  }

  const ticketRowsPromise = (async () => {
    const rows: SalesReportTicketRow[] = []
    const batchSize = 1000
    let offset = 0

    while (true) {
      let ticketBatchQuery = client
        .from('tickets')
        .select(`
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
          )
        `)
        .eq('tenant_id', context.tenantId)
        .order('local_created_at', { ascending: false })
        .range(offset, offset + batchSize - 1)

      if (venueId) {
        ticketBatchQuery = ticketBatchQuery.eq('venue_id', venueId)
      }

      const { data, error } = await ticketBatchQuery
      if (error) throw error

      const batch = (data ?? []) as SalesReportTicketRow[]
      rows.push(...batch)

      if (batch.length < batchSize) break
      offset += batchSize
    }

    return rows
  })()

  const [
    ticketRows,
    { data: productRows, error: productsError },
    { data: categoryRows, error: categoriesError },
  ] = await Promise.all([
    ticketRowsPromise,
    productsQuery,
    client.from('categories').select('id, name').eq('tenant_id', context.tenantId),
  ])

  if (productsError) throw productsError
  if (categoriesError) throw categoriesError

  const tickets = ticketRows
  const categoryIdByProductId = new Map(
    ((productRows ?? []) as SalesReportProductRow[]).map((product) => [product.id, product.category_id]),
  )
  const categoryNameById = new Map(
    ((categoryRows ?? []) as SalesReportCategoryRow[]).map((category) => [category.id, category.name]),
  )
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
      const categoryId = line.category_id_snapshot ?? (line.product_id ? categoryIdByProductId.get(line.product_id) : undefined)
      const categoryName = line.category_name_snapshot ?? (categoryId ? categoryNameById.get(categoryId) : undefined)
      const formatName = line.sale_format_name_snapshot?.trim() || line.variant_name.trim() || 'Sin formato'

      addSalesReportLine(byProduct, productId, line.product_name, ticket.id, line)
      addSalesReportLine(byCategory, categoryId ?? 'uncategorized', categoryName ?? 'Sin categoría', ticket.id, line)
      addSalesReportLine(byFormat, line.sale_format_id ?? (normalizeText(formatName) || 'sin-formato'), formatName, ticket.id, line)
      addSalesReportLine(byVariant, line.variant_id ?? `deleted:${normalizeText(line.variant_name)}`, line.variant_name || 'Sin variante', ticket.id, line)
      addSalesReportLine(byCatalogTab, line.catalog_tab_id_snapshot ?? 'sin-pestana', line.catalog_tab_name_snapshot ?? 'Sin pestana historica', ticket.id, line)
      for (const component of line.ticket_line_components ?? []) {
        const target = component.component_type === 'mixer' ? byMixer : byMenuComponent
        addNamedAggregate(target, component.product_id ?? component.id, component.product_name_snapshot, ticket.id, component.quantity * Number(line.allocated_quantity ?? line.quantity), component.price_delta_cents * component.quantity)
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
    tickets: tickets.map((ticket) => ({
      id: ticket.id,
      createdAt: ticket.local_created_at,
      lineCount: ticket.ticket_lines?.length ?? 0,
      lines: (ticket.ticket_lines ?? []).map((line) => {
        const categoryId = line.category_id_snapshot ?? (line.product_id ? categoryIdByProductId.get(line.product_id) ?? null : null)

        return {
          categoryId,
          categoryName: line.category_name_snapshot ?? (categoryId ? categoryNameById.get(categoryId) ?? 'Sin categoría' : 'Sin categoría'),
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
    })),
  }
}
