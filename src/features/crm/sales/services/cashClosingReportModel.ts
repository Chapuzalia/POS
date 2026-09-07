import { getOperationalDateKey, getZonedDateTimeParts, toIsoDate, type OperationalDayConfig } from '../../../../lib/operationalDay.ts'
import type { CashClosingPrintSnapshot, CashClosingRecord } from '../../../../types'
import type { ImportedCashClosing } from '../../../../lib/revoCashClosings.ts'
import { getCashClosingAmounts } from '../../../cash-registers/services/cashClosingAmounts.ts'

export type CashClosingReportRecord = CashClosingRecord | ImportedCashClosing

export function sortCashClosings(
  closings: readonly CashClosingReportRecord[],
  column: string,
  direction: 'ascending' | 'descending',
) {
  const columnIndex = Number(column.replace('column-', ''))
  const value = (closing: CashClosingReportRecord): string | number | null => {
    if (isImportedCashClosing(closing)) {
      return [Date.parse(`${closing.date}T12:00:00Z`), 'REVO', closing.cashCents + closing.cardCents,
        closing.cashCents, closing.cardCents, null, null][columnIndex] ?? null
    }
    const snapshot = closing.printSnapshot
    const amounts = getCashClosingAmounts(snapshot)
    return [Date.parse(closing.closedAt), `${snapshot.registerName} ${snapshot.shiftLabel}`,
      snapshot.summary.totalSalesCents, amounts.billedCashCents, amounts.billedCardCents,
      snapshot.differences.cashDifferenceCents + snapshot.differences.cardDifferenceCents,
      snapshot.cashFund.openingCashFundCents][columnIndex] ?? null
  }
  const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' })
  return closings.map(closing => ({ closing, value: value(closing) })).sort((a, b) => {
    if (a.value === null || b.value === null) return a.value === b.value ? 0 : a.value === null ? 1 : -1
    const comparison = typeof a.value === 'number' && typeof b.value === 'number'
      ? a.value - b.value : collator.compare(String(a.value), String(b.value))
    return direction === 'ascending' ? comparison : -comparison
  }).map(({ closing }) => closing)
}

export function getDefaultClosingDateRange(timeZone: string, now = new Date()) {
  const today = getZonedDateTimeParts(now, timeZone)
  const start = new Date(Date.UTC(today.year, today.month - 4, 1))
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
  start.setUTCDate(Math.min(today.day, lastDay))
  return { dateFrom: start.toISOString().slice(0, 10), dateTo: toIsoDate(today) }
}

export function isImportedCashClosing(closing: CashClosingReportRecord): closing is ImportedCashClosing {
  return 'source' in closing && closing.source === 'revo'
}

export type CashClosingDailyValue = {
  closingCount: number
  date: string
  totalCents: number
}

export function projectCashClosingCounts(
  snapshot: CashClosingPrintSnapshot,
  countedCashCents: number,
  countedCardCents: number,
): CashClosingPrintSnapshot {
  return {
    ...snapshot,
    expectedAndCounted: {
      ...snapshot.expectedAndCounted,
      countedCashCents,
      countedCardCents,
    },
    differences: {
      cashDifferenceCents: countedCashCents - snapshot.expectedAndCounted.expectedCashCents,
      cardDifferenceCents: countedCardCents - snapshot.expectedAndCounted.expectedCardCents,
    },
  }
}

export function getCashClosingDay(closing: CashClosingReportRecord, config: OperationalDayConfig) {
  if (isImportedCashClosing(closing)) return closing.date
  try {
    return getOperationalDateKey(closing.closedAt, {
      dayChangeTime: config.dayChangeTime,
      timeZone: closing.printSnapshot.timezone || config.timeZone,
    })
  } catch {
    return new Date(closing.closedAt).toISOString().slice(0, 10)
  }
}

export function buildCashClosingDailyValues(closings: readonly CashClosingReportRecord[], config: OperationalDayConfig) {
  const values = new Map<string, CashClosingDailyValue>()

  for (const closing of closings) {
    const date = getCashClosingDay(closing, config)
    const current = values.get(date) ?? { closingCount: 0, date, totalCents: 0 }
    current.closingCount += 1
    current.totalCents += isImportedCashClosing(closing) ? closing.cashCents + closing.cardCents : closing.printSnapshot.summary.totalSalesCents
    values.set(date, current)
  }

  return [...values.values()].sort((left, right) => left.date.localeCompare(right.date))
}

export function filterCashClosingsByDate(
  closings: readonly CashClosingReportRecord[],
  dateFrom: string,
  dateTo: string,
  config: OperationalDayConfig,
) {
  return closings.filter((closing) => {
    const day = getCashClosingDay(closing, config)
    return (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo)
  })
}
