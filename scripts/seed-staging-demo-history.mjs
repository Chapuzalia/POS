#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { accountDefinitions, scenarios, target } from './staging-demo-data.mjs'
import { remote } from './seed-staging-demos.mjs'
import { createHistoryPlan, historyIntegritySql, historyReportSql, historySeed, historySessionSql, sourceSql } from './staging-demo-history.mjs'

export function parseHistoryArgs(args) {
  if (args.length !== 2 || !['--check', '--apply', '--verify'].includes(args[0]) || args[1] !== target.project) throw new Error(`Uso: node scripts/seed-staging-demo-history.mjs --check|--apply|--verify ${target.project}. Destino fijo: ${target.api}`)
  return args[0]
}

export async function main(args) {
  const mode = parseHistoryArgs(args)
  const directory = resolve('backups/staging-demos')
  const credentials = JSON.parse(await readFile(resolve(directory, 'credentials.local.json'), 'utf8'))
  if (credentials.project !== target.project || credentials.api !== target.api) throw new Error('Credenciales fuera de staging')
  const expected = accountDefinitions()
  if (credentials.accounts.length !== expected.length || expected.some((a, i) => Object.entries(a).some(([key, value]) => JSON.stringify(credentials.accounts[i][key]) !== JSON.stringify(value)))) throw new Error('Las cuentas no coinciden con las demos')
  // Strip passwords from the frozen history plan and all SQL payloads.
  const accounts = credentials.accounts.map(({ password: _password, ...account }) => account)
  const planPath = resolve(directory, 'history-plan.local.json')
  const { output: rawSource } = await remote({ action: 'sql', sql: sourceSql() })
  const source = JSON.parse(rawSource)
  let plan
  try { plan = JSON.parse(await readFile(planPath, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (mode === '--verify') throw new Error('No hay un plan histórico guardado')
    plan = createHistoryPlan(source, accounts)
    if (mode === '--apply') await writeFile(planPath, JSON.stringify(plan), { flag: 'wx', mode: 0o600 })
  }
  if (plan.project !== target.project || plan.api !== target.api || plan.seed !== historySeed || plan.sessions.length !== 450) throw new Error('Plan histórico no válido')
  // Validate the entire frozen session identity before using it as an SQL fixture.
  for (const session of plan.sessions) {
    const actor = accounts.find(a => a.id === session.actorId && a.deviceId === session.deviceId && a.venueId === session.venueId && a.tenantId === session.tenantId)
    if (!actor || !scenarios.some(s => s.id === session.tenantId)) throw new Error('Identidad histórica fuera de las demos')
  }
  const tickets = plan.sessions.reduce((sum, s) => sum + s.events.length, 0)
  const lines = plan.sessions.reduce((sum, s) => sum + s.events.reduce((total, e) => total + e.payload.lines.length, 0), 0)
  console.log(`Staging verificado. Plan: ${plan.startDate} a ${plan.endDate}, 450 cierres, ${tickets} tickets y ${lines} líneas.`)
  if (mode === '--check') return
  if (mode === '--apply') {
    const representative = [...new Map(plan.sessions.map(s => [s.venueId, s])).values()]
    await remote({ action: 'sql', sql: representative.map(s => historySessionSql(s, { rollback: true })).join('\n') })
    console.log('Validación con rollback correcta para los cinco locales. Cargando por jornadas atómicas…')
    for (let offset = 0; offset < plan.sessions.length; offset += 14) {
      const batch = plan.sessions.slice(offset, offset + 14)
      await remote({ action: 'sql', sql: batch.map(s => historySessionSql(s)).join('\n') })
      console.log(`Jornadas verificadas: ${Math.min(offset + batch.length, plan.sessions.length)}/450 (${batch.at(-1).venueName}, ${batch.at(-1).date})`)
    }
  }
  await remote({ action: 'sql', sql: historyIntegritySql(plan) })
  const { output } = await remote({ action: 'sql', sql: historyReportSql(plan) })
  const report = JSON.parse(output)
  if (report.length !== 5) throw new Error('Faltan locales en el histórico')
  for (const row of report) {
    const sessions = plan.sessions.filter(s => s.venueId === row.venue_id)
    if (row.sessions !== sessions.length || row.open_sessions || row.tickets !== sessions.reduce((n, s) => n + s.events.length, 0)
      || row.total_cents !== sessions.reduce((n, s) => n + s.totalCents, 0)) throw new Error('El histórico no coincide con el plan')
  }
  const { verified } = await remote({ action: 'history-stats', accounts: credentials.accounts.filter(a => a.role === 'owner'), startDate: plan.startDate, endDate: plan.endDate, sessions: plan.sessions.map(({ venueId, tenantId }) => ({ venueId, tenantId })) })
  await writeFile(resolve(directory, 'history-verification.local.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), startDate: plan.startDate, endDate: plan.endDate, tickets, lines, report, verified }, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
  console.log(`Integridad y estadísticas reales del CRM verificadas en ${verified.length} locales. Cashlogy y Verifactu siguen desactivados.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
