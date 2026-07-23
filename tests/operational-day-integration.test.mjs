import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [accessService, analyticsService, reportsPage, settingsPage] = await Promise.all([
  readFile(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crm/analytics/services/analyticsService.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crm/sales/pages/SalesReportsPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crm/venues/pages/VenueSettingsPage.tsx', import.meta.url), 'utf8'),
])

test('la configuración del local carga, edita y limpia la hora de cambio', () => {
  assert.match(accessService, /select\('id, name, address, day_change_time,/)
  assert.match(accessService, /dayChangeTime: normalizeDayChangeTime/)
  assert.match(accessService, /day_change_time: dayChangeTime/)
  assert.match(settingsPage, /name="dayChangeTime"/)
  assert.match(settingsPage, /Vacío usa días naturales/)
})

test('informes y estadísticas aplican el día operativo a la fecha real de venta', () => {
  assert.match(reportsPage, /getOperationalDateKey\(ticket\.createdAt, operationalDayConfig\)/)
  assert.match(reportsPage, /Día operativo desde/)
  assert.match(analyticsService, /getOperationalMonthStartIso/)
  assert.match(analyticsService, /\.gte\('local_created_at', monthStart\)/)
})
