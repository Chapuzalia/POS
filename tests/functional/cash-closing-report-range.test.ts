import { describe, expect, it } from 'vitest'
import { filterCashClosingsByDate, getCashClosingDay, getCashClosingQueryRange } from '../../src/features/crm/sales/services/cashClosingReportModel'
import { getOperationalDayRangeIso } from '../../src/lib/operationalDay'
import type { CashClosingRecord } from '../../src/types'

const config = { dayChangeTime: '06:00', timeZone: 'Europe/Madrid' }
const closing = (closedAt: string, timezone: string) => ({ id: closedAt, closedAt, printSnapshot: { timezone } }) as unknown as CashClosingRecord

describe('Z report period query', () => {
  it('widens the selected operational days by one day on each side', () => {
    const range = getCashClosingQueryRange({ dateFrom: '2026-11-01', dateTo: '2026-11-10' }, config)
    expect(range).toEqual({
      fromIso: getOperationalDayRangeIso(config, '2026-10-31').startIso,
      toIso: getOperationalDayRangeIso(config, '2026-11-11').endIso,
    })
  })

  it('leaves a cleared date unbounded', () => {
    expect(getCashClosingQueryRange({ dateFrom: '', dateTo: '' }, config)).toEqual({ fromIso: null, toIso: null })
  })

  it('still loads every closing the page shows for the period, even in another time zone', () => {
    const selected = { dateFrom: '2026-11-01', dateTo: '2026-11-10' }
    const range = getCashClosingQueryRange(selected, config)
    const candidates = [
      closing('2026-11-01T04:30:00Z', 'Atlantic/Canary'), closing('2026-11-11T04:59:00Z', 'Atlantic/Canary'),
      closing('2026-11-11T05:30:00Z', 'Europe/Madrid'), closing('2026-10-31T23:00:00Z', 'America/New_York'),
    ]
    const shown = filterCashClosingsByDate(candidates, selected.dateFrom, selected.dateTo, config)
    expect(shown.length).toBeGreaterThan(0)
    for (const item of shown) {
      expect(item.closedAt >= range.fromIso! && item.closedAt < range.toIso!, `${item.closedAt} ${getCashClosingDay(item, config)}`).toBe(true)
    }
  })
})
