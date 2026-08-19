import type { ProductLineSelection } from '../../../types'
import type { ResolvedCatalogItem } from '../../catalog/domain/types'

export function hasSelectableProductModifiers(item: ResolvedCatalogItem) {
  return item.modifierGroups.some((group) => (
    group.assignment.maxSelection > 0 && group.modifiers.length > 0
  ))
}

export function shouldOpenProductSelectionDialog(input: {
  allowVariantSelection: boolean
  defaultSelection: ProductLineSelection | null
  item: ResolvedCatalogItem
  variantCount: number
}) {
  const hasConfiguredSelections = input.item.selectionGroups.length > 0 || input.item.modifierGroups.length > 0
  return input.item.product.type === 'menu'
    || hasSelectableProductModifiers(input.item)
    || (hasConfiguredSelections && !input.defaultSelection)
    || (input.allowVariantSelection && input.variantCount > 1)
}
