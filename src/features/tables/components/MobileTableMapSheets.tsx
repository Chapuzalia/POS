import { Unlink } from 'lucide-react'
import type { ReactNode } from 'react'

import { AppModal } from '../../../components/ui/AppModal'
import { Button as UiButton } from '../../../components/ui/Button'

function SheetSurface({ children }: { children: ReactNode }) {
  return (
    <section className="w-full rounded-t-[20px] bg-[var(--surface)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 text-[var(--foreground)]">
      <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--separator)]" />
      {children}
    </section>
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
