import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('la desactivacion de un negocio corta el acceso sin alterar sus membresias', async () => {
  const migration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')

  assert.match(migration, /is_active boolean default true not null/i)
  assert.match(migration, /join public\.tenants t on t\.id = tm\.tenant_id/)
  assert.match(migration, /and t\.is_active = true/)
  assert.match(migration, /create function public\.user_has_tenant_role\(/i)
})

test('las operaciones de plataforma permanecen restringidas al superadmin', async () => {
  const edgeFunction = await readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')

  for (const action of [
    'platform-update-tenant',
    'platform-set-tenant-active',
    'platform-delete-tenant',
  ]) {
    assert.match(edgeFunction, new RegExp(`action === '${action}'`))
  }

  assert.match(edgeFunction, /if \(!isSuperadmin\)/)
  assert.match(edgeFunction, /adminClient\.from\('tenants'\)\.delete\(\)/)
  assert.match(edgeFunction, /remainingMembership/)
})

test('los limites del plan se aplican en base de datos a todos los recursos', async () => {
  const migration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')

  assert.match(migration, /max_venues integer default 1 not null/i)
  assert.match(migration, /max_devices integer default 5 not null/i)
  assert.doesNotMatch(migration, /max_users/)
  assert.match(migration, /for update/)
  assert.match(migration, /before insert on public\.venues/i)
  assert.match(migration, /before insert on public\.devices/i)
  assert.match(migration, /before insert on public\.tenant_memberships/i)
  assert.match(migration, /Has alcanzado el límite de % de tu plan/)
})

test('el crm puede consultar uso y limites desde una accion protegida', async () => {
  const edgeFunction = await readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')

  assert.match(edgeFunction, /action === 'tenant-plan'/)
  assert.match(edgeFunction, /max_venues, max_devices/)
  assert.doesNotMatch(edgeFunction, /max_users/)
  assert.match(edgeFunction, /usage:/)
  assert.match(edgeFunction, /limits:/)
})

test('los usuarios tpv comparten el limite de dispositivos', async () => {
  const migration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')

  assert.doesNotMatch(migration, /max_users/i)
  assert.match(migration, /if new\.role <> 'cashier'/)
  assert.match(migration, /select max_devices into resource_limit/)
  assert.match(migration, /role = 'cashier'/)
})
