import type {
  AppliedDiscount,
  Discount,
  DiscountCalculationType,
  DiscountRoundingIncrementCents,
  PaymentMethod,
  DiscountCreateInput,
  DiscountTarget,
  TicketLine,
} from '../types'
import { formatMoney } from './format.ts'

import { getOperationalDateKey, getZonedDateTimeParts, shiftIsoDate, toIsoDate } from './operationalDay.ts'
export type DiscountCalculation = {
  discountAmountCents: number
  totalCents: number
}

export const discountRoundingOptions: Array<{
  label: string
  value: DiscountRoundingIncrementCents | null
}> = [
  { label: 'Sin redondeo', value: null },
  { label: 'A los 0,05 € más cercanos', value: 5 },
  { label: 'A los 0,10 € más cercanos', value: 10 },
  { label: 'A los 0,50 € más cercanos', value: 50 },
  { label: 'Al euro más cercano', value: 100 },
]

const validRoundingIncrements = new Set<DiscountRoundingIncrementCents>([5, 10, 50, 100])

export function calculateDiscount(
  subtotalCents: number,
  calculationType?: DiscountCalculationType | null,
  value?: number | null,
  roundingIncrementCents?: DiscountRoundingIncrementCents | null,
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
  let totalCents = subtotalCents - discountAmountCents

  if (roundingIncrementCents !== null && roundingIncrementCents !== undefined) {
    if (!validRoundingIncrements.has(roundingIncrementCents)) {
      throw new Error('El incremento de redondeo no es válido.')
    }
    totalCents = Math.min(subtotalCents, Math.round(totalCents / roundingIncrementCents) * roundingIncrementCents)
  }

  return {
    discountAmountCents: subtotalCents - totalCents,
    totalCents,
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
  return calculateDiscount(
    subtotalCents,
    discount?.calculationType,
    discount?.value,
    discount?.roundingIncrementCents,
  )
}

export function formatDiscountValue(calculationType: DiscountCalculationType, value: number) {
  return calculationType === 'percentage'
    ? `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(value)} %`
    : formatMoney(value)
}

export function formatDiscountRounding(incrementCents: DiscountRoundingIncrementCents | null) {
  return discountRoundingOptions.find((option) => option.value === incrementCents)?.label ?? 'Sin redondeo'
}

export function getDiscountLabel(discount: AppliedDiscount) {
  return `${discount.name} · ${formatDiscountValue(discount.calculationType, discount.value)}`
}
export type DiscountScheduleContext = {
  dayChangeTime: string | null
  timeZone: string
  now?: Date
}

export type DiscountableLine = Pick<TicketLine, 'productId' | 'variantId'> & {
  grossCents: number
}

export type LineDiscountAllocation = {
  eligible: boolean
  grossCents: number
  discountAmountCents: number
  netCents: number
}

export type AppliedDiscountCalculation = DiscountCalculation & {
  eligibleSubtotalCents: number
  lineAllocations: LineDiscountAllocation[]
}

const promotionTimePattern = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/

function timeToMinutes(value: string | null) {
  if (!value) return null
  const match = promotionTimePattern.exec(value)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

function getIsoWeekday(isoDate: string) {
  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay()
  return weekday === 0 ? 7 : weekday
}

export function isLineEligibleForDiscount(
  line: Pick<DiscountableLine, 'productId' | 'variantId'>,
  scope: Discount['scope'],
  targets: DiscountTarget[],
) {
  if (scope === 'general') return true
  return targets.some((target) => target.productId === line.productId
    && (target.variantId === null || target.variantId === line.variantId))
}

export function calculateDiscountForLines(
  lines: DiscountableLine[],
  discount: AppliedDiscount | null,
): AppliedDiscountCalculation {
  const eligibleIndexes: number[] = []
  const eligibleGross: number[] = []
  lines.forEach((line, index) => {
    if (!Number.isInteger(line.grossCents) || line.grossCents < 0) {
      throw new Error('Los importes de línea deben expresarse en céntimos enteros.')
    }
    if (discount && isLineEligibleForDiscount(line, discount.scope ?? 'general', discount.targets ?? [])) {
      eligibleIndexes.push(index)
      eligibleGross.push(line.grossCents)
    }
  })
  const subtotalCents = lines.reduce((total, line) => total + line.grossCents, 0)
  const eligibleSubtotalCents = eligibleGross.reduce((total, value) => total + value, 0)
  const eligibleCalculation = calculateDiscount(
    eligibleSubtotalCents,
    discount?.calculationType,
    discount?.value,
    discount?.roundingIncrementCents,
  )
  const eligibleNet = allocateNetTotalToLines(eligibleGross, eligibleCalculation.totalCents)
  const eligiblePositions = new Map(eligibleIndexes.map((lineIndex, position) => [lineIndex, position]))
  const lineAllocations = lines.map((line, index) => {
    const position = eligiblePositions.get(index)
    if (position === undefined) {
      return { eligible: false, grossCents: line.grossCents, discountAmountCents: 0, netCents: line.grossCents }
    }
    const netCents = eligibleNet[position]
    return {
      eligible: true,
      grossCents: line.grossCents,
      discountAmountCents: line.grossCents - netCents,
      netCents,
    }
  })
  return {
    eligibleSubtotalCents,
    lineAllocations,
    discountAmountCents: eligibleCalculation.discountAmountCents,
    totalCents: subtotalCents - eligibleCalculation.discountAmountCents,
  }
}

export function isPromotionActive(
  discount: Pick<Discount, 'ruleKind' | 'activeWeekdays' | 'startsAt' | 'endsAt'>,
  context: DiscountScheduleContext,
) {
  if (discount.ruleKind !== 'promotion') return true
  const startsAt = timeToMinutes(discount.startsAt)
  const endsAt = timeToMinutes(discount.endsAt)
  if (startsAt === null || endsAt === null || startsAt === endsAt || !discount.activeWeekdays.length) return false
  const now = context.now ?? new Date()
  const local = getZonedDateTimeParts(now, context.timeZone)
  const minute = local.hour * 60 + local.minute
  const overnight = endsAt < startsAt
  const insideWindow = overnight ? minute >= startsAt || minute < endsAt : minute >= startsAt && minute < endsAt
  if (!insideWindow) return false
  const calendarDate = toIsoDate(local)
  const operationalDate = getOperationalDateKey(now, context)
  const previousCalendarDate = shiftIsoDate(calendarDate, -1)
  const scheduleDate = overnight && minute < endsAt && previousCalendarDate < operationalDate
    ? previousCalendarDate
    : operationalDate
  return discount.activeWeekdays.includes(getIsoWeekday(scheduleDate))
}

export function getAvailableVenueDiscounts(
  discounts: Discount[],
  venueId: string,
  context: DiscountScheduleContext,
) {
  return getActiveVenueDiscounts(discounts, venueId)
    .filter((discount) => !discount.autoApply && isPromotionActive(discount, context))
}

export function toAppliedDiscount(discount: Discount, automatic = discount.autoApply): AppliedDiscount {
  return {
    discountId: discount.id,
    name: discount.name,
    type: discount.type,
    calculationType: discount.type,
    value: discount.value,
    roundingIncrementCents: discount.roundingIncrementCents,
    color: discount.color,
    ruleKind: discount.ruleKind,
    scope: discount.scope,
    targets: discount.targets.map((target) => ({ ...target })),
    requiresPin: discount.requiresPin,
    activeWeekdays: [...discount.activeWeekdays],
    startsAt: discount.startsAt,
    endsAt: discount.endsAt,
    automatic,
  }
}

export function resolveTicketDiscount(
  current: AppliedDiscount | null,
  discounts: Discount[],
  venueId: string,
  context: DiscountScheduleContext,
) {
  const automatic = getActiveVenueDiscounts(discounts, venueId)
    .find((discount) => discount.ruleKind === 'promotion' && discount.autoApply && isPromotionActive(discount, context))
  if (automatic) return toAppliedDiscount(automatic, true)
  if (!current) return null
  if (!current.discountId) return current
  const configured = discounts.find((discount) => discount.id === current.discountId)
  if (!configured?.isActive) return null
  if (configured.ruleKind === 'promotion' && !isPromotionActive(configured, context)) return null
  return { ...current, automatic: false }
}

export function validateDiscountRule(input: Pick<DiscountCreateInput,
  'name' | 'type' | 'value' | 'ruleKind' | 'scope' | 'targets' | 'requiresPin' | 'pin' | 'activeWeekdays' | 'startsAt' | 'endsAt' | 'autoApply'
>) {
  const name = validateDiscountDefinition(input.name, input.type, input.value)
  if (input.scope === 'specific' && !input.targets.length) throw new Error('Selecciona al menos un producto o variante.')
  if (input.autoApply && input.requiresPin) throw new Error('Una promoción automática no puede requerir PIN.')
  if (input.requiresPin && input.pin !== null && !/^\d{4,8}$/.test(input.pin)) {
    throw new Error('El PIN debe contener entre 4 y 8 dígitos.')
  }
  if (input.ruleKind === 'promotion') {
    if (!input.activeWeekdays.length || input.activeWeekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw new Error('Selecciona al menos un día válido para la promoción.')
    }
    const start = timeToMinutes(input.startsAt)
    const end = timeToMinutes(input.endsAt)
    if (start === null || end === null || start === end) throw new Error('Indica una franja horaria válida y no vacía.')
  }
  return name
}

