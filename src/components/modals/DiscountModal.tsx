import { Percent, Tags, X } from 'lucide-react'
import { useState } from 'react'
import { calculateDiscount, formatDiscountRounding, formatDiscountValue, getActiveVenueDiscounts } from '../../lib/discounts'
import { parseMoneyToCents } from '../../lib/format'
import type { AppliedDiscount, Discount, DiscountCalculationType } from '../../types'
import { Button } from '../ui'
import { closeOnModalBackdrop } from './modalBackdrop'

type DiscountModalProps = {
  description?: string
  discounts: Discount[]
  isBusy: boolean
  manualDiscountEnabled: boolean
  onCancel: () => void
  onSelect: (discount: AppliedDiscount) => void
  subtotalCents: number
  venueId: string
}

export function DiscountModal({
  description = 'Se aplicará a la cuenta completa.',
  discounts,
  isBusy,
  manualDiscountEnabled,
  onCancel,
  onSelect,
  subtotalCents,
  venueId,
}: DiscountModalProps) {
  const [manualOpen, setManualOpen] = useState(false)
  const availableDiscounts = getActiveVenueDiscounts(discounts, venueId)
  const [manualType, setManualType] = useState<DiscountCalculationType>('percentage')
  const [manualValue, setManualValue] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)

  function applyManual() {
    const value = manualType === 'fixed'
      ? parseMoneyToCents(manualValue)
      : Number(manualValue.replace(',', '.'))

    try {
      calculateDiscount(subtotalCents, manualType, value)
      onSelect({
        discountId: null,
        name: 'Descuento manual',
        type: 'manual',
        calculationType: manualType,
        value,
        roundingIncrementCents: null,
        color: null,
      })
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'El descuento no es válido.')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-4" onClick={(event) => closeOnModalBackdrop(event, onCancel, isBusy)}>
      <section aria-labelledby="discount-title" aria-modal="true" className="max-h-[85svh] w-full overflow-y-auto rounded-t-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)] sm:max-w-xl sm:rounded-[var(--radius)]" role="dialog">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold" id="discount-title">Aplicar descuento</h2>
            <p className="text-sm text-[var(--muted)]">{description}</p>
          </div>
          <Button disabled={isBusy} onClick={onCancel} size="sm" type="button" variant="tertiary">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-5 grid gap-2">
          {availableDiscounts.map((discount) => (
            <button
              className="flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] px-4 py-3 text-left hover:border-[var(--accent)]"
              disabled={isBusy}
              key={discount.id}
              onClick={() => onSelect({
                discountId: discount.id,
                name: discount.name,
                type: discount.type,
                calculationType: discount.type,
                value: discount.value,
                roundingIncrementCents: discount.roundingIncrementCents,
                color: discount.color,
              })}
              type="button"
            >
              <span className="flex items-center gap-3">
                <span className="h-3 w-3 rounded-full border border-black/10" style={{ backgroundColor: discount.color ?? 'var(--accent)' }} />
                <strong>{discount.name}</strong>
              </span>
              <span className="flex flex-col items-end">
                <strong className="font-mono">{formatDiscountValue(discount.type, discount.value)}</strong>
                {discount.roundingIncrementCents ? <small className="text-xs text-[var(--muted)]">{formatDiscountRounding(discount.roundingIncrementCents)}</small> : null}
              </span>
            </button>
          ))}
          {!availableDiscounts.length && !manualDiscountEnabled ? (
            <p className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-5 text-center text-sm font-semibold text-[var(--muted)]">No hay descuentos disponibles para este local.</p>
          ) : null}
        </div>

        {manualDiscountEnabled ? (
          <div className="mt-4 border-t border-[var(--separator)] pt-4">
            {!manualOpen ? (
              <Button fullWidth onClick={() => setManualOpen(true)} type="button" variant="tertiary">
                <Tags className="h-4 w-4" />
                Descuento manual
              </Button>
            ) : (
              <div className="grid gap-3 rounded-[var(--radius)] bg-[var(--background)] p-4">
                <div className="grid grid-cols-2 gap-2">
                  <Button active={manualType === 'percentage'} onClick={() => setManualType('percentage')} type="button" variant="secondary">Porcentaje</Button>
                  <Button active={manualType === 'fixed'} onClick={() => setManualType('fixed')} type="button" variant="secondary">Importe fijo</Button>
                </div>
                <label>
                  <span className="text-sm font-semibold text-[var(--muted)]">{manualType === 'percentage' ? 'Porcentaje' : 'Importe'}</span>
                  <div className="mt-1 flex h-12 items-center rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3">
                    <Percent className="h-4 w-4 text-[var(--muted)]" />
                    <input autoFocus className="min-w-0 flex-1 bg-transparent px-3 outline-none" inputMode="decimal" onChange={(event) => { setManualValue(event.target.value); setValidationError(null) }} value={manualValue} />
                    <span className="text-sm font-bold text-[var(--muted)]">{manualType === 'percentage' ? '%' : 'EUR'}</span>
                  </div>
                </label>
                {validationError ? <p className="text-sm font-semibold text-[var(--danger)]">{validationError}</p> : null}
                <Button disabled={isBusy || !manualValue.trim()} fullWidth onClick={applyManual} type="button" variant="primary">Aplicar descuento manual</Button>
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  )
}
