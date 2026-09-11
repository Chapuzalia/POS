export function validateBuildEnvironment(env: Record<string, unknown>) {
  const redacted = Object.entries(env)
    .filter(([key, value]) => key.startsWith('VITE_') && typeof value === 'string' && value.trim() === '[SENSITIVE]')
    .map(([key]) => key)
  if (redacted.length) {
    throw new Error(`Variables de compilación censuradas: ${redacted.join(', ')}. Compila en Vercel para acceder a sus valores reales; no publiques una compilación local con variables sensibles descargadas.`)
  }
}
