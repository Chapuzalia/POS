import type { CashClosingRecord } from '../../../../types'

export type CashClosingDailyValue = {
  closingCount: number
  date: string
  totalCents: number
}

export function getCashClosingDay(closing: CashClosingRecord) {
  const date = new Date(closing.closedAt)
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      timeZone: closing.printSnapshot.timezone,
      year: 'numeric',
    }).formatToParts(date)
    const values = new Map(parts.map((part) => [part.type, part.value]))
    return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

export function buildCashClosingDailyValues(closings: readonly CashClosingRecord[]) {
  const values = new Map<string, CashClosingDailyValue>()

  for (const closing of closings) {
    const date = getCashClosingDay(closing)
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
) {
  return closings.filter((closing) => {
    const day = getCashClosingDay(closing)
    return (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo)
  })
}
