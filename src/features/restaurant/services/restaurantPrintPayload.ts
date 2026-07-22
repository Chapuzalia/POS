import type {
  AppliedDiscount,
  CashSession,
  PaymentMethod,
  SaleCreatedPayload,
  TenantContext,
} from '../../../types/index.ts'
import type { RestaurantEqualSplit, RestaurantOrderLine, RestaurantOrderLineMove } from '../../tables/types.ts'

export type RestaurantPrintLine = RestaurantOrderLine & { lineTotalCents?: number }

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
  saleId: string
  subtotalCents: number
  ticketId: string
  totalCents: number
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
    lines: input.lines.map((line) => {
      const components = printComponents(line)
      const modifierDeltaCents = line.modifiers.reduce((total, modifier) => total + modifier.priceCents, 0)
        + components.reduce((total, component) => total + (component.modifiers ?? []).reduce((sum, modifier) => sum + modifier.priceCents, 0), 0)
      const componentDeltaCents = components.reduce((total, component) => total + component.priceDeltaCents, 0)
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
      lineTotalCents: line.lineTotalCents ?? line.unitPriceCents * line.quantity,
      modifiers: line.modifiers,
      components,
      catalogSnapshot: { saleFormatId: null, saleFormatName: '', categoryId: null, categoryName: '', catalogTabId: null, catalogTabName: '' },
      fiscalSnapshot: null,
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
