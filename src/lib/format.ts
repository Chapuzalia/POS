import type { TicketLine } from '../types'

const moneyFormatter = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatMoney(cents: number) {
  return moneyFormatter.format(cents / 100)
}

export function parseMoneyToCents(value: string) {
  const normalized = value
    .replace(',', '.')
    .replace(/[^\d.-]/g, '')
    .trim()
  const parsed = Number.parseFloat(normalized)

  if (!Number.isFinite(parsed)) {
    return 0
  }

  return Math.max(0, Math.round(parsed * 100))
}

export function centsToInput(cents: number) {
  return (cents / 100).toFixed(2)
}

export function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

export function createId() {
  if ('crypto' in window && window.crypto.randomUUID) {
    return window.crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function getLineTotal(line: TicketLine) {
  return line.unitPriceCents * line.quantity
}

export function getTicketTotal(lines: TicketLine[]) {
  return lines.reduce((total, line) => total + getLineTotal(line), 0)
}

export function getLineSignature(line: Pick<TicketLine, 'productId' | 'variantId' | 'modifiers'> & Pick<Partial<TicketLine>, 'mixerProductId'>) {
  const modifierIds = line.modifiers
    .map((modifier) => modifier.id)
    .sort()
    .join('|')

  return `${line.productId}:${line.variantId}:${modifierIds}:${line.mixerProductId ?? ''}`
}
