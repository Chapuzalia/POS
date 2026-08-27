import { getOperationalDateKey, type OperationalDayConfig } from '../../../../lib/operationalDay.ts'
import type { CrmStats, HistoricalPaymentMethod } from '../../../../types/domain.ts'

export type SalesBreakdownLine = {
  categoryId: string | null
  categoryName: string | null
  productId: string | null
  productName: string
  quantity: number
  totalCents: number
}

export function buildDayActivityStats(
  tickets: Array<{ id: string; createdAt: string; totalCents: number }>,
  sales: Array<{
    ticketId: string
    paymentMethod: HistoricalPaymentMethod | null
    totalCents: number
  }>,
  config: OperationalDayConfig,
  now = new Date(),
): CrmStats['dayActivity'] {
  const currentDayKey = getOperationalDateKey(now, config)
  const dayTicketIds = new Set<string>()
  let totalCents = 0

  tickets.forEach((ticket) => {
    if (getOperationalDateKey(ticket.createdAt, config) !== currentDayKey) return
    dayTicketIds.add(ticket.id)
    totalCents += ticket.totalCents
  })

  let cashCents = 0
  let cardCents = 0
  sales.forEach((sale) => {
    if (!dayTicketIds.has(sale.ticketId)) return
    if (sale.paymentMethod === 'cash') cashCents += sale.totalCents
    if (sale.paymentMethod === 'card') cardCents += sale.totalCents
  })

  return {
    totalCents,
    cashCents,
    cardCents,
    ticketCount: dayTicketIds.size,
  }
}

type SalesBreakdownItem = CrmStats['salesByCategory'][number]

function addSalesBreakdownItem(
  items: Map<string, SalesBreakdownItem>,
  id: string,
  label: string,
  line: SalesBreakdownLine,
) {
  const current = items.get(id) ?? { id, label, quantity: 0, totalCents: 0 }
  current.quantity += line.quantity
  current.totalCents += line.totalCents
  items.set(id, current)
}

function sortSalesBreakdown(items: Map<string, SalesBreakdownItem>) {
  return [...items.values()].sort((left, right) =>
    right.totalCents - left.totalCents
    || right.quantity - left.quantity
    || left.label.localeCompare(right.label, 'es'),
  )
}

export function buildSalesBreakdowns(lines: SalesBreakdownLine[]): Pick<CrmStats, 'salesByCategory' | 'salesByProduct'> {
  const categories = new Map<string, SalesBreakdownItem>()
  const products = new Map<string, SalesBreakdownItem>()

  lines.forEach((line) => {
    const categoryLabel = line.categoryName?.trim() || 'Sin categoría'
    const productLabel = line.productName.trim() || 'Producto sin nombre'
    addSalesBreakdownItem(categories, line.categoryId ?? 'uncategorized', categoryLabel, line)
    addSalesBreakdownItem(products, line.productId ?? `deleted:${productLabel.toLocaleLowerCase('es')}`, productLabel, line)
  })

  return {
    salesByCategory: sortSalesBreakdown(categories),
    salesByProduct: sortSalesBreakdown(products),
  }
}

export type TopProductCombinationLine = {
  productName: string
  quantity: number
  totalCents: number
  modifiers: Array<{
    id?: string
    groupId?: string
    name?: string
  }> | null
  components: Array<{
    type: 'mixer' | 'menu_component'
    productName: string
    sortOrder: number
    modifiers: Array<{ name?: string }> | null
  }> | null
}

function uniqueSortedNames(names: Array<string | undefined>) {
  return [...new Set(names.map((name) => name?.trim()).filter((name): name is string => Boolean(name)))]
    .sort((left, right) => left.localeCompare(right, 'es'))
}

export function buildTopProductCombinations(lines: TopProductCombinationLine[]): CrmStats['topProductCombinations'] {
  const combinations = new Map<string, CrmStats['topProductCombinations'][number]>()

  lines.forEach((line) => {
    const components = (line.components ?? []).toSorted((left, right) => left.sortOrder - right.sortOrder)
    const componentMixers = uniqueSortedNames(
      components.filter((component) => component.type === 'mixer').map((component) => component.productName),
    )
    const legacyMixers = (line.modifiers ?? []).filter((modifier) =>
      modifier.groupId === 'mixer' || modifier.id?.startsWith('mixer:'),
    )
    const mixers = componentMixers.length
      ? componentMixers
      : uniqueSortedNames(legacyMixers.map((modifier) => modifier.name))
    const lineModifiers = (line.modifiers ?? []).filter((modifier) =>
      modifier.groupId !== 'mixer' && !modifier.id?.startsWith('mixer:'),
    )
    const modifiers = uniqueSortedNames([
      ...lineModifiers.map((modifier) => modifier.name),
      ...components.flatMap((component) => (component.modifiers ?? []).map((modifier) =>
        modifier.name ? `${component.productName} · ${modifier.name}` : undefined,
      )),
    ])
    const key = JSON.stringify([line.productName, mixers, modifiers])
    const current = combinations.get(key) ?? {
      productName: line.productName,
      mixers,
      modifiers,
      quantity: 0,
      totalCents: 0,
    }
    current.quantity += line.quantity
    current.totalCents += line.totalCents
    combinations.set(key, current)
  })

  return [...combinations.values()].sort((left, right) =>
    right.quantity - left.quantity
    || right.totalCents - left.totalCents
    || left.productName.localeCompare(right.productName, 'es')
    || left.mixers.join().localeCompare(right.mixers.join(), 'es')
    || left.modifiers.join().localeCompare(right.modifiers.join(), 'es'),
  )
}

export function buildHourlySalesStats(
  tickets: Array<{ createdAt: string; totalCents: number }>,
  timeZone: string,
): CrmStats['hourlySales'] {
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    ticketCount: 0,
    totalCents: 0,
  }))
  const hourFormatter = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone,
  })

  tickets.forEach((ticket) => {
    const createdAt = new Date(ticket.createdAt)
    if (Number.isNaN(createdAt.getTime())) return
    const hour = Number(hourFormatter.format(createdAt))
    const current = hours[hour]
    if (!current) return
    current.ticketCount += 1
    current.totalCents += ticket.totalCents
  })

  return hours
}

export function sortCrmTopProductsByUnits(products: CrmStats['topProducts']) {
  return products.toSorted((left, right) =>
    right.quantity - left.quantity
    || right.totalCents - left.totalCents
    || left.productName.localeCompare(right.productName, 'es'),
  )
}

export function applyCrmOpenCashSalesTotals(
  stats: CrmStats | null,
  totalsByCashSession: ReadonlyMap<string, number>,
) {
  if (!stats) return stats
  let changed = false
  const openCashSessions = stats.openCashSessions.map((current) => {
    const salesCents = totalsByCashSession.get(current.id) ?? 0
    if (salesCents === current.salesCents) return current
    changed = true
    return { ...current, salesCents }
  })

  return changed ? { ...stats, openCashSessions } : stats
}
