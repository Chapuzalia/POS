import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import ts from 'typescript'
import vm from 'node:vm'
import * as permissions from '../src/features/crm/routing/crmPermissions.ts'
import { hasTenantFeature, normalizeTenantFeatures } from '../src/features/platform/tenantFeatureAccess.ts'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migration = await read('supabase/migrations/20260905120000_separate_supplier_document_addons.sql')
const tenant = '00000000-0000-0000-0000-000000000001'
const venue = '00000000-0000-0000-0000-000000000002'
const scanId = '00000000-0000-0000-0000-000000000003'
const supplierId = '00000000-0000-0000-0000-000000000004'

const bootstrap = `
create role anon; create role authenticated; create role service_role;
create schema auth; create schema storage;
create function auth.uid() returns uuid language sql as $$ select '${tenant}'::uuid $$;
create function auth.role() returns text language sql as $$ select 'authenticated'::text $$;
create function public.user_is_tenant_admin(uuid) returns boolean language sql as $$ select $1 = '${tenant}'::uuid $$;
create function public.user_has_venue_access(uuid, uuid) returns boolean language sql as $$ select false $$;
create table public.platform_features (key text primary key, name text, description text, is_core boolean, is_active boolean default true, enabled_by_default boolean, sort_order integer, updated_at timestamptz);
create table public.tenant_feature_assignments (tenant_id uuid, feature_key text references platform_features(key), unique(tenant_id,feature_key));
create table public.venues(id uuid primary key, tenant_id uuid, is_active boolean default true);
insert into public.venues values ('${venue}', '${tenant}', true);
insert into public.platform_features(key, enabled_by_default) values ('inventory', true);
insert into public.tenant_feature_assignments values ('${tenant}', 'inventory');
create table public.supplier_documents (
  id uuid primary key, tenant_id uuid, venue_id uuid, supplier_id uuid, document_type text,
  document_number text, document_date date, affects_stock boolean default true, stock_applied_at timestamptz,
  status text default 'processing', storage_bucket text, storage_path text, original_file_name text, original_mime_type text,
  file_hash text, created_by uuid, confirmed_at timestamptz, confirmed_by uuid, updated_at timestamptz,
  check ((status = 'confirmed' and confirmed_by is not null and confirmed_at is not null) or (status <> 'confirmed' and confirmed_at is null))
);
insert into public.supplier_documents(id,tenant_id,venue_id,status) values ('${scanId}', '${tenant}', '${venue}', 'review');
create table public.supplier_document_lines(id uuid primary key default gen_random_uuid(), supplier_document_id uuid, tenant_id uuid, venue_id uuid);
create table public.supplier_document_links(tenant_id uuid);
create table public.suppliers(id uuid primary key, tenant_id uuid, venue_id uuid);
insert into public.suppliers values ('${supplierId}', '${tenant}', '${venue}');
create table public.supplier_item_aliases(tenant_id uuid);
create table storage.objects(bucket_id text, name text);
create function public.can_access_supplier_document_object(text) returns boolean language sql as $$ select true $$;
create policy supplier_documents_storage_read on storage.objects for select to authenticated using (public.can_access_supplier_document_object(name));
create policy supplier_documents_storage_insert on storage.objects for insert to authenticated with check (public.can_access_supplier_document_object(name));
create policy supplier_documents_storage_delete on storage.objects for delete to authenticated using (public.can_access_supplier_document_object(name));
create table rpc_audit(name text);
`

async function setup(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(bootstrap)
  // Stub only the existing RPC bodies. The migration's real wrappers, archive
  // functions, privileges, RLS and triggers execute against PostgreSQL.
  for (const match of migration.matchAll(/create function public\.(\w+)\(([^]*?)\)\s*returns (\w+)[^]*?\$\$;?/g)) {
    const [, name, args, type] = match
    if (!migration.includes(`rename to ${name}_without_addon;`)) continue
    if (name === 'can_access_supplier_document_object') continue
    const result = type === 'void' ? '' : type === 'uuid' ? `return '${scanId}'::uuid;` : `return '{}'::jsonb;`
    await db.exec(`create function public.${name}(${args}) returns ${type} language plpgsql as $$ begin insert into public.rpc_audit values ('${name}'); ${result} end; $$;`)
  }
  for (const table of ['supplier_documents', 'supplier_document_lines', 'supplier_document_links', 'suppliers', 'supplier_item_aliases']) {
    await db.exec(`alter table public.${table} enable row level security; create policy existing_access on public.${table} for select to authenticated using (public.user_is_tenant_admin(tenant_id)); grant select on public.${table} to authenticated;`)
  }
  await db.exec(await read('supabase/migrations/20260902004127_persist_supplier_document_stock_choice.sql'))
  await db.exec(migration)
  return db
}
const rows = async (db, sql, args = []) => (await db.query(sql, args)).rows
const enable = (db, ...keys) => db.exec(keys.map((key) => `insert into tenant_feature_assignments values ('${tenant}', '${key}') on conflict do nothing;`).join('\n'))
const createArchive = async (db) => (await rows(db, 'select create_supplier_document_archive($1, $2, $3, $4, $5) as result', [venue, 'invoice', 'factura.pdf', 'application/pdf', 'a'.repeat(64)]))[0].result

test('stock conserva el acceso; archivo y escaneo fallan cerrados incluso con sesiones antiguas', () => {
  assert.equal(hasTenantFeature({}, 'inventory'), true)
  for (const features of [undefined, [], ['inventory']]) {
    assert.equal(hasTenantFeature({ features }, 'supplier_documents'), false)
    assert.equal(hasTenantFeature({ features }, 'supplier_document_scanning'), false)
    assert.equal(permissions.canAccessCrmSection('owner', 'purchases-invoices', features), false)
  }
  assert.equal(permissions.canAccessCrmSection('owner', 'inventory-stock', ['inventory']), true)
  assert.equal(permissions.canAccessCrmSection('manager', 'purchases-invoices', ['supplier_documents']), true)
  assert.equal(permissions.canAccessCrmSection('owner', 'purchases-summary', ['supplier_documents']), false)
  const all = ['inventory', 'supplier_documents', 'supplier_document_scanning']
  assert.equal(hasTenantFeature({ features: all }, 'supplier_document_scanning'), true)
  for (const key of all) assert.equal(hasTenantFeature({ features: all.filter((value) => value !== key) }, 'supplier_document_scanning'), false)
  assert.deepEqual(normalizeTenantFeatures(all), all)
})

test('migracion desactiva addons sin alterar asignaciones de stock ni documentos existentes', async (t) => {
  const db = await setup(t)
  assert.deepEqual(await rows(db, 'select feature_key from tenant_feature_assignments'), [{ feature_key: 'inventory' }])
  assert.ok((await rows(db, "select enabled_by_default from platform_features where key <> 'inventory'")).every((row) => row.enabled_by_default === false))
  assert.deepEqual(await rows(db, 'select processing_mode, status, affects_stock from supplier_documents'), [{ processing_mode: 'scan', status: 'review', affects_stock: true }])
  await assert.rejects(createArchive(db), /SUPPLIER_DOCUMENT_ADDON_DISABLED/)
  await assert.rejects(db.query('select assert_supplier_document_scanning($1)', [scanId]), /SCANNING_DISABLED/)
})

test('archivo independiente: guarda metadatos y original sin costes, lineas ni movimientos', async (t) => {
  const db = await setup(t)
  await db.exec('delete from tenant_feature_assignments')
  await enable(db, 'supplier_documents')
  const file = await createArchive(db)
  const duplicate = await createArchive(db)
  assert.equal(duplicate.documentId, file.documentId)
  assert.equal(duplicate.duplicate, true)
  await assert.rejects(db.query('select save_supplier_document_archive($1,$2,$3,$4)', [file.documentId, supplierId, '2026-09-05', 'F001']), /todavía no se ha subido/)
  await db.query('insert into storage.objects values ($1,$2)', [file.storageBucket, file.storagePath])
  await db.query('select save_supplier_document_archive($1,$2,$3,$4)', [file.documentId, supplierId, '2026-09-05', 'F001'])
  const [document] = await rows(db, 'select * from supplier_documents where id=$1', [file.documentId])
  assert.equal(document.status, 'confirmed')
  assert.equal(document.processing_mode, 'archive')
  assert.equal(document.affects_stock, false)
  assert.equal(document.stock_applied_at, null)
  assert.equal(document.document_number, 'F001')
  assert.deepEqual(await rows(db, 'select * from rpc_audit'), [])
  assert.deepEqual(await rows(db, 'select * from supplier_document_lines'), [])
  await assert.rejects(db.query('select confirm_supplier_document($1,$2,$3)', [file.documentId, '2026-09-05', true]), /SCANNING_DISABLED/)
  await enable(db, 'inventory', 'supplier_document_scanning')
  await assert.rejects(db.query('select assert_supplier_document_scanning($1)', [file.documentId]), /SCANNING_DISABLED/)
  await assert.rejects(db.query('insert into supplier_document_lines(supplier_document_id) values ($1)', [file.documentId]), /SCANNING_DISABLED/)
  await assert.rejects(db.query("update supplier_documents set processing_mode='scan' where id=$1", [file.documentId]), /MODE_IMMUTABLE/)
})

test('RPC de escaneo, costes y correcciones bloqueadas; solo funcionan con los tres permisos', async (t) => {
  const db = await setup(t)
  const calls = [
    `select create_supplier_document('${venue}', 'invoice')`,
    `select create_supplier_document('${venue}', 'invoice', true)`,
    `select confirm_supplier_document('${scanId}', '2026-09-05', true)`,
    `select create_inventory_item_from_supplier_document('${scanId}', 'Item', null, null)`,
    `select update_supplier_document_supplier('${scanId}', null)`,
    `select correct_supplier_document_line('${scanId}', null, null, null, 1, 2, true)`,
    `select save_supplier_document_line('${scanId}', null, null, null, 1, 'kg', 1, 1, 'kg', 2, 0, 1, 2, true, true)`,
    `select replace_supplier_document_lines_from_ocr('${scanId}', null, '[]', false, '[]', null, '{}')`,
  ]
  for (const sql of calls) await assert.rejects(db.query(sql), /(?:ADDON|SCANNING)_DISABLED/)
  assert.deepEqual(await rows(db, 'select * from rpc_audit'), [])
  await enable(db, 'supplier_documents', 'supplier_document_scanning')
  for (const sql of calls) await db.query(sql)
  assert.equal((await rows(db, 'select * from rpc_audit')).length, calls.length)
  await db.exec("delete from tenant_feature_assignments where feature_key='inventory'")
  for (const sql of calls) await assert.rejects(db.query(sql), /(?:ADDON|SCANNING)_DISABLED/)
  await assert.rejects(db.query("update supplier_documents set status='processing' where id=$1", [scanId]), /ADDON_DISABLED/)
})

test('RLS, storage y permisos impiden saltarse el addon; revocarlo bloquea de inmediato', async (t) => {
  const db = await setup(t)
  await db.exec('set role authenticated')
  assert.deepEqual(await rows(db, 'select * from supplier_documents'), [])
  await assert.rejects(db.query('select confirm_supplier_document_without_addon($1,$2,$3)', [scanId, '2026-09-05', true]), /permission denied/)
  await db.exec('reset role')
  await enable(db, 'supplier_documents')
  const file = await createArchive(db)
  await db.exec('set role authenticated')
  assert.equal((await rows(db, 'select id from supplier_documents')).length, 2)
  assert.equal((await rows(db, 'select can_access_supplier_document_object($1) as allowed', [file.storagePath]))[0].allowed, true)
  await db.exec('reset role; delete from tenant_feature_assignments where feature_key=\'supplier_documents\'; set role authenticated')
  assert.deepEqual(await rows(db, 'select id from supplier_documents'), [])
  assert.equal((await rows(db, 'select can_access_supplier_document_object($1) as allowed', [file.storagePath]))[0].allowed, false)
})

for (const duplicateState of ['new', 'uploaded', 'failed-upload']) {
  test(`archivo ${duplicateState}: sube el original y guarda metadatos sin invocar OCR`, async () => {
    const calls = []
    const client = {
      rpc: async (name) => {
        calls.push(name)
        assert.ok(['create_supplier_document_archive', 'save_supplier_document_archive'].includes(name))
        return { data: { documentId: 'document', storageBucket: 'bucket', storagePath: 'path', duplicate: duplicateState !== 'new' }, error: null }
      },
      storage: { from: () => ({
        download: async () => ({ data: duplicateState === 'uploaded' ? new Blob(['file']) : null }),
        upload: async () => { calls.push('upload'); return { error: null } },
      }) },
      functions: { invoke: () => assert.fail('el archivo nunca debe invocar OCR') },
    }
    const exports = {}
    vm.runInNewContext(ts.transpileModule(await read('src/features/crm/purchases/services/documentArchiveService.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports, require: () => ({ requireSupabase: () => client }), crypto,
    })
    await exports.uploadDocumentArchive(venue, 'invoice', new File(['file'], 'factura.pdf', { type: 'application/pdf' }), {
      supplierId: null, documentDate: '2026-09-05', documentNumber: 'F001',
    })
    assert.deepEqual(calls, ['create_supplier_document_archive', ...(duplicateState === 'uploaded' ? [] : ['upload']), 'save_supplier_document_archive'])
  })
}
