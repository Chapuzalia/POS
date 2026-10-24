import { Check } from 'lucide-react'
import { Button } from '../../../components/ui'
import { formatMoney, formatQuantity, quantityAmountCents } from '../../../lib/format'
import type { TicketLineComponent } from '../../../types'
import type { ProductionEntry, ProductionSelection } from '../../production/types'
import { getMenuCourseService } from '../menu-service-model'
import type { RestaurantOrderLine } from '../types'

type Props = {
  component: TicketLineComponent
  entry?: ProductionEntry
  line: RestaurantOrderLine
  disabled: boolean
  productionEnabled: boolean
  onEdit: (line: RestaurantOrderLine) => void
  onSend?: (selection: ProductionSelection[]) => void
  onServe?: (lineId: string, componentId: string, quantity: number) => void
}

export function MenuCourseRow({ component, entry, line, disabled, productionEnabled, onEdit, onSend, onServe }: Props) {
  const service = getMenuCourseService(line, entry, productionEnabled)
  const quantity = line.quantity * component.quantity
  const supplement = quantityAmountCents(component.priceDeltaCents + (component.modifiers ?? []).reduce((sum, modifier) => sum + modifier.priceCents, 0), quantity)
  return <div className="flex items-center gap-3 py-3" data-menu-course={component.id}>
    <button aria-label={`Editar ${component.selectionGroupName}: ${component.productName}`} className="min-h-11 min-w-0 flex-1 cursor-pointer text-left disabled:cursor-default"
      disabled={disabled} onClick={() => onEdit(line)} type="button">
      <span className="block text-xs font-medium text-[var(--muted)]">{component.selectionGroupName}</span>
      <span className="block text-sm font-bold leading-5 text-[var(--foreground)]">{quantity !== 1 ? `${formatQuantity(quantity)}× ` : ''}{component.productName}
        {supplement !== 0 ? <span className="ml-2 whitespace-nowrap text-xs font-medium text-[var(--muted)]">{supplement > 0 ? '+' : ''}{formatMoney(supplement)}</span> : null}
      </span>
      {(component.modifiers ?? []).length ? <span className="block text-xs font-semibold text-[var(--foreground)]">{component.modifiers?.map((modifier) => modifier.name).join(' · ')}</span> : null}
      {service.status && service.pending > 0 ? <span className={`block text-xs ${service.ready > 0 ? 'font-bold text-[var(--success)]' : 'text-[var(--muted)]'}`}>{service.status}</span> : null}
      {line.quantity > 1 && service.served > 0 && service.pending > 0 ? <span className="block text-xs text-[var(--muted)]">{formatQuantity(service.served * component.quantity)} servido · {formatQuantity(service.pending * component.quantity)} pendiente</span> : null}
    </button>
    {service.pending === 0 ? <span aria-label="Servido" className="flex min-h-11 min-w-11 items-center justify-center text-[var(--success)]"><Check aria-hidden="true" className="h-5 w-5" /></span>
      : service.action === 'send' && entry && onSend ? <Button aria-label={`Enviar ${component.productName}`} className="!min-h-11 shrink-0 !rounded-[10px] !px-3 text-sm font-bold" disabled={disabled}
        onClick={() => onSend([{ lineId: line.id, componentId: component.id, quantity: service.unsent, passId: entry.passId, passName: entry.passName }])} size="sm" type="button" variant="primary">Enviar</Button>
      : onServe ? <Button aria-label={`Servir ${component.productName}`} className="!min-h-11 shrink-0 !rounded-[10px] !px-3 text-sm font-bold" disabled={disabled}
        onClick={() => onServe(line.id, component.id, service.served + service.serveQuantity)} size="sm" type="button" variant="secondary">Servir{quantity > 1 ? ` ${formatQuantity(service.serveQuantity * component.quantity)}` : ''}</Button> : null}
  </div>
}
