import { calculateCatalogPrice } from '../domain/pricing.ts'
import { resolveSellableProduct } from '../domain/resolver.ts'
import type {
  CatalogData,
  ResolvedCatalogItem,
  ResolvedCatalogModifierGroup,
  ResolvedSellableProduct,
} from '../domain/types.ts'
import type {
  ProductLineSelection,
  SaleLineCatalogSnapshot,
  TicketLine,
  TicketLineComponent,
  TicketLineModifier,
} from '../../../types/index.ts'

export type SaleLineTotals = {
  basePriceCents: number
  componentDeltaCents: number
  modifierDeltaCents: number
  grossBeforeDiscountCents: number
}

function canonicalModifiers(
  groups: readonly ResolvedCatalogModifierGroup[],
  submitted: readonly TicketLineModifier[],
): TicketLineModifier[] {
  const allowedGroups = new Map(groups.flatMap((group) => group.modifiers.map((modifier) => [modifier.id, group.group.id] as const)))
  const submittedIds = new Set(submitted.map((modifier) => modifier.id))
  if (submittedIds.size !== submitted.length) throw new Error('La selección contiene un modificador repetido.')
  if (submitted.some((modifier) => allowedGroups.get(modifier.id) !== modifier.groupId)) {
    throw new Error('La selección contiene un modificador que no está asignado al producto o variante.')
  }
  const result: TicketLineModifier[] = []
  for (const resolvedGroup of groups) {
    const selected = resolvedGroup.modifiers.filter((modifier) => submittedIds.has(modifier.id))
    const { minSelection, maxSelection } = resolvedGroup.assignment
    if (selected.length < minSelection || selected.length > maxSelection) {
      throw new Error(`${resolvedGroup.assignment.displayName ?? resolvedGroup.group.name}: selecciona entre ${minSelection} y ${maxSelection}.`)
    }
    result.push(...selected.map((modifier) => ({
      id: modifier.id,
      groupId: resolvedGroup.group.id,
      name: modifier.name,
      priceCents: modifier.supplementCents,
    })))
  }
  return result
}

function canonicalComponents(
  catalog: CatalogData,
  sellable: ResolvedSellableProduct,
  submitted: readonly TicketLineComponent[],
): TicketLineComponent[] {
  const allowedGroups = new Map(sellable.selectionGroups.flatMap((resolvedGroup) => resolvedGroup.options
    .map((option) => [option.id, resolvedGroup.group.id] as const)))
  if (submitted.some((component) => allowedGroups.get(component.id) !== component.selectionGroupId)) {
    throw new Error('La selección contiene una opción que no está asignada al producto o variante.')
  }
  const result: TicketLineComponent[] = []
  for (const resolvedGroup of sellable.selectionGroups) {
    const selected = submitted.filter((component) => component.selectionGroupId === resolvedGroup.group.id)
    const selectedIds = new Set(selected.map((component) => component.id))
    if (selectedIds.size !== selected.length) throw new Error(`${resolvedGroup.group.name}: una opción está repetida.`)
    const count = selected.reduce((total, component) => total + component.quantity, 0)
    const { minSelection, maxSelection } = resolvedGroup.assignment
    if (count < minSelection || count > maxSelection) {
      throw new Error(`${resolvedGroup.assignment.displayName ?? resolvedGroup.group.name}: selecciona entre ${minSelection} y ${maxSelection}.`)
    }
    for (const component of selected) {
      if (!Number.isSafeInteger(component.quantity) || component.quantity <= 0) {
        throw new Error(`${resolvedGroup.group.name}: la cantidad debe ser un entero positivo.`)
      }
      const option = resolvedGroup.options.find((candidate) => candidate.id === component.id)
      if (!option) throw new Error(`${resolvedGroup.group.name}: la opción ya no está disponible.`)
      if (option.maxQuantity !== null && component.quantity > option.maxQuantity) {
        throw new Error(`${option.product.name}: la cantidad máxima es ${option.maxQuantity}.`)
      }
      const componentSellable = resolveSellableProduct(catalog, option.product.id, option.variant.id)
      result.push({
        id: option.id,
        type: resolvedGroup.group.type,
        selectionGroupId: resolvedGroup.group.id,
        selectionGroupName: resolvedGroup.assignment.displayName ?? resolvedGroup.group.name,
        productId: option.product.id,
        variantId: option.variant.id,
        productName: option.product.name,
        variantName: option.variant.name,
        quantity: component.quantity,
        priceDeltaCents: option.supplementCents,
        sortOrder: option.sortOrder,
        modifiers: canonicalModifiers(componentSellable.modifierGroups, component.modifiers ?? []),
      })
    }
  }
  return result
}

export function canonicalizeProductLineSelection(
  catalog: CatalogData,
  sellable: ResolvedSellableProduct,
  selection: ProductLineSelection,
): ProductLineSelection {
  const components = canonicalComponents(catalog, sellable, selection.components)
  const modifiers = canonicalModifiers(sellable.modifierGroups, selection.modifiers)
  const mixer = components.find((component) => component.type === 'mixer') ?? null
  return {
    modifiers,
    components,
    catalogSnapshot: selection.catalogSnapshot,
    mixerProductId: mixer?.productId ?? null,
    mixer: mixer ? {
      productId: mixer.productId,
      variantId: mixer.variantId,
      name: mixer.productName,
      priceCents: mixer.priceDeltaCents,
    } : null,
  }
}

export function validateProductLineSelection(
  catalog: CatalogData,
  sellable: ResolvedSellableProduct,
  selection: ProductLineSelection,
) {
  canonicalizeProductLineSelection(catalog, sellable, selection)
}

export function getDefaultProductLineSelection(
  catalog: CatalogData,
  sellable: ResolvedSellableProduct,
): ProductLineSelection | null {
  const components: TicketLineComponent[] = sellable.selectionGroups.flatMap((resolvedGroup) => resolvedGroup.options
    .filter((option) => option.defaultQuantity > 0)
    .map((option) => {
      const componentSellable = resolveSellableProduct(catalog, option.product.id, option.variant.id)
      return {
        id: option.id,
        type: resolvedGroup.group.type,
        selectionGroupId: resolvedGroup.group.id,
        selectionGroupName: resolvedGroup.assignment.displayName ?? resolvedGroup.group.name,
        productId: option.product.id,
        variantId: option.variant.id,
        productName: option.product.name,
        variantName: option.variant.name,
        quantity: option.defaultQuantity,
        priceDeltaCents: option.supplementCents,
        sortOrder: option.sortOrder,
        modifiers: componentSellable.modifierGroups.flatMap((group) => group.modifiers
          .filter((modifier) => modifier.isDefault)
          .map((modifier) => ({ id: modifier.id, groupId: group.group.id, name: modifier.name, priceCents: modifier.supplementCents }))),
      }
    }))
  const modifiers = sellable.modifierGroups.flatMap((group) => group.modifiers
    .filter((modifier) => modifier.isDefault)
    .map((modifier) => ({ id: modifier.id, groupId: group.group.id, name: modifier.name, priceCents: modifier.supplementCents })))
  try {
    return canonicalizeProductLineSelection(catalog, sellable, {
      modifiers,
      components,
      mixerProductId: null,
      mixer: null,
    })
  } catch {
    return null
  }
}

export function buildCatalogSnapshot(
  sellable: ResolvedSellableProduct,
  item: ResolvedCatalogItem | null = null,
): SaleLineCatalogSnapshot {
  return {
    placementId: item?.placement.id ?? null,
    productType: sellable.product.type,
    productId: sellable.product.id,
    productName: sellable.product.name,
    variantId: sellable.variant.id,
    variantName: sellable.variant.name,
    basePriceCents: sellable.basePriceCents,
    vatRate: sellable.vatRate,
    categoryId: item?.category?.id ?? null,
    categoryName: item?.category?.name ?? '',
    catalogTabId: item?.tab.id ?? null,
    catalogTabName: item?.tab.label ?? '',
    saleFormatId: null,
    saleFormatName: sellable.variant.name,
  }
}

export function calculateSaleLineTotals(
  variant: { priceCents: number },
  components: readonly Pick<TicketLineComponent, 'type' | 'priceDeltaCents' | 'quantity' | 'modifiers'>[],
  modifiers: readonly Pick<TicketLineModifier, 'priceCents'>[],
): SaleLineTotals {
  const componentModifiers = components.flatMap((component) => (component.modifiers ?? []).map((modifier) => ({
    supplementCents: modifier.priceCents,
    quantity: component.quantity,
  })))
  const price = calculateCatalogPrice({
    baseVariantPriceCents: variant.priceCents,
    selections: components.map((component) => ({
      type: component.type,
      supplementCents: component.priceDeltaCents,
      quantity: component.quantity,
    })),
    modifiers: [
      ...modifiers.map((modifier) => ({ supplementCents: modifier.priceCents })),
      ...componentModifiers,
    ],
    vatRate: 0,
  })
  return {
    basePriceCents: price.baseVariantPriceCents,
    componentDeltaCents: price.selectionSupplementsCents + price.menuSupplementsCents,
    modifierDeltaCents: price.modifierSupplementsCents,
    grossBeforeDiscountCents: price.grossUnitPriceCents,
  }
}

export function buildSaleLine(
  id: string,
  catalog: CatalogData,
  sellable: ResolvedSellableProduct,
  selection: ProductLineSelection,
  item: ResolvedCatalogItem | null = null,
): TicketLine {
  const canonical = canonicalizeProductLineSelection(catalog, sellable, selection)
  const totals = calculateSaleLineTotals(sellable.variant, canonical.components, canonical.modifiers)
  return {
    id,
    productId: sellable.product.id,
    productName: sellable.product.name,
    variantId: sellable.variant.id,
    variantName: sellable.variant.name,
    basePriceCents: totals.basePriceCents,
    componentDeltaCents: totals.componentDeltaCents,
    modifierDeltaCents: totals.modifierDeltaCents,
    unitPriceCents: totals.grossBeforeDiscountCents,
    quantity: 1,
    modifiers: canonical.modifiers,
    components: canonical.components,
    catalogSnapshot: item ? buildCatalogSnapshot(sellable, item) : selection.catalogSnapshot ?? buildCatalogSnapshot(sellable),
    mixerProductId: canonical.mixerProductId,
    mixer: canonical.mixer,
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
