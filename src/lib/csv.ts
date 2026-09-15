export function escapeCsvValue(value: unknown) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function buildCsv(headers: string[], rows: readonly unknown[][]) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(escapeCsvValue).join(';')).join('\r\n')}\r\n`
}

export function downloadCsv(content: string, fileName: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}
