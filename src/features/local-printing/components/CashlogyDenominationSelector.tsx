import { Minus, Plus } from 'lucide-react'
import { Button } from '../../../components/ui'
import { formatMoney } from '../../../lib/format'
import type { CashlogyDenominationOption } from '../cashlogy/cashlogyManagement'

type Props = {
  disabled?: boolean
  options: CashlogyDenominationOption[]
  quantities: Record<number, number>
  targetCents?: number
  onChange: (valueCents: number, quantity: number) => void
}

export function CashlogyDenominationSelector({ disabled, onChange, options, quantities, targetCents }: Props) {
  const selectedTotalCents = options.reduce((total, option) => (
    total + option.valueCents * (quantities[option.valueCents] ?? 0)
  ), 0)
  const remainingCents = targetCents === undefined ? null : targetCents - selectedTotalCents

  return <section aria-label="Selector de denominaciones" className="grid gap-3">
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const quantity = quantities[option.valueCents] ?? 0
        return <div className="flex min-h-16 items-center gap-3 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-2" key={option.valueCents}>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-lg font-black">{formatMoney(option.valueCents)}</p>
            <p className="text-xs text-[var(--muted)]">{option.kind === 'note' ? 'Billete' : 'Moneda'} · disponibles: {option.availableQuantity}</p>
          </div>
          <Button
            aria-label={`Quitar una unidad de ${formatMoney(option.valueCents)}`}
            className="!min-h-12 !min-w-12 !px-0"
            disabled={disabled || quantity <= 0}
            onClick={() => onChange(option.valueCents, Math.max(0, quantity - 1))}
            type="button"
            variant="tertiary"
          ><Minus className="h-5 w-5" /></Button>
          <span aria-live="polite" className="w-8 text-center font-mono text-xl font-black">{quantity}</span>
          <Button
            aria-label={`Añadir una unidad de ${formatMoney(option.valueCents)}`}
            className="!min-h-12 !min-w-12 !px-0"
            disabled={disabled || quantity >= option.availableQuantity || (targetCents !== undefined && selectedTotalCents + option.valueCents > targetCents)}
            onClick={() => onChange(option.valueCents, Math.min(option.availableQuantity, quantity + 1))}
            type="button"
            variant="secondary"
          ><Plus className="h-5 w-5" /></Button>
        </div>
      })}
    </div>
    {options.length === 0 ? <p className="rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 p-4 text-sm">Cashlogy no informa de denominaciones dispensables disponibles.</p> : null}
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3">
        <p className="text-xs font-bold uppercase text-[var(--muted)]">Seleccionado</p>
        <p className="font-mono text-2xl font-black">{formatMoney(selectedTotalCents)}</p>
      </div>
      {remainingCents !== null ? <div className={`rounded-[var(--radius)] border p-3 ${remainingCents === 0 ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
        <p className="text-xs font-bold uppercase text-[var(--muted)]">{remainingCents >= 0 ? 'Falta' : 'Exceso'}</p>
        <p className="font-mono text-2xl font-black">{formatMoney(Math.abs(remainingCents))}</p>
      </div> : null}
    </div>
  </section>
}
