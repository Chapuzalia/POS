import { CheckCircle2, Coins, CreditCard, X, Percent, type LucideIcon } from 'lucide-react'
import { formatDiscountValue, getDiscountLabel } from '../../lib/discounts'
import { formatMoney } from '../../lib/format'
import type { AppliedDiscount, PaymentMethod } from '../../types'
import { Button } from '../ui'
import { PosCatalogTab } from './PosCatalogTab'

const paymentOptions: Array<{ id: PaymentMethod; label: string; icon: LucideIcon }> = [
  { id: 'cash', label: 'Efectivo', icon: Coins },
  { id: 'card', label: 'Tarjeta', icon: CreditCard },
]

type PaymentPanelProps = {
  allowDiscount?: boolean
  discount: AppliedDiscount | null
  disabled: boolean
  feedback: PaymentMethod | null
  heading?: string
  onOpenDiscount: () => void
  onPayment: (method: PaymentMethod | null) => void
  onRemoveDiscount: () => void
  subtotalCents: number
  totalCents: number
}

export function PaymentPanel({
  allowDiscount = true,
  discount,
  disabled,
  feedback,
  heading,
  onOpenDiscount,
  onPayment,
  onRemoveDiscount,
  subtotalCents,
  totalCents,
}: PaymentPanelProps) {
  if (disabled) {
    return null
  }

  return (
  <section className="space-y-3">
    {heading ? (
      <h2 className="text-sm font-black uppercase tracking-wide text-[var(--foreground)]">
        {heading}
      </h2>
    ) : null}

    <div className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-3 text-sm">
      

      {discount ? (
        <div className="border-b border-[var(--separator)] pb-2">
          <div className="flex justify-between gap-3 text-[var(--muted)]">
            <span>Subtotal</span>
            <span className="font-mono font-bold">
              {formatMoney(subtotalCents)}
            </span>
          </div>
          <div className="mt-2 flex justify-between gap-3 text-[var(--danger)]">
            <span className="min-w-0 truncate">
              {discount.name} ·{' '}
              {formatDiscountValue(
                discount.calculationType,
                discount.value,
              )}
            </span>

            <span className="font-mono font-bold">
              −{formatMoney(subtotalCents - totalCents)}
            </span>
          </div>
        </div>
      ) : null}

      <div className="flex justify-between gap-3 items-center text-base font-black">
        <span>Total a cobrar</span>
        <span className="font-extrabold text-3xl">{formatMoney(totalCents)}</span>
      </div>
    </div>

    <div
      className={
        allowDiscount
          ? 'grid grid-cols-3 gap-2'
          : 'grid grid-cols-2 gap-2'
      }
    >
      {paymentOptions.map((payment) => {
        const Icon =
          feedback === payment.id
            ? CheckCircle2
            : payment.icon

        return (
          <PosCatalogTab
            active={feedback === payment.id}
            disabled={disabled || totalCents === 0}
            icon={Icon}
            key={payment.id}
            label={payment.label}
            onSelect={() => onPayment(payment.id)}
            size="lg"
          />
        )
      })}

      {allowDiscount ? (
        <PosCatalogTab
          active={Boolean(discount)}
          ariaLabel={discount ? 'Eliminar descuento' : 'Añadir descuento'}
          disabled={discount ? disabled : disabled || totalCents === 0}
          icon={discount ? X : Percent}
          label={discount ? getDiscountLabel(discount) : 'Descuento'}
          onSelect={discount ? onRemoveDiscount : onOpenDiscount}
          size="lg"
          tone={discount ? 'danger' : 'default'}
        />
      ) : null}
    </div>

    {totalCents === 0 ? (
      <Button
        disabled={disabled}
        fullWidth
        onClick={() => onPayment(null)}
        size="lg"
        type="button"
        variant="primary"
      >
        Finalizar sin cobro
      </Button>
    ) : null}
  </section>
)}