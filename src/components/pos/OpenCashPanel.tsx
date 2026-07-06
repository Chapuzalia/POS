import { DoorOpen, Euro } from 'lucide-react'
import { useState } from 'react'
import { parseMoneyToCents } from '../../lib/format'
import { Button } from '../ui'

type OpenCashPanelProps = {
  disabled: boolean
  isBusy: boolean
  onOpen: (openingFloatCents: number) => void
}

export function OpenCashPanel({ disabled, isBusy, onOpen }: OpenCashPanelProps) {
  const [openingFloat, setOpeningFloat] = useState('0.00')

  return (
    <section className="flex min-h-0 flex-1 items-center justify-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
      <div className="w-full max-w-md">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-[var(--radius)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <DoorOpen className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-[var(--foreground)]">Apertura de caja</h2>
            <p className="text-sm text-[var(--muted)]">La venta queda bloqueada hasta abrir una sesion.</p>
          </div>
        </div>
        <label className="block">
          <span className="text-sm font-semibold text-[var(--muted)]">Fondo inicial</span>
          <div className="mt-1 flex h-12 items-center rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)]">
            <span className="px-3 font-mono text-sm font-bold text-[var(--muted)]">EUR</span>
            <input
              className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-[var(--field-foreground)] outline-none"
              inputMode="decimal"
              onChange={(event) => setOpeningFloat(event.target.value)}
              value={openingFloat}
            />
          </div>
        </label>
        <Button
          className="mt-4"
          disabled={disabled || isBusy}
          fullWidth
          onClick={() => onOpen(parseMoneyToCents(openingFloat))}
          size="lg"
          type="button"
          variant="primary"
        >
          <Euro className="h-5 w-5" />
          Abrir caja
        </Button>
      </div>
    </section>
  )
}
