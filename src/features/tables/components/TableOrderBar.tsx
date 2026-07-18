import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRightLeft, ChevronDown, CircleX, ListChecks, Scissors, UsersRound } from 'lucide-react'
import type { RestaurantOrderDetail } from '../types'
import type { RestaurantOrderSaveState } from '../types'

type Props = {
  isBusy: boolean
  isOnline: boolean
  order: RestaurantOrderDetail | null
  quickSale: boolean
  onBack: () => void
  onCancelEmpty: () => void
  onMove: () => void
  onSplitItems: () => void
  onSplitEqual: () => void
  saveState: RestaurantOrderSaveState
  canSell: boolean
}

const saveLabels: Record<RestaurantOrderSaveState, string> = {
  dirty: 'Cambios pendientes',
  error: 'Error al guardar',
  saved: 'Guardado',
  saving: 'Guardando...',
}

export function TableOrderBar({ isBusy, isOnline, onBack, onCancelEmpty, onMove, onSplitItems, onSplitEqual, order, quickSale, saveState, canSell }: Props) {
  const [splitMenuOpen, setSplitMenuOpen] = useState(false)
  const splitMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!splitMenuOpen) return
    const close = (event: MouseEvent) => {
      if (!splitMenuRef.current?.contains(event.target as Node)) setSplitMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSplitMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [splitMenuOpen])

  const chooseSplit = (action: () => void) => {
    setSplitMenuOpen(false)
    action()
  }

  return (
    <div className="mx-auto flex w-full max-w-[1600px] items-center gap-3 px-4 pt-3 justify-between">
      <div className="flex items-center gap-2">
        <button className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-bold" onClick={onBack} type="button"><ArrowLeft size={17} /><p className="truncate max-lg:hidden">Volver al mapa</p></button>
        {order?.lines.length === 0 ? <button aria-label="Cerrar mesa vacía" className="inline-flex min-h-9 items-center gap-2 rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-soft)] px-3 text-sm font-bold text-[var(--danger)]" disabled={!isOnline || isBusy} onClick={onCancelEmpty} title="Cerrar mesa vacía" type="button"><CircleX size={16} /><span className="max-lg:hidden">Cerrar mesa</span></button> : null}
      </div>
      {order ? <>
        <div className="min-w-0 flex flex-col items-center"><strong className="block truncate">{order.tables.map((table) => table.name).join(' + ')}</strong><span className="text-sm text-[var(--muted)]">{order.order.guestCount} comensales · {saveLabels[saveState]}</span></div>
        <div className="flex flex-row gap-2">
          <button className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-bold" disabled={!isOnline || isBusy} onClick={onMove} type="button"><ArrowRightLeft size={17} /><p className="truncate max-lg:hidden">Mover comanda</p></button>
          {canSell ? <div className="relative" ref={splitMenuRef}>
            <button aria-expanded={splitMenuOpen} aria-haspopup="menu" className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-bold" disabled={!isOnline || isBusy} onClick={() => setSplitMenuOpen((open) => !open)} type="button"><Scissors size={17} /><p className="truncate max-lg:hidden">Dividir comanda</p><ChevronDown className={splitMenuOpen ? 'rotate-180 transition-transform' : 'transition-transform'} size={16} /></button>
            {splitMenuOpen ? <div className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-72 overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface-elevated,var(--surface))] p-1.5 shadow-2xl" role="menu">
              <button className="flex min-h-14 w-full items-center gap-3 rounded-[calc(var(--radius)-4px)] px-3 text-left hover:bg-[var(--accent-soft)]" onClick={() => chooseSplit(onSplitItems)} role="menuitem" type="button"><ListChecks className="shrink-0 text-[var(--accent)]" size={20} /><span><strong className="block">Por ítems</strong><small className="text-[var(--muted)]">Elige productos y cantidades</small></span></button>
              <button className="flex min-h-14 w-full items-center gap-3 rounded-[calc(var(--radius)-4px)] px-3 text-left hover:bg-[var(--accent-soft)]" onClick={() => chooseSplit(onSplitEqual)} role="menuitem" type="button"><UsersRound className="shrink-0 text-[var(--accent)]" size={20} /><span><strong className="block">A partes iguales</strong><small className="text-[var(--muted)]">Divide el total entre comensales</small></span></button>
            </div> : null}
          </div> : null}
        </div>
      </> : quickSale ? <div className="text-sm font-semibold text-[var(--muted)]">Venta rapida - sin mesa ni comanda</div> : null}
    </div>
  )
}
