#!/usr/bin/env node
// Install beside the root-owned check-migrations.mjs; never run either from a release archive.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzeMigration } from './check-migrations.mjs'

const versionPattern = /^\d{14}$/
const migrationPattern = /^(\d{14})_[A-Za-z0-9_-]+\.sql$/
const environmentPattern = /^[a-z][a-z0-9-]{0,31}$/

function migrationFiles(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Invalid migration directory.')
  const files = new Map()
  for (const name of readdirSync(directory)) {
    const match = migrationPattern.exec(name)
    if (!match) throw new Error('Unexpected migration filename.')
    if (files.has(match[1])) throw new Error('Duplicate migration version.')
    files.set(match[1], name)
  }
  return files
}

function migrationBytes(directory, files, version) {
  const name = files.get(version)
  if (!name) throw new Error('Missing migration file.')
  const path = join(directory, name)
  if (!lstatSync(path).isFile()) throw new Error('Migration must be a plain file.')
  return readFileSync(path)
}

export function migrationHistoryFingerprint({ directory, applied }) {
  if (!Array.isArray(applied) || new Set(applied).size !== applied.length
    || applied.some(version => typeof version !== 'string' || !versionPattern.test(version))) {
    throw new Error('Invalid applied migration versions.')
  }
  const files = migrationFiles(directory)
  const hashes = Object.fromEntries([...applied].sort().map(version => [version,
    createHash('sha256').update(migrationBytes(directory, files, version)).digest('hex')]))
  return { sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), applied_count: applied.length }
}

function approved(approvals, environment, migration, bytes, now) {
  const hash = createHash('sha256').update(bytes).digest('hex')
  return approvals.find(approval => approval && typeof approval === 'object'
    && approval.environment === environment && approval.migration === migration
    && approval.sha256 === hash && typeof approval.reason === 'string' && approval.reason.trim()
    && typeof approval.expires_at === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(approval.expires_at)
    && Number.isFinite(Date.parse(approval.expires_at)) && Date.parse(approval.expires_at) > now)
}

function requiresAnonymousBlockApproval(sql) {
  if (!/\bDO\b/i.test(sql)) return false
  const identifierStart = /[A-Za-z_\u0080-\uFFFF]/
  const identifierPart = /[A-Za-z0-9_$\u0080-\uFFFF]/
  let index = 0
  let statementStart = true
  while (index < sql.length) {
    const character = sql[index]
    if (/\s/.test(character)) { index += 1; continue }
    if (sql.startsWith('--', index)) {
      while (index < sql.length && !/[\r\n]/.test(sql[index])) index += 1
      continue
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1
      index += 2
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) { depth += 1; index += 2 }
        else if (sql.startsWith('*/', index)) { depth -= 1; index += 2 }
        else index += 1
      }
      if (depth) return true
      continue
    }
    if (character === "'" || character === '"') {
      const escapes = character === "'" && index > 0 && /[eE]/.test(sql[index - 1])
        && (index < 2 || !identifierPart.test(sql[index - 2]))
      index += 1
      let closed = false
      while (index < sql.length) {
        if (sql[index] === '\\' && character === "'") {
          // A plain string's backslash interpretation can be changed by SET.
          // Ambiguous lexical input needs the same exact-content root review.
          if (!escapes) return true
          index += 2
        } else if (sql[index] === character) {
          if (sql[index + 1] === character) index += 2
          else { index += 1; closed = true; break }
        } else index += 1
      }
      if (!closed) return true
      statementStart = false
      continue
    }
    if (character === '$') {
      const tag = sql.slice(index).match(/^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/)?.[0]
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length)
        if (end === -1) return true
        index = end + tag.length
        statementStart = false
        continue
      }
    }
    if (identifierStart.test(character)) {
      const start = index++
      while (index < sql.length && identifierPart.test(sql[index])) index += 1
      if (statementStart && sql.slice(start, index).toUpperCase() === 'DO') return true
      statementStart = false
      continue
    }
    statementStart = character === ';'
    index += 1
  }
  return false
}

export function checkPendingMigrations(request, now = Date.now()) {
  const { directory, pending, applied, environment, approvals = [] } = request
  if (typeof directory !== 'string' || !isAbsolute(directory) || !environmentPattern.test(environment ?? '')
    || !Array.isArray(pending) || !Array.isArray(applied) || !Array.isArray(approvals)
    || [...pending, ...applied].some(version => typeof version !== 'string' || !versionPattern.test(version))
    || new Set(pending).size !== pending.length || new Set(applied).size !== applied.length
    || pending.some(version => applied.includes(version))) {
    throw new Error('Invalid pending migration safety request.')
  }
  const files = migrationFiles(directory)
  for (const version of pending) {
    const name = files.get(version)
    const bytes = migrationBytes(directory, files, version)
    const sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    // Review declarations supplied by a release cannot authorize their own SQL.
    // Root approvals bind the exact prepared bytes, never just a SHA or version.
    const unreviewed = sql.replace(/^\s*--\s*migration-safety-reviewed:[^\r\n]*/gim, '')
    const findings = analyzeMigration(unreviewed)
    // The range analyzer's historical DO exceptions are not deployment authority.
    // Inspect statement boundaries before erasing bodies or consulting source comments.
    if (requiresAnonymousBlockApproval(sql)) findings.push('ANONYMOUS DO BLOCK REQUIRES ROOT CONTENT APPROVAL')
    const approval = approved(approvals, environment, name, bytes, now)
    if (/^-- migration-safety: contract\r?$/m.test(sql)) {
      const expand = typeof approval?.expand_migration === 'string'
        ? migrationPattern.exec(approval.expand_migration) : null
      if (!expand || !applied.includes(expand[1])) {
        throw new Error(`Contract ${name} requires a root-approved expand migration already in the applied ledger.`)
      }
    }
    if (findings.length && !approval) {
      throw new Error(`Unsafe pending migration ${name}: ${findings.join(', ')}`)
    }
  }
  return pending.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const request = JSON.parse(readFileSync(0, 'utf8'))
    if (process.argv.length === 3 && process.argv[2] === '--history-hash') {
      console.log(JSON.stringify(migrationHistoryFingerprint(request)))
    } else if (process.argv.length === 2) {
      console.log(`Pending migration safety verified: ${checkPendingMigrations(request)}`)
    } else {
      throw new Error('Usage: pending-migration-safety.mjs [--history-hash] < request.json')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Pending migration safety failed.')
    process.exitCode = 1
  }
}
