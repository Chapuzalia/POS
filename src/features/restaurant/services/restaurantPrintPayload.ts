import type {
  AppliedDiscount,
  CashSession,
  PaymentMethod,
  SaleCreatedPayload,
  TenantContext,
  TicketLineModifier,
} from '../../../types/index.ts'
import type { RestaurantEqualSplit, RestaurantOrderLine, RestaurantOrderLineMove } from '../../tables/types.ts'

export type RestaurantPrintLine = RestaurantOrderLine & { lineTotalCents?: number }

type BuildRestaurantPrintPayloadInput = {
  cashSession: CashSession
  context: TenantContext
  createdAt: string
  discount: AppliedDiscount | null
  lines: RestaurantPrintLine[]
  paymentId: string | null
  paymentMethod: PaymentMethod | null
  receivedCents: number | null
  saleId: string
  subtotalCents: number
  ticketId: string
  totalCents: number
}

function printModifiers(line: RestaurantOrderLine): TicketLineModifier[] {
  if (!line.mixer) return line.modifiers
  return [...line.modifiers, {
    id: `mixer:${line.mixerProductId || line.mixer.productId}`,
    groupId: 'mixer',
    name: line.mixer.name,
    priceCents: line.mixer.priceCents,
  }]
}

export function buildRestaurantPrintPayload(input: BuildRestaurantPrintPayloadInput): SaleCreatedPayload {
  const discountAmountCents = Math.max(0, input.subtotalCents - input.totalCents)
  return {
    ticket: {
      id: input.ticketId,
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
    },
    lines: input.lines.map((line) => ({
      id: `${input.ticketId}:${line.id}`,
      ticketId: input.ticketId,
      tenantId: input.context.tenantId,
      productId: line.productId || '',
      variantId: line.variantId || '',
      productName: line.productName,
      variantName: line.variantName,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: line.lineTotalCents ?? line.unitPriceCents * line.quantity,
      modifiers: printModifiers(line),
      fiscalSnapshot: null,
    })),
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
      changeCents: Math.max(0, (input.receivedCents ?? input.totalCents) - input.totalCents),
    } : null,
  }
}

export function getMovedRestaurantPrintLines(lines: RestaurantOrderLine[], moves: RestaurantOrderLineMove[]): RestaurantPrintLine[] {
  const linesById = new Map(lines.map((line) => [line.id, line]))
  return moves.flatMap((move) => {
    const line = linesById.get(move.lineId)
    return line ? [{ ...line, quantity: move.quantity, lineTotalCents: line.unitPriceCents * move.quantity }] : []
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
      const lineTotalCents = line.quantity * line.unitPriceCents
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
  return lines.reduce((total, line) => total + (line.lineTotalCents ?? line.unitPriceCents * line.quantity), 0)
}
