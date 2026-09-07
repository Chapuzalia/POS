/** Redact unstructured backend messages without losing exception type or stack frames. */
export function sanitizeDiagnosticText(text: string) {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try { const parsed = new URL(url); parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; return parsed.toString() } catch { return '[url]' }
    })
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[token]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[number]')
    .replace(/\b(password|token|authorization|apikey|api_key|tax_id|nif|iban)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/"(password|token|authorization|apikey|api_key|tax_id|nif|iban)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/Key\s*\([^)]*\)\s*=\s*\([^)]*\)/gi, 'Key [redacted]')
    .replace(/Failing row contains\s*\([^)]*\)/gi, 'Failing row [redacted]')
    .replace(/'[^']*'/g, "'[redacted]'")
}

export function sanitizeDiagnosticData(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]'
  if (typeof value === 'string') return sanitizeDiagnosticText(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticData(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/password|token|authorization|cookie|api.?key|email|phone|address|tax.?id|nif|iban|card|customer|payload|details|__serialized__/i.test(key)) continue
    result[key] = sanitizeDiagnosticData(item, depth + 1)
  }
  return result
}
