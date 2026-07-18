import { Trash2, X } from 'lucide-react'
import { Button } from '../../../components/ui'
import type { RestaurantOrderLine } from '../types'

type Props = {
  isBusy: boolean
  line: RestaurantOrderLine
  onCancel: () => void
  onConfirm: () => void
}

export function RemoveOrderLineModal({ isBusy, line, onCancel, onConfirm }: Props) {
  const served = line.servedQuantity > 0

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-4">
      <section aria-labelledby="remove-order-line-title" aria-modal="true" className="w-full rounded-t-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)] sm:max-w-md sm:rounded-[var(--radius)]" role="dialog">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold" id="remove-order-line-title">Eliminar producto</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">Se eliminará {line.quantity}x {line.productName} de la comanda.</p>
          </div>
          <Button aria-label="Cerrar" disabled={isBusy} onClick={onCancel} size="sm" type="button" variant="tertiary"><X className="h-4 w-4" /></Button>
        </div>

        {served ? <p className="mt-4 rounded-[var(--radius)] border border-[var(--warning)] bg-[var(--warning-soft)] p-3 text-sm font-semibold text-[var(--warning)]">Este producto ya está marcado como servido. Confirma que quieres eliminarlo igualmente.</p> : null}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button disabled={isBusy} onClick={onCancel} type="button" variant="secondary">Cancelar</Button>
          <Button disabled={isBusy} onClick={onConfirm} type="button" variant="danger"><Trash2 className="h-4 w-4" /> Eliminar</Button>
        </div>
      </section>
    </div>
  )
}
