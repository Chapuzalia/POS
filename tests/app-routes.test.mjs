import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getRequiredAppRoute } from '../src/app/app-permissions.ts'
import { getAppRoute, getAppRoutePath } from '../src/app/app-routes.ts'

test('route resolution keeps POS as the fallback', () => {
  assert.equal(getAppRoute('/'), 'pos')
  assert.equal(getAppRoute('/crm/'), 'crm')
  assert.equal(getAppRoute('/superadmin'), 'superadmin')
  assert.equal(getAppRoutePath('pos'), '/')
  assert.equal(getAppRoutePath('crm'), '/crm')
  assert.equal(getAppRoutePath('superadmin'), '/superadmin')
})
test('role chooses the required app route', () => {
  assert.equal(getRequiredAppRoute({ role: 'cashier' }), 'pos')
  assert.equal(getRequiredAppRoute({ role: 'owner' }), 'crm')
  assert.equal(getRequiredAppRoute({ role: 'manager' }), 'crm')
  assert.equal(getRequiredAppRoute({ role: 'superadmin' }), 'superadmin')
})

test('TPV y CRM conservan sesiones Supabase y contextos aislados', async () => {
  const [supabaseClient, offlineStore, router] = await Promise.all([
    readFile(new URL('../src/lib/supabase.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/offlineStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/AppRouter.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(supabaseClient, /club-pos:supabase-auth:\$\{route\}/)
  assert.match(supabaseClient, /storageKey: authStorageKey\(initialAppRoute\)/)
  assert.match(supabaseClient, /moveSupabaseSessionToRoute/)
  assert.match(offlineStore, /`\$\{prefix\}:context:\$\{route\}`/)
  assert.match(offlineStore, /context\.role === 'owner' \|\| context\.role === 'manager'/)
  assert.match(router, /moveSupabaseSessionToRoute\(requiredRoute\)/)
  assert.match(router, /window\.location\.replace\(getAppRoutePath\(requiredRoute\)\)/)
})
