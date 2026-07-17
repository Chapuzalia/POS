import type { AppliedDiscount, Discount, DiscountCalculationType, PaymentMethod } from '../types'
import { formatMoney } from './format.ts'

export type DiscountCalculation = {
  discountAmountCents: number
  totalCents: number
}

export function calculateDiscount(
  subtotalCents: number,
  calculationType?: DiscountCalculationType | null,
  value?: number | null,
): DiscountCalculation {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) {
    throw new Error('El subtotal debe expresarse en céntimos enteros.')
  }

  if (!calculationType || value === null || value === undefined) {
    return { discountAmountCents: 0, totalCents: subtotalCents }
  }

  if (!Number.isFinite(value)) {
    throw new Error('El valor del descuento no es válido.')
  }

  let requestedAmountCents: number

  if (calculationType === 'percentage') {
    if (value <= 0 || value > 100) {
      throw new Error('El porcentaje debe ser mayor que 0 y como máximo 100.')
    }
    requestedAmountCents = Math.round((subtotalCents * value) / 100)
  } else {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error('El importe fijo debe ser mayor que 0 y expresarse en céntimos.')
    }
    requestedAmountCents = value
  }

  const discountAmountCents = Math.min(subtotalCents, requestedAmountCents)
  return {
    discountAmountCents,
    totalCents: subtotalCents - discountAmountCents,
  }
}
export function allocateNetTotalToLines(grossLineCents: number[], netTotalCents: number) {
  if (!grossLineCents.every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error('Los importes de línea deben expresarse en céntimos enteros.')
  }
  if (!Number.isInteger(netTotalCents) || netTotalCents < 0) {
    throw new Error('El total neto debe expresarse en céntimos enteros.')
  }

  let remainingGrossCents = grossLineCents.reduce((total, value) => total + value, 0)
  if (netTotalCents > remainingGrossCents) {
    throw new Error('El total neto no puede superar el subtotal.')
  }

  let remainingNetCents = netTotalCents
  return grossLineCents.map((grossCents, index) => {
    const isLastLine = index === grossLineCents.length - 1
    const netCents = isLastLine || remainingGrossCents <= 0
      ? remainingNetCents
      : Math.round((grossCents * remainingNetCents) / remainingGrossCents)
    remainingGrossCents -= grossCents
    remainingNetCents -= netCents
    return netCents
  })
}

export function assertValidTicketPayment(totalCents: number, paymentMethod: PaymentMethod | null) {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error('El total debe expresarse en céntimos enteros.')
  }
  if (totalCents === 0 && paymentMethod !== null) {
    throw new Error('Un ticket a cero no requiere método de pago.')
  }
  if (totalCents > 0 && paymentMethod === null) {
    throw new Error('Selecciona Efectivo o Tarjeta.')
  }
}

export function getActiveVenueDiscounts(discounts: Discount[], venueId: string) {
  return discounts
    .filter((discount) => discount.venueId === venueId && discount.isActive)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'es'))
}

export function validateDiscountDefinition(name: string, type: DiscountCalculationType, value: number) {
  const normalizedName = name.trim()
  if (!normalizedName) throw new Error('El nombre es obligatorio.')
  calculateDiscount(100, type, value)
  return normalizedName
}


export function calculateAppliedDiscount(subtotalCents: number, discount: AppliedDiscount | null) {
  return calculateDiscount(subtotalCents, discount?.calculationType, discount?.value)
}

export function formatDiscountValue(calculationType: DiscountCalculationType, value: number) {
  return calculationType === 'percentage'
    ? `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(value)} %`
    : formatMoney(value)
}

export function getDiscountLabel(discount: AppliedDiscount) {
  return `${discount.name} · ${formatDiscountValue(discount.calculationType, discount.value)}`
}
