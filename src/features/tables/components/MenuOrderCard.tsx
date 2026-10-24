import { Check, ChevronDown, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../../components/ui'
import { formatMoney, formatQuantity, quantityAmountCents } from '../../../lib/format'
import type { LineDiscountAllocation } from '../../../lib/discounts'
import type { CatalogData } from '../../catalog/domain/types'
import type { ProductionEntry, ProductionRouting, ProductionSelection } from '../../production/types'
import { getMenuCourseGroups, isMenuServiceComplete } from '../menu-service-model'
import type { RestaurantOrderLine } from '../types'
import { MenuCourseRow } from './MenuCourseRow'
import { MenuDetailsModal } from './MenuDetailsModal'
import { useOrderLineLongPress } from '../hooks/useOrderLineLongPress'

type Props = {
  line: RestaurantOrderLine
  number: number
  entries: ProductionEntry[]
  catalog?: CatalogData | null
  routing?: ProductionRouting
  productionEnabled: boolean
  disabled: boolean
  discount?: LineDiscountAllocation
  onEdit: (line: RestaurantOrderLine) => void
  onSend?: (selection: ProductionSelection[]) => void
  onServe?: (lineId: string, componentId: string, quantity: number) => void
  onChangePass?: (input: { lineId: string; componentId?: string | null; passId: string }) => void
  onIncrement: (lineId: string) => void
  onDecrement: (lineId: string) => void
  onRemove: (lineId: string) => void
  onOpenQuantity: () => void
  onOpenPrice: () => void
  onOpenActions?: () => void
  onComment?: () => void
}

export function MenuOrderCard({ line, number, entries, catalog, routing, productionEnabled, disabled, discount,
  onEdit, onSend, onServe, onChangePass, onIncrement, onDecrement, onRemove, onOpenQuantity, onOpenPrice, onOpenActions, onComment }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const groups = getMenuCourseGroups(line, catalog)
  const missingChoices = groups.filter((group) => group.remaining > 0)
  const completed = isMenuServiceComplete(line, entries, missingChoices.length)
  const label = `${line.productName} · ${number}`
  const total = discount?.netCents ?? quantityAmountCents(line.unitPriceCents, line.quantity)
  const longPress = useOrderLineLongPress(disabled || !onOpenActions, () => onOpenActions?.())

  return <article {...longPress} tabIndex={!disabled && onOpenActions ? 0 : undefined} aria-label={label} className="touch-pan-y select-none rounded-[14px] border border-[var(--separator)] bg-[var(--surface)] px-3.5 [-webkit-touch-callout:none]" data-menu-id={line.id}>
    <div className="flex min-h-16 items-center gap-2 py-2">
      {completed ? <Check aria-label="Menú completado" className="h-4 w-4 shrink-0 text-[var(--success)]" /> : null}
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-extrabold leading-5">{label}</h3>
        {line.quantity !== 1 ? <span className="text-xs text-[var(--muted)]">{formatQuantity(line.quantity)} menús</span> : null}
        {completed ? <button aria-expanded={expanded} aria-label={`${expanded ? 'Ocultar' : 'Ver'} platos de ${label}`} className="flex min-h-11 cursor-pointer items-center gap-1 text-xs font-semibold text-[var(--muted)]"
          onClick={() => setExpanded((current) => !current)} type="button">{expanded ? 'Ocultar platos' : 'Ver platos'}<ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 ${expanded ? 'rotate-180' : ''}`} /></button> : null}
      </div>
      <strong className="shrink-0 whitespace-nowrap font-mono text-sm tabular-nums">{formatMoney(total)}</strong>
      <Button aria-label={`Detalles de ${label}`} className="!min-h-11 !min-w-11 !rounded-[10px] !p-0" disabled={disabled} onClick={() => setDetailsOpen(true)} size="sm" type="button" variant="tertiary"><MoreHorizontal className="h-5 w-5" /></Button>
    </div>
    {!completed || expanded ? <div className="divide-y divide-[var(--separator)] border-t border-[var(--separator)]">
      {groups.flatMap((group) => [
        ...group.components.map((component) => <MenuCourseRow key={component.id} component={component} entry={entries.find((entry) => entry.componentId === component.id)} line={line}
          disabled={disabled} productionEnabled={productionEnabled} onEdit={onEdit} onSend={onSend} onServe={onServe} />),
        group.remaining > 0 ? <div className="flex items-center gap-3 py-3" key={`pending:${group.id}`}>
        <div className="min-w-0 flex-1"><p className="text-xs font-medium text-[var(--muted)]">{group.name}</p><p className="text-sm font-semibold text-[var(--muted)]">Pendiente de elegir{group.remaining > 1 ? ` · ${group.remaining}` : ''}</p></div>
        <Button aria-label={`Elegir ${group.name} de ${label}`} className="!min-h-11 !rounded-[10px] !px-3 text-sm font-bold" disabled={disabled} onClick={() => onEdit(line)} size="sm" type="button" variant="secondary">Elegir</Button>
      </div> : null])}
      {!line.components.length && !missingChoices.length ? <Button className="my-2 !min-h-11" disabled={disabled} onClick={() => onEdit(line)} type="button" variant="secondary">Elegir platos</Button> : null}
      {line.note || line.modifiers.length ? <p className="whitespace-pre-wrap break-words py-3 text-xs font-semibold text-[var(--foreground)]">{[...line.modifiers.map((modifier) => modifier.name), line.note].filter(Boolean).join(' · ')}</p> : null}
    </div> : null}
    {detailsOpen ? <MenuDetailsModal label={label} line={line} entries={entries} routing={routing} productionEnabled={productionEnabled} disabled={disabled} discount={discount}
      onClose={() => setDetailsOpen(false)} onEdit={onEdit} onIncrement={onIncrement} onDecrement={onDecrement} onRemove={onRemove}
      onOpenQuantity={onOpenQuantity} onOpenPrice={onOpenPrice} onServe={onServe} onChangePass={onChangePass} onComment={onComment} /> : null}
  </article>
}
