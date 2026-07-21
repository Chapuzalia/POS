export function createSeparator(width: number, character = '-') {
  return character.repeat(Math.max(1, Math.trunc(width)))
}

export function centerReceiptText(value: string, width: number) {
  const text = value.trim().slice(0, width)
  const left = Math.max(0, Math.floor((width - text.length) / 2))
  return `${' '.repeat(left)}${text}`
}

export function formatReceiptRow({ label, value, width, gap = 1 }: {
  label: string
  value: string
  width: number
  gap?: number
}) {
  const safeWidth = Math.max(1, Math.trunc(width))
  const safeValue = value.trim().slice(0, safeWidth)
  const availableLabel = Math.max(0, safeWidth - safeValue.length - Math.max(1, gap))
  if (!availableLabel) return safeValue.padStart(safeWidth)
  const safeLabel = label.trim().slice(0, availableLabel)
  return `${safeLabel}${' '.repeat(safeWidth - safeLabel.length - safeValue.length)}${safeValue}`
}

export function formatMoneyForReceipt(amountCents: number, options: {
  currency?: string
  locale?: string
  symbol?: 'currency' | 'code'
} = {}) {
  const currency = options.currency || 'EUR'
  const locale = options.locale || 'es-ES'
  const formatted = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: options.symbol === 'code' ? 'code' : 'symbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.trunc(amountCents) / 100)
  return formatted.replace(/\u00a0/g, ' ')
}

export function formatReceiptDate(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}
