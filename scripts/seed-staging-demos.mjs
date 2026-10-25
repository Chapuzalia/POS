#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { accountDefinitions, preflightSql, reportSql, scenarios, seedSql, target } from './staging-demo-data.mjs'

export function parseArgs(args) {
  if (args.length !== 2 || !['--check', '--apply', '--verify', '--rotate-passwords'].includes(args[0]) || args[1] !== target.project) {
    throw new Error(`Uso: node scripts/seed-staging-demos.mjs --check|--apply|--verify|--rotate-passwords ${target.project}. Destino fijo: ${target.api}`)
  }
  return args[0]
}

export async function remote(payload) {
  const program = Buffer.from(await readFile(new URL('./staging-demo-remote.py', import.meta.url))).toString('base64')
  return new Promise((resolveResult, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target.sshHost,
      `python3 -c "import base64;exec(base64.b64decode('${program}'))"`], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.stdin.on('error', () => {})
    child.on('close', code => {
      if (code) return reject(new Error(stderr.trim() || `SSH terminó con código ${code}`))
      try { resolveResult(JSON.parse(stdout)) } catch { reject(new Error('Respuesta de staging no válida')) }
    })
    child.stdin.end(JSON.stringify({ ...payload, project: target.project, api: target.api }))
  })
}

export async function main(args) {
  const mode = parseArgs(args)
  const credentialsPath = resolve('backups/staging-demos/credentials.local.json')
  await remote({ action: 'sql', sql: preflightSql() })
  console.log(`Destino staging verificado: ${target.api} (${target.project})`)
  if (mode === '--check') {
    console.log(JSON.stringify({ scenarios, accounts: accountDefinitions().map(({ key, email, role }) => ({ key, email, role })) }, null, 2))
    return
  }
  let manifest
  try { manifest = JSON.parse(await readFile(credentialsPath, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT' || mode !== '--apply') throw error
    manifest = { project: target.project, api: target.api, seed: target.seed, createdAt: new Date().toISOString(), accounts: accountDefinitions().map(a => ({ ...a, password: `Demo-${randomBytes(18).toString('base64url')}!` })) }
    await mkdir(resolve('backups/staging-demos'), { recursive: true, mode: 0o700 })
    // Save passwords before provisioning so interrupted runs can resume safely.
    await writeFile(credentialsPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  if (manifest.project !== target.project || manifest.api !== target.api || manifest.seed !== target.seed) throw new Error('El manifiesto no corresponde a staging')
  const expected = accountDefinitions()
  if (manifest.accounts.length !== expected.length || expected.some((a, i) => Object.entries(a).some(([key, value]) => JSON.stringify(manifest.accounts[i][key]) !== JSON.stringify(value)))) throw new Error('El manifiesto no coincide con las cuentas previstas')
  if (mode === '--rotate-passwords') {
    if (process.stdin.isTTY) throw new Error('Proporciona la nueva contraseña por stdin, nunca por argumentos')
    let password = ''
    for await (const chunk of process.stdin) password += chunk.toString('utf8')
    password = password.trim()
    if (password.length < 8 || password.length > 128 || /[\r\n]/.test(password)) throw new Error('Usa una sola contraseña de 8 a 128 caracteres')
    manifest.accounts = manifest.accounts.map(a => ({ ...a, password }))
    // Preserve the intended credentials if an interrupted request updates only
    // part of the batch. Repeating this explicit mode safely finishes the batch.
    manifest.passwordChangedAt = new Date().toISOString()
    await writeFile(resolve('backups/staging-demos/password-rotation.local.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    const { updated } = await remote({ action: 'passwords', accounts: manifest.accounts })
    if (updated !== manifest.accounts.length) throw new Error('No se ha confirmado la actualización de todas las contraseñas')
    await writeFile(credentialsPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    console.log(`Contraseñas actualizadas: ${updated} cuentas demo. Verificando los accesos…`)
  }
  if (mode === '--apply') {
    const { users } = await remote({ action: 'auth', accounts: manifest.accounts })
    const ids = new Map(users.map(u => [u.key, u.id]))
    manifest.accounts = manifest.accounts.map(a => ({ ...a, id: ids.get(a.key) }))
    await writeFile(credentialsPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    console.log('Auth listo. Validando la seed completa en una transacción con rollback…')
    await remote({ action: 'sql', sql: seedSql(manifest.accounts, { rollback: true }) })
    console.log('Validación SQL correcta. Aplicando únicamente los tres negocios demo…')
    await remote({ action: 'sql', sql: seedSql(manifest.accounts) })
  }
  const { output } = await remote({ action: 'sql', sql: reportSql() })
  const report = JSON.parse(output)
  if (report.length !== 3 || report.some(s => s.cashlogy || s.verifactu || s.legacy_fiscal)) throw new Error('La comprobación de escenarios/integraciones ha fallado')
  const { verified } = await remote({ action: 'verify', accounts: manifest.accounts, tenantIds: scenarios.map(s => s.id) })
  await writeFile(resolve('backups/staging-demos/verification.local.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), report, verified }, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
  console.log(`Acceso y aislamiento verificados: ${verified.length} cuentas. Credenciales privadas: ${credentialsPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
