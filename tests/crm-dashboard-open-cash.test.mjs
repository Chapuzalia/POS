import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { applyCrmOpenCashSalesTotals, buildHourlySalesStats, buildSalesBreakdowns, buildTopProductCombinations, sortCrmTopProductsByUnits } from '../src/features/crm/analytics/services/analyticsModel.ts'

test('estadisticas agrupa el importe vendido por categoria y producto', () => {
  const breakdown = buildSalesBreakdowns([
    { categoryId: 'bebidas', categoryName: 'Bebidas', productId: 'cola', productName: 'Cola', quantity: 2, totalCents: 500 },
    { categoryId: 'bebidas', categoryName: 'Bebidas', productId: 'agua', productName: 'Agua', quantity: 1, totalCents: 200 },
    { categoryId: null, categoryName: null, productId: null, productName: 'Producto borrado', quantity: 3, totalCents: 300 },
  ])

  assert.deepEqual(breakdown.salesByCategory, [
    { id: 'bebidas', label: 'Bebidas', quantity: 3, totalCents: 700 },
    { id: 'uncategorized', label: 'Sin categoría', quantity: 3, totalCents: 300 },
  ])
  assert.deepEqual(breakdown.salesByProduct.map(({ label, totalCents }) => ({ label, totalCents })), [
    { label: 'Cola', totalCents: 500 },
    { label: 'Producto borrado', totalCents: 300 },
    { label: 'Agua', totalCents: 200 },
  ])
})

test('la card circular alterna categorias y productos y usa los datos del mes cargado', async () => {
  const [statsPage, chart, service] = await Promise.all([
    readFile(new URL('../src/features/crm/analytics/pages/StatsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/analytics/components/SalesBreakdownChart.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/analytics/services/analyticsService.ts', import.meta.url), 'utf8'),
  ])

  assert.match(statsPage, /<SalesBreakdownChart stats=\{stats\}/)
  assert.match(chart, /role="switch"/)
  assert.match(chart, /stats\?\.salesByCategory/)
  assert.match(chart, /stats\?\.salesByProduct/)
  assert.match(service, /category_name_snapshot/)
  assert.match(service, /\.\.\.salesBreakdown/)
})

test('estadisticas separa productos top por mixer y modificadores sin duplicar mixers historicos', () => {
  const combinations = buildTopProductCombinations([
    {
      productName: 'Brugal', quantity: 2, totalCents: 1_600,
      modifiers: [{ id: 'mixer:cola', groupId: 'mixer', name: 'Coca-Cola' }, { id: 'ice', groupId: 'service', name: 'Sin hielo' }],
      components: [{ type: 'mixer', productName: 'Coca-Cola', sortOrder: 0, modifiers: [] }],
    },
    {
      productName: 'Brugal', quantity: 1, totalCents: 800,
      modifiers: [{ id: 'mixer:cola', groupId: 'mixer', name: 'Coca-Cola' }, { id: 'ice', groupId: 'service', name: 'Sin hielo' }],
      components: [],
    },
    {
      productName: 'Brugal', quantity: 2, totalCents: 1_500, modifiers: [],
      components: [{ type: 'mixer', productName: 'Sprite', sortOrder: 0, modifiers: [{ name: 'Limón' }] }],
    },
  ])

  assert.deepEqual(combinations, [
    {
      productName: 'Brugal', mixers: ['Coca-Cola'], modifiers: ['Sin hielo'],
      quantity: 3, totalCents: 2_400,
    },
    {
      productName: 'Brugal', mixers: ['Sprite'], modifiers: ['Sprite · Limón'],
      quantity: 2, totalCents: 1_500,
    },
  ])
})

test('el desglose por combinacion se muestra solo en estadisticas y no cambia el top del dashboard', async () => {
  const [statsPage, dashboardPage] = await Promise.all([
    readFile(new URL('../src/features/crm/analytics/pages/StatsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/dashboard/pages/DashboardPage.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(statsPage, /<TopProductCombinationsList stats=\{stats\}/)
  assert.match(statsPage, /Mixer: \{mixer\}/)
  assert.match(statsPage, /Modificador: \{modifier\}/)
  assert.match(dashboardPage, /<TopProductsList stats=\{stats\}/)
  assert.doesNotMatch(dashboardPage, /TopProductCombinationsList/)
})

test('las ventas por hora se agrupan en la zona horaria del local', () => {
  const hourlySales = buildHourlySalesStats([
    { createdAt: '2026-07-10T18:10:00.000Z', totalCents: 500 },
    { createdAt: '2026-07-11T18:45:00.000Z', totalCents: 1_000 },
    { createdAt: '2026-07-11T22:30:00.000Z', totalCents: 750 },
  ], 'Europe/Madrid')

  assert.equal(hourlySales.length, 24)
  assert.deepEqual(hourlySales[20], { hour: 20, ticketCount: 2, totalCents: 1_500 })
  assert.deepEqual(hourlySales[0], { hour: 0, ticketCount: 1, totalCents: 750 })
})

test('estadisticas permite alternar el grafico horario entre tickets y facturacion', async () => {
  const [statsPage, hourlyChart] = await Promise.all([
    readFile(new URL('../src/features/crm/analytics/pages/StatsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/analytics/components/HourlySalesChart.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(statsPage, /Actividad por hora/)
  assert.match(statsPage, /hora local del establecimiento/)
  assert.match(hourlyChart, /setMetric\('tickets'\)/)
  assert.match(hourlyChart, /setMetric\('revenue'\)/)
  assert.match(hourlyChart, /Más tickets/)
  assert.match(hourlyChart, /Mayor facturación/)
})

test('el selector mensual recarga todos los paneles de estadisticas', async () => {
  const [statsPage, routing, crmPage, analyticsService] = await Promise.all([
    readFile(new URL('../src/features/crm/analytics/pages/StatsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/routing/CrmSectionContent.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/crm/CrmPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/analytics/services/analyticsService.ts', import.meta.url), 'utf8'),
  ])

  assert.match(statsPage, /type="month"/)
  assert.match(statsPage, /max=\{currentMonthKey\}/)
  assert.match(statsPage, /loadedStats\?\.monthKey === selectedMonthKey/)
  assert.match(statsPage, /void onRefresh\(monthKey\)/)
  assert.match(routing, /onRefresh=\{\(monthKey\) => onStatsRefresh\(\{ monthKey \}\)\}/)
  assert.match(crmPage, /loadCrmStats\(context, selectedVenue, options\.monthKey\)/)
  assert.match(analyticsService, /monthKey: selectedMonthKey/)
})

test('los productos top de estadisticas se ordenan primero por unidades vendidas', () => {
  const products = [
    { productName: 'Producto caro', quantity: 2, totalCents: 10_000 },
    { productName: 'Producto popular', quantity: 5, totalCents: 2_500 },
    { productName: 'Producto popular premium', quantity: 5, totalCents: 3_000 },
  ]

  assert.deepEqual(
    sortCrmTopProductsByUnits(products).map((product) => product.productName),
    ['Producto popular premium', 'Producto popular', 'Producto caro'],
  )
})

test('el dashboard muestra primero las cajas y permite filtrar por el local seleccionado', async () => {
  const [dashboard, routing, service, domain] = await Promise.all([
    readFile(new URL('../src/features/crm/dashboard/pages/DashboardPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/routing/CrmSectionContent.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/analytics/services/analyticsService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/types/domain.ts', import.meta.url), 'utf8'),
  ])

  assert.ok(dashboard.indexOf('<span>Cajas abiertas</span>') < dashboard.indexOf('<span>Resumen del catálogo</span>'))
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

test('las cajas abiertas usan el mismo patrón realtime por local que el mapa de mesas', async () => {
  const [crmPage, service, tableService, tableRealtime, publicationMigration] = await Promise.all([
    readFile(new URL('../src/components/crm/CrmPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/analytics/services/analyticsService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/restaurant/hooks/useRestaurantRealtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260725220000_enable_crm_dashboard_realtime.sql', import.meta.url), 'utf8'),
  ])

  for (const table of ['cash_sessions', 'sales']) {
    assert.match(service, new RegExp(`table: '${table}'`))
    assert.match(publicationMigration, new RegExp(`'${table}'`))
  }
  assert.match(service, /channel\(`crm-open-cash:\$\{context\.tenantId\}:\$\{venueId\}`\)/)
  assert.match(service, /filter: `venue_id=eq\.\$\{venueId\}`/)
  assert.match(tableService, /filter: `venue_id=eq\.\$\{context\.venueId\}`/)
  assert.match(service, /\.subscribe\(\(status, error\) => onStatus\?\.\(status, error\)\)/)
  assert.match(crmPage, /venues\.map\(\(venue\) => subscribeToCrmStatsChanges/)
  assert.match(crmPage, /status === 'SUBSCRIBED'/)
  assert.match(crmPage, /window\.setTimeout\(\(\) => void refreshOpenCashSales\(\), 250\)/)
  assert.match(tableRealtime, /realtimeTimer = window\.setTimeout/)
  assert.match(crmPage, /loadCrmOpenCashSalesTotals\(context, cashSessionIds\)/)
  assert.match(crmPage, /setStats\(\(current\) => applyCrmOpenCashSalesTotals\(current, totals\)\)/)
  assert.match(crmPage, /window\.setInterval\(scheduleSalesRefresh, 3000\)/)
  assert.doesNotMatch(crmPage, /window\.setInterval\(refreshCashSessions/)
  assert.match(publicationMigration, /alter publication supabase_realtime add table public\.%I/i)
})

test('la resincronización de ventas solo sustituye el facturado de cada caja abierta', () => {
  const untouchedSession = {
    id: 'session-2',
    venueId: 'venue-2',
    venueName: 'Local 2',
    deviceName: 'Caja 2',
    openedAt: '2026-07-26T08:00:00.000Z',
    openingFloatCents: 5000,
    salesCents: 2500,
    ticketCount: 1,
    cashCents: 2500,
    cardCents: 0,
    invitationCents: 0,
    otherCents: 0,
  }
  const stats = {
    averageTicketCents: 0,
    byPayment: [],
    discountApplications: [],
    discountedTicketCount: 0,
    discountsCents: 0,
    hourlySales: [],
    monthKey: '2026-07',
    monthSalesCents: 0,
    monthTicketCount: 0,
    openCashSessions: [{
      ...untouchedSession,
      id: 'session-1',
      venueId: 'venue-1',
      venueName: 'Local 1',
      deviceName: 'Caja 1',
      salesCents: 1000,
      ticketCount: 1,
      cashCents: 1000,
    }, untouchedSession],
    topProductCombinations: [],
    topProducts: [],
  }

  const next = applyCrmOpenCashSalesTotals(stats, new Map([
    ['session-1', 2750],
    ['session-2', 2500],
  ]))

  assert.equal(next.openCashSessions[0].salesCents, 2750)
  assert.equal(next.openCashSessions[0].ticketCount, 1)
  assert.equal(next.openCashSessions[0].cashCents, 1000)
  assert.equal(next.openCashSessions[0].cardCents, 0)
  assert.equal(next.openCashSessions[1], untouchedSession)
  assert.equal(next.monthSalesCents, stats.monthSalesCents)
})
