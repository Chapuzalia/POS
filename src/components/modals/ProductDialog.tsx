import { GlassWater, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getProductSaleFormats,
  getProductVariantForSaleFormat,
} from '../../lib/catalog'
import { getProductModifierGroups, getVariantSelectionGroups } from '../../features/catalog/services/catalogAccess'
import { formatMoney } from '../../lib/format'
import type { Catalog, ModifierGroup, Product, ProductLineSelection, ProductVariant, SaleFormat, SaleLineCatalogSnapshot, TicketLineComponent, TicketLineModifier, VariantSelectionGroup } from '../../types'
import { cx } from '../../utils/cx'
import { Button } from '../ui'

type ProductDialogProps = {
  allowFormatSelection: boolean
  catalog: Catalog | null
  initialSelection?: ProductLineSelection
  initialVariantId?: string
  isBusy: boolean
  onAdd: (product: Product, variant: ProductVariant, selection: ProductLineSelection, sourceElement?: HTMLElement | null) => boolean
  onCancel: () => void
  product: Product
  saleFormat: SaleFormat
  catalogSnapshot?: SaleLineCatalogSnapshot
}

function compareProductNames(a: Product, b: Product) {
  return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) || a.sortOrder - b.sortOrder
}

function getProductLineSelection(
  explicitModifierList: TicketLineModifier[],
  assignments: VariantSelectionGroup[],
  selectedComponentIds: Record<string, string[]>,
  selectedComponentModifiers: Record<string, Record<string, string[]>>,
  products: Product[],
  catalogSnapshot?: SaleLineCatalogSnapshot,
): ProductLineSelection {
  const components: TicketLineComponent[] = assignments.flatMap((assignment) => (
    assignment.group.items
      .filter((item) => selectedComponentIds[assignment.group.id]?.includes(item.id))
      .map((item) => {
        const selectedProduct = products.find((candidate) => candidate.id === item.productId)
        const selectedVariant = selectedProduct?.variants.find((candidate) => candidate.id === item.variantId)
          ?? selectedProduct?.variants.find((candidate) => candidate.isDefault)
          ?? null
        const modifiers = selectedProduct && selectedVariant
          ? getProductModifierGroups(selectedProduct, selectedVariant.id).flatMap((group) => group.modifiers
            .filter((modifier) => selectedComponentModifiers[item.id]?.[group.id]?.includes(modifier.id))
            .map((modifier) => ({ id: modifier.id, groupId: group.id, name: modifier.name, priceCents: modifier.priceCents })))
          : []
        return {
          id: item.id,
          type: assignment.group.kind,
          selectionGroupId: assignment.group.id,
          selectionGroupName: assignment.group.name,
          productId: item.productId,
          variantId: selectedVariant?.id ?? null,
          productName: selectedProduct?.name ?? 'Producto',
          variantName: selectedVariant?.name ?? '',
          quantity: 1,
          priceDeltaCents: item.priceDeltaCents,
          sortOrder: item.sortOrder,
          modifiers,
        }
      })
  ))
  const mixer = components.find((component) => component.type === 'mixer') ?? null
  return {
    modifiers: explicitModifierList,
    components,
    catalogSnapshot,
    mixerProductId: mixer?.productId ?? null,
    mixer: mixer ? {
      productId: mixer.productId,
      variantId: mixer.variantId,
      name: mixer.productName,
      priceCents: mixer.priceDeltaCents,
    } : null,
  }
}

function getSaleFormatForVariant(product: Product, variant: ProductVariant, fallbackSaleFormat: SaleFormat) {
  return (
    getProductSaleFormats(product).find(
      (candidateSaleFormat) => getProductVariantForSaleFormat(product, candidateSaleFormat)?.id === variant.id,
    ) ?? fallbackSaleFormat
  )
}

export function ProductDialog({
  allowFormatSelection,
  catalog,
  initialSelection,
  initialVariantId,
  isBusy,
  onAdd,
  onCancel,
  product,
  saleFormat,
  catalogSnapshot,
}: ProductDialogProps) {
  const defaultVariant = getProductVariantForSaleFormat(product, saleFormat)
  const startsWithFormatSelection = !initialSelection && allowFormatSelection && product.variants.length > 1
  const [selectedSaleFormat, setSelectedSaleFormat] = useState(saleFormat)
  const [selectedVariantId, setSelectedVariantId] = useState(startsWithFormatSelection ? '' : initialVariantId ?? defaultVariant?.id ?? '')
  const [selectedComponentIds, setSelectedComponentIds] = useState<Record<string, string[]>>(() => {
    const selected: Record<string, string[]> = {}
    for (const component of initialSelection?.components ?? []) {
      if (!component.selectionGroupId) continue
      selected[component.selectionGroupId] = [...(selected[component.selectionGroupId] ?? []), component.id]
    }
    if (!initialSelection) {
      const startingVariantId = initialVariantId ?? defaultVariant?.id
      for (const assignment of startingVariantId ? getVariantSelectionGroups(product, startingVariantId) : []) {
        selected[assignment.group.id] = assignment.group.items.filter((item) => item.isActive && item.isDefault).map((item) => item.id)
      }
    }
    return selected
  })
  const [selectedComponentModifiers, setSelectedComponentModifiers] = useState<Record<string, Record<string, string[]>>>(() => {
    const selected: Record<string, Record<string, string[]>> = Object.fromEntries((initialSelection?.components ?? []).map((component) => [
      component.id,
      Object.fromEntries([...new Set((component.modifiers ?? []).map((modifier) => modifier.groupId))].map((groupId) => [
        groupId,
        (component.modifiers ?? []).filter((modifier) => modifier.groupId === groupId).map((modifier) => modifier.id),
      ])),
    ]))
    if (!initialSelection) {
      const startingVariantId = initialVariantId ?? defaultVariant?.id
      for (const assignment of startingVariantId ? getVariantSelectionGroups(product, startingVariantId) : []) {
        for (const item of assignment.group.items.filter((candidate) => candidate.isActive && candidate.isDefault)) {
          const componentProduct = catalog?.products.find((candidate) => candidate.id === item.productId)
          const componentVariant = componentProduct?.variants.find((candidate) => candidate.id === item.variantId)
            ?? componentProduct?.variants.find((candidate) => candidate.isDefault)
          if (!componentProduct || !componentVariant) continue
          selected[item.id] = Object.fromEntries(getProductModifierGroups(componentProduct, componentVariant.id).map((group) => [
            group.id,
            group.modifiers.filter((modifier) => modifier.isActive && modifier.isDefault).map((modifier) => modifier.id),
          ]))
        }
      }
    }
    return selected
  })
  const [selectedModifiers, setSelectedModifiers] = useState<Record<string, string[]>>(() =>
    Object.fromEntries([...new Map([
      ...product.modifierGroups,
      ...(product.modifierGroupAssignments ?? []).map((assignment) => assignment.group),
    ].map((group) => [group.id, group])).values()].map((group) => [
      group.id,
      initialSelection?.modifiers.filter((modifier) => modifier.groupId === group.id).map((modifier) => modifier.id)
        ?? group.modifiers.filter((modifier) => modifier.isActive && modifier.isDefault).map((modifier) => modifier.id),
    ])),
  )
  const [hasChosenFormat, setHasChosenFormat] = useState(!startsWithFormatSelection)
  const [hasSubmitted, setHasSubmitted] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const submittedRef = useRef(false)
  const dialogRef = useRef<HTMLElement>(null)
  const isChoosingFormat = startsWithFormatSelection && !hasChosenFormat
  const selectedVariant =
    product.variants.find((variant) => variant.id === selectedVariantId) ??
    getProductVariantForSaleFormat(product, selectedSaleFormat) ??
    defaultVariant
  const selectionAssignments = useMemo(
    () => selectedVariant ? getVariantSelectionGroups(product, selectedVariant.id) : [],
    [product, selectedVariant],
  )
  const mixerAssignment = selectionAssignments.find((assignment) => assignment.group.kind === 'mixer') ?? null
  const menuAssignments = selectionAssignments.filter((assignment) => assignment.group.kind === 'menu_component')
  const modifierGroups = useMemo(
    () => selectedVariant ? getProductModifierGroups(product, selectedVariant.id) : [],
    [product, selectedVariant],
  )
  const isChoosingMixer = !isChoosingFormat && Boolean(mixerAssignment)
  const mixerOptions = useMemo(() => (mixerAssignment?.group.items ?? [])
    .filter((item) => item.isActive)
    .map((item) => ({ item, product: (catalog?.products ?? []).find((candidate) => candidate.id === item.productId) }))
    .filter((option): option is typeof option & { product: Product } => Boolean(option.product?.isActive))
    .sort((a, b) => compareProductNames(a.product, b.product)), [catalog, mixerAssignment])
  const selectedMixerItemId = mixerAssignment ? selectedComponentIds[mixerAssignment.group.id]?.[0] ?? '' : ''

  const explicitModifierList = useMemo(
    () =>
      modifierGroups.flatMap((group) =>
        group.modifiers
          .filter((modifier) => selectedModifiers[group.id]?.includes(modifier.id))
          .map((modifier) => ({
            id: modifier.id,
            groupId: group.id,
            name: modifier.name,
            priceCents: modifier.priceCents,
          })),
      ),
    [modifierGroups, selectedModifiers],
  )

  const isModifierValid = modifierGroups.every((group) => {
    const selectedCount = selectedModifiers[group.id]?.length ?? 0
    return selectedCount >= group.minSelect && selectedCount <= group.maxSelect
  })
  const isComponentSelectionValid = selectionAssignments.every((assignment) => {
    const count = selectedComponentIds[assignment.group.id]?.length ?? 0
    return count >= assignment.group.minSelect && count <= assignment.group.maxSelect
  })
  const isComponentModifierValid = menuAssignments.every((assignment) => assignment.group.items
    .filter((item) => selectedComponentIds[assignment.group.id]?.includes(item.id))
    .every((item) => {
      const componentProduct = catalog?.products.find((candidate) => candidate.id === item.productId)
      const componentVariant = componentProduct?.variants.find((candidate) => candidate.id === item.variantId)
        ?? componentProduct?.variants.find((candidate) => candidate.isDefault)
      return !componentProduct || !componentVariant || getProductModifierGroups(componentProduct, componentVariant.id).every((group) => {
        const count = selectedComponentModifiers[item.id]?.[group.id]?.length ?? 0
        return count >= group.minSelect && count <= group.maxSelect
      })
    }))

  useEffect(() => {
    if (!isClosing) return

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onCancel()
      return
    }

    const timeout = window.setTimeout(onCancel, 170)
    return () => window.clearTimeout(timeout)
  }, [isClosing, onCancel])

  function submitSelection(
    variant = selectedVariant,
    sourceElement?: HTMLElement | null,
  ) {
    if (!variant || !isModifierValid || !isComponentSelectionValid || !isComponentModifierValid || submittedRef.current || isBusy) {
      return
    }
    const wasAdded = onAdd(
      product,
      variant,
      getProductLineSelection(explicitModifierList, selectionAssignments, selectedComponentIds, selectedComponentModifiers, catalog?.products ?? [], catalogSnapshot ?? initialSelection?.catalogSnapshot),
      sourceElement ?? dialogRef.current,
    )
    if (!wasAdded) return

    submittedRef.current = true
    setHasSubmitted(true)
    setIsClosing(true)
  }

  function handleMixerSelect(itemId: string, sourceElement: HTMLElement) {
    if (!mixerAssignment) return
    setSelectedComponentIds((current) => ({ ...current, [mixerAssignment.group.id]: [itemId] }))
    if (!modifierGroups.length && !menuAssignments.length && !initialSelection) {
      const nextSelection = { ...selectedComponentIds, [mixerAssignment.group.id]: [itemId] }
      const wasAdded = selectedVariant && onAdd(
        product,
        selectedVariant,
        getProductLineSelection(explicitModifierList, selectionAssignments, nextSelection, selectedComponentModifiers, catalog?.products ?? [], catalogSnapshot),
        sourceElement,
      )
      if (wasAdded) {
        submittedRef.current = true
        setHasSubmitted(true)
        setIsClosing(true)
      }
    }
  }

  function handleNoMixer(sourceElement: HTMLElement) {
    if (!mixerAssignment) return
    setSelectedComponentIds((current) => ({ ...current, [mixerAssignment.group.id]: [] }))
    if (!modifierGroups.length) submitSelection(selectedVariant, sourceElement)
  }

  function toggleModifier(group: ModifierGroup, modifierId: string) {
    setSelectedModifiers((current) => {
      const selected = current[group.id] ?? []
      const exists = selected.includes(modifierId)
      const next = exists
        ? selected.filter((id) => id !== modifierId)
        : group.maxSelect === 1
          ? [modifierId]
          : [...selected, modifierId].slice(0, group.maxSelect)

      return {
        ...current,
        [group.id]: next,
      }
    })
  }

  function toggleMenuComponent(assignment: VariantSelectionGroup, itemId: string) {
    const currentValues = selectedComponentIds[assignment.group.id] ?? []
    const isSelected = currentValues.includes(itemId)
    const nextValues = isSelected
      ? currentValues.filter((id) => id !== itemId)
      : assignment.group.maxSelect === 1 ? [itemId] : [...currentValues, itemId].slice(0, assignment.group.maxSelect)
    setSelectedComponentIds((current) => ({ ...current, [assignment.group.id]: nextValues }))
    if (isSelected) return

    const item = assignment.group.items.find((candidate) => candidate.id === itemId)
    const componentProduct = catalog?.products.find((candidate) => candidate.id === item?.productId)
    const componentVariant = componentProduct?.variants.find((candidate) => candidate.id === item?.variantId)
      ?? componentProduct?.variants.find((candidate) => candidate.isDefault)
    if (!componentProduct || !componentVariant) return
    setSelectedComponentModifiers((current) => ({
      ...current,
      [itemId]: Object.fromEntries(getProductModifierGroups(componentProduct, componentVariant.id).map((group) => [
        group.id,
        group.modifiers.filter((modifier) => modifier.isActive && modifier.isDefault).map((modifier) => modifier.id),
      ])),
    }))
  }

  function toggleComponentModifier(itemId: string, group: ModifierGroup, modifierId: string) {
    setSelectedComponentModifiers((current) => {
      const selected = current[itemId]?.[group.id] ?? []
      const exists = selected.includes(modifierId)
      const next = exists
        ? selected.filter((id) => id !== modifierId)
        : group.maxSelect === 1 ? [modifierId] : [...selected, modifierId].slice(0, group.maxSelect)
      return { ...current, [itemId]: { ...current[itemId], [group.id]: next } }
    })
  }

  function handleVariantSelect(variant: ProductVariant, sourceElement: HTMLElement) {
    const nextSaleFormat = getSaleFormatForVariant(product, variant, selectedSaleFormat)

    setSelectedVariantId(variant.id)
    setSelectedSaleFormat(nextSaleFormat)
    setSelectedComponentIds({})
    setSelectedComponentModifiers({})
    setHasChosenFormat(true)

    if (!getVariantSelectionGroups(product, variant.id).length && getProductModifierGroups(product, variant.id).length === 0) {
      submitSelection(variant, sourceElement)
    }
  }

  return (
    <div className={cx('fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4', isClosing && 'product-dialog-backdrop-closing')}>
      <section
        ref={dialogRef}
        className={cx(
          'max-h-[calc(100svh-32px)] w-full overflow-y-auto rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]',
          isChoosingMixer ? 'max-w-5xl' : 'max-w-xl',
          isClosing && 'product-dialog-closing',
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">
              {isChoosingFormat ? 'Formato' : (product.name + ' con')}
            </h2>
          </div>
          <Button disabled={isBusy || hasSubmitted} onClick={onCancel} size="sm" type="button" variant="tertiary">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {isChoosingFormat ? (
          <div className="mt-5">
            <div className="grid gap-2">
              {product.variants.map((variant) => (
                <Button
                  active={variant.id === selectedVariantId}
                  disabled={hasSubmitted}
                  fullWidth
                  key={variant.id}
                  onClick={(event) => handleVariantSelect(variant, event.currentTarget)}
                  type="button"
                  variant="tertiary"
                  size="lg"
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    <span>{variant.name}</span>
                    <span className="font-mono tabular-nums">{formatMoney(variant.priceCents)}</span>
                  </span>
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {isChoosingMixer ? (
          <div className="mt-5">
            {mixerOptions.length ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {initialSelection ? <Button
                  active={!selectedMixerItemId}
                  disabled={isBusy || hasSubmitted}
                  fullWidth
                  onClick={(event) => handleNoMixer(event.currentTarget)}
                  type="button"
                  variant="tertiary"
                  className="h-28"
                >Sin mixer</Button> : null}
                {mixerOptions.map(({ item, product: mixer }) => (
                  <Button
                    active={item.id === selectedMixerItemId}
                    disabled={isBusy || hasSubmitted}
                    fullWidth
                    key={item.id}
                    onClick={(event) => handleMixerSelect(item.id, event.currentTarget)}
                    type="button"
                    variant="tertiary"
                    className="h-28 overflow-hidden !justify-start !p-0"
                  >
                    <span className="grid h-full w-full grid-cols-[6rem_minmax(0,1fr)] items-center">
                      <span className="grid h-full w-24 place-items-center overflow-hidden bg-[var(--surface-secondary)] text-[var(--accent)]">
                        {mixer.imageUrl ? (
                          <img
                            alt=""
                            className="h-full w-full object-cover"
                            src={mixer.imageUrl}
                          />
                        ) : (
                          <GlassWater className="h-8 w-8" />
                        )}
                      </span>
                      <span className="min-w-0 px-4 text-left text-lg">
                        <span className="block truncate">{mixer.name}</span>
                        {item.priceDeltaCents ? <span className="block text-sm text-[var(--muted)]">+{formatMoney(item.priceDeltaCents)}</span> : null}
                      </span>
                    </span>
                  </Button>
                ))}
              </div>
            ) : (
              <div className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-4 text-sm font-semibold text-[var(--muted)]">
                No hay mixers configurados en el CRM.
              </div>
            )}
          </div>
        ) : null}

        {!isChoosingFormat && menuAssignments.length ? (
          <div className="mt-5 space-y-4">
            {menuAssignments.map((assignment) => (
              <div key={assignment.selectionGroupId}>
                <p className="mb-2 text-sm font-semibold text-[var(--muted)]">
                  {assignment.group.name} - selecciona entre {assignment.group.minSelect} y {assignment.group.maxSelect}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {assignment.group.items.filter((item) => item.isActive).map((item) => {
                    const optionProduct = catalog?.products.find((candidate) => candidate.id === item.productId)
                    const optionVariant = optionProduct?.variants.find((candidate) => candidate.id === item.variantId)
                      ?? optionProduct?.variants.find((candidate) => candidate.isDefault)
                    const componentModifierGroups = optionProduct && optionVariant ? getProductModifierGroups(optionProduct, optionVariant.id) : []
                    const selected = selectedComponentIds[assignment.group.id]?.includes(item.id) ?? false
                    return <div className="grid gap-2" key={item.id}>
                      <Button
                        active={selected}
                        disabled={hasSubmitted || !optionProduct}
                        fullWidth
                        onClick={() => toggleMenuComponent(assignment, item.id)}
                        type="button"
                        variant="tertiary"
                      >
                        <span className="flex w-full items-center justify-between gap-3">
                          <span>{optionProduct?.name ?? 'Producto no disponible'}</span>
                          <span>{item.priceDeltaCents ? `+${formatMoney(item.priceDeltaCents)}` : 'Incluido'}</span>
                        </span>
                      </Button>
                      {selected && componentModifierGroups.length ? <div className="rounded-[var(--radius)] border border-[var(--separator)] p-3">
                        {componentModifierGroups.map((group) => <div className="mb-3 last:mb-0" key={group.id}>
                          <p className="mb-2 text-xs font-semibold text-[var(--muted)]">{group.name} · {group.minSelect}-{group.maxSelect}</p>
                          <div className="grid gap-2">
                            {group.modifiers.filter((modifier) => modifier.isActive).map((modifier) => <Button
                              active={selectedComponentModifiers[item.id]?.[group.id]?.includes(modifier.id) ?? false}
                              disabled={hasSubmitted}
                              fullWidth
                              key={modifier.id}
                              onClick={() => toggleComponentModifier(item.id, group, modifier.id)}
                              size="sm"
                              type="button"
                              variant="tertiary"
                            >
                              <span className="flex w-full items-center justify-between gap-3">
                                <span>{modifier.name}</span>
                                <span>{modifier.priceCents ? `+${formatMoney(modifier.priceCents)}` : 'Incluido'}</span>
                              </span>
                            </Button>)}
                          </div>
                        </div>)}
                      </div> : null}
                    </div>
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {!isChoosingFormat && modifierGroups.length ? (
          <div className="mt-5 space-y-4">
            {modifierGroups.map((group) => (
              <div key={group.id}>
                <p className="mb-2 text-sm font-semibold text-[var(--muted)]">
                  {group.name}
                  {group.minSelect ? ` - minimo ${group.minSelect}` : ''}
                </p>
                <div className="grid gap-2">
                  {group.modifiers.map((modifier) => (
                    <Button
                      active={selectedModifiers[group.id]?.includes(modifier.id) ?? false}
                      disabled={hasSubmitted}
                      fullWidth
                      key={modifier.id}
                      onClick={() => toggleModifier(group, modifier.id)}
                      type="button"
                      variant="tertiary"
                    >
                      <span className="flex w-full items-center justify-between gap-3">
                        <span>{modifier.name}</span>
                        <span className="font-mono tabular-nums">
                          {modifier.priceCents ? `+${formatMoney(modifier.priceCents)}` : 'Incluido'}
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {!isChoosingFormat && (modifierGroups.length > 0 || selectionAssignments.length > 0 || initialSelection) ? (
          <div className="mt-5">
            <Button
              disabled={isBusy || hasSubmitted || !selectedVariant || !isModifierValid || !isComponentSelectionValid || !isComponentModifierValid}
              fullWidth
              onClick={(event) => submitSelection(selectedVariant, event.currentTarget)}
              size="lg"
              type="button"
              variant="primary"
            >{initialSelection ? 'Guardar cambios' : 'Anadir producto'}</Button>
          </div>
        ) : null}

      </section>
    </div>
  )
}
