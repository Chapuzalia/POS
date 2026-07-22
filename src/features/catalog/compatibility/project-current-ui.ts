import type {
  Catalog,
  CatalogPlacement as CurrentCatalogPlacement,
  CatalogTab as CurrentCatalogTab,
  Category,
  Discount,
  ModifierGroup,
  Product,
  ProductModifierGroupAssignment,
  ProductVariant,
  SelectionGroup,
  VariantSelectionGroup,
} from '../../../types/index.ts'
import type { CatalogAssignment, CatalogData } from '../domain/types.ts'

const byOrder = <T extends { id: string; sortOrder: number }>(left: T, right: T) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)

function assignmentApplies(assignment: CatalogAssignment, variantId: string) {
  return assignment.active && (assignment.appliesToAllVariants || assignment.variantIds.includes(variantId))
}

export function projectCatalogForCurrentUi(input: {
  catalog: CatalogData
  discounts: Discount[]
  manualDiscountEnabled: boolean
}): Catalog {
  const { catalog } = input
  const variantsByProduct = new Map<string, ProductVariant[]>()
  const tabsById = new Map(catalog.tabs.map((tab) => [tab.id, tab]))
  const placementsByProduct = new Map<string, typeof catalog.placements>()
  const selectionGroupsById = new Map(catalog.selectionGroups.map((group) => [group.id, group]))
  const modifierGroupsById = new Map(catalog.modifierGroups.map((group) => [group.id, group]))
  const optionsByGroup = new Map<string, typeof catalog.selectionOptions>()
  const modifiersByGroup = new Map<string, typeof catalog.modifiers>()

  for (const placement of catalog.placements) {
    placementsByProduct.set(placement.productId, [...(placementsByProduct.get(placement.productId) ?? []), placement])
  }
  for (const option of catalog.selectionOptions) {
    optionsByGroup.set(option.groupId, [...(optionsByGroup.get(option.groupId) ?? []), option])
  }
  for (const modifier of catalog.modifiers) {
    modifiersByGroup.set(modifier.groupId, [...(modifiersByGroup.get(modifier.groupId) ?? []), modifier])
  }
  for (const variant of catalog.variants) {
    const placement = (placementsByProduct.get(variant.productId) ?? []).find((candidate) => candidate.pinnedVariantId === variant.id)
      ?? (variant.isDefault ? (placementsByProduct.get(variant.productId) ?? []).find((candidate) => candidate.pinnedVariantId === null) : null)
    const tab = placement ? tabsById.get(placement.tabId) : null
    const current: ProductVariant = {
      id: variant.id,
      productId: variant.productId,
      name: variant.name,
      priceCents: variant.priceCents,
      sku: variant.sku,
      saleFormatId: tab?.id ?? null,
      saleFormatKey: tab?.key ?? null,
      isDefault: variant.isDefault,
      isActive: variant.active,
      sortOrder: variant.sortOrder,
    }
    variantsByProduct.set(variant.productId, [...(variantsByProduct.get(variant.productId) ?? []), current])
  }

  const mapSelectionGroup = (assignment: CatalogAssignment): SelectionGroup | null => {
    const group = selectionGroupsById.get(assignment.groupId)
    if (!group) return null
    return {
      id: group.id,
      tenantId: group.tenantId,
      venueId: group.venueId,
      kind: group.type,
      name: assignment.displayName ?? group.name,
      minSelect: assignment.minSelection,
      maxSelect: assignment.maxSelection,
      isActive: assignment.active && group.active,
      sortOrder: assignment.sortOrder,
      items: (optionsByGroup.get(group.id) ?? []).map((option) => ({
        id: option.id,
        groupId: option.groupId,
        productId: option.productId,
        variantId: option.variantId,
        priceDeltaCents: option.supplementCents,
        isDefault: option.defaultQuantity > 0,
        isActive: option.active,
        sortOrder: option.sortOrder,
      })).sort(byOrder),
    }
  }

  const mapModifierGroup = (assignment: CatalogAssignment): ModifierGroup | null => {
    const group = modifierGroupsById.get(assignment.groupId)
    if (!group) return null
    return {
      id: group.id,
      productId: assignment.productId,
      name: assignment.displayName ?? group.name,
      minSelect: assignment.minSelection,
      maxSelect: assignment.maxSelection,
      isActive: assignment.active && group.active,
      sortOrder: assignment.sortOrder,
      modifiers: (modifiersByGroup.get(group.id) ?? []).map((modifier) => ({
        id: modifier.id,
        groupId: modifier.groupId,
        name: modifier.name,
        priceCents: modifier.supplementCents,
        isDefault: modifier.isDefault,
        isActive: modifier.active,
        sortOrder: modifier.sortOrder,
      })).sort(byOrder),
    }
  }

  const products: Product[] = catalog.products.map((product) => {
    const placements = placementsByProduct.get(product.id) ?? []
    const variants = (variantsByProduct.get(product.id) ?? []).sort(byOrder)
    const selectionAssignments = catalog.selectionAssignments.filter((assignment) => assignment.productId === product.id)
    const variantSelectionGroups: VariantSelectionGroup[] = variants.flatMap((variant) => selectionAssignments
      .filter((assignment) => assignmentApplies(assignment, variant.id))
      .flatMap((assignment) => {
        const group = mapSelectionGroup(assignment)
        return group ? [{ variantId: variant.id, selectionGroupId: group.id, sortOrder: assignment.sortOrder, group }] : []
      }))
    const modifierAssignments: ProductModifierGroupAssignment[] = []
    for (const assignment of catalog.modifierAssignments.filter((candidate) => candidate.productId === product.id)) {
      const group = mapModifierGroup(assignment)
      if (!group) continue
      if (assignment.appliesToAllVariants) {
        modifierAssignments.push({ productId: product.id, variantId: null, modifierGroupId: group.id, sortOrder: assignment.sortOrder, group })
        continue
      }
      modifierAssignments.push(...assignment.variantIds.map((variantId) => ({
        productId: product.id, variantId, modifierGroupId: group.id, sortOrder: assignment.sortOrder, group,
      })))
    }
    const mixerOptions = catalog.selectionOptions.filter((option) => option.productId === product.id)
      .filter((option) => selectionGroupsById.get(option.groupId)?.type === 'mixer')
    return {
      id: product.id,
      tenantId: product.tenantId,
      venueId: product.venueId,
      categoryId: placements.find((placement) => placement.categoryId)?.categoryId ?? '',
      name: product.name,
      productType: product.type,
      description: product.description,
      imagePath: product.image?.storagePath ?? null,
      imageUrl: product.image?.publicUrl ?? null,
      kind: 'other' as const,
      saleFormats: [...new Set(placements.flatMap((placement) => tabsById.get(placement.tabId)?.key ?? []))],
      canSellStandalone: placements.some((placement) => placement.active),
      canUseAsMixer: mixerOptions.some((option) => option.active),
      isFeatured: placements.some((placement) => placement.featured),
      mixerSupplementCents: mixerOptions[0]?.supplementCents ?? 0,
      taxRate: product.vatRate,
      isActive: product.active,
      sortOrder: product.sortOrder,
      variants,
      modifierGroups: modifierAssignments.filter((assignment) => assignment.variantId === null).map((assignment) => assignment.group),
      modifierGroupAssignments: modifierAssignments,
      variantSelectionGroups,
    }
  }).sort(byOrder)

  const categories: Category[] = catalog.categories.map((category) => ({
    id: category.id,
    tenantId: category.tenantId,
    name: category.name,
    kind: 'other' as const,
    icon: category.icon ?? 'receipt',
    isActive: category.active,
    sortOrder: category.sortOrder,
  })).sort(byOrder)
  const tabs: CurrentCatalogTab[] = catalog.tabs.map((tab) => ({
    id: tab.id, tenantId: tab.tenantId, venueId: tab.venueId, key: tab.key, label: tab.label,
    icon: tab.icon ?? 'receipt', isActive: tab.active, sortOrder: tab.sortOrder,
  })).sort(byOrder)
  const placements: CurrentCatalogPlacement[] = catalog.placements.map((placement) => ({
    id: placement.id, tenantId: placement.tenantId, venueId: placement.venueId, tabId: placement.tabId,
    categoryId: placement.categoryId ?? '', productId: placement.productId,
    defaultVariantId: placement.pinnedVariantId, isFeatured: placement.featured,
    isActive: placement.active, sortOrder: placement.sortOrder,
  })).sort(byOrder)

  return {
    catalogProfile: 'custom',
    tabs,
    placements,
    selectionGroups: catalog.selectionAssignments.flatMap((assignment) => mapSelectionGroup(assignment) ?? []),
    usesLegacyFallback: false,
    categories,
    discounts: input.discounts,
    manualDiscountEnabled: input.manualDiscountEnabled,
    products,
    saleFormats: tabs.map((tab) => ({
      id: tab.id, tenantId: tab.tenantId, venueId: tab.venueId, key: tab.key,
      label: tab.label, isActive: tab.isActive, sortOrder: tab.sortOrder,
    })),
    updatedAt: catalog.loadedAt,
    source: 'supabase',
  }
}
