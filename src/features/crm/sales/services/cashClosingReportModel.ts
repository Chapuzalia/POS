import { getOperationalDateKey, type OperationalDayConfig } from '../../../../lib/operationalDay.ts'
import type { CashClosingRecord } from '../../../../types'

export type CashClosingDailyValue = {
  closingCount: number
  date: string
  totalCents: number
}

export function getCashClosingDay(closing: CashClosingRecord, config: OperationalDayConfig) {
  try {
    return getOperationalDateKey(closing.closedAt, {
      dayChangeTime: config.dayChangeTime,
      timeZone: closing.printSnapshot.timezone || config.timeZone,
    })
  } catch {
    return new Date(closing.closedAt).toISOString().slice(0, 10)
  }
}

export function buildCashClosingDailyValues(closings: readonly CashClosingRecord[], config: OperationalDayConfig) {
  const values = new Map<string, CashClosingDailyValue>()

  for (const closing of closings) {
    const date = getCashClosingDay(closing, config)
    const current = values.get(date) ?? { closingCount: 0, date, totalCents: 0 }
    current.closingCount += 1
    current.totalCents += closing.printSnapshot.summary.totalSalesCents
    values.set(date, current)
  }

  return [...values.values()].sort((left, right) => left.date.localeCompare(right.date))
}

export function filterCashClosingsByDate(
  closings: readonly CashClosingRecord[],
  dateFrom: string,
  dateTo: string,
  config: OperationalDayConfig,
) {
  return closings.filter((closing) => {
    const day = getCashClosingDay(closing, config)
    return (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo)
  })
}
