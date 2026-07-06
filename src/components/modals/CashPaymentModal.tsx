import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { centsToInput, formatMoney, parseMoneyToCents } from '../../lib/format'
import { cx } from '../../utils/cx'
import { Button } from '../ui'

type CashPaymentModalProps = {
  isBusy: boolean
  onCancel: () => void
  onConfirm: (receivedCents: number) => void
  totalCents: number
}

export function CashPaymentModal({ isBusy, onCancel, onConfirm, totalCents }: CashPaymentModalProps) {
  const [delivered, setDelivered] = useState(centsToInput(totalCents))
  const deliveredCents = parseMoneyToCents(delivered)
  const difference = deliveredCents - totalCents
  const quickAmounts = [totalCents, 500, 1000, 2000, 5000, 10000, 20000]

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isBusy) {
        onCancel()
      }

      if (event.key === 'Enter' && !isBusy && difference >= 0) {
        onConfirm(deliveredCents)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [deliveredCents, difference, isBusy, onCancel, onConfirm])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <section className="w-full max-w-xl rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">Cobro en efectivo</h2>
            <p className="text-sm text-[var(--muted)]">Confirma el importe entregado.</p>
          </div>
          <Button disabled={isBusy} onClick={onCancel} size="sm" type="button" variant="tertiary">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-5 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4">
          <p className="text-sm font-semibold text-[var(--muted)]">Total a cobrar</p>
          <p className="mt-1 font-mono text-4xl font-black tabular-nums">{formatMoney(totalCents)}</p>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-7">
          {quickAmounts.map((amount) => (
            <Button
              key={amount}
              onClick={() => setDelivered(centsToInput(amount))}
              type="button"
              variant={amount === totalCents ? 'primary' : 'tertiary'}
            >
              {amount === totalCents ? 'Exacto' : formatMoney(amount)}
            </Button>
          ))}
        </div>

        <label className="mt-4 block">
          <span className="text-sm font-semibold text-[var(--muted)]">Entregado</span>
          <div className="mt-1 flex h-12 items-center rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)]">
            <span className="px-3 font-mono text-sm font-bold text-[var(--muted)]">EUR</span>
            <input
              className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-[var(--field-foreground)] outline-none"
              inputMode="decimal"
              onChange={(event) => setDelivered(event.target.value)}
              value={delivered}
            />
            <Button className="mr-1" onClick={() => setDelivered('0.00')} size="sm" type="button" variant="tertiary">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </label>

        <div
          className={cx(
            'mt-4 rounded-[var(--radius)] border p-4',
            difference >= 0
              ? 'border-[var(--success)] bg-[var(--success-soft)] text-[var(--success)]'
              : 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]',
          )}
        >
          <p className="text-sm font-semibold">{difference >= 0 ? 'Cambio' : 'Falta'}</p>
          <p className="font-mono text-2xl font-black tabular-nums">{formatMoney(Math.abs(difference))}</p>
        </div>

        <Button
          className="mt-4"
          disabled={isBusy || difference < 0}
          fullWidth
          onClick={() => onConfirm(deliveredCents)}
          size="lg"
          type="button"
          variant="primary"
        >
          Confirmar cobro
        </Button>
      </section>
    </div>
  )
}
