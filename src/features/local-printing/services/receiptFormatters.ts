import type { Printer, PrinterLayout } from '../types.ts'

const combiningMarks = /[\u0300-\u036f]/gu
const cp858Characters = new Set(Array.from('áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙäëïöüÄËÏÖÜâêîôûÂÊÎÔÛãõÃÕåÅæÆçÇñÑøØ¿¡ºª€'))
const cp850Characters = new Set(Array.from('áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙäëïöüÄËÏÖÜâêîôûÂÊÎÔÛãõÃÕåÅæÆçÇñÑøØ¿¡ºª'))

const replacements: Record<string, string> = {
  '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...',
  '•': '+', '·': '-', '×': 'x', '\u00a0': ' ', '\u202f': ' ',
  'ß': 'ss', 'Æ': 'AE', 'æ': 'ae', 'Ø': 'O', 'ø': 'o', 'Œ': 'OE', 'œ': 'oe',
}

function characters(value: string) {
  return Array.from(value)
}

export function hasPrintControlCharacters(value: string) {
  return characters(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || code === 127
  })
}

export function receiptTextWidth(value: string) {
  return characters(value).length
}

export function truncateReceiptText(value: string, width: number) {
  return characters(value).slice(0, Math.max(0, Math.trunc(width))).join('')
}

export function adaptTextToCharacterSet(value: unknown, characterSet = 'CP858') {
  const charset = characterSet.trim().toUpperCase().replace(/[-_\s]/g, '')
  const unicode = charset === 'UTF8' || charset === 'UTF16' || charset === 'UNICODE'
  const latin = charset.includes('1252') || charset.includes('885915') || charset.includes('LATIN9')
  const supported = charset.includes('858') ? cp858Characters : charset.includes('850') ? cp850Characters : null
  const raw = characters(String(value ?? '')).map((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || code === 127 ? ' ' : character
  }).join('')

  return characters(raw).map((character) => {
    const replaced = replacements[character] ?? character
    if (unicode) return replaced
    if (replaced === '€') return charset.includes('858') || latin ? replaced : 'EUR'
    if (characters(replaced).every((item) => item >= ' ' && item <= '~')) return replaced
    if (supported?.has(replaced) || (latin && /^[\u00a0-\u00ff]$/u.test(replaced))) return replaced
    const ascii = replaced.normalize('NFD').replace(combiningMarks, '')
    return characters(ascii).filter((item) => item >= ' ' && item <= '~').join('') || '?'
  }).join('')
}

export function wrapReceiptText(value: unknown, width: number, characterSet = 'CP858') {
  const safeWidth = Math.max(1, Math.trunc(width))
  const words = adaptTextToCharacterSet(value, characterSet).trim().split(/\s+/u).filter(Boolean)
  if (!words.length) return ['']
  const lines: string[] = []
  let current = ''

  const pushLongWord = (word: string) => {
    let remaining = word
    while (receiptTextWidth(remaining) > safeWidth) {
      lines.push(truncateReceiptText(remaining, safeWidth))
      remaining = characters(remaining).slice(safeWidth).join('')
    }
    current = remaining
  }

  for (const word of words) {
    if (!current) {
      pushLongWord(word)
      continue
    }
    if (receiptTextWidth(`${current} ${word}`) <= safeWidth) {
      current = `${current} ${word}`
      continue
    }
    lines.push(current)
    current = ''
    pushLongWord(word)
  }
  if (current) lines.push(current)
  return lines
}

export function createSeparator(width: number, character = '-') {
  const safeWidth = Math.max(1, Math.trunc(width))
  const safeCharacter = truncateReceiptText(adaptTextToCharacterSet(character), 1) || '-'
  return safeCharacter.repeat(safeWidth)
}

export function centerReceiptText(value: string, width: number, characterSet = 'CP858') {
  const safeWidth = Math.max(1, Math.trunc(width))
  const text = truncateReceiptText(adaptTextToCharacterSet(value, characterSet).trim(), safeWidth)
  const left = Math.max(0, Math.floor((safeWidth - receiptTextWidth(text)) / 2))
  return `${' '.repeat(left)}${text}`
}

export function formatReceiptRow({ label, value, width, gap = 1, characterSet = 'CP858' }: {
  label: string
  value: string
  width: number
  gap?: number
  characterSet?: string
}) {
  const safeWidth = Math.max(1, Math.trunc(width))
  const safeValue = truncateReceiptText(adaptTextToCharacterSet(value, characterSet).trim(), safeWidth)
  const availableLabel = Math.max(0, safeWidth - receiptTextWidth(safeValue) - Math.max(1, gap))
  if (!availableLabel) return safeValue.padStart(safeWidth)
  const safeLabel = truncateReceiptText(adaptTextToCharacterSet(label, characterSet).trim(), availableLabel)
  return `${safeLabel}${' '.repeat(safeWidth - receiptTextWidth(safeLabel) - receiptTextWidth(safeValue))}${safeValue}`
}

export function formatWrappedReceiptRow(input: {
  label: string
  value: string
  width: number
  characterSet?: string
}) {
  const safeValue = adaptTextToCharacterSet(input.value, input.characterSet).trim()
  const labelWidth = Math.max(1, input.width - receiptTextWidth(safeValue) - 1)
  const labels = wrapReceiptText(input.label, labelWidth, input.characterSet)
  return labels.map((label, index) => index === labels.length - 1
    ? formatReceiptRow({ ...input, label, value: safeValue })
    : label)
}

export function formatMoneyForReceipt(amountCents: number, options: {
  currency?: string
  locale?: string
  symbol?: 'currency' | 'code'
} = {}) {
  if (!Number.isSafeInteger(amountCents)) throw new Error('El importe del documento debe estar expresado en céntimos enteros.')
  const currency = options.currency || 'EUR'
  const locale = options.locale || 'es-ES'
  const absolute = Math.abs(amountCents)
  const whole = Math.floor(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, '0')
  const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole)
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value || ','
  const currencyPart = options.symbol === 'code'
    ? currency
    : new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0)
      .find((part) => part.type === 'currency')?.value || currency
  return `${amountCents < 0 ? '-' : ''}${grouped}${decimal}${fraction} ${currencyPart}`
}

export function formatReceiptDate(value: string, timezone: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}

export function printerLayoutFromPrinter(printer: Printer): PrinterLayout {
  const paperWidth = printer.paperWidth === 58 ? 58 : 80
  return {
    paperWidth,
    columns: paperWidth === 58 ? 32 : 48,
    characterSet: typeof printer.characterSet === 'string' && printer.characterSet.trim()
      ? printer.characterSet.trim()
      : 'CP858',
  }
}

export function finalizeReceiptLines(lines: string[], layout: PrinterLayout) {
  const finalized = lines.flatMap((line) => {
    const safe = adaptTextToCharacterSet(line, layout.characterSet)
    if (receiptTextWidth(safe) <= layout.columns) return [safe]
    const chunks: string[] = []
    let remaining = safe
    while (receiptTextWidth(remaining) > layout.columns) {
      chunks.push(truncateReceiptText(remaining, layout.columns))
      remaining = characters(remaining).slice(layout.columns).join('')
    }
    if (remaining) chunks.push(remaining)
    return chunks
  })
  if (!finalized.length) throw new Error('El documento no contiene líneas para imprimir.')
  if (finalized.length > 1000) throw new Error('El documento supera el máximo de 1.000 líneas.')
  return finalized
}
