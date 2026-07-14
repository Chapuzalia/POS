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
  canSell: boolean
}

const saveLabels: Record<RestaurantOrderSaveState, string> = {
  dirty: 'Cambios pendientes',
  error: 'Error al guardar',
  saved: 'Guardado',
  saving: 'Guardando...',
}

export function TableOrderBar({ isBusy, isOnline, onBack, onMove, order, quickSale, saveState, canSell }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] items-center gap-3 px-4 pt-3 justify-between">
      <button className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-bold" onClick={onBack} type="button"><ArrowLeft size={17} /><p className="truncate max-lg:hidden">Volver al mapa</p></button>
      {order ? <>
        <div className="min-w-0 flex flex-col items-center"><strong className="block truncate">{order.tables.map((table) => table.name).join(' + ')}</strong><span className="text-sm text-[var(--muted)]">{order.order.guestCount} comensales · {saveLabels[saveState]}</span></div>
        <div className="flex flex-row gap-2">
          <button className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-bold" disabled={!isOnline || isBusy} onClick={onMove} type="button"><ArrowRightLeft size={17} /><p className="truncate max-lg:hidden">Mover comanda</p></button>
          {canSell ? <button className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-bold" disabled={!isOnline || isBusy} onClick={() => {}} type="button"><Scissors size={17} /><p className="truncate max-lg:hidden">Dividir comanda</p></button> : null}
        </div>
      </> : quickSale ? <div className="text-sm font-semibold text-[var(--muted)]">Venta rapida - sin mesa ni comanda</div> : null}
    </div>
  )
}
