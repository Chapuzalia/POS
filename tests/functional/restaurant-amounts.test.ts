import { expect, it } from 'vitest'
import type { RestaurantEqualSplit, RestaurantOrderLine } from '../../src/features/tables/types'
import { buildRestaurantPrintPayload, getEqualSplitPrintLines, getMovedRestaurantPrintLines, getRestaurantPrintSubtotal, withRestaurantCalculationLines } from '../../src/features/restaurant/services/restaurantPrintPayload'
import { createRestaurantControllerHarness, flush } from '../helpers/restaurant-controller-harness.mjs'

const line: RestaurantOrderLine = {
  id: 'line', tenantId: 'tenant', venueId: 'venue', orderId: 'order', productId: 'product', variantId: 'variant',
  productName: 'Producto', variantName: '', unitPriceCents: 199, quantity: 1.5, servedQuantity: 1.5, fullyServedAt: null,
  modifiers: [], components: [], mixerProductId: null, mixer: null, note: null,
  createdAt: '2026-11-02T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z',
  catalogSnapshot: { placementId: null, productType: 'standard', productId: 'product', productName: 'Producto', variantId: 'variant',
    variantName: '', basePriceCents: 199, vatRate: 10, categoryId: null, categoryName: '', catalogTabId: null, catalogTabName: '', saleFormatId: null, saleFormatName: '' },
}
const split: RestaurantEqualSplit = {
  id: 'split', orderId: 'order', orderGroupId: 'group', totalCents: 299, partCount: 3, paidParts: 0, paidCents: 0,
  remainingParts: 3, remainingCents: 299, nextPartCents: 100, nextDefaultDiscount: null, nextDefaultDiscountAmountCents: 0,
  nextDefaultTotalCents: 100, status: 'open', revision: 1, allowPendingService: false,
}
const input: Parameters<typeof buildRestaurantPrintPayload>[0] = {
  cashSession: { id: 'session', tenantId: 'tenant', venueId: 'venue', deviceId: 'device', cashRegisterId: 'register', cashRegisterName: 'Caja', userId: 'user', openedAt: line.createdAt, openingFloatCents: 0, status: 'open' },
  context: { tenantId: 'tenant', tenantName: 'Local', tenantSlug: 'local', venueId: 'venue', venueName: 'Local', deviceId: 'device', deviceName: 'Caja', userId: 'user', userName: 'Cajero', role: 'cashier' },
  createdAt: line.createdAt, discount: null, lines: [line], paymentId: 'payment', paymentMethod: 'card', receivedCents: null,
  saleId: 'sale', subtotalCents: 299, ticketId: 'ticket', totalCents: 299,
}

it('uses rounded integer cents for a fractional restaurant line and its fiscal snapshot', () => {
  expect(getRestaurantPrintSubtotal([line])).toBe(299)
  const payload = buildRestaurantPrintPayload(input)
  expect(payload.lines[0].lineTotalCents).toBe(299)
  expect(payload.lines[0].netTotalCents).toBe(299)
  expect(payload.lines[0].fiscalSnapshot?.grossTotalCents).toBe(299)
  expect(payload.lines[0].quantity).toBe(1.5)
})

it('rounds a selected quantity while retaining an explicit historical line amount', () => {
  const selected = getMovedRestaurantPrintLines([line], [{ lineId: line.id, quantity: 0.5 }])
  expect(getRestaurantPrintSubtotal(selected)).toBe(100)
  expect(buildRestaurantPrintPayload({ ...input, lines: selected, subtotalCents: 100, totalCents: 100 }).lines[0].lineTotalCents).toBe(100)
  expect(buildRestaurantPrintPayload({ ...input, lines: [{ ...line, lineTotalCents: 298 }], subtotalCents: 298, totalCents: 298 }).lines[0].lineTotalCents).toBe(298)
})

it('allocates each cent once across equal parts of a fractional line', () => {
  const totals = [0, 1, 2].map(paidParts => {
    const lines = getEqualSplitPrintLines([line], { ...split, paidParts })
    const total = getRestaurantPrintSubtotal(lines)
    const payload = buildRestaurantPrintPayload({ ...input, lines, subtotalCents: total, totalCents: total })
    expect(payload.lines.every(item => Number.isInteger(item.lineTotalCents))).toBe(true)
    return total
  })
  expect(totals).toEqual([100, 100, 99])
  expect(totals.reduce((sum, total) => sum + total, 0)).toBe(299)
})

it('keeps the split allocation and nullable variant in the discount request snapshot', () => {
  const discount = { discountId: null, name: 'Descuento', type: 'manual' as const, calculationType: 'fixed' as const,
    value: 1, roundingIncrementCents: null, color: null }
  const lines = getEqualSplitPrintLines([{ ...line, variantId: null }], split)
  expect(withRestaurantCalculationLines(discount, lines)?.calculationLines).toEqual([
    { productId: 'product', variantId: null, quantity: lines[0].quantity, grossCents: 100 },
  ])
  expect(buildRestaurantPrintPayload({ ...input, discount, lines, subtotalCents: 100, totalCents: 99 }).lines[0].netTotalCents).toBe(99)
})

it('can close a fractional order using the same amount as its persisted draft', async () => {
  const h = createRestaurantControllerHarness({
    currentOrder: { lines: [line], order: { id: 'order', revision: 1, status: 'open' }, tables: [] }, realPayloads: true,
    closeResult: { requiresConfirmation: false, pendingUnits: 0, ticketId: 'ticket', saleId: 'sale', paymentId: 'payment', totalCents: 299 },
  })
  await h.render().completePayment('card', null, true)
  await flush()
  expect(h.calls.close).toBe(1)
  expect(h.calls.errors.filter(Boolean)).toEqual([])
  expect(h.calls.printed[0].ticket.totalCents).toBe(299)
  h.print.resolve(); h.queueSync.resolve()
  await flush()
})
