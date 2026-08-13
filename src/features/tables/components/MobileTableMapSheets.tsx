import { ArrowRight, Unlink, Users } from 'lucide-react'
import type { ReactNode } from 'react'

import { AppModal } from '../../../components/ui/AppModal'
import { Button as UiButton } from '../../../components/ui/Button'
import { Chip } from '../../../components/ui'
import { formatMoney } from '../../../lib/format'
import type { RestaurantTableMapItem } from '../types'

function statusLabel(status: RestaurantTableMapItem['status']) {
  return status === 'free' ? 'Libre' : status === 'reserved' ? 'Reservada' : 'Ocupada'
}

function SheetSurface({ children }: { children: ReactNode }) {
  return (
    <section className="w-full rounded-t-[20px] bg-[var(--surface)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 text-[var(--foreground)]">
      <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--separator)]" />
      {children}
    </section>
  )
}

type TableSheetProps = {
  canOpen: boolean
  isBusy: boolean
  isOnline: boolean
  onClose: () => void
  onPrimaryAction: () => void
  table: RestaurantTableMapItem
}

export function MobileTableActionSheet({ canOpen, isBusy, isOnline, onClose, onPrimaryAction, table }: TableSheetProps) {
  const hasPrimaryAction = (table.status === 'occupied' && Boolean(table.orderId)) || (table.status === 'free' && canOpen)
  const tone = table.status === 'free' ? 'success' : table.status === 'occupied' ? 'danger' : 'warning'

  return (
    <AppModal
      containerClassName="!p-0"
      dialogClassName="!rounded-b-none !rounded-t-[20px] !border-x-0 !border-b-0"
      label={`Acciones de ${table.name}`}
      maxWidth={560}
      onClose={onClose}
      placement="bottom"
    >
      <SheetSurface>
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-xl font-black">{table.name}</h2>
            <div className="mt-2"><Chip tone={tone}>{statusLabel(table.status)}</Chip></div>
          </div>
          {table.status === 'occupied' ? <strong className="text-lg">{formatMoney(table.totalCents)}</strong> : null}
        </header>
        <div className="mt-4 flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--muted)]">
          <Users className="size-[18px]" />
          <span>{table.capacity} {table.capacity === 1 ? 'plaza' : 'plazas'}</span>
        </div>
        {hasPrimaryAction ? (
          <UiButton
            className="mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)]"
            disabled={isBusy || !isOnline}
            onClick={onPrimaryAction}
            type="button"
          >
            {table.status === 'occupied' ? 'Abrir comanda' : 'Abrir mesa'} <ArrowRight className="size-[18px]" />
          </UiButton>
        ) : null}
      </SheetSurface>
    </AppModal>
  )
}

type GroupSheetProps = {
  locked: boolean
  onClose: () => void
  onSeparateAll: () => void
  onSeparateOne: () => void
  tableName: string
}

export function MobileGroupActionsSheet({ locked, onClose, onSeparateAll, onSeparateOne, tableName }: GroupSheetProps) {
  return (
    <AppModal
      containerClassName="!p-0"
      dialogClassName="!rounded-b-none !rounded-t-[20px] !border-x-0 !border-b-0"
      label={`Editar grupo de ${tableName}`}
      maxWidth={560}
      onClose={onClose}
      placement="bottom"
    >
      <SheetSurface>
        <h2 className="m-0 text-xl font-black">{tableName}</h2>
        {locked ? <p className="mt-2 text-sm leading-5 text-[var(--muted)]">La comanda está abierta. Cobra o cancela la comanda antes de separar las mesas.</p> : null}
        <div className="mt-4 grid gap-2">
          <UiButton className="inline-flex min-h-12 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-bold" disabled={locked} onClick={onSeparateOne} type="button">
            <Unlink className="size-[18px]" /> Separar esta mesa
          </UiButton>
          <UiButton className="inline-flex min-h-12 items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-bold" disabled={locked} onClick={onSeparateAll} type="button">
            <Unlink className="size-[18px]" /> Separar todas las mesas
          </UiButton>
        </div>
      </SheetSurface>
    </AppModal>
  )
}
