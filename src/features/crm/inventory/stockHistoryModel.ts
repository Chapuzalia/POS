import { getOperationalDateKey, getOperationalDayRangeIso, shiftIsoDate, type OperationalDayConfig } from '../../../lib/operationalDay'
import type { InventoryConsumptionReport, InventoryStockMovement } from './types'

export function inventoryHistoryPeriod(days: number, config: OperationalDayConfig, now = new Date()) {
  const today = getOperationalDateKey(now, config)
  const currentStartDay = shiftIsoDate(today, -days)
  const previousStartDay = shiftIsoDate(today, -days * 2)
  return {
    currentStartDay, previousStartDay, today,
    startIso: getOperationalDayRangeIso(config, previousStartDay).startIso,
    currentStartIso: getOperationalDayRangeIso(config, currentStartDay).startIso,
    endIso: getOperationalDayRangeIso(config, today).startIso,
    nowIso: now.toISOString(),
  }
}

export function consumptionComparison(report: InventoryConsumptionReport, startDay: string, today: string) {
  let current = 0
  let previous = 0
  for (const day of report.daily) {
    if (day.day >= today) continue
    if (day.day >= startDay) current += day.quantity
    else previous += day.quantity
  }
  return {
    current: Number(current.toFixed(6)), previous: Number(previous.toFixed(6)),
    percent: report.failureCount || report.incompatibleCount || previous <= 0 ? null : (current - previous) / previous * 100,
  }
}

const saleTypes = new Set(['product', 'mixer', 'menu_component', 'modifier', 'sale', 'sale_aggregate'])
export function movementLabel(movement: InventoryStockMovement) {
  if (movement.delta < 0 && movement.ticketLineId && saleTypes.has(movement.sourceType)) return 'Consumo asociado a ventas'
  if (movement.sourceType === 'manual_adjustment') return 'Ajuste manual'
  if (movement.sourceType === 'supplier_document_receipt') return 'Entrada por compra'
  if (movement.sourceType === 'supplier_document_correction') return 'Corrección de compra'
  if (movement.sourceType === 'production_ingredient') return 'Consumo para elaboración'
  if (movement.sourceType === 'production_output') return 'Elaboración terminada'
  return 'Otro movimiento'
}

// Return only verified links. Equal timestamps do not imply a known order.
// Never infer an opening balance or fill an unrecorded change between entries.
export function recordedStockSegments(movements: InventoryStockMovement[], warehouseId: string, unitId: string) {
  const ordered = movements.filter((movement) => movement.warehouseId === warehouseId)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const segments: InventoryStockMovement[][] = []
  let segment: InventoryStockMovement[] | undefined
  for (const movement of ordered) {
    if (movement.unitId !== unitId) { segment = undefined; continue }
    const previous = segment?.at(-1)
    if (previous && previous.createdAt !== movement.createdAt && Math.abs(previous.after - movement.before) < 0.0000005) segment?.push(movement)
    else { segment = [movement]; segments.push(segment) }
  }
  return segments
}
