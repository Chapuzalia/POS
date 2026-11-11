import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const readMigration = (name) => readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8')
const migration = await readMigration('20261110200000_restore_product_image_storage_policies')
const billing = await readMigration('20261101164502_tenant_stripe_onboarding')
const canOperate = billing.match(/create function billing_private\.can_operate\(target_tenant uuid\)[\s\S]*?\n\$\$;/)[0]
const tenantAdmin = billing.match(/create or replace function public\.user_is_tenant_admin\(target_tenant uuid\)[\s\S]*?\n\$\$;/)[0]
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const tenant = id(1), otherTenant = id(2), venue = id(3)
const owner = id(10), manager = id(11), cashier = id(12), outsider = id(13)
const path = (tenantId, file = 'image.webp') => `${tenantId}/${venue}/products/${id(50)}/${file}`

test('las policies de product-images permiten importar imágenes solo al propio negocio', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema storage; create schema billing_private;
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function storage.foldername(text) returns text[] language sql as $$
      select (string_to_array($1, '/'))[1:array_length(string_to_array($1, '/'), 1) - 1] $$;
    create table public.tenants (id uuid primary key, billing_activation_required boolean);
    create table public.profiles (id uuid primary key, is_superadmin boolean);
    create table public.tenant_memberships (tenant_id uuid, user_id uuid, role text, is_active boolean);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema auth, storage to authenticated, anon;
    grant select, insert, update, delete on storage.objects to authenticated, anon;
    insert into public.tenants values ('${tenant}', false), ('${otherTenant}', false);
    insert into public.tenant_memberships values
      ('${tenant}', '${owner}', 'owner', true), ('${tenant}', '${manager}', 'manager', true),
      ('${tenant}', '${cashier}', 'cashier', true), ('${otherTenant}', '${outsider}', 'owner', true);
  `)
  await db.exec(canOperate)
  await db.exec(tenantAdmin)
  const asUser = async (user, role = 'authenticated') => {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? ''])
    await db.exec(`set role ${role}`)
  }
  const upload = (name) => db.query("insert into storage.objects(bucket_id, name) values ('product-images', $1)", [name])

  await t.test('reproduce el 403 sin policies y lo corrige con la migración', async () => {
    await asUser(owner)
    await assert.rejects(upload(path(tenant)), { code: '42501' })
    await db.exec('reset role')
    await db.exec(migration)
    await asUser(owner)
    await upload(path(tenant))
    assert.equal((await db.query('select 1 from storage.objects')).rows.length, 1)
  })

  await t.test('owner y manager suben; cajero, otro negocio, desconocido y anon no', async () => {
    await asUser(manager)
    await upload(path(tenant, 'manager.webp'))
    for (const user of [cashier, outsider, id(99), null]) {
      await asUser(user)
      await assert.rejects(upload(path(tenant, 'x.webp')), { code: '42501' })
    }
    await asUser(owner, 'anon')
    await assert.rejects(upload(path(tenant, 'anon.webp')), { code: '42501' })
  })

  await t.test('un owner no puede escribir en la carpeta de otro negocio ni en otros buckets', async () => {
    await asUser(owner)
    await assert.rejects(upload(path(otherTenant)), { code: '42501' })
    await assert.rejects(db.query("insert into storage.objects(bucket_id, name) values ('supplier-documents', $1)", [path(tenant, 'doc.webp')]), { code: '42501' })
  })

  await t.test('negocio pendiente de pago o membresía inactiva bloquea la subida', async () => {
    await db.exec(`reset role; update public.tenants set billing_activation_required = true where id = '${tenant}'`)
    await asUser(owner)
    await assert.rejects(upload(path(tenant, 'billing.webp')), { code: '42501' })
    await db.exec(`reset role; update public.tenants set billing_activation_required = false; update public.tenant_memberships set is_active = false where user_id = '${owner}'`)
    await asUser(owner)
    await assert.rejects(upload(path(tenant, 'inactive.webp')), { code: '42501' })
    await db.exec(`reset role; update public.tenant_memberships set is_active = true`)
  })

  await t.test('lectura y borrado limitados al propio negocio; sin policy de UPDATE', async () => {
    await db.exec(`reset role; insert into storage.objects(bucket_id, name) values ('product-images', '${path(otherTenant)}')`)
    await asUser(outsider)
    assert.equal((await db.query('select 1 from storage.objects')).rows.length, 1)
    await asUser(owner)
    assert.equal((await db.query('select 1 from storage.objects')).rows.length, 2)
    assert.equal((await db.query("update storage.objects set name = 'replacement' returning id")).rows.length, 0)
    assert.equal((await db.query('delete from storage.objects returning id')).rows.length, 2)
    await db.exec('reset role')
    assert.equal((await db.query('select 1 from storage.objects')).rows.length, 1)
    const policies = (await db.query("select cmd, roles from pg_policies where schemaname = 'storage' order by cmd")).rows
    assert.deepEqual(policies, ['DELETE', 'INSERT', 'SELECT'].map((cmd) => ({ cmd, roles: ['authenticated'] })))
  })
})
