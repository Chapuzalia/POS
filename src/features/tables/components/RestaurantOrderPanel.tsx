import { Check, CheckCheck, Minus, Plus, Trash2 } from 'lucide-react'
import { formatMoney } from '../../../lib/format'
import { Button } from '../../../components/ui'
import { canDecreaseLineQuantity, getOrderPendingUnits, getPendingQuantity, isLineRemovable } from '../service-status'
import type { RestaurantOrderDetail, RestaurantOrderLine } from '../types'

type Props = {
  isBusy: boolean
  order: RestaurantOrderDetail
  onDecrement: (lineId: string) => void
  onIncrement: (lineId: string) => void
  onRemove: (lineId: string) => void
  onServeAll: (lineId: string) => void
  onServeAllOrder: () => void
  onServeOne: (lineId: string) => void
}

function OrderLineRow({ isBusy, line, onDecrement, onIncrement, onRemove, onServeAll, onServeOne }: Omit<Props, 'order' | 'onServeAllOrder'> & { line: RestaurantOrderLine }) {
  const pending = getPendingQuantity(line)
  const removable = isLineRemovable(line)
  return (
    <article className={`rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3 ${pending === 0 ? 'opacity-65' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-bold">{line.quantity}x - {line.productName}</p>
          {line.modifiers.length ? <p className="text-sm text-[var(--muted)]">+ {line.modifiers.map((modifier) => modifier.name).join(', ')}</p> : null}
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            {pending === 0 ? 'Todo servido' : `${line.servedQuantity} servidas - ${pending} ${pending === 1 ? 'pendiente' : 'pendientes'}`}
          </p>
          <p className="mt-1 font-mono text-sm">{formatMoney(line.unitPriceCents * line.quantity)}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button aria-label="Reducir cantidad" disabled={isBusy || !canDecreaseLineQuantity(line)} onClick={() => onDecrement(line.id)} size="sm" type="button" variant="tertiary"><Minus className="h-4 w-4" /></Button>
          <span className="w-7 text-center font-mono font-bold">{line.quantity}</span>
          <Button aria-label="Aumentar cantidad" disabled={isBusy} onClick={() => onIncrement(line.id)} size="sm" type="button" variant="tertiary"><Plus className="h-4 w-4" /></Button>
          <Button aria-label="Eliminar linea" disabled={isBusy || !removable} onClick={() => onRemove(line.id)} size="sm" title={removable ? 'Eliminar linea' : 'No se puede eliminar una linea con productos ya servidos.'} type="button" variant="tertiary"><Trash2 className="h-4 w-4" /></Button>
        </div>
      </div>
      {pending > 0 ? <div className="mt-3 grid grid-cols-2 gap-2">
        <Button disabled={isBusy} onClick={() => onServeOne(line.id)} size="md" type="button" variant="secondary"><Check className="h-4 w-4" /> Servir 1</Button>
        <Button disabled={isBusy} onClick={() => onServeAll(line.id)} size="md" type="button" variant="primary"><CheckCheck className="h-4 w-4" /> Servir todas</Button>
      </div> : null}
    </article>
  )
}

export function RestaurantOrderPanel(props: Props) {
  const { isBusy, order, onServeAllOrder, ...lineProps } = props
  const pendingLines = order.lines.filter((line) => getPendingQuantity(line) > 0)
  const servedLines = order.lines.filter((line) => getPendingQuantity(line) === 0)
  const pendingUnits = getOrderPendingUnits(order.lines)
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)]">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {order.lines.length === 0 ? <div className="flex min-h-52 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">Pulsa un producto para anadirlo a la comanda.</div> : null}
        {pendingLines.length ? <section><h2 className="mb-2 text-xs font-black uppercase tracking-wide text-[var(--warning)]">Por servir</h2><div className="space-y-2">{pendingLines.map((line) => <OrderLineRow {...lineProps} isBusy={isBusy} key={line.id} line={line} />)}</div></section> : null}
        {servedLines.length ? <section><h2 className="mb-2 text-xs font-black uppercase tracking-wide text-[var(--success)]">Servido</h2><div className="space-y-2">{servedLines.map((line) => <OrderLineRow {...lineProps} isBusy={isBusy} key={line.id} line={line} />)}</div></section> : null}
      </div>
      <div className="space-y-3 border-t border-[var(--separator)] p-4">
        {pendingUnits > 0 ? <Button disabled={isBusy} fullWidth onClick={onServeAllOrder} size="lg" type="button" variant="primary"><CheckCheck className="h-5 w-5" /> Marcar {pendingUnits} {pendingUnits === 1 ? 'producto' : 'productos'} como servidos</Button> : order.lines.length ? <p className="text-center font-bold text-[var(--success)]">Todo servido OK</p> : null}
        <div className="flex items-center justify-between gap-4"><span className="text-lg font-bold">Total</span><span className="font-mono text-3xl font-black tabular-nums">{formatMoney(order.totalCents)}</span></div>
      </div>
    </section>
  )
}
