import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [appShell, posPage, crmSections, main, viteConfig] = await Promise.all([
  readFile(new URL('../src/app/AppShell.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crm/routing/CrmSectionContent.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../vite.config.ts', import.meta.url), 'utf8'),
])

test('las superficies principales se cargan bajo demanda según el rol', () => {
  assert.match(appShell, /lazy\(\(\) => import\('\.\/PosPage'\)/)
  assert.match(appShell, /lazy\(\(\) => import\('\.\.\/components\/crm\/CrmPage'\)/)
  assert.match(appShell, /lazy\(\(\) => import\('\.\.\/components\/superadmin\/SuperAdminPage'\)/)
  assert.match(appShell, /lazy\(\(\) => import\('\.\.\/features\/production\/components\/KdsPage'\)/)
})

test('reservas y preparaciones no forman parte del chunk inicial del TPV', () => {
  assert.match(posPage, /lazy\(\(\) => import\('\.\.\/features\/reservations\/components\/ReservationsPage'\)/)
  assert.match(posPage, /lazy\(\(\) => import\('\.\.\/features\/inventory\/InventoryPreparationsPanel'\)/)
  assert.doesNotMatch(posPage, /from ['"]\.\.\/features\/reservations['"];/)
})

test('cada sección pesada del CRM conserva su frontera de carga diferida', () => {
  assert.match(crmSections, /lazy\(\(\) => import\('\.\.\/dashboard\/pages\/DashboardPage'\)/)
  assert.match(crmSections, /lazy\(\(\) => import\('\.\.\/inventory\/pages\/InventoryStockPage'\)/)
  assert.match(crmSections, /lazy\(\(\) => import\('\.\.\/catalog\/pages\/CatalogProductsPage\.tsx'\)/)
  assert.match(crmSections, /lazy\(\(\) => import\('\.\.\/sales\/pages\/SalesReportsPage'\)/)
})

test('Sentry se inicializa después del primer render y mantiene un error boundary local', () => {
  assert.match(main, /window\.setTimeout\(\(\) => void import\('\.\/sentry\.ts'\), 0\)/)
  assert.match(main, /<AppErrorBoundary fallback=\{sentryFallback\}>/)
  assert.doesNotMatch(main, /import \* as Sentry/)
})

test('Rolldown separa los proveedores grandes en grupos estables', () => {
  for (const group of ['vendor-react', 'vendor-supabase', 'vendor-validation', 'vendor-sentry']) {
    assert.match(viteConfig, new RegExp(`name: ['"]${group}['"]`))
  }
  assert.match(viteConfig, /codeSplitting:/)
  assert.match(viteConfig, /chunkSizeWarningLimit: 1000/)
  assert.doesNotMatch(viteConfig, /name: ['"]vendor-ui['"]/)
})
