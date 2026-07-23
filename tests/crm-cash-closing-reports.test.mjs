import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { reportNavItems, reportSections } from '../src/features/crm/routing/crmNavigation.ts'
import { buildCashClosingDailyValues, filterCashClosingsByDate } from '../src/features/crm/sales/services/cashClosingReportModel.ts'

function closing(id, closedAt, totalSalesCents) {
  return {
    id,
    closedAt,
    printSnapshot: {
      timezone: 'Europe/Madrid',
      summary: { totalSalesCents },
    },
  }
}

const madridAtFour = {
  dayChangeTime: '04:00',
  timeZone: 'Europe/Madrid',
}

test('sales reports navigation exposes Tickets and the cash-closing report as child pages', () => {
  assert.deepEqual(reportNavItems.map(({ id }) => id), ['reports', 'x-reports'])
  assert.equal(reportNavItems[0].label, 'Tickets')
  assert.ok(reportNavItems[1].label.trim())
  assert.equal(reportSections.has('reports'), true)
  assert.equal(reportSections.has('x-reports'), true)
})

test('cash-closing reports aggregate values by the venue operational day', () => {
  const closings = [
    closing('one', '2026-07-22T21:30:00.000Z', 1250),
    closing('two', '2026-07-22T23:30:00.000Z', 2750),
    closing('three', '2026-07-23T02:00:00.000Z', 5000),
  ]

  assert.deepEqual(buildCashClosingDailyValues(closings, madridAtFour), [
    { closingCount: 2, date: '2026-07-22', totalCents: 4000 },
    { closingCount: 1, date: '2026-07-23', totalCents: 5000 },
  ])
  assert.deepEqual(filterCashClosingsByDate(closings, '2026-07-22', '2026-07-22', madridAtFour).map(({ id }) => id), ['one', 'two'])
})

test('cash-closing reports render the chart and the detailed table', async () => {
  const source = await readFile(new URL('../src/features/crm/sales/pages/CashClosingReportsPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /ClosingValuesChart/)
  assert.match(source, /Valor total de los cierres agrupado por día operativo/)
  assert.match(source, /Cierres de caja/)
  assert.match(source, /expectedAndCounted/)
  assert.match(source, /crm-list-toolbar[^\n]+!bg-transparent[^\n]+!text-\[var\(--crm-text\)\]/)
  assert.match(source, /onMouseEnter=\{\(\) => setHoveredPointIndex\(index\)\}/)
  assert.match(source, /cash-closing-tooltip-shadow/)
  assert.match(source, /hoveredPoint\.totalCents/)
})
