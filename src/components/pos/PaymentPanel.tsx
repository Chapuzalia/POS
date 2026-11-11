import { useState } from 'react'
import { Dropdown, Label } from '@heroui/react'
import { CheckCircle2, Coins, CreditCard, LoaderCircle, Plus, X, Percent, type LucideIcon } from 'lucide-react'
import { formatDiscountValue, getDiscountLabel } from '../../lib/discounts'
import { centsToInput, formatMoney } from '../../lib/format'
import type { AppliedDiscount, PaymentMethod } from '../../types'
import { Button } from '../ui'
import { PosCatalogTab } from './PosCatalogTab'
import { parsePaymentAmount } from '../../lib/customPayments'
import { NumericKeypadModal } from '../ui/NumericKeypadModal'

const paymentOptions: Array<{ id: PaymentMethod; label: string; icon: LucideIcon }> = [
  { id: 'cash', label: 'Efectivo', icon: Coins },
  { id: 'card', label: 'Tarjeta', icon: CreditCard },
]

type PaymentPanelProps = {
  allowDiscount?: boolean
  discount: AppliedDiscount | null
  disabled: boolean
  feedback: PaymentMethod | null
  processing?: boolean
  pendingMethod?: PaymentMethod | null
  heading?: string
  onOpenDiscount: () => void
  onPayment: (method: PaymentMethod | null) => void
  onCustomPayment: (cashCents: number) => void
  onRemoveDiscount: () => void
  subtotalCents: number
  totalCents: number
}

export function PaymentPanel({
  allowDiscount = true,
  discount,
  disabled,
  feedback,
  processing = false,
  pendingMethod = null,
  heading,
  onOpenDiscount,
  onPayment,
  onCustomPayment,
  onRemoveDiscount,
  subtotalCents,
  totalCents,
}: PaymentPanelProps) {
  const [customPayment, setCustomPayment] = useState<{ cash: string; card: string; totalCents: number } | null>(null)
  const [keypadMethod, setKeypadMethod] = useState<PaymentMethod | null>(null)
  const custom = customPayment?.totalCents === totalCents ? customPayment : null
  const cashCents = custom ? parsePaymentAmount(custom.cash) : null
  const cardCents = custom ? parsePaymentAmount(custom.card) : null
  const validCustomPayment = cashCents !== null && cardCents !== null && cashCents > 0 && cardCents > 0 && cashCents + cardCents === totalCents

  function updateAmount(method: 'cash' | 'card', value: string) {
    const cents = parsePaymentAmount(value)
    const remainder = cents !== null && cents <= totalCents ? centsToInput(totalCents - cents) : ''
    setCustomPayment({ cash: method === 'cash' ? value : remainder, card: method === 'card' ? value : remainder, totalCents })
  }
  if (disabled && !processing) {
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
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem] items-center gap-2"
    >
      {paymentOptions.map((payment) => {
        const isProcessing = processing && pendingMethod === payment.id
        const isConfirmed = feedback === payment.id
        const Icon =
          isProcessing
            ? LoaderCircle
            : isConfirmed
            ? CheckCircle2
            : payment.icon

        return (
          <PosCatalogTab
            active={isProcessing || isConfirmed}
            busy={isProcessing}
            disabled={disabled || processing || totalCents === 0}
            icon={Icon}
            iconClassName={isProcessing ? 'motion-safe:animate-spin' : undefined}
            key={payment.id}
            label={isProcessing ? 'Cobrando…' : isConfirmed ? 'Cobrado' : payment.label}
            onSelect={() => onPayment(payment.id)}
            size="lg"
            tone={isConfirmed ? 'success' : 'default'}
          />
        )
      })}

      <Dropdown>
        <Dropdown.Trigger aria-label="Más opciones de pago" isDisabled={disabled || processing}
          className="group flex h-20 min-h-20 w-full items-center justify-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] text-[var(--foreground)] shadow-sm transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-45">
          <Plus aria-hidden="true" className="size-6 transition-transform duration-150 motion-reduce:transition-none group-aria-expanded:rotate-45" />
        </Dropdown.Trigger>
        <Dropdown.Popover placement="top end" className="!z-[75] !w-72 !max-w-[calc(100vw-24px)] !rounded-[var(--radius)] !border !border-[var(--separator)] !bg-[var(--surface)] !p-1.5 !text-[var(--foreground)] !shadow-[var(--shadow)]">
          <Dropdown.Menu aria-label="Opciones de pago" className="!p-0">
            {allowDiscount ? <Dropdown.Item id="discount" textValue={discount ? 'Eliminar descuento' : 'Descuento'} onAction={discount ? onRemoveDiscount : onOpenDiscount} className="min-h-12 gap-3 rounded-lg px-3" isDisabled={!discount && totalCents === 0}>
              {discount ? <X className="size-5" /> : <Percent className="size-5" />}<Label>{discount ? `Quitar ${getDiscountLabel(discount)}` : 'Descuento'}</Label>
            </Dropdown.Item> : null}
            <Dropdown.Item id="custom" textValue="Pago personalizado" isDisabled={totalCents < 2} onAction={() => { setKeypadMethod(null); setCustomPayment({ cash: '', card: centsToInput(totalCents), totalCents }) }} className="min-h-12 gap-3 rounded-lg px-3">
              <CreditCard className="size-5" /><Label>Pago personalizado <span className="block text-xs font-normal text-[var(--muted)]">Tarjeta + efectivo</span></Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>

    {custom ? <div className="space-y-3 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold">Pago personalizado</span>
        <button type="button" aria-label="Cancelar pago personalizado" disabled={processing} onClick={() => setCustomPayment(null)} className="grid size-11 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--background)]"><X className="size-5" /></button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {paymentOptions.map(({ id, label, icon: Icon }) => <div key={id} className="grid min-w-0 gap-2 text-sm font-semibold">
          <span className="flex items-center gap-2"><Icon className="size-4" />{label}</span>
          <button aria-label={`Importe en ${label.toLowerCase()}`} type="button" disabled={disabled || processing} onClick={() => setKeypadMethod(id)} className="flex min-h-12 w-full items-center justify-between gap-1 rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 text-left focus-visible:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-45">
            <span className="min-w-0 truncate py-3 text-xl font-bold tabular-nums text-[var(--field-foreground)]">{centsToInput(parsePaymentAmount(custom[id]) ?? 0).replace('.', ',')}</span>
            <span className="text-[var(--muted)]">€</span>
          </button>
        </div>)}
      </div>
      <p className="text-xs text-[var(--muted)]" aria-live="polite">{validCustomPayment ? 'El resto se ajusta automáticamente.' : 'Indica cuánto cobrar en cada método. Deben sumar el total.'}</p>
      <Button disabled={disabled || processing || !validCustomPayment} fullWidth size="lg" variant="primary" type="button" onClick={() => { if (validCustomPayment && cashCents !== null) { setCustomPayment(null); onCustomPayment(cashCents) } }}>
        {processing ? 'Cobrando…' : `Cobrar ${formatMoney(totalCents)}`}
      </Button>
    </div> : null}

    {custom && keypadMethod ? <NumericKeypadModal
      disabled={disabled || processing}
      initialValue={custom[keypadMethod] || '0'}
      maxFractionDigits={2}
      onCancel={() => setKeypadMethod(null)}
      onConfirm={(value) => { updateAmount(keypadMethod, value); setKeypadMethod(null) }}
      title={`Importe en ${keypadMethod === 'cash' ? 'efectivo' : 'tarjeta'}`}
      unit="EUR"
    /> : null}

    {totalCents === 0 ? (
      <Button
        disabled={disabled || processing}
        fullWidth
        onClick={() => onPayment(null)}
        size="lg"
        type="button"
        variant="primary"
      >
        {processing ? 'Finalizando…' : 'Finalizar sin cobro'}
      </Button>
    ) : null}
  </section>
)}
