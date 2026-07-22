import { isLegacyMixerModifier, isUuid } from '../../lib/mixers.ts'
import type { RestaurantOrderDetail } from './types'

export function buildRestaurantOrderLinesPayload(detail: RestaurantOrderDetail) {
  return detail.lines.map((line) => {
    if (line.modifiers.some(isLegacyMixerModifier)) throw new Error('El mixer no puede guardarse como modificador de comanda.')
    if (line.modifiers.some((modifier) => !isUuid(modifier.id))) throw new Error('La comanda contiene un modificador no valido.')
    if (line.mixerProductId && !isUuid(line.mixerProductId)) throw new Error('La comanda contiene un mixer no valido.')
    if ((line.components ?? []).some((component) => !isUuid(component.productId))) throw new Error('La comanda contiene un componente no valido.')
    return {
      id: line.id,
      productId: line.productId,
      variantId: line.variantId,
      modifierIds: line.modifiers.map((modifier) => modifier.id),
      mixerProductId: line.mixerProductId,
      components: line.components ?? [],
      catalogSnapshot: line.catalogSnapshot ?? {},
      quantity: line.quantity,
      note: line.note,
    }
  })
}
