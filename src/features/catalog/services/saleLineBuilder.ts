import type {
  CatalogPlacement,
  CatalogTab,
  Category,
  Product,
  ProductLineSelection,
  ProductVariant,
  SaleFormatDefinition,
  SaleLineCatalogSnapshot,
  TicketLine,
  TicketLineComponent,
  TicketLineModifier,
} from '../../../types/index.ts'
import { getProductModifierGroups, getVariantSelectionGroups } from './catalogAccess.ts'

export type SaleLineTotals = {
  basePriceCents: number
  componentDeltaCents: number
  modifierDeltaCents: number
  grossBeforeDiscountCents: number
}

export type SaleLineContext = {
  tab?: CatalogTab | null
  placement?: CatalogPlacement | null
  category?: Category | null
  saleFormat?: SaleFormatDefinition | null
}

export function calculateSaleLineTotals(
  variant: Pick<ProductVariant, 'priceCents'>,
  components: Pick<TicketLineComponent, 'priceDeltaCents' | 'quantity' | 'modifiers'>[],
  modifiers: Pick<TicketLineModifier, 'priceCents'>[],
): SaleLineTotals {
  const basePriceCents = Math.round(variant.priceCents)
  const componentDeltaCents = components.reduce(
    (total, component) => total + Math.round(component.priceDeltaCents) * Math.max(1, Math.round(component.quantity)),
    0,
  )
  const modifierDeltaCents = modifiers.reduce((total, modifier) => total + Math.round(modifier.priceCents), 0)
    + components.reduce((total, component) => total + (component.modifiers ?? [])
      .reduce((componentTotal, modifier) => componentTotal + Math.round(modifier.priceCents) * Math.max(1, Math.round(component.quantity)), 0), 0)
  return {
    basePriceCents,
    componentDeltaCents,
    modifierDeltaCents,
    grossBeforeDiscountCents: basePriceCents + componentDeltaCents + modifierDeltaCents,
  }
}

export function validateProductLineSelection(product: Product, variant: ProductVariant, selection: ProductLineSelection) {
  for (const assignment of getVariantSelectionGroups(product, variant.id)) {
    const count = selection.components
      .filter((component) => component.selectionGroupId === assignment.selectionGroupId)
      .reduce((total, component) => total + component.quantity, 0)
    if (count < assignment.group.minSelect || count > assignment.group.maxSelect) {
      throw new Error(`${assignment.group.name}: selecciona entre ${assignment.group.minSelect} y ${assignment.group.maxSelect}.`)
    }
  }

  for (const group of getProductModifierGroups(product, variant.id)) {
    const count = selection.modifiers.filter((modifier) => modifier.groupId === group.id).length
    if (count < group.minSelect || count > group.maxSelect) {
      throw new Error(`${group.name}: selecciona entre ${group.minSelect} y ${group.maxSelect}.`)
    }
  }
}

export function getDefaultProductLineSelection(product: Product, variant: ProductVariant, products: Product[]): ProductLineSelection | null {
  const components = getVariantSelectionGroups(product, variant.id).flatMap((assignment) => assignment.group.items
    .filter((item) => item.isActive && item.isDefault)
    .map((item) => {
      const componentProduct = products.find((candidate) => candidate.id === item.productId)
      const componentVariant = componentProduct?.variants.find((candidate) => candidate.id === item.variantId)
        ?? componentProduct?.variants.find((candidate) => candidate.isDefault)
      return {
        id: item.id,
        type: assignment.group.kind,
        selectionGroupId: assignment.group.id,
        selectionGroupName: assignment.group.name,
        productId: item.productId,
        variantId: componentVariant?.id ?? null,
        productName: componentProduct?.name ?? 'Producto',
        variantName: componentVariant?.name ?? '',
        quantity: 1,
        priceDeltaCents: item.priceDeltaCents,
        sortOrder: item.sortOrder,
        modifiers: componentProduct && componentVariant
          ? getProductModifierGroups(componentProduct, componentVariant.id).flatMap((group) => group.modifiers
            .filter((modifier) => modifier.isActive && modifier.isDefault)
            .map((modifier) => ({ id: modifier.id, groupId: group.id, name: modifier.name, priceCents: modifier.priceCents })))
          : [],
      }
    }))
  const modifiers = getProductModifierGroups(product, variant.id).flatMap((group) => group.modifiers
    .filter((modifier) => modifier.isActive && modifier.isDefault)
    .map((modifier) => ({ id: modifier.id, groupId: group.id, name: modifier.name, priceCents: modifier.priceCents })))
  const mixer = components.find((component) => component.type === 'mixer') ?? null
  const selection: ProductLineSelection = {
    modifiers,
    components,
    mixerProductId: mixer?.productId ?? null,
    mixer: mixer ? { productId: mixer.productId, variantId: mixer.variantId, name: mixer.productName, priceCents: mixer.priceDeltaCents } : null,
  }
  try {
    validateProductLineSelection(product, variant, selection)
    for (const component of components) {
      const componentProduct = products.find((candidate) => candidate.id === component.productId)
      const componentVariant = componentProduct?.variants.find((candidate) => candidate.id === component.variantId)
      if (!componentProduct || !componentVariant) return null
      for (const group of getProductModifierGroups(componentProduct, componentVariant.id)) {
        const count = (component.modifiers ?? []).filter((modifier) => modifier.groupId === group.id).length
        if (count < group.minSelect || count > group.maxSelect) return null
      }
    }
    return selection
  } catch {
    return null
  }
}

export function buildCatalogSnapshot(context: SaleLineContext = {}): SaleLineCatalogSnapshot {
  return {
    saleFormatId: context.saleFormat?.id ?? null,
    saleFormatName: context.saleFormat?.label ?? '',
    categoryId: context.category?.id ?? context.placement?.categoryId ?? null,
    categoryName: context.category?.name ?? '',
    catalogTabId: context.tab?.id ?? context.placement?.tabId ?? null,
    catalogTabName: context.tab?.label ?? '',
  }
}

export function buildSaleLine(
  id: string,
  product: Product,
  variant: ProductVariant,
  selection: ProductLineSelection,
  context: SaleLineContext = {},
): TicketLine {
  validateProductLineSelection(product, variant, selection)
  const totals = calculateSaleLineTotals(variant, selection.components, selection.modifiers)
  return {
    id,
    productId: product.id,
    productName: product.name,
    variantId: variant.id,
    variantName: variant.name,
    basePriceCents: totals.basePriceCents,
    componentDeltaCents: totals.componentDeltaCents,
    modifierDeltaCents: totals.modifierDeltaCents,
    unitPriceCents: totals.grossBeforeDiscountCents,
    quantity: 1,
    modifiers: selection.modifiers,
    components: selection.components,
    catalogSnapshot: selection.catalogSnapshot ?? buildCatalogSnapshot(context),
    mixerProductId: selection.mixerProductId,
    mixer: selection.mixer,
  }
}

export function serializeSaleLine(line: TicketLine) {
  return {
    ...line,
    modifiers: line.modifiers.map((modifier) => ({ ...modifier })),
    components: line.components.map((component) => ({
      ...component,
      modifiers: component.modifiers?.map((modifier) => ({ ...modifier })) ?? [],
    })),
    catalogSnapshot: { ...line.catalogSnapshot },
  }
}

export function getSaleLineConsumption(line: TicketLine) {
  const quantities = new Map<string, number>()
  quantities.set(line.productId, line.quantity)
  for (const component of line.components) {
    quantities.set(
      component.productId,
      (quantities.get(component.productId) ?? 0) + component.quantity * line.quantity,
    )
  }
  return [...quantities].map(([productId, quantity]) => ({ productId, quantity }))
}

export function wouldCreateMenuCycle(
  menuProductId: string,
  candidateProductId: string,
  childProductIds: ReadonlyMap<string, readonly string[]>,
) {
  if (menuProductId === candidateProductId) return true
  const visited = new Set<string>()
  const pending = [candidateProductId]
  while (pending.length) {
    const current = pending.pop()!
    if (current === menuProductId) return true
    if (visited.has(current)) continue
    visited.add(current)
    pending.push(...(childProductIds.get(current) ?? []))
  }
  return false
}
