import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const migration = '20261019120000_change.sql'
const expand = "-- migration-safety: expand\nset lock_timeout = '5s';\nset statement_timeout = '5min';\n"
function check(sql, overrides = {}, arguments_ = []) {
  const directory = mkdtempSync(join(tmpdir(), 'pending-safety-'))
  try {
    writeFileSync(join(directory, migration), sql)
    return spawnSync(process.execPath, ['scripts/pending-migration-safety.mjs', ...arguments_], {
      input: JSON.stringify({ directory, pending: ['20261019120000'], applied: ['20261015120000'],
        environment: 'production', approvals: [], ...overrides }), encoding: 'utf8',
    })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
function approval(sql, overrides = {}) {
  return { environment: 'production', migration, sha256: createHash('sha256').update(sql).digest('hex'),
    expires_at: '2099-01-01T00:00:00Z', reason: 'Reviewed compatible replacement', ...overrides }
}

test('accepts safe expand and rejects destructive SQL and missing safety metadata', () => {
  assert.equal(check(expand + 'alter table public.example add column value text;').status, 0)
  assert.equal(check(expand + 'drop table public.example;').status, 1)
  assert.equal(check('select 1;').status, 1)
})

test('structured report names sensitive files, exact content hash and all detected reasons', () => {
  const sql = expand + 'drop table public.sales; delete from public.payments;'
  const result = check(sql, {}, ['--report'])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.pending_count, 1)
  assert.equal(report.sensitive.length, 1)
  assert.equal(report.sensitive[0].migration, migration)
  assert.equal(report.sensitive[0].sha256, createHash('sha256').update(sql).digest('hex'))
  assert.ok(report.sensitive[0].reasons.includes('DROP'))
  assert.ok(report.sensitive[0].reasons.includes('DELETE FROM'))
  assert.deepEqual(JSON.parse(check(expand + 'select 1;', {}, ['--report']).stdout).sensitive, [])
  assert.equal(check(sql).status, 1)
})

test('downloaded migration cannot grant itself reviewed exceptions', () => {
  const sql = expand + '-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE\n'
    + '-- migration-safety-reason: claims compatibility\n'
    + 'create or replace function public.example() returns int language sql as $$ select 1 $$;'
  assert.equal(check(sql).status, 1)
  assert.equal(check(sql, { approvals: [approval(sql)] }).status, 0)
})

test('anonymous DO bodies require exact root approval for every delimiter and language syntax', () => {
  const bodies = [
    'DO $migration$ BEGIN DROP TABLE public.sales; END; $migration$;',
    'DO $$ BEGIN DROP TABLE public.sales; END; $$;',
    'DO LANGUAGE plpgsql $migration$ BEGIN DROP TABLE public.sales; END; $migration$;',
    'DO $migration$ BEGIN DROP TABLE public.sales; END; $migration$ LANGUAGE plpgsql;',
    "DO 'BEGIN DROP TABLE public.sales; END;' LANGUAGE plpgsql;",
    'DO /* language selected below */ LANGUAGE plpgsql $任意$ BEGIN DROP TABLE public.sales; END; $任意$;',
    '/* outer /* nested */ quote \' stays commented */ DO $migration$ BEGIN DROP TABLE public.sales; END; $migration$; SELECT \'tail\';',
    String.raw`SELECT E'escaped \' quote'; DO $migration$ BEGIN DROP TABLE public.sales; END; $migration$;`,
  ]
  for (const body of bodies) {
    const sql = expand + body
    assert.equal(check(sql).status, 1, body)
    assert.equal(check(sql, { approvals: [approval(sql)] }).status, 0, body)
    assert.equal(check(sql, { approvals: [approval(sql, { environment: 'staging' })] }).status, 1, body)
  }
})

test('source comments cannot spoof the pg_get_functiondef anonymous block exception', () => {
  const bodies = [
    '-- DO $$ pg_get_functiondef execute definition $$\nDO $$ BEGIN DROP TABLE public.sales; END; $$;',
    'DO $$ BEGIN /* pg_get_functiondef execute definition */ DROP TABLE public.sales; END; $$;',
    '/* DO $$ pg_get_functiondef execute definition $$ */\nDO LANGUAGE plpgsql $tag$ BEGIN DROP TABLE public.sales; END; $tag$;',
  ]
  for (const body of bodies) {
    const sql = expand + body
    assert.equal(check(sql).status, 1, body)
    assert.equal(check(sql, { approvals: [approval(sql)] }).status, 0, body)
  }
})

test('DO text in comments, strings, routine bodies and upserts is not an anonymous statement', () => {
  for (const body of [
    '-- DO $migration$ DROP TABLE public.sales $migration$;\nSELECT 1;',
    '/* outer /* DO $tag$ */ still a comment */ SELECT 1;',
    "SELECT 'DO LANGUAGE plpgsql DROP TABLE public.sales';",
    'SELECT $note$DO $migration$ BEGIN DROP TABLE public.sales; END; $migration$;$note$;',
    'CREATE FUNCTION public.example() RETURNS int LANGUAGE sql AS $fn$ SELECT 1; /* DO $$ DROP TABLE public.sales $$ */ $fn$;',
    'INSERT INTO public.example(id) VALUES (1) ON CONFLICT (id) DO NOTHING;',
    'INSERT INTO public.example(id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = excluded.id;',
  ]) {
    assert.equal(check(expand + body).status, 0, body)
  }
})

test('approval binds environment, prepared bytes, filename, expiry and reason', () => {
  const sql = expand + 'drop table public.example;'
  assert.equal(check(sql, { approvals: [approval(sql)] }).status, 0)
  for (const change of [{ environment: 'staging' }, { sha256: 'a'.repeat(64) },
    { migration: '20261019120000_other.sql' }, { expires_at: '2000-01-01T00:00:00Z' },
    { expires_at: 'invalid' }, { expires_at: '2099-01-01' }, { reason: '' }]) {
    assert.equal(check(sql, { approvals: [approval(sql, change)] }).status, 1, JSON.stringify(change))
  }
})

test('contract approval requires its root-configured expand to already be in the actual ledger', () => {
  const sql = "-- migration-safety: contract\n-- migration-contract: remove-legacy\n"
    + "set lock_timeout = '5s';\nset statement_timeout = '5min';\ndrop table public.legacy;"
  assert.equal(check(sql, { approvals: [approval(sql)] }).status, 1)
  const reviewed = approval(sql, { expand_migration: '20261015120000_expand.sql' })
  assert.equal(check(sql, { approvals: [reviewed] }).status, 0)
  assert.equal(check(sql, { applied: [], approvals: [reviewed] }).status, 1)
  assert.equal(check(sql, { approvals: [approval(sql, { expand_migration: migration })] }).status, 1)
  assert.equal(check(sql, { approvals: [approval(sql, { expand_migration: '../20261015120000_expand.sql' })] }).status, 1)
})

test('missing or duplicate pending files and invalid approval collections fail closed', () => {
  assert.equal(check(expand + 'select 1;', { pending: ['20261020120000'] }).status, 1)
  assert.equal(check(expand + 'select 1;', { pending: ['20261019120000', '20261019120000'] }).status, 1)
  assert.equal(check(expand + 'select 1;', { approvals: {} }).status, 1)
})

test('history fingerprint hashes exact prepared bytes and the canonical applied version map', () => {
  const sql = expand + 'select 1;'
  const result = check(sql, { applied: ['20261019120000'] }, ['--history-hash'])
  assert.equal(result.status, 0, result.stderr)
  const map = { '20261019120000': createHash('sha256').update(sql).digest('hex') }
  const fingerprint = JSON.parse(result.stdout)
  assert.equal(fingerprint.sha256, createHash('sha256').update(JSON.stringify(map)).digest('hex'))
  const changed = check(sql + '\n', { applied: ['20261019120000'] }, ['--history-hash'])
  assert.notEqual(JSON.parse(changed.stdout).sha256, fingerprint.sha256)
  assert.equal(check(sql, { applied: ['20261020120000'] }, ['--history-hash']).status, 1)
})
