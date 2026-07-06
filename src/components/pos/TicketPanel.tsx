import { Minus, Plus, Trash2 } from 'lucide-react'
import { formatMoney, getLineTotal, getTicketTotal } from '../../lib/format'
import type { TicketLine } from '../../types'
import { cx } from '../../utils/cx'
import { Button } from '../ui'

type TicketPanelProps = {
  isBusy: boolean
  lines: TicketLine[]
  onClear: () => void
  onDecrement: (lineId: string) => void
  onIncrement: (lineId: string) => void
  onRemove: (lineId: string) => void
}

export function TicketPanel({ isBusy, lines, onClear, onDecrement, onIncrement, onRemove }: TicketPanelProps) {
  const total = getTicketTotal(lines)

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)]">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {lines.length === 0 ? (
          <div className="flex h-full min-h-52 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">
            Pulsa un producto para crear un ticket.
          </div>
        ) : (
          <div className="space-y-2">
            {lines.map((line) => (
              <article
                className={cx(
                  'grid grid-cols-[1fr_auto] gap-3 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3',
                  isBusy && 'opacity-60',
                )}
                key={line.id}
              >
                <div className="min-w-0">
                  <p className="truncate font-bold text-[var(--foreground)]">{line.productName}</p>
                  <p className="text-sm text-[var(--muted)]">
                    {line.variantName}
                    {line.modifiers.length ? ` - ${line.modifiers.map((modifier) => modifier.name).join(', ')}` : ''}
                  </p>
                  <p className="mt-1 font-mono text-sm tabular-nums text-[var(--muted)]">
                    Cantidad: {line.quantity} x {formatMoney(line.unitPriceCents)}
                  </p>
                  {line.quantity > 1 ? (
                    <p className="font-mono text-sm font-bold tabular-nums text-[var(--foreground)]">
                      {formatMoney(getLineTotal(line))}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <Button disabled={isBusy} onClick={() => onDecrement(line.id)} size="sm" type="button" variant="tertiary">
                    <Minus className="h-4 w-4" />
                  </Button>
                  <span className="w-7 text-center font-mono font-bold tabular-nums">{line.quantity}</span>
                  <Button disabled={isBusy} onClick={() => onIncrement(line.id)} size="sm" type="button" variant="tertiary">
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Button disabled={isBusy} onClick={() => onRemove(line.id)} size="sm" type="button" variant="danger">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--separator)] p-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-lg font-bold">Total</span>
          <span className="font-mono text-3xl font-black tabular-nums">{formatMoney(total)}</span>
        </div>
      </div>
    </section>
  )
}
