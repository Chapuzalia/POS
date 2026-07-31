import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the app uses a visual-viewport height without disabling accessible scaling', async () => {
  const [html, app, page, header, styles] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/layout/AppHeader.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(html, /maximum-scale=1/)
  assert.doesNotMatch(html, /user-scalable=no/)
  assert.match(html, /viewport-fit=cover/)
  assert.match(app, /h-\[var\(--app-height,100dvh\)\]/)
  assert.match(app, /useIOSPWAViewportFix/)
  assert.match(page, /h-full/)
  assert.match(page, /safe-area-inset-bottom/)
  assert.match(header, /safe-area-inset-top/)
  assert.match(styles, /#root[\s\S]+height: var\(--app-height, 100dvh\)/)
  assert.match(styles, /font-size: max\(16px, 1em\)/)
})

test('the global hook repairs only installed iOS/iPadOS PWA viewports', async () => {
  const [hook, styles, mapView, viewport] = await Promise.all([
    readFile(new URL('../src/hooks/useIOSPWAViewportFix.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/components/TableMapView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/useMapViewport.ts', import.meta.url), 'utf8'),
  ])

  assert.match(hook, /iPad\|iPhone\|iPod/)
  assert.match(hook, /platform === 'MacIntel'/)
  assert.match(hook, /maxTouchPoints > 1/)
  assert.match(hook, /standalone === true/)
  assert.match(hook, /display-mode: standalone/)
  assert.match(hook, /window\.visualViewport/)
  assert.match(hook, /viewport\.addEventListener\('resize'/)
  assert.doesNotMatch(hook, /viewport\.addEventListener\('scroll'/)
  assert.doesNotMatch(hook, /viewport\.removeEventListener\('scroll'/)
  assert.match(hook, /window\.innerHeight - viewport\.height/)
  assert.match(hook, /--app-height/)
  assert.match(hook, /window\.scrollTo\(0, 0\)/)
  assert.match(hook, /document\.documentElement\.scrollTop = 0/)
  assert.match(hook, /document\.body\.scrollTop = 0/)
  assert.match(hook, /requestAnimationFrame/)
  assert.match(hook, /setTimeout/)
  assert.match(hook, /focusout/)
  assert.match(hook, /pageshow/)
  assert.match(hook, /visibilitychange/)
  assert.match(styles, /html,\s*body\s*\{[^}]*overflow:\s*hidden;[^}]*overscroll-behavior:\s*none;/)
  assert.match(styles, /#root\s*\{[^}]*overflow:\s*hidden;[^}]*overscroll-behavior:\s*none;/)
  assert.doesNotMatch(styles, /touch-action:\s*none/)
  assert.doesNotMatch(hook, /touch(?:start|move)/)
  assert.doesNotMatch(styles, /body\.pos-viewport-locked/)
  assert.doesNotMatch(styles, /body[^{]*\{[^}]*position:\s*fixed/)
  assert.match(mapView, /touch-none/)
  assert.match(mapView, /cursor-grab/)
  assert.doesNotMatch(styles, /\.table-map-canvas\b/)
  assert.match(viewport, /pinchRef/)
  assert.match(viewport, /zoomAtPoint/)
})

test('POS vertical scroll zones keep momentum and contain overscroll', async () => {
  const sources = await Promise.all([
    '../src/components/pos/CatalogPanel.tsx',
    '../src/components/pos/TicketPanel.tsx',
    '../src/components/modals/SessionTicketsModal.tsx',
    '../src/components/modals/CashClosingsHistoryModal.tsx',
    '../src/components/modals/ProductDialog.tsx',
    '../src/components/modals/ConfigModal.tsx',
    '../src/features/reservations/components/ReservationsPage.tsx',
    '../src/features/reservations/components/ReservationList.tsx',
    '../src/features/reservations/components/ReservationFormModal.tsx',
    '../src/features/reservations/components/ReservationDetailPanel.tsx',
    '../src/features/reservations/components/ReservationMapView.tsx',
    '../src/features/tables/components/RestaurantOrderPanel.tsx',
    '../src/features/tables/components/TableMapView.tsx',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')))

  for (const source of sources) {
    assert.match(source, /overflow-y-auto/)
    assert.match(source, /overscroll-contain/)
    assert.match(source, /\[-webkit-overflow-scrolling:touch\]/)
  }
})
