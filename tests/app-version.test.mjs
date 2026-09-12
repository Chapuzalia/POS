import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  loadAppVersionStatus,
  resolveAppVersionStatus,
} from '../src/config/appVersion.ts'

test('la política de versión solo produce compatible o actualización requerida', () => {
  const policy = { supportedVersions: ['build-current'] }

  assert.equal(resolveAppVersionStatus('build-current', policy), 'compatible')
  assert.equal(resolveAppVersionStatus('build-previous', policy), 'update-required')
  assert.equal(resolveAppVersionStatus('build-old', policy), 'update-required')
  assert.throws(() => resolveAppVersionStatus('build-current', {}), /política de versiones/i)
})

test('la comprobación remota evita caché y falla sin convertir el error en un tercer estado', async () => {
  let request
  const compatible = await loadAppVersionStatus(async (...args) => {
    request = args
    return new Response(JSON.stringify({ supportedVersions: ['build-current'] }))
  }, 'build-current')

  assert.equal(compatible, 'compatible')
  assert.equal(request[0], '/app-version.json')
  assert.equal(request[1].cache, 'no-store')
  await assert.rejects(
    loadAppVersionStatus(async () => new Response('', { status: 503 }), 'build-current'),
    /No se pudo comprobar/,
  )
})

test('el ciclo de vida comprueba red, foreground y sesiones que permanecen abiertas', async () => {
  const [hook, app, appShell, banner, quickSalePayment, offlineSync, viteConfig, serviceWorkerRegistration] = await Promise.all([
    readFile(new URL('../src/hooks/useAppVersionStatus.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/AppShell.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/feedback/AppUpdateBanner.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/quick-sale/hooks/useQuickSalePayment.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/useOfflineSync.ts', import.meta.url), 'utf8'),
    readFile(new URL('../vite.config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pwa/registerServiceWorker.ts', import.meta.url), 'utf8'),
  ])

  assert.match(hook, /\[isOnline\]/)
  assert.match(hook, /visibilitychange/)
  assert.match(hook, /addEventListener\('focus'/)
  assert.match(hook, /setInterval/)
  assert.match(hook, /ACTIVE_SESSION_CHECK_INTERVAL_MS/)
  assert.match(hook, /catch \{[\s\S]*must never stop the POS/)
  assert.match(app, /versionStatus=\{versionStatus\}/)
  assert.match(appShell, /AppUpdateBanner blocked=\{updateBlocked\} status=\{versionStatus\}/)
  assert.match(appShell, /quickSale\.paymentInFlight/)
  assert.match(appShell, /quickSale\.cashPaymentOpen/)
  assert.match(appShell, /offline\.isSyncing/)
  assert.match(appShell, /offline\.pendingCount > 0/)
  assert.match(appShell, /offline\.rejectedSaleEvent/)
  assert.match(appShell, /auxiliaryOperationBusy/)
  assert.match(appShell, /!networkOnline/)
  assert.match(appShell, /restaurant\.saveState !== 'saved'/)
  assert.match(appShell, /reservations\.isLoading/)
  assert.match(appShell, /cash\.movementSaving/)
  assert.match(appShell, /cash\.printingClosingId/)
  assert.match(appShell, /cashlogyPaymentActive/)
  assert.match(appShell, /cashlogyManagementActive/)
  assert.match(appShell, /localHardwareActive/)
  assert.match(quickSalePayment, /onPaymentInFlightChange\?\.\(true\)/)
  assert.match(offlineSync, /setIsSyncing\(true\)/)
  assert.match(banner, /!blocked[\s\S]*window\.location\.reload\(\)/)
  assert.doesNotMatch(banner, /useEffect|setTimeout|setInterval/)
  assert.match(viteConfig, /fileName: 'app-version\.json'/)
  assert.match(viteConfig, /SUPPORTED_APP_VERSIONS/)
  assert.match(serviceWorkerRegistration, /sw\.js\?v=/)
})
