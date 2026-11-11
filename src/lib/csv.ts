export function escapeCsvValue(value: unknown) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function buildCsv(headers: string[], rows: readonly unknown[][]) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(escapeCsvValue).join(';')).join('\r\n')}\r\n`
}
