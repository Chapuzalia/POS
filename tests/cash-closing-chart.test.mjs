import assert from 'node:assert/strict'
import test from 'node:test'
import { buildClosingChart, buildClosingTrend } from '../src/features/crm/sales/services/cashClosingChartModel.ts'

const day = (date, totalCents, closingCount = 1) => ({ date, totalCents, closingCount })

test('trend uses trailing periods, preserves zero and refunds, and skips missing data', () => {
  const periods = [day('', 300), day('', 0), day('', -150), day('', 0, 0), day('', 600)]
  assert.deepEqual(buildClosingTrend(periods, 3), [300, 150, 50, null, 225])
  assert.deepEqual(buildClosingTrend([], 7), [])
  assert.deepEqual(buildClosingTrend([day('', 0)], 7), [0])
})

test('automatic grouping uses calendar span even when records are sparse', () => {
  assert.equal(buildClosingChart([day('2026-01-01', 100)], 'auto').resolution, 'day')
  assert.equal(buildClosingChart([day('2026-01-01', 100), day('2026-03-01', 200)], 'auto').resolution, 'week')
  assert.equal(buildClosingChart([day('2025-01-01', 100), day('2026-03-01', 200)], 'auto').resolution, 'month')
})

test('monthly buckets preserve totals, refunds, counts and missing months across years', () => {
  const { periods } = buildClosingChart([day('2026-02-05', -200), day('2025-12-01', 1000, 2), day('2025-12-31', 300)], 'month')
  assert.deepEqual(periods, [
    { date: '2025-12-01', endDate: '2025-12-31', totalCents: 1300, closingCount: 3, days: 2 },
    { date: '2026-01-01', endDate: '2026-01-31', totalCents: 0, closingCount: 0, days: 0 },
    { date: '2026-02-01', endDate: '2026-02-28', totalCents: -200, closingCount: 1, days: 1 },
  ])
})

test('weeks start on Monday and cross the year boundary', () => {
  const { periods } = buildClosingChart([day('2025-12-31', 100), day('2026-01-04', 200), day('2026-01-05', 300)], 'week')
  assert.equal(periods[0].date, '2025-12-29')
  assert.equal(periods[0].endDate, '2026-01-04')
  assert.equal(periods[0].totalCents, 300)
  assert.equal(periods[1].date, '2026-01-05')
})

test('daily detail only shows operational days with closings, including zero totals and refunds', () => {
  const values = [day('2024-03-02', -100), day('2024-02-28', 0), day('2024-03-01', 0, 0)]
  for (const grouping of ['day', 'auto']) {
    const { periods } = buildClosingChart(values, grouping)
    assert.deepEqual(periods, [
      { date: '2024-02-28', endDate: '2024-02-28', totalCents: 0, closingCount: 1, days: 1 },
      { date: '2024-03-02', endDate: '2024-03-02', totalCents: -100, closingCount: 1, days: 1 },
    ])
  }
  assert.deepEqual(buildClosingChart([], 'auto').periods, [])
})
