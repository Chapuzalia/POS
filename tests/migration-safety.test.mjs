import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
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
