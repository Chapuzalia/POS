import { readFile } from 'node:fs/promises'

export function parseArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`Argumento inesperado: ${token}`)
    const [rawKey, inlineValue] = token.slice(2).split('=', 2)
    const value = inlineValue ?? argv[index + 1]
    if (value == null || value.startsWith('--')) throw new Error(`Falta el valor de --${rawKey}`)
    result[rawKey] = value
    if (inlineValue === undefined) index += 1
  }
  return result
}

export async function loadEnvironment(filePath) {
  const environment = { ...process.env }
  if (!filePath) return environment
  const text = await readFile(filePath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 1) continue
    const name = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    environment[name] = value
  }
  return environment
}

export function connectionFrom(args, environment) {
  const url = args.url ?? environment.SUPABASE_URL ?? environment.VITE_SUPABASE_URL
  const key = args.key ?? environment.SUPABASE_SERVICE_ROLE_KEY ?? environment.SUPABASE_ANON_KEY ?? environment.VITE_SUPABASE_ANON_KEY
  if (!url) throw new Error('Falta --url o SUPABASE_URL/VITE_SUPABASE_URL.')
  if (!key) throw new Error('Falta --key o SUPABASE_SERVICE_ROLE_KEY.')
  return { url: url.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, ''), key }
}

