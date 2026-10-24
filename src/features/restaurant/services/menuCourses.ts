import type { TicketLineComponent, TicketLineModifier } from '../../../types/domain'
import type { RestaurantOrderLine } from '../../tables/types'
import type { ProductionEntry } from '../../production/types'

function componentSignature(component: TicketLineComponent) {
  return JSON.stringify([component.id, component.productId, component.variantId, component.quantity,
    (component.modifiers ?? []).map((modifier) => modifier.id).sort()])
}

export function changedMenuComponentIds(previous: TicketLineComponent[], next: TicketLineComponent[]) {
  const nextById = new Map(next.map((component) => [component.id, component]))
  return previous.filter((component) => {
    const replacement = nextById.get(component.id)
    return !replacement || componentSignature(component) !== componentSignature(replacement)
  }).map((component) => component.id)
}

function supplements(components: TicketLineComponent[]) {
  return components.reduce((total, component) => total + component.quantity * (component.priceDeltaCents
    + (component.modifiers ?? []).reduce((sum, modifier) => sum + modifier.priceCents, 0)), 0)
}

export function reconcileMenuEdit(line: Pick<RestaurantOrderLine, 'components' | 'modifiers' | 'unitPriceCents' | 'servedQuantity'>, next: TicketLineComponent[], entries: ProductionEntry[], modifiers = line.modifiers) {
  const changed = new Set(changedMenuComponentIds(line.components, next))
  if (entries.some((entry) => entry.componentId && changed.has(entry.componentId) && (entry.servedQuantity ?? line.servedQuantity) > 0)) {
    throw new Error('No puedes sustituir un plato del menú que ya se ha servido.')
  }
  const previousById = new Map(line.components.map((component) => [component.id, component]))
  const components = next.map((component) => changed.has(component.id) ? component : previousById.get(component.id) ?? component)
  const modifierTotal = (items: TicketLineModifier[]) => items.reduce((sum, modifier) => sum + modifier.priceCents, 0)
  const unitPriceCents = line.unitPriceCents - supplements(line.components) + supplements(components)
    - modifierTotal(line.modifiers ?? []) + modifierTotal(modifiers ?? [])
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) throw new Error('El precio del menú no es válido.')
  const parentModifiersChanged = JSON.stringify((line.modifiers ?? []).map((modifier) => modifier.id).sort()) !== JSON.stringify((modifiers ?? []).map((modifier) => modifier.id).sort())
  return { components, unitPriceCents, changesSentDish: entries.some((entry) => entry.componentId && (changed.has(entry.componentId) || parentModifiersChanged) && entry.sentQuantity > 0) }
}
