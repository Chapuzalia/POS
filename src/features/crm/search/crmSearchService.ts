import { Boxes, LayoutGrid, ListChecks, Puzzle, ReceiptText, Ruler, type LucideIcon } from 'lucide-react'
import type { CatalogData } from '../../catalog/domain/types.ts'
import type { CrmVenue, TenantContext } from '../../../types'
import { formatMoney } from '../../../lib/format'
import type { OperationalDayConfig } from '../../../lib/operationalDay'
import { catalogAdminService } from '../catalog/services/catalogAdminService.ts'
import { getCashClosingDay, isImportedCashClosing, type CashClosingReportRecord } from '../sales/services/cashClosingReportModel'
import { loadCashClosingReports } from '../sales/services/revoCashClosingService'
import type { CrmSection } from '../routing/crmNavigation'

export type CrmSearchItem = {
  id: string
  label: string
  context: string
  keywords: string
  icon: LucideIcon
  section: CrmSection
  targetId: string
}

const formatDay = (day: string) => day.split('-').reverse().join('/')

export function buildCatalogSearchItems(catalog: CatalogData, allowed: ReadonlySet<CrmSection>): CrmSearchItem[] {
  const items: CrmSearchItem[] = []
  const add = (section: CrmSection, icon: LucideIcon, context: string, entry: { id: string; name: string }, keywords = '') => {
    if (allowed.has(section)) items.push({ id: `${section}:${entry.id}`, label: entry.name, context, keywords, icon, section, targetId: entry.id })
  }
  for (const product of catalog.products) {
    const variants = catalog.variants.filter((variant) => variant.productId === product.id)
    add('products', Boxes, product.active ? 'Producto' : 'Producto · inactivo', product, variants.map((variant) => `${variant.name} ${variant.sku ?? ''}`).join(' '))
  }
  for (const format of catalog.saleFormats) add('formats', Ruler, 'Formato', format)
  for (const category of catalog.categories) add('categories', LayoutGrid, 'Categoría', category)
  for (const group of catalog.selectionGroups) if (group.type === 'mixer') add('selection-groups', ListChecks, 'Mixer', group)
  for (const group of catalog.modifierGroups) add('modifiers', Puzzle, 'Modificador', group)
  return items
}

export function buildCashClosingSearchItems(closings: readonly CashClosingReportRecord[], config: OperationalDayConfig): CrmSearchItem[] {
  return closings.map((closing) => {
    const day = getCashClosingDay(closing, config)
    const [name, totalCents] = isImportedCashClosing(closing)
      ? ['REVO', closing.cashCents + closing.cardCents]
      : [`${closing.printSnapshot.registerName} ${closing.printSnapshot.shiftLabel}`.trim(), closing.printSnapshot.summary.totalSalesCents]
    return {
      id: `x-reports:${closing.id}`,
      label: `Cierre ${formatDay(day)} · ${name}`,
      context: formatMoney(totalCents),
      keywords: `${day} cierre caja informe z`,
      icon: ReceiptText,
      section: 'x-reports',
      targetId: closing.id,
    }
  })
}

const catalogSearchSections: CrmSection[] = ['products', 'formats', 'categories', 'selection-groups', 'modifiers']

export async function loadCrmSearchItems(context: TenantContext, venue: CrmVenue, allowed: ReadonlySet<CrmSection>) {
  const config: OperationalDayConfig = { dayChangeTime: venue.dayChangeTime, timeZone: venue.timeZone || 'Europe/Madrid' }
  const [catalog, closings] = await Promise.all([
    catalogSearchSections.some((section) => allowed.has(section)) ? catalogAdminService.load(venue.id) : null,
    allowed.has('x-reports') ? loadCashClosingReports({ ...context, venueId: venue.id }, config) : [],
  ])
  return [...(catalog ? buildCatalogSearchItems(catalog, allowed) : []), ...buildCashClosingSearchItems(closings, config)]
}
