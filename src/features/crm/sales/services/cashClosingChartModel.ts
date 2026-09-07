import type { CashClosingDailyValue } from './cashClosingReportModel'

export type ClosingChartGrouping = 'auto' | 'day' | 'week' | 'month'
const timestamp = (date: string) => Date.parse(`${date}T00:00:00Z`)
const key = (date: Date) => date.toISOString().slice(0, 10)

// Calculate before pagination so the same period keeps its trend on every screen.
export function buildClosingTrend(
  periods: readonly { totalCents: number; closingCount: number }[],
  windowSize: number,
) {
  return periods.map((period, index) => {
    if (!period.closingCount) return null
    const window = periods.slice(Math.max(0, index - windowSize + 1), index + 1)
      .filter(value => value.closingCount > 0)
    return window.reduce((sum, value) => sum + value.totalCents, 0) / window.length
  })
}

export function buildClosingChart(values: readonly CashClosingDailyValue[], grouping: ClosingChartGrouping) {
  const sorted = [...values].sort((a, b) => a.date.localeCompare(b.date))
  const span = sorted.length ? (timestamp(sorted.at(-1)!.date) - timestamp(sorted[0].date)) / 86400000 + 1 : 0
  const resolution = grouping === 'auto' ? (span <= 35 ? 'day' : span <= 180 ? 'week' : 'month') : grouping
  if (resolution === 'day') {
    return {
      resolution,
      periods: sorted.filter(value => value.closingCount > 0).map(value => ({
        ...value,
        endDate: value.date,
        days: 1,
      })),
    }
  }
  const startOfPeriod = (date: string) => {
    const result = new Date(timestamp(date))
    if (resolution === 'month') result.setUTCDate(1)
    if (resolution === 'week') result.setUTCDate(result.getUTCDate() - (result.getUTCDay() + 6) % 7)
    return result
  }
  const nextPeriod = (date: Date) => {
    const result = new Date(date)
    if (resolution === 'month') result.setUTCMonth(result.getUTCMonth() + 1)
    else result.setUTCDate(result.getUTCDate() + (resolution === 'week' ? 7 : 1))
    return result
  }
  const totals = new Map<string, { totalCents: number; closingCount: number; days: number }>()
  for (const value of sorted) {
    const date = key(startOfPeriod(value.date))
    const total = totals.get(date) ?? { totalCents: 0, closingCount: 0, days: 0 }
    total.totalCents += value.totalCents
    total.closingCount += value.closingCount
    total.days += 1
    totals.set(date, total)
  }
  const periods = []
  if (sorted.length) {
    const last = startOfPeriod(sorted.at(-1)!.date)
    for (let date = startOfPeriod(sorted[0].date); date <= last; date = nextPeriod(date)) {
      const end = new Date(nextPeriod(date).getTime() - 86400000)
      periods.push({ date: key(date), endDate: key(end), ...(totals.get(key(date)) ?? { totalCents: 0, closingCount: 0, days: 0 }) })
    }
  }
  return { resolution, periods }
}
