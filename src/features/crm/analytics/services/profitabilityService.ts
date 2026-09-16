import { requireSupabase } from '../../shared/services/crmServiceSupport'
import type { CrmStatsPeriod, TenantContext } from '../../../../types'

export type ProfitabilityMetricRow = {
  dimension: 'product' | 'category'
  id: string
  label: string
  units: number
  net_sales_cents: number
  gross_sales_cents: number
  discounts_cents: number
  theoretical_cost_cents: number
  known_net_sales_cents: number
  known_gross_sales_cents: number
  known_lines: number
  line_count: number
}

export type ProfitabilityTimelinePoint = {
  day: string
  net_sales_cents: number
  gross_sales_cents: number
  theoretical_cost_cents: number
  known_net_sales_cents: number
  known_gross_sales_cents: number
}

export type ProfitabilityReport = {
  summary: Omit<ProfitabilityMetricRow, 'dimension' | 'id' | 'label' | 'units'>
  products: ProfitabilityMetricRow[]
  categories: ProfitabilityMetricRow[]
  timeline: ProfitabilityTimelinePoint[]
}

export type CurrentProductProfitability = {
  variantId: string
  variantName: string
  priceCents: number
  costCents: number | null
  costKnown: boolean
  components: Array<{
    inventoryItemId: string
    name?: string
    quantity: number
    unitId: string
    unitCost: number | null
    cost: number
    known: boolean
    components?: unknown[]
  }>
}

function parseReport(value: unknown): ProfitabilityReport {
  const source = value as Partial<ProfitabilityReport>
  return {
    summary: (source.summary ?? {}) as ProfitabilityReport['summary'],
    products: (source.products ?? []) as ProfitabilityMetricRow[],
    categories: (source.categories ?? []) as ProfitabilityMetricRow[],
    timeline: (source.timeline ?? []) as ProfitabilityTimelinePoint[],
  }
}

export async function loadProfitabilityReport(
  context: Pick<TenantContext, 'tenantId'>,
  venueId: string,
  range: { startIso: string; endIso: string },
  filters: { categoryId?: string; productId?: string } = {},
) {
  void context
  const { data, error } = await requireSupabase().rpc('crm_profitability_report', {
    p_venue_id: venueId,
    p_start_at: range.startIso,
    p_end_at: range.endIso,
    p_category_id: filters.categoryId || null,
    p_product_id: filters.productId || null,
  })
  if (error) throw error
  return parseReport(data)
}

export async function loadCurrentProductProfitability(
  context: Pick<TenantContext, 'tenantId'>,
  venueId: string,
  productId: string,
) {
  void context
  const { data, error } = await requireSupabase().rpc('crm_current_product_profitability', {
    p_venue_id: venueId,
    p_product_id: productId,
  })
  if (error) throw error
  return data as CurrentProductProfitability | null
}

export function profitabilityRange(period: CrmStatsPeriod, timeZone: string) {
  const start = new Date(`${period.startDate}T00:00:00`)
  const end = new Date(`${period.endDate}T00:00:00`)
  end.setDate(end.getDate() + 1)
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const toIso = (value: Date) => `${formatter.format(value).replaceAll('/', '-')}T00:00:00.000Z`
  return { startIso: toIso(start), endIso: toIso(end) }
}
