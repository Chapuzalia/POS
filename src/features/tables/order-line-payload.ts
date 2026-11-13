import { isLegacyMixerModifier, isUuid } from '../../lib/mixers.ts'
import type { TicketLine } from '../../types'
import type { RestaurantOrderDetail } from './types'

type PersistableOrderLine = Pick<TicketLine,
  'id' | 'modifiers' | 'components' | 'catalogSnapshot' | 'quantity' | 'mixerProductId'> & {
    note?: string | null
    productId: string | null
    variantId: string | null
  }

export function buildCatalogOrderLinesPayload(lines: PersistableOrderLine[]) {
  return lines.map((line) => {
    if (line.modifiers.some(isLegacyMixerModifier)) throw new Error('El mixer no puede guardarse como modificador de comanda.')
    if (line.modifiers.some((modifier) => !isUuid(modifier.id))) throw new Error('La comanda contiene un modificador no válido.')
    if (line.mixerProductId && !isUuid(line.mixerProductId)) throw new Error('La comanda contiene un mixer no válido.')
    if ((line.components ?? []).some((component) => !isUuid(component.productId))) throw new Error('La comanda contiene un componente no válido.')
    return {
      id: line.id,
      productId: line.productId,
      variantId: line.variantId,
      modifierIds: line.modifiers.map((modifier) => modifier.id),
      mixerProductId: line.mixerProductId,
      components: line.components ?? [],
      catalogSnapshot: line.catalogSnapshot ?? {},
      quantity: line.quantity,
      note: line.note ?? null,
    }
  })
}

export function buildRestaurantOrderLinesPayload(detail: RestaurantOrderDetail) {
  // Repeated ids are snapshots of one line, not additional quantities.
  const lines = [...new Map(detail.lines.map((line) => [line.id, line])).values()]
  return buildCatalogOrderLinesPayload(lines).map((line, index) => ({
    ...line,
    unitPriceCents: lines[index].unitPriceCents,
  }))
}
