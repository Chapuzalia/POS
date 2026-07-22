import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('CRM login defers catalog loading until a venue has been selected', async () => {
  const sessionSource = await readFile(new URL('../src/features/session/services/loadTenantState.ts', import.meta.url), 'utf8')
  const hookSource = await readFile(new URL('../src/features/crm/catalog/hooks/useCatalogAdmin.ts', import.meta.url), 'utf8')
  const adminBranch = sessionSource.match(/if \(isCrmAdministrator\(context\)\) \{([\s\S]*?)\n  \}/)?.[1] ?? ''

  assert.match(adminBranch, /catalog: null/)
  assert.doesNotMatch(adminBranch, /loadCatalogFromSupabase/)
  assert.match(hookSource, /if \(!venueId \|\| !enabled\)/)
  assert.match(hookSource, /if \(enabled && venueId\) void refresh\(false\)/)
})

test('CRM catalog mutations refresh the projection for the selected venue', async () => {
  const appShellSource = await readFile(new URL('../src/app/AppShell.tsx', import.meta.url), 'utf8')
  const crmPageSource = await readFile(new URL('../src/components/crm/CrmPage.tsx', import.meta.url), 'utf8')

  assert.match(crmPageSource, /onCatalogChanged: \(venueId: string\) => Promise<void>/)
  assert.match(crmPageSource, /onCatalogChanged\(selectedVenueId\)/)
  assert.match(appShellSource, /onCatalogChanged=\{\(venueId\) => refreshCatalog\(\{ \.\.\.context, venueId \}\)\}/)
  assert.doesNotMatch(appShellSource, /onCatalogChanged=\{\(\) => refreshCatalog\(context\)\}/)
})
