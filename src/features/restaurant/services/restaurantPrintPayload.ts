import type {
  AppliedDiscount,
  CashSession,
  PaymentMethod,
  SaleCreatedPayload,
  TenantContext,
  TicketInvoice,
} from '../../../types/index.ts'
import type { RestaurantEqualSplit, RestaurantOrderLine, RestaurantOrderLineMove } from '../../tables/types.ts'
import { calculateDiscountForLines } from '../../../lib/discounts.ts'
import { calculateTaxFromGross, isValidTaxRate } from '../../../lib/tax.ts'
import { normalizeCatalogSnapshot } from '../../catalog/services/catalogSnapshots.ts'
import { quantityAmountCents } from '../../../lib/format.ts'

export type RestaurantPrintLine = RestaurantOrderLine & { lineTotalCents?: number }

export function getRestaurantCalculationLines(lines: RestaurantPrintLine[]) {
  return lines.map((line) => ({
    productId: line.productId ?? '',
    variantId: line.variantId ?? '',
    grossCents: line.lineTotalCents ?? quantityAmountCents(line.unitPriceCents, line.quantity),
    quantity: line.quantity,
  }))
}

export function withRestaurantCalculationLines(discount: AppliedDiscount | null, lines: RestaurantPrintLine[]) {
  return discount ? {
    ...discount,
    calculationLines: getRestaurantCalculationLines(lines).map((line, index) => ({ ...line, variantId: lines[index].variantId })),
  } : null
}

function printComponents(line: RestaurantOrderLine) {
  if (line.components?.length) return line.components
  if (!line.mixer) return []
  return [{
    id: `legacy-component:${line.mixerProductId || line.mixer.productId}`,
    type: 'mixer' as const,
    selectionGroupId: null,
    selectionGroupName: 'Mixer',
    productId: line.mixerProductId || line.mixer.productId,
    variantId: line.mixer.variantId ?? null,
    productName: line.mixer.name,
    variantName: '',
    quantity: 1,
    priceDeltaCents: line.mixer.priceCents,
    sortOrder: 0,
  }]
}

type BuildRestaurantPrintPayloadInput = {
  cashSession: CashSession
  context: TenantContext
  createdAt: string
  discount: AppliedDiscount | null
  lines: RestaurantPrintLine[]
  paymentId: string | null
  paymentMethod: PaymentMethod | null
  receivedCents: number | null
  changeCents?: number | null
  saleId: string
  subtotalCents: number
  ticketId: string
  totalCents: number
  ticketNumber?: number
  fiscal?: SaleCreatedPayload['fiscal']

  invoice?: TicketInvoice | null
}

export function buildRestaurantPrintPayload(input: BuildRestaurantPrintPayloadInput): SaleCreatedPayload {
  const discountAmountCents = Math.max(0, input.subtotalCents - input.totalCents)
  const calculationLines = getRestaurantCalculationLines(input.lines)
  const grossLineTotals = calculationLines.map((line) => line.grossCents)
  const calculated = calculateDiscountForLines(calculationLines, input.discount)
  const lineAllocations = calculated.totalCents === input.totalCents ? calculated.lineAllocations : null
  return {
    ticket: {
      id: input.ticketId,
      ticketNumber: input.ticketNumber,
      tenantId: input.context.tenantId,
      cashSessionId: input.cashSession.id,
      cashRegisterId: input.cashSession.cashRegisterId,
      venueId: input.context.venueId,
      deviceId: input.context.deviceId,
      userId: input.context.userId,
      subtotalCents: input.subtotalCents,
      discount: input.discount,
      discountAmountCents,
      totalCents: input.totalCents,
      createdAt: input.createdAt,
      invoice: input.invoice ?? null,
    },
    lines: input.lines.map((line, index) => {
      const components = printComponents(line)
      const modifierDeltaCents = line.modifiers.reduce((total, modifier) => total + modifier.priceCents, 0)
        + components.reduce((total, component) => total + (component.modifiers ?? []).reduce((sum, modifier) => sum + modifier.priceCents, 0), 0)
      const componentDeltaCents = components.reduce((total, component) => total + component.priceDeltaCents, 0)
      const taxRate = line.catalogSnapshot?.vatRate ?? input.context.venueDefaultTaxRate
      const fiscalSnapshot = lineAllocations?.[index] && taxRate !== undefined && isValidTaxRate(taxRate)
        ? { taxRate, ...calculateTaxFromGross(lineAllocations[index].netCents, taxRate) }
        : null
      return {
      id: `${input.ticketId}:${line.id}`,
      ticketId: input.ticketId,
      tenantId: input.context.tenantId,
      productId: line.productId || '',
      variantId: line.variantId || '',
      productName: line.productName,
      variantName: line.variantName,
      basePriceCents: line.unitPriceCents - modifierDeltaCents - componentDeltaCents,
      componentDeltaCents,
      modifierDeltaCents,
      grossBeforeDiscountCents: line.unitPriceCents,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: grossLineTotals[index],
      discountAmountCents: lineAllocations?.[index].discountAmountCents,
      netTotalCents: lineAllocations?.[index].netCents,
      note: line.note,
      modifiers: line.modifiers,
      components,
      catalogSnapshot: normalizeCatalogSnapshot(line.catalogSnapshot, { productId: line.productId, productName: line.productName, variantId: line.variantId, variantName: line.variantName, basePriceCents: line.unitPriceCents }),
      fiscalSnapshot,
    }}),
    sale: {
      id: input.saleId,
      tenantId: input.context.tenantId,
      ticketId: input.ticketId,
      cashSessionId: input.cashSession.id,
      cashRegisterId: input.cashSession.cashRegisterId,
      venueId: input.context.venueId,
      deviceId: input.context.deviceId,
      userId: input.context.userId,
      totalCents: input.totalCents,
      paymentMethod: input.paymentMethod,
      createdAt: input.createdAt,
    },
    payment: input.paymentMethod ? {
      id: input.paymentId || input.saleId,
      tenantId: input.context.tenantId,
      saleId: input.saleId,
      method: input.paymentMethod,
      amountCents: input.totalCents,
      receivedCents: input.receivedCents,
      changeCents: input.changeCents ?? Math.max(0, (input.receivedCents ?? input.totalCents) - input.totalCents),
    } : null,
    ...(input.fiscal ? { fiscal: input.fiscal } : {}),
  }
}

export function getMovedRestaurantPrintLines(lines: RestaurantOrderLine[], moves: RestaurantOrderLineMove[]): RestaurantPrintLine[] {
  const linesById = new Map(lines.map((line) => [line.id, line]))
  return moves.flatMap((move) => {
    const line = linesById.get(move.lineId)
    return line ? [{ ...line, quantity: move.quantity, lineTotalCents: quantityAmountCents(line.unitPriceCents, move.quantity) }] : []
  })
}

export function getEqualSplitPrintLines(lines: RestaurantOrderLine[], split: RestaurantEqualSplit): RestaurantPrintLine[] {
  const baseAmount = Math.floor(split.totalCents / split.partCount)
  const remainder = split.totalCents % split.partCount
  const partNumber = split.paidParts + 1
  const partSubtotal = baseAmount + (partNumber <= remainder ? 1 : 0)
  const partStart = (partNumber - 1) * baseAmount + Math.min(partNumber - 1, remainder)
  const partEnd = partStart + partSubtotal
  let lineStart = 0

  return [...lines]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .flatMap((line) => {
      const lineTotalCents = quantityAmountCents(line.unitPriceCents, line.quantity)
      const lineEnd = lineStart + lineTotalCents
      const allocatedCents = Math.max(0, Math.min(lineEnd, partEnd) - Math.max(lineStart, partStart))
      lineStart = lineEnd
      const includeFreeLine = lineTotalCents === 0 && partNumber === 1
      if (allocatedCents <= 0 && !includeFreeLine) return []
      const quantity = lineTotalCents === 0 ? line.quantity : line.quantity * allocatedCents / lineTotalCents
      return [{ ...line, quantity, lineTotalCents: allocatedCents }]
    })
}

export function getRestaurantPrintSubtotal(lines: RestaurantPrintLine[]) {
  return getRestaurantCalculationLines(lines).reduce((total, line) => total + line.grossCents, 0)
}
