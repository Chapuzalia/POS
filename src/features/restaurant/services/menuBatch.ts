import { resolveSellableProduct } from '../../catalog/domain/resolver.ts'
import type { CatalogData, ResolvedCatalogItem, ResolvedCatalogSelectionGroup, ResolvedCatalogSelectionOption, ResolvedSellableProduct } from '../../catalog/domain/types.ts'
import { buildSaleLine, canonicalizeProductModifiers } from '../../catalog/services/saleLineBuilder.ts'
import type { ProductLineSelection, TenantContext, TicketLineComponent, TicketLineModifier } from '../../../types/domain.ts'
import type { RestaurantOrderLine } from '../../tables/types.ts'

export const MAX_MENU_BATCH_SIZE = 99
export type MenuBatchDraft = { selections: ProductLineSelection[]; template: ProductLineSelection }

export function createMenuBatchDraft(selection: ProductLineSelection, count: number): MenuBatchDraft {
  const template = { ...selection, components: selection.components.filter((component) => component.type !== 'menu_component') }
  const size = Math.max(1, Math.min(MAX_MENU_BATCH_SIZE, Math.trunc(count) || 1))
  return { template, selections: Array.from({ length: size }, (_, index) => index === 0 ? selection : { ...template, components: [...template.components] }) }
}

export function resizeMenuBatch(draft: MenuBatchDraft, size: number): MenuBatchDraft {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MENU_BATCH_SIZE) return draft
  return { ...draft, selections: size <= draft.selections.length ? draft.selections.slice(0, size)
    : [...draft.selections, ...Array.from({ length: size - draft.selections.length }, () => ({ ...draft.template, components: [...draft.template.components] }))] }
}

export function getMenuBatchGroupCount(selections: ProductLineSelection[], groupId: string, optionId?: string) {
  return selections.reduce((total, selection) => total + selection.components.reduce((sum, component) => sum
    + (component.selectionGroupId === groupId && (!optionId || component.id === optionId) ? component.quantity : 0), 0), 0)
}

export function menuBatchPreparationKey(modifiers: readonly TicketLineModifier[] = []) {
  return JSON.stringify(modifiers.map((modifier) => [modifier.groupId, modifier.id]).sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1])))
}

export function getMenuBatchPreparations(draft: MenuBatchDraft, groupId: string, optionId: string) {
  const preparations = new Map<string, { key: string; quantity: number; modifiers: TicketLineModifier[] }>()
  for (const selection of draft.selections) for (const component of selection.components) {
    if (component.selectionGroupId !== groupId || component.id !== optionId) continue
    const key = menuBatchPreparationKey(component.modifiers)
    const current = preparations.get(key)
    if (current) current.quantity += component.quantity
    else preparations.set(key, { key, quantity: component.quantity, modifiers: component.modifiers ?? [] })
  }
  return [...preparations.values()]
}

export function getMenuBatchChoiceCapacity(selections: ProductLineSelection[], group: ResolvedCatalogSelectionGroup, option: ResolvedCatalogSelectionOption, modifiers?: TicketLineModifier[]) {
  return selections.reduce((total, selection) => {
    const components = selection.components.filter((component) => component.selectionGroupId === group.group.id)
    const existing = components.find((component) => component.id === option.id)
    if (existing && modifiers && menuBatchPreparationKey(existing.modifiers) !== menuBatchPreparationKey(modifiers)) return total
    const groupRemaining = group.assignment.maxSelection - components.reduce((sum, component) => sum + component.quantity, 0)
    const optionRemaining = (option.maxQuantity ?? group.assignment.maxSelection) - (existing?.quantity ?? 0)
    return total + Math.max(0, Math.min(groupRemaining, optionRemaining))
  }, 0)
}

export function findMenuForBatchChoice(selections: ProductLineSelection[], group: ResolvedCatalogSelectionGroup, option: ResolvedCatalogSelectionOption, modifiers?: TicketLineModifier[]) {
  return selections.findIndex((selection) => {
    const components = selection.components.filter((component) => component.selectionGroupId === group.group.id)
    const existing = components.find((component) => component.id === option.id)
    if (existing && modifiers && menuBatchPreparationKey(existing.modifiers) !== menuBatchPreparationKey(modifiers)) return false
    return components.reduce((sum, component) => sum + component.quantity, 0) < group.assignment.maxSelection
      && (components.find((component) => component.id === option.id)?.quantity ?? 0) < (option.maxQuantity ?? group.assignment.maxSelection)
  })
}

export function addMenuBatchChoice(catalog: CatalogData, draft: MenuBatchDraft, group: ResolvedCatalogSelectionGroup, option: ResolvedCatalogSelectionOption, modifiers?: TicketLineModifier[]): MenuBatchDraft {
  const sellable = resolveSellableProduct(catalog, option.product.id, option.variant.id)
  const defaults = sellable.modifierGroups.flatMap((resolved) => resolved.modifiers.filter((modifier) => modifier.isDefault)
    .map((modifier) => ({ id: modifier.id, groupId: resolved.group.id, name: modifier.name, priceCents: modifier.supplementCents })))
  const canonical = canonicalizeProductModifiers(sellable.modifierGroups, modifiers ?? defaults)
  const index = findMenuForBatchChoice(draft.selections, group, option, canonical)
  if (index < 0) return draft
  const component: TicketLineComponent = {
    id: option.id, type: group.group.type, selectionGroupId: group.group.id, selectionGroupName: group.assignment.displayName ?? group.group.name,
    productId: option.product.id, variantId: option.variant.id, productName: option.product.name, variantName: option.variant.name,
    quantity: 1, priceDeltaCents: option.supplementCents, sortOrder: option.sortOrder,
    modifiers: canonical,
  }
  return { ...draft, selections: draft.selections.map((selection, menuIndex) => menuIndex !== index ? selection : {
    ...selection, components: selection.components.some((current) => current.id === option.id)
      ? selection.components.map((current) => current.id === option.id ? { ...current, quantity: current.quantity + 1 } : current)
      : [...selection.components, component],
  }) }
}

export function addMenuBatchPreparation(catalog: CatalogData, draft: MenuBatchDraft, group: ResolvedCatalogSelectionGroup, option: ResolvedCatalogSelectionOption, modifiers: TicketLineModifier[], quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > getMenuBatchChoiceCapacity(draft.selections, group, option, modifiers)) throw new Error('No quedan suficientes raciones disponibles para esta preparación.')
  let next = draft
  for (let index = 0; index < quantity; index++) next = addMenuBatchChoice(catalog, next, group, option, modifiers)
  return next
}

export function replaceMenuBatchPreparation(catalog: CatalogData, draft: MenuBatchDraft, group: ResolvedCatalogSelectionGroup, option: ResolvedCatalogSelectionOption, previousKey: string, modifiers: TicketLineModifier[]) {
  const sellable = resolveSellableProduct(catalog, option.product.id, option.variant.id)
  const canonical = canonicalizeProductModifiers(sellable.modifierGroups, modifiers)
  return { ...draft, selections: draft.selections.map((selection) => ({ ...selection, components: selection.components.map((component) =>
    component.selectionGroupId === group.group.id && component.id === option.id && menuBatchPreparationKey(component.modifiers) === previousKey ? { ...component, modifiers: canonical } : component) })) }
}

export function removeMenuBatchChoice(draft: MenuBatchDraft, groupId: string, optionId: string, preparationKey?: string): MenuBatchDraft {
  const matches = (component: TicketLineComponent) => component.selectionGroupId === groupId && component.id === optionId
    && (preparationKey === undefined || menuBatchPreparationKey(component.modifiers) === preparationKey)
  const index = draft.selections.findLastIndex((selection) => selection.components.some(matches))
  if (index < 0) return draft
  return { ...draft, selections: draft.selections.map((selection, menuIndex) => menuIndex !== index ? selection : {
    ...selection, components: selection.components.flatMap((component) => !matches(component) ? [component]
      : component.quantity > 1 ? [{ ...component, quantity: component.quantity - 1 }] : []),
  }) }
}

export function buildRestaurantMenuBatchLines(input: {
  catalog: CatalogData; sellable: ResolvedSellableProduct; item: ResolvedCatalogItem | null; selections: ProductLineSelection[]
  context: Pick<TenantContext, 'tenantId' | 'venueId'>; orderId: string; createLineId: () => string; timestamp: string
}): RestaurantOrderLine[] {
  if (input.sellable.product.type !== 'menu' || input.selections.length < 1 || input.selections.length > MAX_MENU_BATCH_SIZE) throw new Error('El número de menús no es válido.')
  return input.selections.map((selection) => {
    const line = buildSaleLine(input.createLineId(), input.catalog, input.sellable, selection, input.item, true)
    return { id: line.id, tenantId: input.context.tenantId, venueId: input.context.venueId, orderId: input.orderId,
      productId: line.productId, variantId: line.variantId, productName: line.productName, variantName: line.variantName,
      unitPriceCents: line.unitPriceCents, quantity: 1, servedQuantity: 0, fullyServedAt: null,
      modifiers: line.modifiers, components: line.components, catalogSnapshot: line.catalogSnapshot,
      mixerProductId: line.mixerProductId ?? null, mixer: line.mixer ?? null, note: null, createdAt: input.timestamp, updatedAt: input.timestamp }
  })
}
