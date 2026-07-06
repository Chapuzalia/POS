import { X } from 'lucide-react'
import { useMemo, useState, useEffect } from 'react'
import { canUseProductAsMixer, getProductVariantForSaleFormat, getSaleFormatLabel } from '../../lib/catalog'
import { formatMoney } from '../../lib/format'
import type { Catalog, ModifierGroup, Product, ProductVariant, SaleFormat, TicketLineModifier } from '../../types'
import { Button } from '../ui'

type ProductDialogProps = {
  catalog: Catalog | null
  isBusy: boolean
  onAdd: (product: Product, variant: ProductVariant, modifiers: TicketLineModifier[]) => void
  onCancel: () => void
  product: Product
  saleFormat: SaleFormat
}

export function ProductDialog({ catalog, isBusy, onAdd, onCancel, product, saleFormat }: ProductDialogProps) {
  const defaultVariant = getProductVariantForSaleFormat(product, saleFormat)
  const [selectedVariantId, setSelectedVariantId] = useState(defaultVariant?.id ?? '')
  const [selectedMixerId, setSelectedMixerId] = useState('')
  const [selectedModifiers, setSelectedModifiers] = useState<Record<string, string[]>>({})
  const selectedVariant = product.variants.find((variant) => variant.id === selectedVariantId) ?? defaultVariant
  const mixerProducts = useMemo(
    () =>
      (catalog?.products ?? [])
        .filter((candidate) => candidate.isActive && canUseProductAsMixer(candidate))
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [catalog],
  )
  const selectedMixer = mixerProducts.find((candidate) => candidate.id === selectedMixerId) ?? null

  const selectedModifierList = useMemo(() => {
    const explicitModifiers = product.modifierGroups.flatMap((group) =>
      group.modifiers
        .filter((modifier) => selectedModifiers[group.id]?.includes(modifier.id))
        .map((modifier) => ({
          id: modifier.id,
          groupId: group.id,
          name: modifier.name,
          priceCents: modifier.priceCents,
        })),
    )

    if (saleFormat !== 'cubata' || !selectedMixer) {
      return explicitModifiers
    }

    return [
      ...explicitModifiers,
      {
        groupId: 'mixer',
        id: `mixer:${selectedMixer.id}`,
        name: selectedMixer.name,
        priceCents: 0,
      },
    ]
  }, [product.modifierGroups, saleFormat, selectedMixer, selectedModifiers])

  const totalCents =
    (selectedVariant?.priceCents ?? 0) +
    selectedModifierList.reduce((total, modifier) => total + modifier.priceCents, 0)

  const isModifierValid = product.modifierGroups.every((group) => {
    const selectedCount = selectedModifiers[group.id]?.length ?? 0
    return selectedCount >= group.minSelect && selectedCount <= group.maxSelect
  })
  const isMixerValid = saleFormat !== 'cubata' || Boolean(selectedMixer)
  const isValid = isModifierValid && isMixerValid

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

  useEffect(() => {
    if (selectedVariant && selectedMixer){
      onAdd(product, selectedVariant, selectedModifierList)
    }
  }, [selectedMixerId])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <section className="max-h-[calc(100svh-32px)] w-full max-w-xl overflow-y-auto rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">{getSaleFormatLabel(saleFormat)}</h2>
            <p className="text-sm text-[var(--muted)]">{product.name}</p>
          </div>
          <Button disabled={isBusy} onClick={onCancel} size="sm" type="button" variant="tertiary">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {product.variants.length > 1 ? (
          <div className="mt-5">
            <p className="mb-2 text-sm font-semibold text-[var(--muted)]">Formato</p>
            <div className="grid gap-2">
              {product.variants.map((variant) => (
                <Button
                  active={variant.id === selectedVariantId}
                  fullWidth
                  key={variant.id}
                  onClick={() => setSelectedVariantId(variant.id)}
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

        {saleFormat === 'cubata' ? (
          <div className="mt-5">
            <p className="mb-2 text-sm font-semibold text-[var(--muted)]">Mixer</p>
            {mixerProducts.length ? (
              <div className="grid gap-2">
                {mixerProducts.map((mixer) => (
                  <Button
                    active={mixer.id === selectedMixerId}
                    fullWidth
                    key={mixer.id}
                    onClick={() => setSelectedMixerId(mixer.id)}
                    type="button"
                    variant="tertiary"
                  >
                    <span className="flex w-full items-center justify-between gap-3">
                      <span>{mixer.name}</span>
                      <span className="font-mono tabular-nums">Incluido</span>
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

        {product.modifierGroups.length ? (
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

        <Button
          className="mt-5"
          disabled={!selectedVariant || !isValid || isBusy}
          fullWidth
          onClick={() => selectedVariant && onAdd(product, selectedVariant, selectedModifierList)}
          size="lg"
          type="button"
          variant="primary"
        >
          Anadir - {formatMoney(totalCents)}
        </Button>
      </section>
    </div>
  )
}
