#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MIGRATIONS_PATHSPEC = ':(glob)supabase/migrations/*.sql'
const CONTRACTS_PATH = 'supabase/contracts-pending.yml'
const CONTRACT_OPERATIONS = new Set(['DROP', 'RENAME', 'ALTER COLUMN TYPE', 'SET NOT NULL', 'ADD NOT NULL COLUMN'])

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function changedFiles(baseSha, headSha, diffFilter, pathspec = MIGRATIONS_PATHSPEC, cwd) {
  const output = git([
    'diff',
    '--name-only',
    `--diff-filter=${diffFilter}`,
    baseSha,
    headSha,
    '--',
    pathspec,
  ], cwd)
  return output ? output.split('\n').filter(Boolean) : []
}

function showFile(sha, file, cwd, required = true) {
  try {
    return git(['show', `${sha}:${file}`], cwd)
  } catch (error) {
    if (!required) return null
    throw error
  }
}

function fileExists(sha, file, cwd) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}:${file}`], { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function parsePendingContracts(yaml) {
  if (yaml === null) return []
  const lines = yaml.replace(/\r/g, '').split('\n')
  const firstContent = lines.findIndex((line) => line.trim())
  if (firstContent === -1 || !/^contracts:\s*(?:\[\])?\s*$/.test(lines[firstContent])) {
    throw new Error('contracts-pending.yml must start with "contracts:"')
  }
  if (/\[\]/.test(lines[firstContent])) return []

  const contracts = []
  let current = null
  let listKey = null
  for (const rawLine of lines.slice(firstContent + 1)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue
    let match = rawLine.match(/^  - ([a-z_]+):\s*(.*?)\s*$/)
    if (match) {
      current = {}
      contracts.push(current)
      listKey = null
      current[match[1]] = match[2]
      continue
    }
    match = rawLine.match(/^    ([a-z_]+):\s*(.*?)\s*$/)
    if (match && current) {
      const [, key, value] = match
      if (Object.hasOwn(current, key)) throw new Error(`Duplicate contract field: ${key}`)
      if (value) {
        current[key] = value
        listKey = null
      } else {
        current[key] = []
        listKey = key
      }
      continue
    }
    match = rawLine.match(/^      -\s+(.+?)\s*$/)
    if (match && current && listKey && Array.isArray(current[listKey])) {
      current[listKey].push(match[1])
      continue
    }
    throw new Error(`Unsupported contracts-pending.yml syntax: ${rawLine.trim()}`)
  }

  const ids = new Set()
  for (const contract of contracts) {
    const keys = Object.keys(contract)
    const allowedKeys = new Set(['id', 'expand_migration', 'description', 'allowed_operations', 'created_at'])
    if (keys.some((key) => !allowedKeys.has(key))) throw new Error(`Unknown field in pending contract: ${keys.find((key) => !allowedKeys.has(key))}`)
    if (!contract.id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(contract.id)) throw new Error('Each pending contract needs a kebab-case id')
    if (ids.has(contract.id)) throw new Error(`Duplicate pending contract id: ${contract.id}`)
    ids.add(contract.id)
    if (!contract.expand_migration || !/^\d{14}_[A-Za-z0-9_]+\.sql$/.test(contract.expand_migration)) {
      throw new Error(`Pending contract ${contract.id} has an invalid expand_migration`)
    }
    if (!contract.description) throw new Error(`Pending contract ${contract.id} needs a description`)
    if (!Array.isArray(contract.allowed_operations) || contract.allowed_operations.length === 0) {
      throw new Error(`Pending contract ${contract.id} needs allowed_operations`)
    }
    contract.allowed_operations = contract.allowed_operations.map((operation) => operation.toUpperCase())
    for (const operation of contract.allowed_operations) {
      if (!CONTRACT_OPERATIONS.has(operation)) throw new Error(`Pending contract ${contract.id} has unsupported operation: ${operation}`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(contract.created_at ?? '')) throw new Error(`Pending contract ${contract.id} needs created_at as YYYY-MM-DD`)
  }
  return contracts
}

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
      } else index += 1
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
  ['DROP', /\bDROP\b(?!\s+(?:POLICY|TRIGGER)\b)/i],
  ['TRUNCATE', /\bTRUNCATE\b/i],
  ['DELETE FROM', /\bDELETE\s+FROM\b/i],
  ['ANONYMOUS DO BLOCK', /\bDO\b/i],
  ['CALL PROCEDURE', /\bCALL\s+/i],
  ['RENAME', /\bALTER\b[^;]*\bRENAME\b/i],
  ['ALTER COLUMN TYPE', /\bALTER\s+TABLE\b[^;]*\b(?:ALTER\s+COLUMN\s+)?[^;]*\bTYPE\b/i],
  ['SET NOT NULL', /\bALTER\s+TABLE\b[^;]*\bSET\s+NOT\s+NULL\b/i],
  ['ADD NOT NULL COLUMN', /\bALTER\s+TABLE\b[^;]*\bADD\s+(?:COLUMN\s+)?[^;]*\bNOT\s+NULL\b/i],
  ['CREATE OR REPLACE ROUTINE', /\bCREATE\s+OR\s+REPLACE\s+(?:FUNCTION|PROCEDURE)\b/i],
  ['CREATE OR REPLACE VIEW', /\bCREATE\s+OR\s+REPLACE\s+VIEW\b/i],
  ['ALTER API/TYPE', /\bALTER\s+(?:FUNCTION|PROCEDURE|VIEW|TYPE)\b/i],
  ['REVOKE', /\bREVOKE\b/i],
  ['WEAKEN RLS', /\b(?:DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY|ALTER\s+POLICY)\b/i],
  ['MOVE SCHEMA', /\bSET\s+SCHEMA\b/i],
]
const reviewableRules = new Set(['CREATE OR REPLACE ROUTINE', 'REVOKE'])

export function analyzeMigration(sql, contract = null) {
  const normalized = normalizeExecutableSql(sql)
  const firstLine = sql.replace(/\r/g, '').split('\n')[0]
  const safety = firstLine.match(/^-- migration-safety: (expand|contract)$/)?.[1] ?? null
  const contractId = sql.match(/^-- migration-contract:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/m)?.[1] ?? null
  const reviewedDeclaration = sql.match(/^\s*--\s*migration-safety-reviewed:\s*(.+)$/im)?.[1]
  const reviewedRules = new Set(reviewedDeclaration?.split(',').map((rule) => rule.trim().toUpperCase()).filter(Boolean) ?? [])
  const reviewReason = sql.match(/^\s*--\s*migration-safety-reason:\s*(.+)$/im)?.[1]?.trim()
  const allowedContractOperations = new Set(contract?.allowed_operations ?? [])
  const findings = []

  if (!safety) findings.push('MISSING OR INVALID MIGRATION SAFETY DECLARATION')
  if (safety === 'expand' && !sql.replace(/\r/g, '').startsWith('-- migration-safety: expand\n')) findings.push('INVALID EXPAND HEADER')
  if (safety === 'contract') {
    if (!contractId) findings.push('MISSING MIGRATION CONTRACT REFERENCE')
    if (!contract || contract.id !== contractId) findings.push('MIGRATION CONTRACT IS NOT REGISTERED IN BASELINE')
    const expectedHeader = `-- migration-safety: contract\n-- migration-contract: ${contractId ?? ''}\nset lock_timeout = '5s';\nset statement_timeout = '5min';`
    if (!sql.replace(/\r/g, '').startsWith(expectedHeader)) findings.push('INVALID CONTRACT HEADER')
  }

  for (const [name, pattern] of blockedRules) {
    if (!pattern.test(normalized)) continue
    if (name === 'ANONYMOUS DO BLOCK' && /\bpg_get_functiondef\b[\s\S]*\bexecute\s+definition\b/i.test(normalized)) continue
    if (name === 'ANONYMOUS DO BLOCK' && !/\bDO\b/i.test(normalized)) continue
    if (name === 'ALTER COLUMN TYPE' && /\bALTER\s+COLUMN\b[^;]*\bTYPE\s+numeric\s*\(\s*18\s*,\s*3\s*\)/i.test(normalized)) continue
    if (safety === 'contract' && CONTRACT_OPERATIONS.has(name)) {
      if (!allowedContractOperations.has(name)) findings.push(`CONTRACT OPERATION NOT DECLARED: ${name}`)
    } else if (!(reviewableRules.has(name) && reviewedRules.has(name))) findings.push(name)
  }

  for (const reviewedRule of reviewedRules) {
    if (!reviewableRules.has(reviewedRule)) findings.push(`RULE CANNOT BE REVIEW-WAIVED: ${reviewedRule}`)
  }
  if (reviewedRules.size && !reviewReason) findings.push('MISSING REVIEW REASON')
  if (reviewedRules.has('REVOKE')) {
    const revokeStatements = normalized.split(';').filter((statement) => /\bREVOKE\b/i.test(statement))
    if (revokeStatements.some((statement) => !/\bREVOKE\s+ALL\s+ON\s+FUNCTION\b[^;]*\bFROM\s+PUBLIC(?:\s*,\s*ANON)?\s*$/i.test(statement))) {
      findings.push('REVIEWED REVOKE MAY ONLY REMOVE FUNCTION ACCESS FROM PUBLIC/ANON')
    }
    if (!/\bGRANT\s+EXECUTE\s+ON\s+FUNCTION\b[^;]*\bTO\s+AUTHENTICATED\b/i.test(normalized)) {
      findings.push('REVIEWED REVOKE MUST GRANT FUNCTION EXECUTE TO AUTHENTICATED')
    }
  }
  if (!/^\s*SET\s+lock_timeout\s*(?:=|TO)\s*'5s'\s*;/im.test(sql)) findings.push('MISSING OR INVALID lock_timeout (required: 5s)')
  if (!/^\s*SET\s+statement_timeout\s*(?:=|TO)\s*'5min'\s*;/im.test(sql)) findings.push('MISSING OR INVALID statement_timeout (required: 5min)')

  for (const statement of normalized.split(';')) {
    if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement) && !/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statement)) {
      findings.push('CREATE INDEX WITHOUT CONCURRENTLY')
    }
    if (/\bADD\s+CONSTRAINT\b[^;]*\b(?:CHECK|FOREIGN\s+KEY)\b/i.test(statement) && !/\bNOT\s+VALID\b/i.test(statement)) {
      findings.push('CHECK/FOREIGN KEY CONSTRAINT WITHOUT NOT VALID')
    }
    if (/\bADD\s+CONSTRAINT\b[^;]*\b(?:UNIQUE|PRIMARY\s+KEY|EXCLUDE)\b/i.test(statement) && !/\bUSING\s+INDEX\b/i.test(statement)) {
      findings.push('BLOCKING UNIQUE/PRIMARY/EXCLUDE CONSTRAINT')
    }
  }
  return [...new Set(findings)]
}

function validateMigrationVersions(sha, cwd) {
  const output = git(['ls-tree', '-r', '--name-only', sha, '--', 'supabase/migrations'], cwd)
  const versions = new Map()
  for (const file of output.split('\n').filter((name) => /\/\d{14}_[^/]+\.sql$/.test(name))) {
    const version = file.split('/').at(-1).slice(0, 14)
    const existing = versions.get(version)
    if (existing) throw new Error(`Duplicate migration version ${version}: ${existing}, ${file}`)
    versions.set(version, file)
  }
}

export function checkMigrationRange(baseSha, headSha, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  git(['cat-file', '-e', `${baseSha}^{commit}`], cwd)
  git(['cat-file', '-e', `${headSha}^{commit}`], cwd)
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseSha, headSha], { cwd, stdio: 'ignore' })
  } catch {
    throw new Error(`The migration baseline ${baseSha} is not an ancestor of ${headSha}. Refusing a partial or reordered production deploy.`)
  }

  const historicalChanges = changedFiles(baseSha, headSha, 'MDRTUXB', MIGRATIONS_PATHSPEC, cwd)
  if (historicalChanges.length) {
    throw new Error(['Existing migration files are immutable. Add a new migration instead:', ...historicalChanges.map((file) => `  - ${file}`)].join('\n'))
  }
  validateMigrationVersions(headSha, cwd)

  const addedMigrations = changedFiles(baseSha, headSha, 'AC', MIGRATIONS_PATHSPEC, cwd)
  let baseContracts
  let headContracts
  try {
    baseContracts = parsePendingContracts(showFile(baseSha, CONTRACTS_PATH, cwd, false))
    headContracts = parsePendingContracts(showFile(headSha, CONTRACTS_PATH, cwd, false))
  } catch (error) {
    throw new Error(`Invalid ${CONTRACTS_PATH}: ${error instanceof Error ? error.message : error}`)
  }
  const baseById = new Map(baseContracts.map((contract) => [contract.id, contract]))
  const headById = new Map(headContracts.map((contract) => [contract.id, contract]))
  const removedIds = new Set(baseContracts.filter(({ id }) => !headById.has(id)).map(({ id }) => id))
  const addedIds = new Set(headContracts.filter(({ id }) => !baseById.has(id)).map(({ id }) => id))

  for (const contract of headContracts) {
    const migrationPath = `supabase/migrations/${contract.expand_migration}`
    if (!fileExists(headSha, migrationPath, cwd)) throw new Error(`Pending contract ${contract.id} references missing expand migration ${contract.expand_migration}`)
    const previous = baseById.get(contract.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(contract)) throw new Error(`Pending contract ${contract.id} cannot be modified after deployment`)
    if (addedIds.has(contract.id) && !addedMigrations.includes(migrationPath)) {
      throw new Error(`New pending contract ${contract.id} must reference an expand migration added in the same release`)
    }
  }

  const failures = []
  const consumedIds = new Set()
  for (const migration of addedMigrations) {
    const sql = showFile(headSha, migration, cwd)
    const contractId = sql.match(/^-- migration-contract:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/m)?.[1] ?? null
    const contract = contractId ? baseById.get(contractId) ?? null : null
    if (contractId) {
      if (consumedIds.has(contractId)) failures.push({ migration, findings: [`CONTRACT ALREADY CONSUMED: ${contractId}`] })
      consumedIds.add(contractId)
      if (contract && !fileExists(baseSha, `supabase/migrations/${contract.expand_migration}`, cwd)) {
        failures.push({ migration, findings: [`EXPAND MIGRATION NOT PRESENT IN BASELINE: ${contract.expand_migration}`] })
      }
      if (headById.has(contractId)) failures.push({ migration, findings: [`CONTRACT ENTRY MUST BE REMOVED: ${contractId}`] })
    }
    const findings = analyzeMigration(sql, contract)
    if (findings.length) failures.push({ migration, findings })
  }

  for (const id of removedIds) {
    if (!consumedIds.has(id)) failures.push({ migration: CONTRACTS_PATH, findings: [`PENDING CONTRACT REMOVED WITHOUT MIGRATION: ${id}`] })
  }
  for (const id of consumedIds) {
    if (!removedIds.has(id)) failures.push({ migration: CONTRACTS_PATH, findings: [`CONTRACT DID NOT CONSUME A BASELINE ENTRY: ${id}`] })
  }

  if (failures.length) {
    throw new Error([
      'Unsafe production migration(s) detected:',
      ...failures.flatMap(({ migration, findings }) => [`  ${migration}`, ...findings.map((finding) => `    - ${finding}`)]),
      'Use an expand migration first; consume its registered pending contract only after the expand exists in the production baseline.',
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
