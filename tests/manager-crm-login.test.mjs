import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('manager login creates a backoffice context without requiring a POS device', async () => {
  const [permissions, posService, appShell, sessionLoader] = await Promise.all([
    readFile(new URL('../src/app/app-permissions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/posService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/AppShell.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/session/services/loadTenantState.ts', import.meta.url), 'utf8'),
  ])

  assert.match(permissions, /context\.role === 'owner' \|\| context\.role === 'manager'/)
  assert.match(posService, /membership\.role === 'owner' \|\| membership\.role === 'manager'/)
  assert.match(appShell, /if \(isCrmUser\(context\)\) return <CrmPage/)
  assert.match(sessionLoader, /if \(isBackofficeUser\(context\)\)/)
})

test('manager data access is enabled while owner-only CRM sections stay hidden', async () => {
  const [schema, migration, shell, settings, edgeFunction] = await Promise.all([
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260725213000_enable_manager_crm_access.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/layout/CrmSidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/venues/pages/VenueSettingsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
  ])

  const managerRoles = /tm\.role = any \(array\['owner'::text, 'manager'::text\]\)/
  assert.match(schema, managerRoles)
  assert.match(migration, managerRoles)
  assert.match(shell, /filter\(\(item\) => canAccessCrmSection\(context\.role, item\.id\)\)/)
  assert.match(settings, /if \(isOwner\) void runAction\(refreshPlan\)/)
  assert.match(edgeFunction, /membership\.role !== 'owner'/)
})
