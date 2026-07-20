const sensitiveKeys = new Set(['authorization', 'token', 'customerdata', 'ticket', 'password', 'privatekey'])

export function sanitizePrintDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePrintDiagnostics)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !sensitiveKeys.has(key.replaceAll('_', '').toLocaleLowerCase()))
    .map(([key, child]) => [key, sanitizePrintDiagnostics(child)]))
}
