import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function args(argv = process.argv.slice(2)) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`Argumento inesperado: ${token}`)
    const key = token.slice(2)
    if (key === 'dry-run') { result.dryRun = true; continue }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Falta el valor de --${key}`)
    result[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  return result
}

export function required(value, name) { if (!value) throw new Error(`--${name} es obligatorio`); return value }
export function readJson(file) { return JSON.parse(readFileSync(resolve(file), 'utf8')) }
export function loadEnv(files = ['.env.local', '.env']) {
  const env = { ...process.env }
  for (const file of files) {
    try {
      for (const line of readFileSync(resolve(file), 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#')) continue
        const at = trimmed.indexOf('='); if (at > 0 && env[trimmed.slice(0, at)] == null) env[trimmed.slice(0, at)] = trimmed.slice(at + 1).replace(/^['"]|['"]$/g, '')
      }
    } catch {}
  }
  return env
}
