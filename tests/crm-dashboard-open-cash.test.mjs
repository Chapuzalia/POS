import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('el dashboard muestra primero las cajas y permite filtrar por el local seleccionado', async () => {
  const [dashboard, routing, service, domain] = await Promise.all([
    readFile(new URL('../src/features/crm/dashboard/pages/DashboardPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/routing/CrmSectionContent.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/analytics/services/analyticsService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/types/domain.ts', import.meta.url), 'utf8'),
  ])

  assert.ok(dashboard.indexOf('<span>Cajas abiertas</span>') < dashboard.indexOf('<span>Resumen del catalogo</span>'))
  assert.match(dashboard, /useState\(true\)/)
  assert.match(dashboard, /checked=\{showAllOpenCashSessions\}/)
  assert.match(dashboard, /Todas las cajas del negocio/)
  assert.match(dashboard, /showAll \|\| session\.venueId === selectedVenueId/)
  assert.match(dashboard, /No hay cajas abiertas en el local seleccionado/)
  assert.match(routing, /selectedVenueId=\{selectedVenueId\}/)

  assert.match(service, /venueId: session\.venue_id/)
  assert.doesNotMatch(service, /openSessionsQuery = openSessionsQuery\.eq\('venue_id'/)
  assert.match(domain, /openCashSessions: Array<\{[\s\S]*venueId: string/)
})
