import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the admin tenant role is removed from application and schema authorization', async () => {
  const [domain, permissions, edgeFunction, schema] = await Promise.all([
    readFile(new URL('../src/types/domain.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/app-permissions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(domain, /TenantRole[^\n]*'admin'/)
  assert.doesNotMatch(domain, /role: 'owner' \| 'admin'/)
  assert.match(permissions, /return context\.role === 'owner'/)
  assert.doesNotMatch(permissions, /context\.role === 'admin'/)
  assert.match(edgeFunction, /membership\.role !== 'owner'/)
  assert.match(schema, /ARRAY\['owner'::text, 'manager'::text, 'cashier'::text\]/)
  assert.match(schema, /and tm\.role = 'owner'/)
})

test('the destructive migration deletes admin memberships without guards', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20260724220000_remove_admin_role_destructive.sql', import.meta.url),
    'utf8',
  )

  assert.match(migration, /delete from public\.tenant_memberships\s+where role = 'admin';/i)
  assert.match(migration, /drop constraint tenant_memberships_role_check;/i)
  assert.match(migration, /add constraint tenant_memberships_role_check/i)
  assert.doesNotMatch(migration, /\bif (?:not )?exists\b|do\s+\$\$/i)
})
