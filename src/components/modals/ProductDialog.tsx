import { GlassWater, Minus, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { resolveSellableProduct } from '../../features/catalog/domain/resolver'
import type {
  CatalogData,
  ResolvedCatalogItem,
  ResolvedCatalogModifierGroup,
  ResolvedCatalogSelectionGroup,
  ResolvedCatalogSelectionOption,
  ResolvedSellableProduct,
} from '../../features/catalog/domain/types'
import { canonicalizeProductLineSelection } from '../../features/catalog/services/saleLineBuilder'
import type { AddCatalogLine } from '../../features/quick-sale/hooks/useQuickSale'
import { formatMoney } from '../../lib/format'
import type { ProductLineSelection, TicketLineModifier } from '../../types'
import { cx } from '../../utils/cx'
import { Button } from '../ui'
import { closeOnModalBackdrop } from './modalBackdrop'

type ProductDialogProps = {
  allowVariantSelection: boolean
  catalog: CatalogData
  initialSelection?: ProductLineSelection
  initialVariantId?: string
  isBusy: boolean
  item: ResolvedCatalogItem
  onAdd: AddCatalogLine
  onCancel: () => void
}

type SelectedQuantities = Record<string, Record<string, number>>
type SelectedModifiers = Record<string, string[]>
type SelectedComponentModifiers = Record<string, Record<string, string[]>>

function defaultQuantities(sellable: ResolvedSellableProduct): SelectedQuantities {
  return Object.fromEntries(sellable.selectionGroups.map((resolvedGroup) => [
    resolvedGroup.group.id,
    Object.fromEntries(resolvedGroup.options.filter((option) => option.defaultQuantity > 0).map((option) => [option.id, option.defaultQuantity])),
  ]))
}

function initialQuantities(sellable: ResolvedSellableProduct, selection?: ProductLineSelection): SelectedQuantities {
  if (!selection) return defaultQuantities(sellable)
  const result: SelectedQuantities = {}
  for (const component of selection.components) {
    if (!component.selectionGroupId) continue
    result[component.selectionGroupId] = { ...result[component.selectionGroupId], [component.id]: component.quantity }
  }
  return result
}

function defaultModifiers(groups: readonly ResolvedCatalogModifierGroup[]): SelectedModifiers {
  return Object.fromEntries(groups.map((resolvedGroup) => [
    resolvedGroup.group.id,
    resolvedGroup.modifiers.filter((modifier) => modifier.isDefault).map((modifier) => modifier.id),
  ]))
}

function initialModifiers(groups: readonly ResolvedCatalogModifierGroup[], selection?: readonly TicketLineModifier[]): SelectedModifiers {
  if (!selection) return defaultModifiers(groups)
  return Object.fromEntries(groups.map((resolvedGroup) => [
    resolvedGroup.group.id,
    selection.filter((modifier) => modifier.groupId === resolvedGroup.group.id).map((modifier) => modifier.id),
  ]))
}

function buildComponentModifierDefaults(
  catalog: CatalogData,
  sellable: ResolvedSellableProduct,
  quantities: SelectedQuantities,
): SelectedComponentModifiers {
  const result: SelectedComponentModifiers = {}
  for (const resolvedGroup of sellable.selectionGroups) {
    for (const option of resolvedGroup.options) {
      if (!(quantities[resolvedGroup.group.id]?.[option.id] > 0)) continue
      const component = resolveSellableProduct(catalog, option.product.id, option.variant.id)
      result[option.id] = defaultModifiers(component.modifierGroups)
    }
  }
  return result
}

function initialComponentModifiers(
  catalog: CatalogData,
  sellable: ResolvedSellableProduct,
  quantities: SelectedQuantities,
  selection?: ProductLineSelection,
): SelectedComponentModifiers {
  if (!selection) return buildComponentModifierDefaults(catalog, sellable, quantities)
  return Object.fromEntries(selection.components.map((component) => [
    component.id,
    Object.fromEntries([...new Set((component.modifiers ?? []).map((modifier) => modifier.groupId))].map((groupId) => [
      groupId,
      (component.modifiers ?? []).filter((modifier) => modifier.groupId === groupId).map((modifier) => modifier.id),
    ])),
  ]))
}

function buildSelection(
  catalog: CatalogData,
  sellable: ResolvedSellableProduct,
  quantities: SelectedQuantities,
  selectedModifiers: SelectedModifiers,
  selectedComponentModifiers: SelectedComponentModifiers,
  previousSnapshot: ProductLineSelection['catalogSnapshot'],
): ProductLineSelection {
  const modifiers = sellable.modifierGroups.flatMap((resolvedGroup) => resolvedGroup.modifiers
    .filter((modifier) => selectedModifiers[resolvedGroup.group.id]?.includes(modifier.id))
    .map((modifier) => ({ id: modifier.id, groupId: resolvedGroup.group.id, name: modifier.name, priceCents: modifier.supplementCents })))
  const components = sellable.selectionGroups.flatMap((resolvedGroup) => resolvedGroup.options
    .filter((option) => (quantities[resolvedGroup.group.id]?.[option.id] ?? 0) > 0)
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
        quantity: quantities[resolvedGroup.group.id]?.[option.id] ?? 0,
        priceDeltaCents: option.supplementCents,
        sortOrder: option.sortOrder,
        modifiers: componentSellable.modifierGroups.flatMap((modifierGroup) => modifierGroup.modifiers
          .filter((modifier) => selectedComponentModifiers[option.id]?.[modifierGroup.group.id]?.includes(modifier.id))
          .map((modifier) => ({ id: modifier.id, groupId: modifierGroup.group.id, name: modifier.name, priceCents: modifier.supplementCents }))),
      }
    }))
  const mixer = components.find((component) => component.type === 'mixer') ?? null
  return {
    modifiers,
    components,
    catalogSnapshot: previousSnapshot,
    mixerProductId: mixer?.productId ?? null,
    mixer: mixer ? { productId: mixer.productId, variantId: mixer.variantId, name: mixer.productName, priceCents: mixer.priceDeltaCents } : null,
  }
}

export function ProductDialog({
  allowVariantSelection,
  catalog,
  initialSelection,
  initialVariantId,
  isBusy,
  item,
  onAdd,
  onCancel,
}: ProductDialogProps) {
  const variants = useMemo(() => catalog.variants
    .filter((variant) => variant.productId === item.product.id && variant.active)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)), [catalog, item.product.id])
  const startsWithVariantSelection = !initialSelection && allowVariantSelection && variants.length > 1
  const [selectedVariantId, setSelectedVariantId] = useState(initialVariantId ?? item.variant.id)
  const selectedSellable = useMemo(
    () => resolveSellableProduct(catalog, item.product.id, selectedVariantId),
    [catalog, item.product.id, selectedVariantId],
  )
  const initialQuantityState = useMemo(
    () => initialQuantities(selectedSellable, initialSelection),
    [initialSelection, selectedSellable],
  )
  const [selectedQuantities, setSelectedQuantities] = useState<SelectedQuantities>(initialQuantityState)
  const [selectedModifiers, setSelectedModifiers] = useState<SelectedModifiers>(() => initialModifiers(selectedSellable.modifierGroups, initialSelection?.modifiers))
  const [selectedComponentModifiers, setSelectedComponentModifiers] = useState<SelectedComponentModifiers>(() => initialComponentModifiers(catalog, selectedSellable, initialQuantityState, initialSelection))
  const [hasChosenVariant, setHasChosenVariant] = useState(!startsWithVariantSelection)
  const [hasSubmitted, setHasSubmitted] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const submittedRef = useRef(false)
  const dialogRef = useRef<HTMLElement>(null)
  const isChoosingVariant = startsWithVariantSelection && !hasChosenVariant
  const mixerAssignment = selectedSellable.selectionGroups.find((resolvedGroup) => resolvedGroup.group.type === 'mixer') ?? null
  const menuAssignments = selectedSellable.selectionGroups.filter((resolvedGroup) => resolvedGroup.group.type === 'menu_component')
  const isChoosingMixer = !isChoosingVariant && Boolean(mixerAssignment)
  const selectedMixerItemId = mixerAssignment
    ? Object.entries(selectedQuantities[mixerAssignment.group.id] ?? {}).find(([, quantity]) => quantity > 0)?.[0] ?? ''
    : ''
  const selectedMixerOption = mixerAssignment?.options.find((option) => option.id === selectedMixerItemId) ?? null
  const selectedMixerSellable = useMemo(() => selectedMixerOption
    ? resolveSellableProduct(catalog, selectedMixerOption.product.id, selectedMixerOption.variant.id)
    : null, [catalog, selectedMixerOption])
  const selection = useMemo(() => buildSelection(
    catalog,
    selectedSellable,
    selectedQuantities,
    selectedModifiers,
    selectedComponentModifiers,
    initialSelection?.catalogSnapshot,
  ), [catalog, initialSelection?.catalogSnapshot, selectedComponentModifiers, selectedModifiers, selectedQuantities, selectedSellable])
  const isSelectionValid = useMemo(() => {
    try {
      canonicalizeProductLineSelection(catalog, selectedSellable, selection)
      return true
    } catch {
      return false
    }
  }, [catalog, selectedSellable, selection])

  useEffect(() => {
    if (!isClosing) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onCancel()
      return
    }
    const timeout = window.setTimeout(onCancel, 170)
    return () => window.clearTimeout(timeout)
  }, [isClosing, onCancel])

  function completeAdd(sellable: ResolvedSellableProduct, nextSelection: ProductLineSelection, sourceElement?: HTMLElement | null) {
    if (submittedRef.current || isBusy) return false
    const wasAdded = onAdd(sellable, nextSelection, item, sourceElement ?? dialogRef.current)
    if (!wasAdded) return false
    submittedRef.current = true
    setHasSubmitted(true)
    setIsClosing(true)
    return true
  }

  function submitSelection(sourceElement?: HTMLElement | null) {
    if (!isSelectionValid) return
    completeAdd(selectedSellable, selection, sourceElement)
  }

  function resetVariantState(sellable: ResolvedSellableProduct) {
    const quantities = defaultQuantities(sellable)
    setSelectedQuantities(quantities)
    setSelectedModifiers(defaultModifiers(sellable.modifierGroups))
    setSelectedComponentModifiers(buildComponentModifierDefaults(catalog, sellable, quantities))
  }

  function handleVariantSelect(variantId: string, sourceElement: HTMLElement) {
    const sellable = resolveSellableProduct(catalog, item.product.id, variantId)
    setSelectedVariantId(variantId)
    resetVariantState(sellable)
    setHasChosenVariant(true)
    if (!sellable.selectionGroups.length && !sellable.modifierGroups.length) {
      completeAdd(sellable, { modifiers: [], components: [], mixerProductId: null, mixer: null }, sourceElement)
    }
  }

  function setOptionQuantity(group: ResolvedCatalogSelectionGroup, option: ResolvedCatalogSelectionOption, quantity: number) {
    const currentGroup = selectedQuantities[group.group.id] ?? {}
    const otherCount = Object.entries(currentGroup).reduce((total, [optionId, current]) => total + (optionId === option.id ? 0 : current), 0)
    const maximum = Math.min(option.maxQuantity ?? group.assignment.maxSelection, group.assignment.maxSelection - otherCount)
    const nextQuantity = Math.max(0, Math.min(quantity, maximum))
    setSelectedQuantities((current) => ({
      ...current,
      [group.group.id]: { ...current[group.group.id], [option.id]: nextQuantity },
    }))
    if (nextQuantity > 0 && !selectedComponentModifiers[option.id]) {
      const component = resolveSellableProduct(catalog, option.productId, option.variant.id)
      setSelectedComponentModifiers((current) => ({ ...current, [option.id]: defaultModifiers(component.modifierGroups) }))
    }
  }

  function toggleOption(group: ResolvedCatalogSelectionGroup, option: ResolvedCatalogSelectionOption) {
    const current = selectedQuantities[group.group.id]?.[option.id] ?? 0
    if (current > 0) {
      setOptionQuantity(group, option, 0)
      return
    }
    if (group.assignment.maxSelection === 1) {
      setSelectedQuantities((all) => ({ ...all, [group.group.id]: { [option.id]: 1 } }))
    } else {
      setOptionQuantity(group, option, Math.max(1, option.defaultQuantity))
    }
    if (!selectedComponentModifiers[option.id]) {
      const component = resolveSellableProduct(catalog, option.productId, option.variant.id)
      setSelectedComponentModifiers((currentModifiers) => ({ ...currentModifiers, [option.id]: defaultModifiers(component.modifierGroups) }))
    }
  }

  function handleMixerSelect(option: ResolvedCatalogSelectionOption, sourceElement: HTMLElement) {
    if (!mixerAssignment) return
    const nextQuantities = { ...selectedQuantities, [mixerAssignment.group.id]: { [option.id]: 1 } }
    const component = resolveSellableProduct(catalog, option.product.id, option.variant.id)
    const nextComponentModifiers = selectedComponentModifiers[option.id]
      ? selectedComponentModifiers
      : { ...selectedComponentModifiers, [option.id]: defaultModifiers(component.modifierGroups) }
    setSelectedQuantities(nextQuantities)
    setSelectedComponentModifiers(nextComponentModifiers)
    if (!selectedSellable.modifierGroups.length && !menuAssignments.length && !component.modifierGroups.length && !initialSelection) {
      const nextSelection = buildSelection(catalog, selectedSellable, nextQuantities, selectedModifiers, nextComponentModifiers, undefined)
      try {
        canonicalizeProductLineSelection(catalog, selectedSellable, nextSelection)
        completeAdd(selectedSellable, nextSelection, sourceElement)
      } catch { /* el boton final permite completar los modificadores requeridos */ }
    }
  }

  function handleNoMixer(sourceElement: HTMLElement) {
    if (!mixerAssignment) return
    const nextQuantities = { ...selectedQuantities, [mixerAssignment.group.id]: {} }
    setSelectedQuantities(nextQuantities)
    const nextSelection = buildSelection(catalog, selectedSellable, nextQuantities, selectedModifiers, selectedComponentModifiers, initialSelection?.catalogSnapshot)
    try {
      canonicalizeProductLineSelection(catalog, selectedSellable, nextSelection)
      if (!selectedSellable.modifierGroups.length && !menuAssignments.length) completeAdd(selectedSellable, nextSelection, sourceElement)
    } catch { /* el botón final comunica que la selección sigue incompleta */ }
  }

  function toggleModifier(group: ResolvedCatalogModifierGroup, modifierId: string, componentId?: string) {
    const update = (current: string[]) => {
      const exists = current.includes(modifierId)
      if (exists) return current.filter((id) => id !== modifierId)
      return group.assignment.maxSelection === 1 ? [modifierId] : [...current, modifierId].slice(0, group.assignment.maxSelection)
    }
    if (componentId) {
      setSelectedComponentModifiers((current) => ({
        ...current,
        [componentId]: { ...current[componentId], [group.group.id]: update(current[componentId]?.[group.group.id] ?? []) },
      }))
    } else {
      setSelectedModifiers((current) => ({ ...current, [group.group.id]: update(current[group.group.id] ?? []) }))
    }
  }

  return <div className={cx('fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4', isClosing && 'product-dialog-backdrop-closing')} onClick={(event) => closeOnModalBackdrop(event, onCancel, isBusy || hasSubmitted)}>
    <section ref={dialogRef} className={cx('max-h-[calc(100svh-32px)] w-full overflow-y-auto rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]', isChoosingMixer ? 'max-w-5xl' : 'max-w-xl', isClosing && 'product-dialog-closing')}>
      <div className="flex items-start justify-between gap-4"><h2 className="text-2xl font-bold">{isChoosingVariant ? 'Variante' : `${item.product.name} con`}</h2><Button disabled={isBusy || hasSubmitted} onClick={onCancel} size="sm" type="button" variant="tertiary"><X className="h-4 w-4" /></Button></div>

      {isChoosingVariant ? <div className="mt-5 grid gap-2">{variants.map((variant) => <Button active={variant.id === selectedVariantId} disabled={hasSubmitted} fullWidth key={variant.id} onClick={(event) => handleVariantSelect(variant.id, event.currentTarget)} size="lg" type="button" variant="tertiary"><span className="flex w-full items-center justify-between gap-3"><span>{variant.name}</span><span className="font-mono tabular-nums">{formatMoney(variant.priceCents)}</span></span></Button>)}</div> : null}

      {isChoosingMixer ? <div className="mt-5">{mixerAssignment!.options.length ? <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {mixerAssignment!.assignment.minSelection === 0 || initialSelection ? <Button active={!selectedMixerItemId} disabled={isBusy || hasSubmitted} fullWidth onClick={(event) => handleNoMixer(event.currentTarget)} type="button" variant="tertiary" className="h-28">Sin mixer</Button> : null}
        {mixerAssignment!.options.map((option) => <Button active={option.id === selectedMixerItemId} disabled={isBusy || hasSubmitted} fullWidth key={option.id} onClick={(event) => handleMixerSelect(option, event.currentTarget)} type="button" variant="tertiary" className="h-28 overflow-hidden !justify-start !p-0"><span className="grid h-full w-full grid-cols-[6rem_minmax(0,1fr)] items-center"><span className="grid h-full w-24 place-items-center overflow-hidden bg-[var(--surface-secondary)] text-[var(--accent)]">{option.product.image?.publicUrl ? <img alt="" className="h-full w-full object-cover" src={option.product.image.publicUrl} /> : <GlassWater className="h-8 w-8" />}</span><span className="min-w-0 px-4 text-left text-lg"><span className="block truncate">{option.product.name}</span>{option.supplementCents ? <span className="block text-sm text-[var(--muted)]">+{formatMoney(option.supplementCents)}</span> : null}</span></span></Button>)}
      </div> : <div className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-4 text-sm font-semibold text-[var(--muted)]">No hay mixers configurados en el CRM.</div>}
        {selectedMixerOption && selectedMixerSellable?.modifierGroups.length ? <div className="mt-4 space-y-3 rounded-[var(--radius)] border border-[var(--separator)] p-3">{selectedMixerSellable.modifierGroups.map((group) => <div key={group.group.id}><p className="mb-2 text-sm font-semibold text-[var(--muted)]">{group.assignment.displayName ?? group.group.name} · {group.assignment.minSelection}-{group.assignment.maxSelection}</p><div className="grid gap-2 sm:grid-cols-2">{group.modifiers.map((modifier) => <Button active={selectedComponentModifiers[selectedMixerOption.id]?.[group.group.id]?.includes(modifier.id) ?? false} disabled={hasSubmitted} fullWidth key={modifier.id} onClick={() => toggleModifier(group, modifier.id, selectedMixerOption.id)} size="sm" type="button" variant="tertiary"><span className="flex w-full items-center justify-between gap-3"><span>{modifier.name}</span><span>{modifier.supplementCents ? `+${formatMoney(modifier.supplementCents)}` : 'Incluido'}</span></span></Button>)}</div></div>)}</div> : null}
      </div> : null}

      {!isChoosingVariant && menuAssignments.length ? <div className="mt-5 space-y-4">{menuAssignments.map((group) => <div key={group.group.id}><p className="mb-2 text-sm font-semibold text-[var(--muted)]">{group.assignment.displayName ?? group.group.name} - selecciona entre {group.assignment.minSelection} y {group.assignment.maxSelection}</p><div className="grid gap-2 sm:grid-cols-2">{group.options.map((option) => {
        const quantity = selectedQuantities[group.group.id]?.[option.id] ?? 0
        const selected = quantity > 0
        const component = resolveSellableProduct(catalog, option.product.id, option.variant.id)
        const maximum = option.maxQuantity ?? group.assignment.maxSelection
        return <div className="grid gap-2" key={option.id}><Button active={selected} disabled={hasSubmitted} fullWidth onClick={() => toggleOption(group, option)} type="button" variant="tertiary"><span className="flex w-full items-center justify-between gap-3"><span>{option.product.name}</span><span>{option.supplementCents ? `+${formatMoney(option.supplementCents)}` : 'Incluido'}</span></span></Button>
          {selected && maximum > 1 ? <div className="flex items-center justify-center gap-2"><Button disabled={hasSubmitted || quantity <= 1} onClick={() => setOptionQuantity(group, option, quantity - 1)} size="sm" type="button" variant="tertiary"><Minus className="h-3 w-3" /></Button><span className="min-w-8 text-center font-mono">{quantity}</span><Button disabled={hasSubmitted || quantity >= maximum} onClick={() => setOptionQuantity(group, option, quantity + 1)} size="sm" type="button" variant="tertiary"><Plus className="h-3 w-3" /></Button></div> : null}
          {selected && component.modifierGroups.length ? <div className="rounded-[var(--radius)] border border-[var(--separator)] p-3">{component.modifierGroups.map((modifierGroup) => <div className="mb-3 last:mb-0" key={modifierGroup.group.id}><p className="mb-2 text-xs font-semibold text-[var(--muted)]">{modifierGroup.assignment.displayName ?? modifierGroup.group.name} · {modifierGroup.assignment.minSelection}-{modifierGroup.assignment.maxSelection}</p><div className="grid gap-2">{modifierGroup.modifiers.map((modifier) => <Button active={selectedComponentModifiers[option.id]?.[modifierGroup.group.id]?.includes(modifier.id) ?? false} disabled={hasSubmitted} fullWidth key={modifier.id} onClick={() => toggleModifier(modifierGroup, modifier.id, option.id)} size="sm" type="button" variant="tertiary"><span className="flex w-full items-center justify-between gap-3"><span>{modifier.name}</span><span>{modifier.supplementCents ? `+${formatMoney(modifier.supplementCents)}` : 'Incluido'}</span></span></Button>)}</div></div>)}</div> : null}
        </div>
      })}</div></div>)}</div> : null}

      {!isChoosingVariant && selectedSellable.modifierGroups.length ? <div className="mt-5 space-y-4">{selectedSellable.modifierGroups.map((group) => <div key={group.group.id}><p className="mb-2 text-sm font-semibold text-[var(--muted)]">{group.assignment.displayName ?? group.group.name}{group.assignment.minSelection ? ` - mínimo ${group.assignment.minSelection}` : ''}</p><div className="grid gap-2">{group.modifiers.map((modifier) => <Button active={selectedModifiers[group.group.id]?.includes(modifier.id) ?? false} disabled={hasSubmitted} fullWidth key={modifier.id} onClick={() => toggleModifier(group, modifier.id)} type="button" variant="tertiary"><span className="flex w-full items-center justify-between gap-3"><span>{modifier.name}</span><span className="font-mono tabular-nums">{modifier.supplementCents ? `+${formatMoney(modifier.supplementCents)}` : 'Incluido'}</span></span></Button>)}</div></div>)}</div> : null}

      {!isChoosingVariant && (selectedSellable.modifierGroups.length > 0 || selectedSellable.selectionGroups.length > 0 || initialSelection) ? <div className="mt-5"><Button disabled={isBusy || hasSubmitted || !isSelectionValid} fullWidth onClick={(event) => submitSelection(event.currentTarget)} size="lg" type="button" variant="primary">{initialSelection ? 'Guardar cambios' : 'Añadir producto'}</Button></div> : null}
    </section>
  </div>
}
