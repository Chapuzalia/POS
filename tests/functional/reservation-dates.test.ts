import { expect, it } from 'vitest'
import { getDateRange, localDateKey, shiftDateKey, zonedLocalToUtc } from '../../src/utils/dates'

it('uses venue calendar dates and preserves date shifts across a year boundary', () => {
  expect(localDateKey(new Date('2026-10-25T23:30:00Z'), 'Europe/Madrid')).toBe('2026-10-26')
  expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01')
  expect(zonedLocalToUtc('2026-11-02', '13:30', 'Europe/Madrid')).toBe('2026-11-02T12:30:00.000Z')
})

it('keeps the complete reservation day across both daylight saving transitions', () => {
  expect(getDateRange('2026-03-29', 'Europe/Madrid')).toEqual({ from: '2026-03-28T23:00:00.000Z', to: '2026-03-29T22:00:00.000Z' })
  expect(getDateRange('2026-10-25', 'Europe/Madrid')).toEqual({ from: '2026-10-24T22:00:00.000Z', to: '2026-10-25T23:00:00.000Z' })
})
