import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { buildDayActivityStats } from '../src/features/crm/analytics/services/analyticsModel.ts'

const madridAtFour = {
  dayChangeTime: '04:00',
  timeZone: 'Europe/Madrid',
}

test('resume todos los turnos del día operativo por forma de pago', () => {
  const activity = buildDayActivityStats(
    [
      { id: 'closed-shift-ticket', createdAt: '2026-08-26T19:00:00.000Z', totalCents: 1_200 },
      { id: 'open-shift-ticket', createdAt: '2026-08-27T01:30:00.000Z', totalCents: 800 },
      { id: 'previous-day-ticket', createdAt: '2026-08-26T01:30:00.000Z', totalCents: 500 },
    ],
    [
      { ticketId: 'closed-shift-ticket', paymentMethod: 'cash', totalCents: 1_200 },
      { ticketId: 'open-shift-ticket', paymentMethod: 'card', totalCents: 800 },
      { ticketId: 'previous-day-ticket', paymentMethod: 'cash', totalCents: 500 },
    ],
    madridAtFour,
    new Date('2026-08-27T01:45:00.000Z'),
  )

  assert.deepEqual(activity, {
    totalCents: 2_000,
    cashCents: 1_200,
    cardCents: 800,
    ticketCount: 2,
  })
})

test('el dashboard coloca la actividad del día entre cajas y actividad mensual', async () => {
  const dashboard = await readFile(
    new URL('../src/features/crm/dashboard/pages/DashboardPage.tsx', import.meta.url),
    'utf8',
  )

  const openCashPosition = dashboard.indexOf('<span>Cajas abiertas</span>')
  const dayPosition = dashboard.indexOf('<span>Actividad del día</span>')
  const monthPosition = dashboard.indexOf('<span>Actividad del mes</span>')

  assert.ok(openCashPosition < dayPosition)
  assert.ok(dayPosition < monthPosition)
  for (const label of ['Total', 'Efectivo', 'Tarjeta', 'Tickets']) {
    assert.match(dashboard, new RegExp(`label="${label}"`))
  }
})
