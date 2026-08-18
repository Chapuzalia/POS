import type { TicketLineComponent } from '../../types'

export function getMenuComponentSearchText(components: readonly TicketLineComponent[]) {
  return components.flatMap((component) => [
    component.selectionGroupName,
    component.productName,
    component.variantName,
    ...((component.modifiers ?? []).map((modifier) => modifier.name)),
  ]).join(' ')
}
