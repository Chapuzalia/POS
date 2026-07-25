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

test('las cajas abiertas actualizan el facturado por realtime con fallback periodico', async () => {
  const [crmPage, service, migration] = await Promise.all([
    readFile(new URL('../src/components/crm/CrmPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/analytics/services/analyticsService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260725220000_enable_crm_dashboard_realtime.sql', import.meta.url), 'utf8'),
  ])

  for (const table of ['cash_sessions', 'sales', 'tickets']) {
    assert.match(service, new RegExp(`table: '${table}'`))
    assert.match(migration, new RegExp(`'${table}'`))
  }
  assert.match(service, /\.subscribe\(\(status, error\) => onStatus\?\.\(status, error\)\)/)
  assert.match(crmPage, /status === 'SUBSCRIBED'/)
  assert.match(crmPage, /status === 'CHANNEL_ERROR' \|\| status === 'TIMED_OUT' \|\| status === 'CLOSED'/)
  assert.match(crmPage, /window\.setInterval\(scheduleRefresh, 3000\)/)
  assert.match(crmPage, /window\.setTimeout\(\(\) => void refreshStats\(\{ silent: true \}\), 250\)/)
  assert.match(migration, /alter publication supabase_realtime add table public\.%I/i)
})
