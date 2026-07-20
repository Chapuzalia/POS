import { createId, getLineSignature } from '../../../lib/format'
import { toQuickSaleModifiers } from '../../../lib/mixers'
import type { Product, ProductLineSelection, ProductVariant, TicketLine } from '../../../types'

export function addQuickSaleTicketLine(lines: TicketLine[], product: Product, variant: ProductVariant, selection: ProductLineSelection) {
  const modifiers = toQuickSaleModifiers(selection.modifiers, selection.mixer)
  const candidate: TicketLine = {
    id: createId(), productId: product.id, productName: product.name,
    variantId: variant.id, variantName: variant.name,
    unitPriceCents: variant.priceCents + modifiers.reduce((total, modifier) => total + modifier.priceCents, 0),
    quantity: 1, modifiers,
  }
  const signature = getLineSignature(candidate)
  const existing = lines.find((line) => getLineSignature(line) === signature)
  return existing
    ? lines.map((line) => line.id === existing.id ? { ...line, quantity: line.quantity + 1 } : line)
    : [...lines, candidate]
}

export function changeQuickSaleTicketLineQuantity(lines: TicketLine[], lineId: string, direction: 1 | -1) {
  return lines
    .map((line) => line.id === lineId ? { ...line, quantity: line.quantity + direction } : line)
    .filter((line) => line.quantity > 0)
}
