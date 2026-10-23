import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const readMigration = (name) => readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8')
const migration = await readMigration('20261023160909_restore_supplier_document_storage_policies')
const receipts = await readMigration('20260901120000_add_supplier_document_receipts')
const deletion = await readMigration('20261006161932_add_supplier_document_deletion')
const managerAccess = await readMigration('20260725213000_enable_manager_crm_access')
const baseHelper = receipts.match(/create or replace function public\.can_access_supplier_document_object\(p_name text\)[\s\S]*?\n\$\$;/)[0]
const currentHelper = deletion.match(/create or replace function public\.can_access_supplier_document_object\(p_name text\)[\s\S]*?\n\$\$;/)[0]
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const tenant = id(1), venue = id(2), otherVenue = id(3), documentId = id(4)
const owner = id(10), cashier = id(11), outsider = id(12), otherCashier = id(13)
const path = `${tenant}/${venue}/${documentId}/image.webp`

test('la restauración de Storage es expand y compatible', () => {
  assert.deepEqual(analyzeMigration(migration), [])
})

test('las policies reparadas conservan los límites reales del documento', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function storage.foldername(text) returns text[] language sql as $$
      select (string_to_array($1, '/'))[1:array_length(string_to_array($1, '/'), 1) - 1] $$;
    create table public.tenant_memberships (tenant_id uuid, user_id uuid, role text, is_active boolean);
    create table public.device_user_assignments (tenant_id uuid, venue_id uuid, user_id uuid, is_active boolean);
    create function public.user_has_venue_access(target_tenant uuid, target_venue uuid)
      returns boolean language sql stable security definer set search_path = '' as $$
      select exists (
        select 1 from public.device_user_assignments dua join public.tenant_memberships tm
          on tm.tenant_id = dua.tenant_id and tm.user_id = dua.user_id
        where dua.tenant_id = target_tenant and dua.venue_id = target_venue and dua.user_id = auth.uid()
          and dua.is_active and tm.is_active and tm.role = 'cashier') $$;
    create function public.supplier_documents_feature_enabled(uuid) returns boolean language sql as $$
      select coalesce(current_setting('test.purchases', true), 'true') <> 'false' $$;
    create table public.supplier_documents (
      id uuid primary key, tenant_id uuid, venue_id uuid, storage_bucket text, storage_path text, deleted_at timestamptz);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema auth, storage to authenticated, anon;
    grant select, insert, update, delete on storage.objects to authenticated, anon;
    insert into public.tenant_memberships values
      ('${tenant}', '${owner}', 'owner', true), ('${tenant}', '${cashier}', 'cashier', true),
      ('${id(99)}', '${outsider}', 'owner', true), ('${tenant}', '${otherCashier}', 'cashier', true);
    insert into public.device_user_assignments values
      ('${tenant}', '${venue}', '${cashier}', true), ('${tenant}', '${otherVenue}', '${otherCashier}', true);
    insert into public.supplier_documents values ('${documentId}', '${tenant}', '${venue}', 'supplier-documents', '${path}', null);
    insert into storage.objects(bucket_id, name) values ('supplier-documents', '${path}'), ('product-images', '${path}');
  `)
  await db.exec(managerAccess)
  await db.exec(baseHelper)
  await db.exec('alter function public.can_access_supplier_document_object(text) rename to can_access_supplier_document_object_without_addon')
  await db.exec(currentHelper)
  const asUser = async (user, role = 'authenticated') => {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? ''])
    await db.exec(`set role ${role}`)
  }
  const visible = async () => (await db.query('select bucket_id from storage.objects')).rows

  await t.test('reproduce el fallo sin policies y recupera lectura sin cambiar el objeto', async () => {
    await asUser(owner)
    assert.deepEqual(await visible(), [])
    await db.exec('reset role')
    await db.exec(migration)
    await asUser(owner)
    assert.deepEqual(await visible(), [{ bucket_id: 'supplier-documents' }])
  })

  await t.test('permite el local asignado y bloquea otro local, tenant, usuario desconocido y anon', async () => {
    await asUser(cashier)
    assert.equal((await visible()).length, 1)
    for (const user of [otherCashier, outsider, id(100), null]) {
      await asUser(user)
      assert.deepEqual(await visible(), [])
    }
    await asUser(owner, 'anon')
    assert.deepEqual(await visible(), [])
  })

  await t.test('la revocación del addon, la baja del documento y membresías inactivas siguen bloqueando', async () => {
    await asUser(owner)
    await db.exec("select set_config('test.purchases', 'false', false)")
    assert.deepEqual(await visible(), [])
    await db.exec("select set_config('test.purchases', 'true', false); reset role")
    await db.exec('update public.supplier_documents set deleted_at = now()')
    await asUser(owner)
    assert.deepEqual(await visible(), [])
    await db.exec('reset role; update public.supplier_documents set deleted_at = null; update public.tenant_memberships set is_active = false')
    await asUser(owner)
    assert.deepEqual(await visible(), [])
    await asUser(cashier)
    assert.deepEqual(await visible(), [])
    await db.exec('reset role; update public.tenant_memberships set is_active = true')
  })

  await t.test('subida limitada a la ruta registrada; no permite sobrescribir originales', async () => {
    await asUser(owner)
    await db.query("insert into storage.objects(bucket_id, name) values ('supplier-documents', $1)", [path])
    for (const [bucket, name] of [
      ['supplier-documents', `${tenant}/${venue}/${documentId}/otro.webp`],
      ['supplier-documents', `${tenant}/${otherVenue}/${documentId}/image.webp`],
      ['supplier-documents', 'ruta/invalida/image.webp'],
      ['product-images', path],
    ]) {
      await assert.rejects(db.query('insert into storage.objects(bucket_id, name) values ($1, $2)', [bucket, name]), { code: '42501' })
    }
    assert.equal((await db.query("update storage.objects set name = 'replacement' returning id")).rows.length, 0)
    await asUser(outsider)
    await assert.rejects(db.query("insert into storage.objects(bucket_id, name) values ('supplier-documents', $1)", [path]), { code: '42501' })
    assert.equal((await db.query('delete from storage.objects returning id')).rows.length, 0)
    await asUser(owner)
    assert.equal((await db.query('delete from storage.objects returning id')).rows.length, 2)
    await db.exec('reset role')
    assert.deepEqual(await visible(), [{ bucket_id: 'product-images' }])
  })

  await t.test('las tres policies nuevas solo conceden los comandos previstos a authenticated y conservan RLS', async () => {
    const policies = (await db.query("select cmd, roles from pg_policies where schemaname = 'storage' order by cmd")).rows
    assert.deepEqual(policies, ['DELETE', 'INSERT', 'SELECT'].map((cmd) => ({ cmd, roles: ['authenticated'] })))
    assert.equal((await db.query("select relrowsecurity from pg_class where oid = 'storage.objects'::regclass")).rows[0].relrowsecurity, true)
  })
})

test('la migración es aditiva en instalaciones con las policies históricas presentes', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role authenticated;
    create schema storage;
    create table storage.objects (bucket_id text, name text);
    create function public.can_access_supplier_document_object(text) returns boolean language sql as $$ select true $$;
  `)
  const originals = receipts.match(/create policy supplier_documents_storage_read[\s\S]*?(?=create or replace function public\.create_supplier_document)/)[0]
  await db.exec(originals)
  const originalPolicies = (await db.query("select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'storage' order by policyname")).rows
  await db.exec(migration)
  const allPolicies = (await db.query("select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'storage' order by policyname")).rows
  assert.deepEqual(allPolicies.filter((policy) => policy.policyname.startsWith('supplier_documents_storage_')), originalPolicies)
  for (const policy of allPolicies.filter((policy) => policy.policyname.startsWith('supplier_document_originals_'))) {
    const original = originalPolicies.find((candidate) => candidate.cmd === policy.cmd)
    assert.deepEqual({ ...policy, policyname: original.policyname }, original)
  }
})
