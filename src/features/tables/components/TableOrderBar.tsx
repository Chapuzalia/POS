import { ArrowLeft, ArrowRightLeft, Scissors } from 'lucide-react'
import type { RestaurantOrderDetail } from '../types'
import type { RestaurantOrderSaveState } from '../types'

type Props = {
  isBusy: boolean
  isOnline: boolean
  order: RestaurantOrderDetail | null
  quickSale: boolean
  onBack: () => void
  onMove: () => void
  saveState: RestaurantOrderSaveState
}

const saveLabels: Record<RestaurantOrderSaveState, string> = {
  dirty: 'Cambios pendientes',
  error: 'Error al guardar',
  saved: 'Guardado',
  saving: 'Guardando...',
}

export function TableOrderBar({ isBusy, isOnline, onBack, onMove, order, quickSale, saveState }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] items-center gap-3 px-4 pt-3">
      <button className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-bold" onClick={onBack} type="button"><ArrowLeft size={17} /> Volver al mapa</button>
      {order ? <>
        <div className="min-w-0 flex-1"><strong className="block truncate">{order.tables.map((table) => table.name).join(' + ')}</strong><span className="text-sm text-[var(--muted)]">Caja: {order.cashRegisterName} - {order.order.guestCount} comensales - {saveLabels[saveState]}</span></div>
        <button className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-bold" disabled={!isOnline || isBusy} onClick={onMove} type="button"><ArrowRightLeft size={17} /> Mover comanda</button>
        <button className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface-secondary)] px-4 font-bold" disabled title="Disponible en un bloque posterior" type="button"><Scissors size={17} /> Dividir cuenta</button>
      </> : quickSale ? <div className="text-sm font-semibold text-[var(--muted)]">Venta rapida - sin mesa ni comanda</div> : null}
    </div>
  )
}
