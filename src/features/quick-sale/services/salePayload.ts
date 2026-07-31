import { allocateNetTotalToLines, assertValidTicketPayment, calculateAppliedDiscount } from '../../../lib/discounts.ts'
import { createId, getLineTotal, getTicketTotal } from '../../../lib/format.ts'
import { calculateTaxFromGross, isValidTaxRate } from '../../../lib/tax.ts'
import type {
  AppliedDiscount,
  CashSession,
  PaymentMethod,
  SaleCreatedPayload,
  SaleLinePayload,
  TenantContext,
  TicketLine,
} from '../../../types/index.ts'
import { nowIso } from '../../../utils/dates.ts'

export function buildSalePayload(
  context: TenantContext,
  cashSession: CashSession,
  lines: TicketLine[],
  paymentMethod: PaymentMethod | null,
  receivedCents: number | null,
  discount: AppliedDiscount | null,
): SaleCreatedPayload {
  const createdAt = nowIso()
  const ticketId = createId()
  const saleId = createId()
  const subtotalCents = getTicketTotal(lines)
  const { discountAmountCents, totalCents } = calculateAppliedDiscount(subtotalCents, discount)
  assertValidTicketPayment(totalCents, paymentMethod)
  const grossLineTotals = lines.map(getLineTotal)
  const netLineTotals = allocateNetTotalToLines(grossLineTotals, totalCents)
  const saleLines: SaleLinePayload[] = lines.map((line, index) => {
    const taxRate = line.fiscalSnapshot?.taxRate
      ?? line.catalogSnapshot.vatRate
      ?? context.venueDefaultTaxRate
    const fiscalSnapshot = taxRate !== undefined && isValidTaxRate(taxRate)
      ? { taxRate, ...calculateTaxFromGross(netLineTotals[index], taxRate) }
      : null

    return {
      id: createId(),
      ticketId,
      tenantId: context.tenantId,
      productId: line.productId,
      variantId: line.variantId,
      productName: line.productName,
      variantName: line.variantName,
      basePriceCents: line.basePriceCents,
      componentDeltaCents: line.componentDeltaCents,
      modifierDeltaCents: line.modifierDeltaCents,
      grossBeforeDiscountCents: line.unitPriceCents,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: grossLineTotals[index],
      modifiers: line.modifiers,
      components: line.components,
      catalogSnapshot: line.catalogSnapshot,
      fiscalSnapshot,
    }
  })

  return {
    ticket: {
      id: ticketId,
      tenantId: context.tenantId,
      cashSessionId: cashSession.id,
      cashRegisterId: cashSession.cashRegisterId,
      venueId: context.venueId,
      deviceId: context.deviceId,
      userId: context.userId,
      subtotalCents,
      discount,
      discountAmountCents,
      totalCents,
      createdAt,
    },
    lines: saleLines,
    sale: {
      id: saleId,
      tenantId: context.tenantId,
      ticketId,
      cashSessionId: cashSession.id,
      cashRegisterId: cashSession.cashRegisterId,
      venueId: context.venueId,
      deviceId: context.deviceId,
      userId: context.userId,
      totalCents,
      paymentMethod,
      createdAt,
    },
    payment: paymentMethod ? {
      id: createId(),
      tenantId: context.tenantId,
      saleId,
      method: paymentMethod,
      amountCents: totalCents,
      receivedCents,
      changeCents: Math.max(0, (receivedCents ?? totalCents) - totalCents),
    } : null,
  }
}
