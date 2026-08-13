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

test('manager data access is scoped by venue while true owner-only sections stay hidden', async () => {
  const [schema, migration, scopeMigration, shell, settings, integrations, edgeFunction] = await Promise.all([
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260725213000_enable_manager_crm_access.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260805000000_add_manager_venue_assignments.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/layout/CrmSidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/venues/pages/VenueSettingsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/integrations/pages/IntegrationsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
  ])

  const managerRoles = /tm\.role = any \(array\['owner'::text, 'manager'::text\]\)/
  assert.match(schema, managerRoles)
  assert.match(migration, managerRoles)
  assert.match(shell, /filter\(\(item\) => canAccessCrmSection\(context\.role, item\.id, context\.features\)\)/)
  assert.match(settings, /if \(isOwner\) void runAction\(refreshPlan\)/)
  assert.match(integrations, /const canEdit = tenantContext\.role === 'owner'/)
  assert.match(integrations, /Puedes consultar la integración/)
  assert.match(scopeMigration, /create table if not exists public\.manager_venue_assignments/i)
  assert.match(edgeFunction, /\['owner', 'manager'\]\.includes\(membership\.role\)/)
  assert.match(edgeFunction, /canManageVenue\(device\.venue_id\)/)
  assert.match(edgeFunction, /Un manager no puede crear otros usuarios gestores/)
})
