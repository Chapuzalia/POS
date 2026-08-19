import { Button as UiButton } from '../../../components/ui/Button'
import { Description, Dropdown, Label } from '@heroui/react'

import { ArrowLeft, ArrowRightLeft, ChevronDown, CircleX, ListChecks, Plus, Scissors, UsersRound } from 'lucide-react'
import type { RestaurantOrderDetail } from '../types'
import type { RestaurantOrderSaveState } from '../types'

type Props = {
  isBusy: boolean
  isOnline: boolean
  order: RestaurantOrderDetail | null
  quickSale: boolean
  canSaveQuickSale: boolean
  onBack: () => void
  onCancelEmpty: () => void
  onMove: () => void
  onSplitItems: () => void
  onSplitEqual: () => void
  onSaveQuickSale: () => void
  saveState: RestaurantOrderSaveState
  canSell: boolean
}

const saveLabels: Record<RestaurantOrderSaveState, string> = {
  dirty: 'Cambios pendientes',
  error: 'Error al guardar',
  saved: 'Guardado',
  saving: 'Guardando...',
}

export function TableOrderBar({ isBusy, isOnline, onBack, onCancelEmpty, onMove, onSaveQuickSale, onSplitItems, onSplitEqual, order, quickSale, saveState, canSell, canSaveQuickSale }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-3 px-4 pt-3">
      <div className="flex items-center gap-2">
        <UiButton className="inline-flex min-h-11 items-center gap-2 px-4 font-bold" onClick={onBack} type="button"><ArrowLeft size={17} /><p className="truncate max-lg:hidden">Volver al mapa</p></UiButton>
        {quickSale ? <UiButton
          aria-label="Guardar como mesa virtual"
          className="inline-flex size-11 min-h-11 min-w-11 items-center justify-center px-0 font-bold"
          disabled={!isOnline || isBusy || !canSaveQuickSale}
          onClick={onSaveQuickSale}
          title="Guardar como mesa virtual"
          type="button"
        ><Plus size={18} /></UiButton> : null}
        {order?.lines.length === 0 ? <UiButton aria-label="Cerrar mesa vacía" className="inline-flex min-h-9 items-center gap-2 px-3 text-sm font-bold text-[var(--danger)]" disabled={!isOnline || isBusy} onClick={onCancelEmpty} title="Cerrar mesa vacía" type="button" variant="dangerSoft"><CircleX size={16} /><span className="max-lg:hidden">Cerrar mesa</span></UiButton> : null}
      </div>
      {order ? <>
        <div className="flex min-w-0 flex-col items-center"><strong className="block truncate">{order.tables.map((table) => table.name).join(' + ')}</strong><span className="text-sm text-[var(--muted)]">{order.order.guestCount} comensales · {saveLabels[saveState]}</span></div>
        <div className="flex flex-row gap-2">
          <UiButton className="inline-flex min-h-11 items-center gap-2 px-4 font-bold" disabled={!isOnline || isBusy} onClick={onMove} type="button"><ArrowRightLeft size={17} /><p className="truncate max-lg:hidden">Mover comanda</p></UiButton>
          {canSell ? (
            <Dropdown>
              <Dropdown.Trigger className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] bg-[var(--surface-muted)] px-4 font-bold text-[var(--foreground)] transition-colors hover:bg-[var(--separator)] disabled:cursor-not-allowed disabled:opacity-50" isDisabled={!isOnline || isBusy}>
                  <Scissors size={17} /><p className="truncate max-lg:hidden">Dividir comanda</p><ChevronDown size={16} />
                </Dropdown.Trigger>
              <Dropdown.Popover className="!w-72" placement="bottom end">
                <Dropdown.Menu onAction={(key) => (String(key) === 'items' ? onSplitItems() : onSplitEqual())}>
                  <Dropdown.Item id="items" textValue="Por ítems">
                    <ListChecks className="shrink-0 text-[var(--accent)]" size={20} />
                    <span><Label>Por ítems</Label><Description>Elige productos y cantidades</Description></span>
                  </Dropdown.Item>
                  <Dropdown.Item id="equal" textValue="A partes iguales">
                    <UsersRound className="shrink-0 text-[var(--accent)]" size={20} />
                    <span><Label>A partes iguales</Label><Description>Divide el total entre comensales</Description></span>
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          ) : null}
        </div>
      </> : quickSale ? <div className="text-sm font-semibold text-[var(--muted)]">Venta rápida - sin mesa ni comanda</div> : null}
    </div>
  )
}
