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

export function formatTicketNumber(ticketNumber: number | string) {
  return String(ticketNumber).padStart(6, '0')
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

export function roundQuantity(value: number) {
  return Math.round(value * 1000) / 1000
}

export function isValidQuantity(value: number) {
  return Number.isFinite(value) && value > 0 && roundQuantity(value) === value
}

export function parseQuantity(value: string) {
  return roundQuantity(Number.parseFloat(value.replace(',', '.')))
}

export function formatQuantity(value: number) {
  return roundQuantity(value).toLocaleString('es-ES', { maximumFractionDigits: 3 })
}

export function quantityAmountCents(unitPriceCents: number, quantity: number) {
  return Math.round(unitPriceCents * roundQuantity(quantity))
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

export function getLineSignature(line: Pick<TicketLine, 'productId' | 'variantId' | 'modifiers'> & Pick<Partial<TicketLine>, 'mixerProductId' | 'components'>) {
  const modifierIds = line.modifiers
    .map((modifier) => modifier.id)
    .sort()
    .join('|')

  const componentIds = (line.components ?? [])
    .map((component) => `${component.selectionGroupId ?? ''}:${component.productId}:${component.variantId ?? ''}:${component.quantity}`)
    .sort()
    .join('|')

  return `${line.productId}:${line.variantId}:${modifierIds}:${componentIds}:${line.mixerProductId ?? ''}`
}
