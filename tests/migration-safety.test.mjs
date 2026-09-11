import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { analyzeMigration, normalizeExecutableSql } from '../scripts/check-migrations.mjs'

const safeHeader = `
-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
`

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

test('acepta una expansión con locks acotados e índice concurrente', () => {
  assert.deepEqual(analyzeMigration(`${safeHeader}
    alter table public.sales add column external_reference text;
    create index concurrently sales_external_reference_idx on public.sales (external_reference);
  `), [])
})

test('bloquea cambios breaking, RLS debilitado e índices que bloquean escrituras', () => {
  const cases = [
    ['drop table public.sales', 'DROP'],
    ["do $$ begin execute 'drop table public.sales'; end $$", 'ANONYMOUS DO BLOCK'],
    ['call public.rewrite_sales()', 'CALL PROCEDURE'],
    ['alter table public.sales rename column total to amount', 'RENAME'],
    ['create or replace function public.pay() returns void language sql as $$ select 1 $$', 'CREATE OR REPLACE API'],
    ['alter table public.sales disable row level security', 'WEAKEN RLS'],
    ['create index sales_created_idx on public.sales (created_at)', 'CREATE INDEX WITHOUT CONCURRENTLY'],
    ['alter table public.sales add constraint positive_total check (total > 0)', 'CHECK/FOREIGN KEY CONSTRAINT WITHOUT NOT VALID'],
  ]

  for (const [sql, expected] of cases) {
    assert.ok(analyzeMigration(`${safeHeader}${sql};`).includes(expected), expected)
  }
})

test('exige declaración expand y timeouts explícitos', () => {
  assert.deepEqual(analyzeMigration('create table public.example (id bigint);'), [
    'MISSING EXPAND SAFETY DECLARATION',
    'MISSING OR INVALID lock_timeout (required: 5s)',
    'MISSING OR INVALID statement_timeout (required: 5min)',
  ])
})

test('rechaza timeouts desactivados aunque las sentencias estén presentes', () => {
  const findings = analyzeMigration(`
    -- migration-safety: expand
    set lock_timeout = '0';
    set statement_timeout = '0';
    create table public.example (id bigint);
  `)

  assert.ok(findings.includes('MISSING OR INVALID lock_timeout (required: 5s)'))
  assert.ok(findings.includes('MISSING OR INVALID statement_timeout (required: 5min)'))
})

test('solo analiza migraciones añadidas y rechaza cambios en la historia', async () => {
  const checker = await readFile(new URL('../scripts/check-migrations.mjs', import.meta.url), 'utf8')

  assert.match(checker, /changedFiles\(baseSha, headSha, 'AC'\)/)
  assert.match(checker, /changedFiles\(baseSha, headSha, 'MDRTUXB'\)/)
  assert.match(checker, /Existing migration files are immutable/)
})
