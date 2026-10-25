import { ChevronDown, ChevronRight, Minus, Pencil, Plus, Trash2, X } from 'lucide-react'
import { AppModal, Button } from '../../../components/ui'
import { NativeSelect } from '../../../components/ui/NativeSelect'
import { formatMoney, formatQuantity } from '../../../lib/format'
import type { LineDiscountAllocation } from '../../../lib/discounts'
import type { ProductionEntry, ProductionRouting } from '../../production/types'
import { getMenuCourseService } from '../menu-service-model'
import type { RestaurantOrderLine } from '../types'

type Props = {
  label: string
  line: RestaurantOrderLine
  entries: ProductionEntry[]
  routing?: ProductionRouting
  productionEnabled: boolean
  disabled: boolean
  discount?: LineDiscountAllocation
  onClose: () => void
  onEdit: (line: RestaurantOrderLine) => void
  onIncrement: (lineId: string) => void
  onDecrement: (lineId: string) => void
  onRemove: (lineId: string) => void
  onOpenQuantity: () => void
  onOpenPrice: () => void
  onServe?: (lineId: string, componentId: string, quantity: number) => void
  onChangePass?: (input: { lineId: string; componentId?: string | null; passId: string }) => void
  onComment?: () => void
}

export function MenuDetailsModal({ label, line, entries, routing, productionEnabled, disabled, discount,
  onClose, onEdit, onIncrement, onDecrement, onRemove, onOpenQuantity, onOpenPrice, onServe, onChangePass, onComment }: Props) {
  const maxServed = Math.max(line.servedQuantity, ...entries.map((entry) => entry.servedQuantity ?? 0))
  const closeAndRun = (action: () => void) => { onClose(); action() }
  const kitchenActions = productionEnabled ? line.components.flatMap((component) => {
    const entry = entries.find((candidate) => candidate.componentId === component.id)
    const service = getMenuCourseService(line, entry, true)
    const canChangePass = Boolean(entry && entry.sentQuantity === 0 && service.pending > 0 && routing && routing.passes.length > 1 && onChangePass)
    const canServeWithoutSending = service.action === 'send' && Boolean(onServe)
    return canChangePass || canServeWithoutSending ? [{ component, entry, service, canChangePass, canServeWithoutSending }] : []
  }) : []

  return <AppModal dismissDisabled={disabled} label={`Detalles de ${label}`} maxWidth={480} onClose={onClose} placement="center" scroll="content">
    <section className="flex max-h-[inherit] min-h-0 w-full flex-col overflow-hidden bg-[var(--surface)] text-[var(--foreground)]">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--separator)] p-5">
        <h2 className="min-w-0 text-xl font-bold leading-6">{label}</h2>
        <Button aria-label="Cerrar detalles del menú" className="!size-11 !min-h-11 !min-w-11 shrink-0 border border-[var(--separator)] !bg-[var(--background)] !p-0"
          disabled={disabled} onClick={onClose} size="sm" type="button" variant="tertiary">
          <X aria-hidden="true" className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] p-5">
        <Button className="!min-h-14 justify-between !px-4 text-sm !font-bold" disabled={disabled} fullWidth
          onClick={() => closeAndRun(() => onEdit(line))} type="button" variant="primary">
          <span className="flex items-center gap-3"><Pencil aria-hidden="true" className="h-4 w-4 shrink-0" />Cambiar elecciones</span>
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0" />
        </Button>

        {onComment ? <Button className="!min-h-12 border border-[var(--separator)] !px-4 !text-[var(--foreground)]" disabled={disabled} fullWidth onClick={() => closeAndRun(onComment)} type="button" variant="tertiary">{line.note ? 'Editar comentario' : 'Añadir comentario'}</Button> : null}

        <div className="space-y-3">
          <div className="flex min-h-20 items-center justify-between gap-3 rounded-[12px] border border-[var(--separator)] bg-[var(--background)] p-3">
            <span className="text-sm font-semibold">Cantidad</span>
            <div className="flex shrink-0 items-center gap-1 rounded-[12px] border border-[var(--separator)] bg-[var(--surface)] p-1">
              <Button aria-label="Reducir cantidad del menú" className="!size-11 !min-h-11 !min-w-11 !bg-[var(--background)] !p-0"
                disabled={disabled || line.quantity <= maxServed} onClick={() => closeAndRun(() => onDecrement(line.id))} type="button" variant="tertiary">
                <Minus aria-hidden="true" className="h-4 w-4" />
              </Button>
              <button aria-label="Editar cantidad del menú" className="min-h-11 min-w-11 cursor-pointer rounded-[8px] font-mono text-lg font-bold tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-default"
                disabled={disabled} onClick={() => closeAndRun(onOpenQuantity)} type="button">{formatQuantity(line.quantity)}</button>
              <Button aria-label="Añadir otro menú" className="!size-11 !min-h-11 !min-w-11 !bg-[var(--background)] !p-0"
                disabled={disabled} onClick={() => closeAndRun(() => onIncrement(line.id))} type="button" variant="tertiary">
                <Plus aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <button aria-label="Editar precio unitario del menú" className="flex min-h-20 w-full cursor-pointer items-center justify-between gap-3 rounded-[12px] border border-[var(--separator)] bg-[var(--background)] p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-default disabled:opacity-50"
            disabled={disabled} onClick={() => closeAndRun(onOpenPrice)} type="button">
            <span className="text-sm font-semibold">Precio unitario</span>
            <span className="flex shrink-0 items-center gap-3"><strong className="whitespace-nowrap font-mono text-lg tabular-nums">{formatMoney(line.unitPriceCents)}</strong><Pencil aria-hidden="true" className="h-4 w-4 text-[var(--muted)]" /></span>
          </button>
          {discount && discount.discountAmountCents > 0 ? <p className="text-sm font-semibold text-[var(--success)]">Descuento aplicado: −{formatMoney(discount.discountAmountCents)}</p> : null}
        </div>

        {kitchenActions.length ? <details className="group rounded-[12px] border border-[var(--separator)]">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            Opciones de cocina<ChevronDown aria-hidden="true" className="h-4 w-4 text-[var(--muted)] group-open:rotate-180" />
          </summary>
          <div className="space-y-4 border-t border-[var(--separator)] p-4">
            {kitchenActions.map(({ component, entry, service, canChangePass, canServeWithoutSending }) => <div className="space-y-2" key={component.id}>
              <p className="text-sm font-bold">{component.productName}</p>
              {canChangePass && entry && routing && onChangePass ? <NativeSelect aria-label={`Pase de ${component.productName}`} disabled={disabled} value={entry.passId}
                onChange={(event) => onChangePass({ lineId: line.id, componentId: component.id, passId: event.target.value })}>
                {routing.passes.map((pass) => <option key={pass.id} value={pass.id}>{pass.name}</option>)}
              </NativeSelect> : null}
              {canServeWithoutSending && onServe ? <Button className="!min-h-11 border border-[var(--separator)] !bg-[var(--background)] !text-[var(--foreground)]" disabled={disabled}
                onClick={() => closeAndRun(() => onServe(line.id, component.id, service.served + service.serveQuantity))} type="button" variant="secondary">Servir sin enviar</Button> : null}
            </div>)}
          </div>
        </details> : null}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--separator)] bg-[var(--background)] px-5 py-4">
        <Button className="!min-h-11 !px-3 !text-[var(--danger)]" disabled={disabled} onClick={() => closeAndRun(() => onRemove(line.id))} type="button" variant="tertiary">
          <Trash2 aria-hidden="true" className="h-4 w-4" />Eliminar menú
        </Button>
        <Button className="!min-h-11 min-w-24 border border-[var(--separator)] !bg-[var(--surface)] !px-4 !font-semibold !text-[var(--foreground)]"
          disabled={disabled} onClick={onClose} type="button" variant="secondary">Cerrar</Button>
      </footer>
    </section>
  </AppModal>
}
