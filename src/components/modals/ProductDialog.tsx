import { GlassWater, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import {
  canUseProductAsMixer,
  getProductSaleFormats,
  getProductVariantForSaleFormat,
} from '../../lib/catalog'
import { formatMoney } from '../../lib/format'
import type { Catalog, ModifierGroup, Product, ProductVariant, SaleFormat, TicketLineModifier } from '../../types'
import { cx } from '../../utils/cx'
import { Button } from '../ui'

type ProductDialogProps = {
  allowFormatSelection: boolean
  catalog: Catalog | null
  isBusy: boolean
  onAdd: (product: Product, variant: ProductVariant, modifiers: TicketLineModifier[]) => void
  onCancel: () => void
  product: Product
  saleFormat: SaleFormat
}

function compareProductNames(a: Product, b: Product) {
  return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) || a.sortOrder - b.sortOrder
}

function getMixerSupplementCents(mixer: Product) {
  return mixer.canUseAsMixer ? (mixer.mixerSupplementCents ?? 0) : 0
}

function getModifierListWithMixer(
  explicitModifierList: TicketLineModifier[],
  saleFormat: SaleFormat,
  mixer: Product | null,
): TicketLineModifier[] {
  if (saleFormat !== 'cubata' || !mixer) {
    return explicitModifierList
  }

  return [
    ...explicitModifierList,
    {
      groupId: 'mixer',
      id: `mixer:${mixer.id}`,
      name: mixer.name,
      priceCents: getMixerSupplementCents(mixer),
    },
  ]
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
  isBusy,
  onAdd,
  onCancel,
  product,
  saleFormat,
}: ProductDialogProps) {
  const defaultVariant = getProductVariantForSaleFormat(product, saleFormat)
  const startsWithFormatSelection = allowFormatSelection && product.variants.length > 1
  const [selectedSaleFormat, setSelectedSaleFormat] = useState(saleFormat)
  const [selectedVariantId, setSelectedVariantId] = useState(startsWithFormatSelection ? '' : defaultVariant?.id ?? '')
  const [selectedMixerId, setSelectedMixerId] = useState('')
  const [selectedModifiers, setSelectedModifiers] = useState<Record<string, string[]>>({})
  const [hasChosenFormat, setHasChosenFormat] = useState(!startsWithFormatSelection)
  const [hasSubmitted, setHasSubmitted] = useState(false)
  const submittedRef = useRef(false)
  const isChoosingFormat = startsWithFormatSelection && !hasChosenFormat
  const isChoosingMixer = !isChoosingFormat && selectedSaleFormat === 'cubata'
  const selectedVariant =
    product.variants.find((variant) => variant.id === selectedVariantId) ??
    getProductVariantForSaleFormat(product, selectedSaleFormat) ??
    defaultVariant
  const mixerProducts = useMemo(
    () =>
      (catalog?.products ?? [])
        .filter((candidate) => candidate.isActive && canUseProductAsMixer(candidate))
        .sort(compareProductNames),
    [catalog],
  )
  const selectedMixer = mixerProducts.find((candidate) => candidate.id === selectedMixerId) ?? null

  const explicitModifierList = useMemo(
    () =>
      product.modifierGroups.flatMap((group) =>
        group.modifiers
          .filter((modifier) => selectedModifiers[group.id]?.includes(modifier.id))
          .map((modifier) => ({
            id: modifier.id,
            groupId: group.id,
            name: modifier.name,
            priceCents: modifier.priceCents,
          })),
      ),
    [product.modifierGroups, selectedModifiers],
  )

  const isModifierValid = product.modifierGroups.every((group) => {
    const selectedCount = selectedModifiers[group.id]?.length ?? 0
    return selectedCount >= group.minSelect && selectedCount <= group.maxSelect
  })

  function submitSelection(
    variant = selectedVariant,
    submitSaleFormat = selectedSaleFormat,
    mixer = selectedMixer,
  ) {
    if (!variant || !isModifierValid || submittedRef.current || isBusy) {
      return
    }

    if (submitSaleFormat === 'cubata' && !mixer) {
      return
    }

    submittedRef.current = true
    setHasSubmitted(true)
    onAdd(product, variant, getModifierListWithMixer(explicitModifierList, submitSaleFormat, mixer))
  }

  function handleMixerSelect(mixer: Product) {
    setSelectedMixerId(mixer.id)
    submitSelection(selectedVariant, selectedSaleFormat, mixer)
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

  function handleVariantSelect(variant: ProductVariant) {
    const nextSaleFormat = getSaleFormatForVariant(product, variant, selectedSaleFormat)

    setSelectedVariantId(variant.id)
    setSelectedSaleFormat(nextSaleFormat)
    setSelectedMixerId('')
    setHasChosenFormat(true)

    if (nextSaleFormat !== 'cubata' && product.modifierGroups.length === 0) {
      submitSelection(variant, nextSaleFormat, null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <section
        className={cx(
          'max-h-[calc(100svh-32px)] w-full overflow-y-auto rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]',
          isChoosingMixer ? 'max-w-5xl' : 'max-w-xl',
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
            <p className="mb-2 text-sm font-semibold text-[var(--muted)]">Formato</p>
            <div className="grid gap-2">
              {product.variants.map((variant) => (
                <Button
                  active={variant.id === selectedVariantId}
                  disabled={hasSubmitted}
                  fullWidth
                  key={variant.id}
                  onClick={() => handleVariantSelect(variant)}
                  type="button"
                  variant="tertiary"
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
            {mixerProducts.length ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {mixerProducts.map((mixer) => (
                  <Button
                    active={mixer.id === selectedMixerId}
                    disabled={isBusy || hasSubmitted}
                    fullWidth
                    key={mixer.id}
                    onClick={() => handleMixerSelect(mixer)}
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
                      <span className="min-w-0 truncate px-4 text-left text-lg">{mixer.name}</span>
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

        {!isChoosingFormat && product.modifierGroups.length ? (
          <div className="mt-5 space-y-4">
            {product.modifierGroups.map((group) => (
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

      </section>
    </div>
  )
}
