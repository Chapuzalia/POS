import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { analyzeMigration, checkMigrationRange, normalizeExecutableSql, parsePendingContracts } from '../scripts/check-migrations.mjs'

const safeHeader = "-- migration-safety: expand\nset lock_timeout = '5s';\nset statement_timeout = '5min';\n"
const contractHeader = (id) => `-- migration-safety: contract\n-- migration-contract: ${id}\nset lock_timeout = '5s';\nset statement_timeout = '5min';\n`

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function createRepository() {
  const cwd = await mkdtemp(join(tmpdir(), 'migration-safety-'))
  git(cwd, 'init', '-q')
  git(cwd, 'config', 'user.email', 'test@example.com')
  git(cwd, 'config', 'user.name', 'Migration Test')
  await mkdir(join(cwd, 'supabase', 'migrations'), { recursive: true })
  await writeFile(join(cwd, '.gitkeep'), '')
  return cwd
}

async function put(cwd, path, content) {
  const absolute = join(cwd, ...path.split('/'))
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, content)
}

function commit(cwd, message) {
  git(cwd, 'add', '.')
  try {
    git(cwd, 'commit', '-q', '-m', message)
  } catch (error) {
    if (!String(error?.stderr ?? '').includes('nothing to commit')) throw error
    git(cwd, 'commit', '--allow-empty', '-q', '-m', message)
  }
  return git(cwd, 'rev-parse', 'HEAD')
}

function pending(id, expandMigration, operations = ['DROP']) {
  return `contracts:\n  - id: ${id}\n    expand_migration: ${expandMigration}\n    description: Remove legacy structure after compatible clients are deployed.\n    allowed_operations:\n${operations.map((operation) => `      - ${operation}`).join('\n')}\n    created_at: 2026-09-16\n`
}

async function withRepository(run) {
  const cwd = await createRepository()
  try {
    await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

test('normaliza comentarios y literales sin permitir separar palabras peligrosas', () => {
  const normalized = normalizeExecutableSql(`
    -- DROP TABLE ignored_comment;
    select 'DROP TABLE ignored_string';
    DROP /* bypass */ TABLE public.sales;
    create function public.example() returns void language sql as $$ DELETE FROM sales $$;
  `)
  assert.doesNotMatch(normalized, /ignored_comment|ignored_string|DELETE FROM sales/i)
  assert.match(normalized, /DROP\s+TABLE\s+public\.sales/i)
})

test('acepta una expansión segura', () => {
  assert.deepEqual(analyzeMigration(`${safeHeader}alter table public.sales add column external_reference text;\ncreate index sales_external_reference_idx on public.sales (external_reference);`), [])
})

test('bloquea cambios breaking, RLS debilitado', () => {
  const cases = [
    ['drop table public.sales', 'DROP'],
    ["do $$ begin execute 'drop table public.sales'; end $$", 'ANONYMOUS DO BLOCK'],
    ['call public.rewrite_sales()', 'CALL PROCEDURE'],
    ['alter table public.sales rename column total to amount', 'RENAME'],
    ['create or replace function public.pay() returns void language sql as $$ select 1 $$', 'CREATE OR REPLACE ROUTINE'],
    ['alter table public.sales disable row level security', 'WEAKEN RLS'],
    ['alter table public.sales add constraint positive_total check (total > 0)', 'CHECK/FOREIGN KEY CONSTRAINT WITHOUT NOT VALID'],
  ]
  for (const [sql, expected] of cases) assert.ok(analyzeMigration(`${safeHeader}${sql};`).includes(expected), expected)
})

test('permite revisar una sustitución de RPC compatible sin eximir reglas destructivas', () => {
  const findings = analyzeMigration(`${safeHeader}-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Same signature and authenticated contract; fixes idempotent retry behavior.
create or replace function public.pay() returns void language sql as $$ select 1 $$;
revoke all on function public.pay() from public, anon;
grant execute on function public.pay() to authenticated;`)
  assert.deepEqual(findings, [])
  assert.ok(analyzeMigration(`${safeHeader}-- migration-safety-reviewed: DROP\ndrop table public.sales;`).includes('RULE CANNOT BE REVIEW-WAIVED: DROP'))
})

test('permite únicamente las dos ampliaciones CHECK revisadas, sin permitir otros DROP ni alterar predicados', async () => {
  const loopback = await readFile(new URL('../supabase/migrations/20261010232706_allow_http_loopback_bridge.sql', import.meta.url), 'utf8')
  const refund = await readFile(new URL('../supabase/migrations/20261011010552_allow_refund_installation_series.sql', import.meta.url), 'utf8')
  for (const sql of [loopback, refund]) {
    assert.deepEqual(analyzeMigration(sql), [])
    assert.deepEqual(analyzeMigration(sql.replaceAll('alter table', 'ALTER /* reviewed syntax */ TABLE').replaceAll('\n', '\r\n')), [])
    assert.deepEqual(analyzeMigration(sql.replace('add constraint', 'add /* ; */ constraint')), [])
    const variants = [
      sql.replace(/-- migration-safety-reviewed:[^\n]*\n/, ''),
      sql.replace(/-- migration-safety-reason:[^\n]*\n/, ''),
      sql.replace('drop constraint', 'drop constraint if exists'),
      sql.replace('not valid;', ';'),
      sql.replace('drop constraint', 'drop column'),
      sql + '\ndrop table public.sales;',
      sql + '\nalter table public.sales drop constraint total_check;',
      sql + '\nalter table public.sales disable row level security;',
      sql.replace('COMPATIBLE CHECK REPLACEMENT', 'DROP'),
      sql.replace('COMPATIBLE CHECK REPLACEMENT', 'COMPATIBLE CHECK REPLACEMENT, DROP'),
      sql.replace('set lock_timeout', 'set standard_conforming_strings = off;\nset lock_timeout'),
    ]
    for (const unsafe of variants) assert.ok(analyzeMigration(unsafe).length, unsafe)
  }
  // Literal values matter: the normal scanner blanks strings, but this rule
  // must reject a changed regex, fiscal suffix, size/port bound or table target.
  for (const unsafe of [
    loopback.replace('65535', '99999'),
    loopback.replaceAll('255', '500'),
    loopback.replace('localhost|127', 'example.com|127'),
    loopback.replace('^https://[^/?#@]+/?$', '^https?://.*$'),
    loopback.replaceAll('public.fiscal_pos_bridge_settings', 'public.other_settings'),
    refund.replaceAll('-R$', '-S$'),
    refund.replace('[1-9][0-9]*', '[0-9]*'),
    refund.replaceAll('refund_requests_fiscal_series_check', 'refund_requests_total_cents_check'),
    refund.replaceAll('public.refund_requests', 'public.sales'),
  ]) assert.ok(analyzeMigration(unsafe).includes('DROP'), unsafe)
})

test('el rango permite los CHECK compatibles añadidos y mantiene la inmutabilidad de migraciones desplegadas', async () => {
  const refund = await readFile(new URL('../supabase/migrations/20261011010552_allow_refund_installation_series.sql', import.meta.url), 'utf8')
  await withRepository(async cwd => {
    const old = 'supabase/migrations/20260901000000_refunds.sql'
    const added = 'supabase/migrations/20261011010552_allow_refund_installation_series.sql'
    await put(cwd, old, `${safeHeader}create table public.refund_requests (fiscal_series text);`)
    const baseSha = commit(cwd, 'baseline')
    await put(cwd, added, refund)
    const headSha = commit(cwd, 'compatible CHECK widening')
    assert.deepEqual(checkMigrationRange(baseSha, headSha, { cwd }), [added])
    await put(cwd, old, refund)
    const rewritten = commit(cwd, 'invalid rewrite of historical migration')
    assert.throws(() => checkMigrationRange(baseSha, rewritten, { cwd }), /Existing migration files are immutable/)
  })
})

test('el historial permite solo retirar los cinco CONCURRENTLY autorizados, sin cambiar otro SQL', async () => {
  const files = [
    'supabase/migrations/20260912222539_paginate_pos_session_tickets.sql',
    'supabase/migrations/20261003183458_optimize_pos_sale_latency.sql',
  ]
  const corrected = await Promise.all(files.map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')))
  await withRepository(async cwd => {
    for (const [index, file] of files.entries()) {
      await put(cwd, file, corrected[index].replace(/^create index if not exists\b/gim, 'create index concurrently if not exists'))
    }
    const unrelated = 'supabase/migrations/20260901000000_other.sql'
    await put(cwd, unrelated, `${safeHeader}create index concurrently if not exists other_idx on public.sales (id);`)
    const base = commit(cwd, 'historical concurrent indexes')
    for (const [index, file] of files.entries()) await put(cwd, file, corrected[index])
    assert.deepEqual(checkMigrationRange(base, commit(cwd, 'remove only CONCURRENTLY'), { cwd }), [])

    for (const [index, file] of files.entries()) {
      for (const changed of [
        corrected[index] + '\ndrop table public.sales;',
        corrected[index] + '\n-- unrelated edit',
        corrected[index].replace('create index if not exists', 'create index concurrently if not exists'),
        corrected[index].replace('where event_kind', 'where upper(event_kind)'),
      ]) {
        await put(cwd, file, changed)
        assert.throws(() => checkMigrationRange(base, commit(cwd, 'reject additional historical edit'), { cwd }), /Existing migration files are immutable/)
      }
      await put(cwd, file, corrected[index])
    }
    await put(cwd, unrelated, `${safeHeader}create index if not exists other_idx on public.sales (id);`)
    assert.throws(() => checkMigrationRange(base, commit(cwd, 'reject an unapproved historical file'), { cwd }), /Existing migration files are immutable/)
  })
})

test('exige cabecera exacta y timeouts explícitos', () => {
  const findings = analyzeMigration('create table public.example (id bigint);')
  assert.ok(findings.includes('MISSING OR INVALID MIGRATION SAFETY DECLARATION'))
  assert.ok(findings.includes('MISSING OR INVALID lock_timeout (required: 5s)'))
  assert.ok(findings.includes('MISSING OR INVALID statement_timeout (required: 5min)'))
  assert.ok(analyzeMigration(`\n${safeHeader}select 1;`).includes('MISSING OR INVALID MIGRATION SAFETY DECLARATION'))
})

test('valida el esquema de contracts pendientes e IDs duplicados', () => {
  assert.equal(parsePendingContracts(pending('cleanup', '20260901000000_expand.sql'))[0].id, 'cleanup')
  assert.throws(() => parsePendingContracts(`${pending('cleanup', '20260901000000_expand.sql')}  - id: cleanup\n    expand_migration: 20260901000000_expand.sql\n    description: duplicate\n    allowed_operations:\n      - DROP\n    created_at: 2026-09-16\n`), /Duplicate contract id/)
})

test('acepta un contract cuyo expand está en base y cuya entry se elimina', async () => withRepository(async (cwd) => {
  const expand = '20260901000000_expand.sql'
  await put(cwd, `supabase/migrations/${expand}`, `${safeHeader}alter table public.sales add column legacy_copy text;`)
  await put(cwd, 'supabase/contracts-pending.yml', pending('legacy-cleanup', expand))
  const base = commit(cwd, 'expand')
  await put(cwd, 'supabase/contracts-pending.yml', 'contracts: []\n')
  await put(cwd, 'supabase/migrations/20260902000000_contract.sql', `${contractHeader('legacy-cleanup')}drop column legacy_column;`)
  const head = commit(cwd, 'contract')
  assert.deepEqual(checkMigrationRange(base, head, { cwd }), ['supabase/migrations/20260902000000_contract.sql'])
}))

test('rechaza expand y contract en el mismo release', async () => withRepository(async (cwd) => {
  await put(cwd, 'supabase/contracts-pending.yml', 'contracts: []\n')
  const base = commit(cwd, 'base')
  const expand = '20260901000000_expand.sql'
  await put(cwd, `supabase/migrations/${expand}`, `${safeHeader}alter table public.sales add column replacement text;`)
  await put(cwd, 'supabase/migrations/20260902000000_contract.sql', `${contractHeader('legacy-cleanup')}drop column legacy_column;`)
  await put(cwd, 'supabase/contracts-pending.yml', pending('legacy-cleanup', expand))
  const head = commit(cwd, 'combined')
  assert.throws(() => checkMigrationRange(base, head, { cwd }), /MIGRATION CONTRACT IS NOT REGISTERED IN BASELINE/)
}))

test('rechaza contract sin pending o con ID inexistente', async () => withRepository(async (cwd) => {
  await put(cwd, 'supabase/contracts-pending.yml', 'contracts: []\n')
  const base = commit(cwd, 'base')
  await put(cwd, 'supabase/migrations/20260902000000_contract.sql', `${contractHeader('missing-cleanup')}drop table public.legacy;`)
  const head = commit(cwd, 'contract')
  assert.throws(() => checkMigrationRange(base, head, { cwd }), /MIGRATION CONTRACT IS NOT REGISTERED IN BASELINE/)
}))

test('rechaza eliminar un pending sin contract', async () => withRepository(async (cwd) => {
  const expand = '20260901000000_expand.sql'
  await put(cwd, `supabase/migrations/${expand}`, `${safeHeader}select 1;`)
  await put(cwd, 'supabase/contracts-pending.yml', pending('legacy-cleanup', expand))
  const base = commit(cwd, 'expand')
  await put(cwd, 'supabase/contracts-pending.yml', 'contracts: []\n')
  const head = commit(cwd, 'remove pending')
  assert.throws(() => checkMigrationRange(base, head, { cwd }), /PENDING CONTRACT REMOVED WITHOUT MIGRATION/)
}))

test('rechaza contract sin eliminar el pending', async () => withRepository(async (cwd) => {
  const expand = '20260901000000_expand.sql'
  await put(cwd, `supabase/migrations/${expand}`, `${safeHeader}select 1;`)
  await put(cwd, 'supabase/contracts-pending.yml', pending('legacy-cleanup', expand))
  const base = commit(cwd, 'expand')
  await put(cwd, 'supabase/migrations/20260902000000_contract.sql', `${contractHeader('legacy-cleanup')}drop table public.legacy;`)
  const head = commit(cwd, 'contract')
  assert.throws(() => checkMigrationRange(base, head, { cwd }), /CONTRACT ENTRY MUST BE REMOVED/)
}))

test('rechaza operaciones contract no declaradas', async () => withRepository(async (cwd) => {
  const expand = '20260901000000_expand.sql'
  await put(cwd, `supabase/migrations/${expand}`, `${safeHeader}select 1;`)
  await put(cwd, 'supabase/contracts-pending.yml', pending('legacy-cleanup', expand, ['DROP']))
  const base = commit(cwd, 'expand')
  await put(cwd, 'supabase/contracts-pending.yml', 'contracts: []\n')
  await put(cwd, 'supabase/migrations/20260902000000_contract.sql', `${contractHeader('legacy-cleanup')}alter table public.sales alter column total type bigint;`)
  const head = commit(cwd, 'contract')
  assert.throws(() => checkMigrationRange(base, head, { cwd }), /CONTRACT OPERATION NOT DECLARED: ALTER COLUMN TYPE/)
}))

test('rechaza migration-safety contract como bypass sin referencia', () => {
  const findings = analyzeMigration("-- migration-safety: contract\nset lock_timeout = '5s';\nset statement_timeout = '5min';\ndrop table public.sales;")
  assert.ok(findings.includes('MISSING MIGRATION CONTRACT REFERENCE'))
  assert.ok(findings.includes('MIGRATION CONTRACT IS NOT REGISTERED IN BASELINE'))
})

test('rechaza versiones de migración duplicadas', async () => withRepository(async (cwd) => {
  const base = commit(cwd, 'base')
  await put(cwd, 'supabase/migrations/20260901000000_one.sql', `${safeHeader}select 1;`)
  await put(cwd, 'supabase/migrations/20260901000000_two.sql', `${safeHeader}select 2;`)
  const head = commit(cwd, 'duplicates')
  assert.throws(() => checkMigrationRange(base, head, { cwd }), /Duplicate migration version 20260901000000/)
}))
