import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { assertEmptyAnalyticsSql, catalogSql, checkManagedColumns, resetSql, selectRestoreEntries, targetConfig, verificationSql } from '../scripts/copy-vps-supabase-to-staging.mjs'

const ref = 'abcdefghijklmnopqrst'
const config = { STAGING_PROJECT_REF: ref, STAGING_DB_HOST: `db.${ref}.supabase.co`, STAGING_DB_USER: 'postgres', STAGING_DB_PASSWORD: 'private' }

test('el destino exige ref/host/usuario coherentes y rechaza el transaction pooler', () => {
  assert.equal(targetConfig(config).PGSSLMODE, 'require')
  const clean = targetConfig({ ...config, PGHOSTADDR: 'production', PGSERVICE: 'production',
    PGSERVICEFILE: '', PGOPTIONS: 'production', pgservicefile: 'production', pghost: 'production', PGPASSFILE: 'production' })
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'pgservicefile', 'pghost', 'PGPASSFILE']) {
    assert.equal(Object.hasOwn(clean, key), false)
  }
  assert.equal(clean.PGPASSWORD, config.STAGING_DB_PASSWORD)
  assert.equal(targetConfig({ ...config, STAGING_DB_HOST: 'aws-1-eu-west-1.pooler.supabase.com', STAGING_DB_USER: `postgres.${ref}` }).PGHOST, 'aws-1-eu-west-1.pooler.supabase.com')
  assert.throws(() => targetConfig({ ...config, STAGING_DB_HOST: 'db.zyxwvutsrqponmlkjihg.supabase.co' }), /no corresponde/)
  assert.throws(() => targetConfig({ ...config, STAGING_DB_PORT: '6543' }), /5432/)
  assert.throws(() => targetConfig({ ...config, STAGING_DB_USER: 'postgres.production' }), /no corresponde/)
})

test('la autenticación por pgpass omite contraseña y archivo de servicio heredados', () => {
  const clean = targetConfig({ ...config, STAGING_DB_PASSWORD: '', STAGING_PGPASSFILE: '/private/staging.pgpass',
    PGPASSWORD: 'production', PGSERVICEFILE: '' })
  assert.equal(Object.hasOwn(clean, 'PGPASSWORD'), false)
  assert.equal(Object.hasOwn(clean, 'PGSERVICEFILE'), false)
  assert.equal(clean.PGPASSFILE, '/private/staging.pgpass')
})

test('restaura el ledger completo y las ACL/RLS de app, evitando DDL de Supabase gestionado', () => {
  const toc = [
    '1; 2615 1 SCHEMA - public postgres',
    '2; 2615 2 SCHEMA - supabase_migrations postgres',
    '3; 1259 3 TABLE supabase_migrations schema_migrations postgres',
    '4; 0 3 TABLE DATA supabase_migrations schema_migrations postgres',
    '5; 0 4 TABLE DATA supabase_migrations seed_files postgres',
    '6; 0 5 TABLE DATA auth users supabase_auth_admin',
    '7; 1259 5 TABLE auth users supabase_auth_admin',
    '8; 0 6 TABLE DATA auth schema_migrations supabase_auth_admin',
    '9; 0 7 TABLE DATA storage migrations supabase_storage_admin',
    '10; 3256 8 POLICY storage objects supplier_documents_storage_read postgres',
    '11; 2620 9 TRIGGER auth users create_profile supabase_auth_admin',
    '12; 2620 10 TRIGGER auth users internal_trigger supabase_auth_admin',
    '13; 0 11 ACL public TABLE tenants postgres',
    '14; 3256 12 POLICY public tenants tenant_isolation postgres',
    '15; 1255 13 FUNCTION pos_private lock_cash_session(uuid) postgres',
    '16; 1255 14 FUNCTION auth public() supabase_auth_admin',
    '17; 0 15 TABLE DATA storage objects supabase_storage_admin',
    '18; 0 16 TABLE DATA storage vector_indexes supabase_storage_admin',
    '19; 0 17 TABLE DATA storage iceberg_namespaces supabase_storage_admin',
    '20; 0 18 TABLE DATA storage iceberg_tables supabase_storage_admin',
    '21; 0 19 TABLE DATA storage buckets_analytics supabase_storage_admin',
    '22; 3256 20 POLICY storage iceberg_namespaces cloud_only supabase_storage_admin',
    '23; 2620 21 TRIGGER storage iceberg_namespaces custom_analytics supabase_storage_admin',
    '24; 826 22 DEFAULT ACL public DEFAULT PRIVILEGES FOR SEQUENCES supabase_admin',
    '25; 826 23 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES supabase_admin',
    '26; 826 24 DEFAULT ACL public DEFAULT PRIVILEGES FOR FUNCTIONS supabase_admin',
    '27; 826 25 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES postgres',
    '28; 826 26 DEFAULT ACL public DEFAULT PRIVILEGES FOR FUNCTIONS custom_app_role',
    '29; 0 27 ACL public FUNCTION secured_rpc(uuid) supabase_admin',
  ].join('\n')
  const { list, dataTables, skippedManagedDefaultAcls } = selectRestoreEntries(toc, new Set(['auth.users.create_profile', 'storage.iceberg_namespaces.custom_analytics']))
  for (const id of [1, 2, 3, 4, 5, 6, 10, 11, 13, 14, 15, 17, 27, 28, 29]) assert.match(list, new RegExp(`^${id};`, 'm'))
  for (const id of [7, 8, 9, 12, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26]) assert.doesNotMatch(list, new RegExp(`^${id};`, 'm'))
  assert.deepEqual(dataTables, ['auth.users', 'storage.objects'])
  assert.equal(skippedManagedDefaultAcls.length, 3)
  assert.throws(() => selectRestoreEntries(toc.replace('TABLE DATA supabase_migrations schema_migrations', 'TABLE DATA auth schema_migrations'), new Set()), /historial incompleto/)
})

test('solo se omite Analytics vacío, usando el contenido del snapshot y sin ignorar filas', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'staging-analytics-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sql = join(dir, 'analytics.sql')
  await writeFile(sql, 'COPY storage.iceberg_namespaces (id) FROM stdin;\n\\.\nCOPY storage.buckets_analytics (id) FROM stdin;\n\\.\n')
  await assertEmptyAnalyticsSql(sql)
  await writeFile(sql, 'COPY storage.iceberg_namespaces (id) FROM stdin;\nexisting-id\n\\.\n')
  await assert.rejects(() => assertEmptyAnalyticsSql(sql), /contiene datos de Analytics/)
  await writeFile(sql, 'COPY storage.iceberg_namespaces (id) FROM stdin;\n')
  await assert.rejects(() => assertEmptyAnalyticsSql(sql), /incompleto/)
})

test('rechaza diferencias de columnas gestionadas antes de tocar staging', () => {
  const column = { schema: 'auth', table: 'users', column: 'id', type: 'pg_catalog.uuid', nullable: 'NO', default: null, identity: 'NO' }
  const source = { columns: [column] }
  checkManagedColumns(source, source, ['auth.users'])
  assert.throws(() => checkManagedColumns(source, { columns: [] }, ['auth.users']), /incompatible/)
  assert.throws(() => checkManagedColumns(source, { columns: [column, { ...column, column: 'new_required' }] }, ['auth.users']), /requiere/)
  checkManagedColumns(source, { columns: [column, { ...column, column: 'new_optional', nullable: 'YES' }] }, ['auth.users'])
})

async function fixture(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA supabase_migrations; CREATE SCHEMA pos_private;
    CREATE TABLE auth.schema_migrations(version text PRIMARY KEY);
    INSERT INTO auth.schema_migrations VALUES ('cloud-auth-version');
    CREATE TABLE storage.migrations(id integer PRIMARY KEY);
    INSERT INTO storage.migrations VALUES (42);
    CREATE TABLE auth.users(id integer PRIMARY KEY);
    CREATE TABLE auth.sessions(id integer PRIMARY KEY, user_id integer REFERENCES auth.users);
    CREATE TABLE auth.refresh_tokens(id bigserial PRIMARY KEY, user_id integer REFERENCES auth.users);
    CREATE TABLE storage.buckets(id text PRIMARY KEY);
    CREATE TABLE storage.objects(id integer PRIMARY KEY, bucket_id text REFERENCES storage.buckets);
    CREATE TABLE storage.buckets_analytics(id text PRIMARY KEY);
    CREATE TABLE storage.iceberg_namespaces(id serial PRIMARY KEY, catalog_id text REFERENCES storage.buckets_analytics);
    CREATE TABLE storage.iceberg_tables(id integer PRIMARY KEY, namespace_id integer REFERENCES storage.iceberg_namespaces);
    INSERT INTO storage.buckets_analytics VALUES ('cloud-only');
    INSERT INTO storage.iceberg_namespaces(catalog_id) VALUES ('cloud-only');
    INSERT INTO storage.iceberg_tables VALUES (1,1);
    CREATE POLICY cloud_analytics ON storage.iceberg_namespaces USING (true);
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, statements text[], name text);
    INSERT INTO supabase_migrations.schema_migrations VALUES ('staging-only', ARRAY['staging SQL'], 'staging');
    CREATE TABLE public.sales(id integer PRIMARY KEY, user_id integer REFERENCES auth.users, total_cents integer);
    INSERT INTO auth.users VALUES (1); INSERT INTO auth.sessions VALUES (1,1);
    INSERT INTO auth.refresh_tokens(user_id) VALUES (1);
    INSERT INTO storage.buckets VALUES ('old'); INSERT INTO storage.objects VALUES (1,'old');
    INSERT INTO public.sales VALUES (1,1,1234);
    CREATE POLICY old_staging ON storage.objects USING (true);
  `)
  return db
}

const restoredApp = `
  CREATE SCHEMA public; CREATE SCHEMA pos_private; CREATE SCHEMA supabase_migrations;
  CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, statements text[], name text);
  INSERT INTO supabase_migrations.schema_migrations VALUES ('main-version', ARRAY['main SQL'], 'main');
  CREATE TABLE public.sales(id integer PRIMARY KEY, user_id integer REFERENCES auth.users, total_cents integer);
  INSERT INTO auth.users VALUES (9);
  INSERT INTO auth.refresh_tokens(id, user_id) VALUES (900,9);
  INSERT INTO storage.buckets VALUES ('main'); INSERT INTO storage.objects VALUES (9,'main');
  INSERT INTO public.sales VALUES (9,9,2450);
`

test('el inventario lee versiones reales y statements sin depender del checkout local', async (t) => {
  const db = await fixture(t)
  const { rows } = await db.query(catalogSql)
  const catalog = rows[0].json_build_object
  assert.deepEqual(catalog.history, ['staging-only'])
  assert.deepEqual(catalog.schemas, ['pos_private', 'public', 'supabase_migrations'])
  assert.ok(catalog.columns.some((c) => c.schema === 'auth' && c.table === 'users' && c.column === 'id'))
  assert.deepEqual(catalog.triggers, [])
})

test('restauración conserva migraciones gestionadas Cloud y reemplaza TODO el ledger de main', async (t) => {
  const db = await fixture(t)
  await db.exec(`BEGIN; ${resetSql()} ${restoredApp} ${verificationSql()} COMMIT;`)
  assert.deepEqual((await db.query('SELECT * FROM supabase_migrations.schema_migrations')).rows,
    [{ version: 'main-version', statements: ['main SQL'], name: 'main' }])
  assert.deepEqual((await db.query('SELECT * FROM auth.schema_migrations')).rows, [{ version: 'cloud-auth-version' }])
  assert.deepEqual((await db.query('SELECT * FROM storage.migrations')).rows, [{ id: 42 }])
  assert.deepEqual((await db.query('SELECT * FROM storage.buckets_analytics')).rows, [{ id: 'cloud-only' }])
  assert.equal((await db.query("SELECT * FROM pg_policies WHERE policyname='cloud_analytics'")).rows.length, 1)
  assert.equal((await db.query('INSERT INTO storage.iceberg_namespaces(catalog_id) VALUES (\'cloud-only\') RETURNING id')).rows[0].id, 2)
  assert.deepEqual((await db.query('SELECT * FROM public.sales')).rows, [{ id: 9, user_id: 9, total_cents: 2450 }])
  assert.equal((await db.query('SELECT * FROM auth.sessions')).rows.length, 0)
  assert.equal((await db.query('INSERT INTO auth.refresh_tokens(user_id) VALUES (9) RETURNING id')).rows[0].id, 901)
})

test('las secuencias gestionadas avanzan sin colisiones y también revierten si falla el commit', async (t) => {
  const db = await fixture(t)
  await db.exec(`BEGIN; ${resetSql()} ${restoredApp} ${verificationSql()}`)
  await assert.rejects(() => db.exec('SELECT missing_column FROM auth.users;'), /does not exist/)
  await db.exec('ROLLBACK;')
  assert.equal((await db.query('INSERT INTO auth.refresh_tokens(user_id) VALUES (1) RETURNING id')).rows[0].id, 2)
})

test('Cloud sin ownership de secuencia avanza IDs sin setval ni permisos de ALTER', async (t) => {
  const db = await fixture(t)
  await db.exec(`
    CREATE ROLE cloud_postgres;
    GRANT USAGE ON SCHEMA public,pos_private,auth,storage,supabase_migrations TO cloud_postgres;
    GRANT SELECT ON ALL TABLES IN SCHEMA public,pos_private,auth,storage,supabase_migrations TO cloud_postgres;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA auth TO cloud_postgres;
    GRANT SET ON PARAMETER session_replication_role TO cloud_postgres;
    BEGIN;
    INSERT INTO auth.refresh_tokens(id,user_id) VALUES (900,1);
    SET LOCAL ROLE cloud_postgres;
  `)
  await db.exec(verificationSql())
  await assert.rejects(() => db.exec('SELECT missing_column FROM auth.users;'), /does not exist/)
  await db.exec('ROLLBACK;')
  assert.deepEqual((await db.query('SELECT id FROM auth.refresh_tokens')).rows, [{ id: 1 }])
  assert.equal((await db.query('INSERT INTO auth.refresh_tokens(user_id) VALUES (1) RETURNING id')).rows[0].id, 901)
})

test('un error de integridad revierte datos, esquemas e historial de staging', async (t) => {
  const db = await fixture(t)
  await db.exec('BEGIN;')
  await db.exec(`${resetSql()} ${restoredApp} INSERT INTO public.sales VALUES (10,999,100);`)
  await assert.rejects(() => db.exec(verificationSql()), /FK inválida/)
  await db.exec('ROLLBACK;')
  assert.deepEqual((await db.query('SELECT * FROM public.sales')).rows, [{ id: 1, user_id: 1, total_cents: 1234 }])
  assert.deepEqual((await db.query('SELECT version FROM supabase_migrations.schema_migrations')).rows, [{ version: 'staging-only' }])
  assert.equal((await db.query("SELECT * FROM pg_policies WHERE policyname='old_staging'")).rows.length, 1)
})

test('verifica FK gestionadas y claves compuestas MATCH FULL, respetando MATCH SIMPLE', async (t) => {
  const db = await fixture(t)
  await db.exec(`${resetSql()} ${restoredApp}
    CREATE TABLE public.parent(a integer, b integer, PRIMARY KEY(a,b));
    CREATE TABLE public.child(a integer, b integer, FOREIGN KEY(a,b) REFERENCES public.parent MATCH FULL);
    INSERT INTO public.child VALUES (NULL,2);
  `)
  await assert.rejects(() => db.exec(verificationSql()), /FK inválida/)
  await db.exec('SET session_replication_role=replica; DELETE FROM public.child; INSERT INTO auth.sessions VALUES (7,999);')
  await assert.rejects(() => db.exec(verificationSql()), /FK inválida/)
  await db.exec('SET session_replication_role=replica; DELETE FROM auth.sessions;')
  await db.exec(verificationSql())
})
