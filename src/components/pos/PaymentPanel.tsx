import { CheckCircle2, Coins, CreditCard, X, Percent, type LucideIcon } from 'lucide-react'
import { formatDiscountValue, getDiscountLabel } from '../../lib/discounts'
import { formatMoney } from '../../lib/format'
import type { AppliedDiscount, PaymentMethod } from '../../types'
import { Button } from '../ui'

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
      <div className="flex justify-between gap-3 text-[var(--muted)]">
        <span>Subtotal</span>
        <span className="font-mono font-bold">
          {formatMoney(subtotalCents)}
        </span>
      </div>

      {discount ? (
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
      ) : null}

      <div className="mt-2 flex justify-between gap-3 border-t border-[var(--separator)] pt-2 text-base font-black">
        <span>Total a cobrar</span>
        <span className="font-mono">{formatMoney(totalCents)}</span>
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
          <Button
            className="flex flex-col items-center justify-center"
            disabled={disabled || totalCents === 0}
            fullWidth
            key={payment.id}
            onClick={() => onPayment(payment.id)}
            size="lg"
            type="button"
            variant={
              feedback === payment.id
                ? 'primary'
                : 'secondary'
            }
          >
            <Icon className="h-6 w-6" />
            <span>{payment.label}</span>
          </Button>
        )
      })}

      {allowDiscount ? (
        <Button
          aria-label={
            discount
              ? 'Eliminar descuento'
              : 'Añadir descuento'
          }
          className="flex flex-col items-center justify-center"
          disabled={
            discount
              ? disabled
              : disabled || totalCents === 0
          }
          fullWidth
          onClick={
            discount
              ? onRemoveDiscount
              : onOpenDiscount
          }
          size="lg"
          type="button"
          variant={
            discount
              ? "dangerSoft"
              : "tertiary"
          }
        >
          {discount ? (
            <X className="h-6 w-6" />
          ) : (
            <Percent className="h-6 w-6" />
          )}

          <span>
            {discount
              ? getDiscountLabel(discount)
              : 'Descuento'}
          </span>
        </Button>
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