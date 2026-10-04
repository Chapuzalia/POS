import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import {
  adaptLegacyPipelineMigration,
  LEGACY_PIPELINE_MIGRATION,
  SALE_LATENCY_PIPELINE_MIGRATION,
  prepareProductionMigrations,
} from '../scripts/prepare-production-migrations.mjs'

const legacySql = `create index concurrently first_idx on public.example (id);
create index concurrently second_idx on public.example (name);
create index concurrently third_idx on public.example (created_at);
`

test('prepara SQL con BOM ejecutable en PostgreSQL sin modificar las fuentes ni literales', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-migrations-'))
  const db = new PGlite()
  try {
    const source = join(directory, 'source')
    const output = join(directory, 'output')
    await mkdir(source)
    await writeFile(join(source, LEGACY_PIPELINE_MIGRATION), legacySql)
    const filename = '20261002120000_example.sql'
    const sql = "-- migration-safety: expand\r\nset lock_timeout = '5s';\r\nset statement_timeout = '5min';\r\ncreate table example (value text);\r\ninsert into example values ('inside\uFEFFliteral');\r\n"
    const original = Buffer.from(`\uFEFF${sql}`, 'utf8')
    await writeFile(join(source, filename), original)
    const unchanged = Buffer.from('-- plain migration\nselect 1;\n', 'utf8')
    await writeFile(join(source, '20261003120000_plain.sql'), unchanged)
    await writeFile(join(source, 'notes.txt'), original)

    await prepareProductionMigrations(source, output)

    const prepared = await readFile(join(output, filename), 'utf8')
    await db.exec(prepared)
    const result = await db.query('select value from example')
    assert.deepEqual(result.rows, [{ value: 'inside\uFEFFliteral' }])
    assert.equal(prepared, sql)
    assert.deepEqual(await readFile(join(source, filename)), original)
    assert.equal(await readFile(join(source, LEGACY_PIPELINE_MIGRATION), 'utf8'), legacySql)
    assert.deepEqual(await readFile(join(output, '20261003120000_plain.sql')), unchanged)
    assert.deepEqual(await readFile(join(output, 'notes.txt')), original)
    assert.equal(
      await readFile(join(output, LEGACY_PIPELINE_MIGRATION), 'utf8'),
      legacySql.replaceAll('create index concurrently', 'create index'),
    )
  } finally {
    await db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('conserva el guard que exige los tres índices de la migración legacy', () => {
  assert.throws(
    () => adaptLegacyPipelineMigration('create index concurrently only_idx on public.example (id);'),
    /must contain exactly 3 concurrent indexes; found 1/,
  )
})

test('los índices de latencia empaquetados se ejecutan en una transacción y conservan sus filtros', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-latency-indexes-'))
  const db = new PGlite()
  try {
    const source = join(directory, 'source')
    const output = join(directory, 'output')
    await mkdir(source)
    const original = await readFile(new URL(`../supabase/migrations/${SALE_LATENCY_PIPELINE_MIGRATION}`, import.meta.url), 'utf8')
    await writeFile(join(source, SALE_LATENCY_PIPELINE_MIGRATION), original)
    await writeFile(join(source, LEGACY_PIPELINE_MIGRATION), legacySql)
    await prepareProductionMigrations(source, output)
    const prepared = await readFile(join(output, SALE_LATENCY_PIPELINE_MIGRATION), 'utf8')
    assert.equal(prepared, original.replace(/^create index concurrently\b/gim, 'create index'))
    assert.equal(await readFile(join(source, SALE_LATENCY_PIPELINE_MIGRATION), 'utf8'), original)
    const indexes = prepared.match(/^create index if not exists offline_event_log_[\s\S]*?;/gm)
    assert.equal(indexes?.length, 2)
    await db.exec(`create table offline_event_log (
      id uuid, tenant_id uuid, sale_cash_session_id text, sale_ticket_id text,
      payload jsonb, created_at timestamptz, event_kind text
    );`)
    await db.exec(`begin; set lock_timeout = '5s'; set statement_timeout = '5min'; ${indexes.join('\n')} commit;`)
    const result = await db.query("select indexname, indexdef from pg_indexes where tablename = 'offline_event_log' order by indexname")
    assert.deepEqual(result.rows.map(row => row.indexname), [
      'offline_event_log_sale_id_idx', 'offline_event_log_sale_session_ticket_idx',
    ])
    for (const row of result.rows) assert.match(row.indexdef, /WHERE \(event_kind = 'sale_created'::text\)/)

    await writeFile(join(source, SALE_LATENCY_PIPELINE_MIGRATION), original.replace(/create index concurrently/, 'create index'))
    await assert.rejects(prepareProductionMigrations(source, join(directory, 'invalid-output')), /must contain exactly 2 concurrent indexes; found 1/)
  } finally {
    await db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
