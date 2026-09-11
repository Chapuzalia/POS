#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MIGRATIONS_PATHSPEC = ':(glob)supabase/migrations/*.sql'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function changedFiles(baseSha, headSha, diffFilter) {
  const output = git([
    'diff',
    '--name-only',
    `--diff-filter=${diffFilter}`,
    baseSha,
    headSha,
    '--',
    MIGRATIONS_PATHSPEC,
  ])
  return output ? output.split('\n').filter(Boolean) : []
}

/**
 * Remove comments and quoted values while keeping statement structure. This
 * closes comment-based token bypasses without matching SQL stored in a
 * function body or a string literal.
 */
export function normalizeExecutableSql(sql) {
  let output = ''
  let index = 0
  let state = 'normal'
  let dollarTag = ''

  const blank = (character) => character === '\n' ? '\n' : ' '

  while (index < sql.length) {
    const character = sql[index]
    const next = sql[index + 1]

    if (state === 'line-comment') {
      output += blank(character)
      index += 1
      if (character === '\n') state = 'normal'
      continue
    }

    if (state === 'block-comment') {
      output += blank(character)
      if (character === '*' && next === '/') {
        output += ' '
        index += 2
        state = 'normal'
      } else {
        index += 1
      }
      continue
    }

    if (state === 'single-quote') {
      output += blank(character)
      if (character === "'" && next === "'") {
        output += ' '
        index += 2
      } else {
        index += 1
        if (character === "'") state = 'normal'
      }
      continue
    }

    if (state === 'double-quote') {
      output += blank(character)
      if (character === '"' && next === '"') {
        output += ' '
        index += 2
      } else {
        index += 1
        if (character === '"') state = 'normal'
      }
      continue
    }

    if (state === 'dollar-quote') {
      if (sql.startsWith(dollarTag, index)) {
        output += ' '.repeat(dollarTag.length)
        index += dollarTag.length
        state = 'normal'
      } else {
        output += blank(character)
        index += 1
      }
      continue
    }

    if (character === '-' && next === '-') {
      output += '  '
      index += 2
      state = 'line-comment'
      continue
    }
    if (character === '/' && next === '*') {
      output += '  '
      index += 2
      state = 'block-comment'
      continue
    }
    if (character === "'") {
      output += ' '
      index += 1
      state = 'single-quote'
      continue
    }
    if (character === '"') {
      output += ' '
      index += 1
      state = 'double-quote'
      continue
    }
    if (character === '$') {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)
      if (match) {
        dollarTag = match[0]
        output += ' '.repeat(dollarTag.length)
        index += dollarTag.length
        state = 'dollar-quote'
        continue
      }
    }

    output += character
    index += 1
  }

  return output.replace(/[\t\r ]+/g, ' ')
}

const blockedRules = [
  ['DROP', /\bDROP\b/i],
  ['TRUNCATE', /\bTRUNCATE\b/i],
  ['DELETE FROM', /\bDELETE\s+FROM\b/i],
  ['ANONYMOUS DO BLOCK', /\bDO\b/i],
  ['CALL PROCEDURE', /\bCALL\s+/i],
  ['RENAME', /\bALTER\b[^;]*\bRENAME\b/i],
  ['ALTER COLUMN TYPE', /\bALTER\s+TABLE\b[^;]*\b(?:ALTER\s+COLUMN\s+)?[^;]*\bTYPE\b/i],
  ['SET NOT NULL', /\bALTER\s+TABLE\b[^;]*\bSET\s+NOT\s+NULL\b/i],
  ['ADD NOT NULL COLUMN', /\bALTER\s+TABLE\b[^;]*\bADD\s+(?:COLUMN\s+)?[^;]*\bNOT\s+NULL\b/i],
  ['CREATE OR REPLACE API', /\bCREATE\s+OR\s+REPLACE\s+(?:FUNCTION|PROCEDURE|VIEW)\b/i],
  ['ALTER API/TYPE', /\bALTER\s+(?:FUNCTION|PROCEDURE|VIEW|TYPE)\b/i],
  ['REVOKE', /\bREVOKE\b/i],
  ['WEAKEN RLS', /\b(?:DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY|ALTER\s+POLICY)\b/i],
  ['MOVE SCHEMA', /\bSET\s+SCHEMA\b/i],
]

export function analyzeMigration(sql) {
  const normalized = normalizeExecutableSql(sql)
  const safetyDeclaration = sql.split(/\r?\n/).find((line) => line.trim())?.trim().toLowerCase()
  const findings = blockedRules
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([name]) => name)

  if (safetyDeclaration !== '-- migration-safety: expand') {
    findings.push('MISSING EXPAND SAFETY DECLARATION')
  }
  if (!/^\s*SET\s+lock_timeout\s*(?:=|TO)\s*'5s'\s*;/im.test(sql)) {
    findings.push('MISSING OR INVALID lock_timeout (required: 5s)')
  }
  if (!/^\s*SET\s+statement_timeout\s*(?:=|TO)\s*'5min'\s*;/im.test(sql)) {
    findings.push('MISSING OR INVALID statement_timeout (required: 5min)')
  }

  for (const statement of normalized.split(';')) {
    if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement)
      && !/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statement)) {
      findings.push('CREATE INDEX WITHOUT CONCURRENTLY')
    }
    if (/\bADD\s+CONSTRAINT\b[^;]*\b(?:CHECK|FOREIGN\s+KEY)\b/i.test(statement)
      && !/\bNOT\s+VALID\b/i.test(statement)) {
      findings.push('CHECK/FOREIGN KEY CONSTRAINT WITHOUT NOT VALID')
    }
    if (/\bADD\s+CONSTRAINT\b[^;]*\b(?:UNIQUE|PRIMARY\s+KEY|EXCLUDE)\b/i.test(statement)
      && !/\bUSING\s+INDEX\b/i.test(statement)) {
      findings.push('BLOCKING UNIQUE/PRIMARY/EXCLUDE CONSTRAINT')
    }
  }

  return [...new Set(findings)]
}

export function checkMigrationRange(baseSha, headSha) {
  git(['cat-file', '-e', `${baseSha}^{commit}`])
  git(['cat-file', '-e', `${headSha}^{commit}`])

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseSha, headSha], { stdio: 'ignore' })
  } catch {
    throw new Error(`The migration baseline ${baseSha} is not an ancestor of ${headSha}. Refusing a partial or reordered production deploy.`)
  }

  const historicalChanges = changedFiles(baseSha, headSha, 'MDRTUXB')
  if (historicalChanges.length) {
    throw new Error([
      'Existing migration files are immutable. Add a new migration instead:',
      ...historicalChanges.map((file) => `  - ${file}`),
    ].join('\n'))
  }

  const addedMigrations = changedFiles(baseSha, headSha, 'AC')
  const failures = []
  for (const migration of addedMigrations) {
    const sql = git(['show', `${headSha}:${migration}`])
    const findings = analyzeMigration(sql)
    if (findings.length) failures.push({ migration, findings })
  }

  if (failures.length) {
    throw new Error([
      'Unsafe production migration(s) detected:',
      ...failures.flatMap(({ migration, findings }) => [
        `  ${migration}`,
        ...findings.map((finding) => `    - ${finding}`),
      ]),
      'Use an expand-only migration with bounded locks; perform contract changes in a later release.',
    ].join('\n'))
  }

  return addedMigrations
}

async function main() {
  const [baseSha, headSha] = process.argv.slice(2)
  if (!baseSha || !headSha || process.argv.length !== 4) {
    console.error('Usage: node scripts/check-migrations.mjs <base-sha> <head-sha>')
    process.exitCode = 2
    return
  }

  try {
    const checked = checkMigrationRange(baseSha, headSha)
    console.log(`Migration safety check passed (${checked.length} new migration${checked.length === 1 ? '' : 's'}).`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
