import { shiftIsoDate } from '../../../../lib/operationalDay.ts'
import type { CrmStatsPeriod, CrmStatsPeriodKind, CrmStatsPeriodSummary } from '../../../../types'

const isoDatePattern = /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/
const millisecondsPerDay = 86_400_000

function parseIsoDate(value: string) {
  const match = isoDatePattern.exec(value)
  if (!match) throw new Error('La fecha debe tener formato YYYY-MM-DD.')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const time = Date.UTC(year, month - 1, day)
  const parsed = new Date(time)
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error('La fecha seleccionada no existe.')
  }
  return time
}

function getMonthEnd(monthKey: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthKey)
  if (!match) throw new Error('El mes debe tener formato YYYY-MM.')
  const year = Number(match[1])
  const month = Number(match[2])
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${monthKey}-${String(lastDay).padStart(2, '0')}`
}

export function createCrmStatsPeriod(kind: CrmStatsPeriodKind, value: string, endValue?: string): CrmStatsPeriod {
  if (kind === 'year') {
    if (!/^\d{4}$/.test(value)) throw new Error('El año debe tener cuatro cifras.')
    return { kind, startDate: `${value}-01-01`, endDate: `${value}-12-31` }
  }
  if (kind === 'month') {
    return { kind, startDate: `${value}-01`, endDate: getMonthEnd(value) }
  }
  if (kind === 'day') {
    parseIsoDate(value)
    return { kind, startDate: value, endDate: value }
  }

  const endDate = endValue ?? value
  parseIsoDate(value)
  parseIsoDate(endDate)
  if (value > endDate) throw new Error('La fecha inicial del período no puede ser posterior a la fecha final.')
  return { kind, startDate: value, endDate }
}

export function getDefaultCrmStatsPeriod(kind: CrmStatsPeriodKind, currentDay: string): CrmStatsPeriod {
  parseIsoDate(currentDay)
  if (kind === 'year') return createCrmStatsPeriod(kind, currentDay.slice(0, 4))
  if (kind === 'month') return createCrmStatsPeriod(kind, currentDay.slice(0, 7))
  if (kind === 'day') return createCrmStatsPeriod(kind, currentDay)
  return createCrmStatsPeriod(kind, `${currentDay.slice(0, 7)}-01`, currentDay)
}

export function getCrmStatsPeriodDayCount(period: CrmStatsPeriod, maximumEndDate = period.endDate) {
  const startTime = parseIsoDate(period.startDate)
  const effectiveEndDate = period.endDate < maximumEndDate ? period.endDate : maximumEndDate
  const endTime = parseIsoDate(effectiveEndDate)
  if (startTime > endTime) throw new Error('El período seleccionado todavía no ha comenzado.')
  return Math.round((endTime - startTime) / millisecondsPerDay) + 1
}

export function summarizeCrmStatsPeriod(period: CrmStatsPeriod, currentDay: string): CrmStatsPeriodSummary {
  const effectiveEndDate = period.endDate < currentDay ? period.endDate : currentDay
  return {
    ...period,
    dayCount: getCrmStatsPeriodDayCount(period, currentDay),
    effectiveEndDate,
  }
}

export function getPreviousCrmStatsPeriod(period: CrmStatsPeriod): CrmStatsPeriod {
  if (period.kind === 'year') {
    return createCrmStatsPeriod('year', String(Number(period.startDate.slice(0, 4)) - 1))
  }
  if (period.kind === 'month') {
    const previousMonthLastDay = shiftIsoDate(period.startDate, -1)
    return createCrmStatsPeriod('month', previousMonthLastDay.slice(0, 7))
  }
  if (period.kind === 'day') {
    return createCrmStatsPeriod('day', shiftIsoDate(period.startDate, -1))
  }

  const dayCount = getCrmStatsPeriodDayCount(period)
  const endDate = shiftIsoDate(period.startDate, -1)
  return createCrmStatsPeriod('period', shiftIsoDate(endDate, 1 - dayCount), endDate)
}

export function isSameCrmStatsPeriod(left: CrmStatsPeriod | null | undefined, right: CrmStatsPeriod) {
  return left?.kind === right.kind && left.startDate === right.startDate && left.endDate === right.endDate
}

const monthFormatter = new Intl.DateTimeFormat('es-ES', { month: 'long', timeZone: 'UTC', year: 'numeric' })
const dayFormatter = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC', year: 'numeric' })

function asUtcDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`)
}

export function formatCrmStatsPeriod(period: CrmStatsPeriod) {
  if (period.kind === 'year') return period.startDate.slice(0, 4)
  if (period.kind === 'month') return monthFormatter.format(asUtcDate(period.startDate))
  if (period.kind === 'day') return dayFormatter.format(asUtcDate(period.startDate))
  return `${dayFormatter.format(asUtcDate(period.startDate))} – ${dayFormatter.format(asUtcDate(period.endDate))}`
}

export type NormalizedComparison = {
  comparisonValue: number
  currentValue: number
  direction: 'up' | 'down' | 'same'
  percentage: number | null
}

export function compareNormalizedValues(
  currentTotal: number,
  currentDayCount: number,
  comparisonTotal: number,
  comparisonDayCount: number,
): NormalizedComparison {
  const currentValue = currentTotal / Math.max(1, currentDayCount)
  const comparisonValue = comparisonTotal / Math.max(1, comparisonDayCount)
  if (comparisonValue === 0) {
    return {
      comparisonValue,
      currentValue,
      direction: currentValue > 0 ? 'up' : 'same',
      percentage: currentValue > 0 ? null : 0,
    }
  }
  const percentage = ((currentValue - comparisonValue) / Math.abs(comparisonValue)) * 100
  return {
    comparisonValue,
    currentValue,
    direction: Math.abs(percentage) < 0.05 ? 'same' : percentage > 0 ? 'up' : 'down',
    percentage,
  }
}
