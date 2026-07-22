import { allocateNetTotalToLines } from '../../../../lib/discounts.ts'
import { normalizeText } from '../../../../lib/format.ts'
import type { CrmSalesReportAggregate, CrmSalesReports, HistoricalPaymentMethod } from '../../../../types'

export const crmReportDateTimeFormatter = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export const paymentLabels: Record<HistoricalPaymentMethod, string> = {
  card: 'Tarjeta',
  cash: 'Efectivo',
  invitation: 'Invitacion',
  other: 'Otros',
}

export type SalesReportView = 'tickets' | 'products' | 'variants' | 'categories' | 'formats' | 'tabs' | 'mixers' | 'menu-components' | 'modifiers'
export type SalesReportAggregateView = Exclude<SalesReportView, 'tickets'>
export type SalesReportSortDirection = 'asc' | 'desc'
export type SalesReportSortKey =
  | 'average'
  | 'createdAt'
  | 'label'
  | 'paymentMethod'
  | 'quantity'
  | 'status'
  | 'ticketCount'
  | 'ticketId'
  | 'totalCents'

export type SalesReportLine = CrmSalesReports['tickets'][number]['lines'][number]

export function salesReportLineMatches(line: SalesReportLine, productQuery: string, categoryQuery: string) {
  return (!productQuery || normalizeText(line.productName).includes(productQuery))
    && (!categoryQuery || normalizeText(line.categoryName).includes(categoryQuery))
}

export function allocateTicketNetLines(ticket: CrmSalesReports['tickets'][number]) {
  const netLineTotals = allocateNetTotalToLines(ticket.lines.map((line) => line.lineTotalCents), ticket.totalCents)
  return ticket.lines.map((line, index) => ({ line, netCents: netLineTotals[index] }))
}

export function buildSalesReportAggregates(
  tickets: CrmSalesReports['tickets'],
  view: SalesReportAggregateView,
  productQuery: string,
  categoryQuery: string,
) {
  const report = new Map<string, CrmSalesReportAggregate & { ticketIds: Set<string> }>()
  tickets.forEach((ticket) => {
    if (ticket.status !== 'paid') return
    allocateTicketNetLines(ticket).forEach(({ line, netCents }) => {
      if (!salesReportLineMatches(line, productQuery, categoryQuery)) return
      if (view === 'mixers' || view === 'menu-components') {
        const componentType = view === 'mixers' ? 'mixer' : 'menu_component'
        const components = line.components ?? []
        components.filter((component) => component.type === componentType).forEach((component) => {
          const id = component.productId || component.id
          const current = report.get(id) ?? { id, label: component.productName, quantity: 0, ticketCount: 0, ticketIds: new Set<string>(), totalCents: 0 }
          current.quantity += component.quantity * line.quantity
          current.totalCents += component.priceDeltaCents * component.quantity * line.quantity
          current.ticketIds.add(ticket.id)
          current.ticketCount = current.ticketIds.size
          report.set(id, current)
        })
        return
      }
      if (view === 'modifiers') {
        line.modifiers.forEach((modifier) => {
          const id = normalizeText(modifier.name)
          const current = report.get(id) ?? { id, label: modifier.name, quantity: 0, ticketCount: 0, ticketIds: new Set<string>(), totalCents: 0 }
          current.quantity += line.quantity
          current.totalCents += modifier.priceCents * line.quantity
          current.ticketIds.add(ticket.id)
          current.ticketCount = current.ticketIds.size
          report.set(id, current)
        })
        return
      }
      const id = view === 'products'
        ? line.productId ?? `deleted:${normalizeText(line.productName)}`
        : view === 'variants'
          ? line.variantId ?? `deleted:${normalizeText(line.variantName)}`
        : view === 'categories'
          ? line.categoryId ?? 'uncategorized'
          : view === 'tabs'
            ? line.catalogTabId ?? 'sin-pestana'
            : line.saleFormatId ?? (normalizeText(line.saleFormatName ?? line.variantName) || 'sin-formato')
      const label = view === 'products'
        ? line.productName
        : view === 'variants'
          ? line.variantName || 'Sin variante'
        : view === 'categories'
          ? line.categoryName
          : view === 'tabs'
            ? line.catalogTabName || 'Sin pestana historica'
            : line.saleFormatName || line.variantName || 'Sin formato'
      const current = report.get(id) ?? {
        id,
        label,
        quantity: 0,
        ticketCount: 0,
        ticketIds: new Set<string>(),
        totalCents: 0,
      }
      current.quantity += line.quantity
      current.totalCents += netCents
      current.ticketIds.add(ticket.id)
      current.ticketCount = current.ticketIds.size
      report.set(id, current)
    })
  })
  return [...report.values()].map((item) => ({
    id: item.id,
    label: item.label,
    quantity: item.quantity,
    ticketCount: item.ticketCount,
    totalCents: item.totalCents,
  }))
}

export function compareSalesReportValues(left: number | string, right: number | string, direction: SalesReportSortDirection) {
  const comparison = typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right), 'es', { sensitivity: 'base' })
  return direction === 'asc' ? comparison : -comparison
}

export const salesReportTabs: Array<{ id: SalesReportView; label: string }> = [
  { id: 'tickets', label: 'Todos los tickets' },
  { id: 'products', label: 'Por producto' },
  { id: 'variants', label: 'Por variante' },
  { id: 'categories', label: 'Por categorÃ­a' },
  { id: 'formats', label: 'Por formato' },
  { id: 'tabs', label: 'Por pestana' },
  { id: 'mixers', label: 'Por mixer' },
  { id: 'menu-components', label: 'Componentes de menu' },
  { id: 'modifiers', label: 'Modificadores' },
]
