import { Check, Pencil, Send } from 'lucide-react'
import { Button } from '../../../components/ui'
import { NativeSelect } from '../../../components/ui/NativeSelect'
import { formatQuantity } from '../../../lib/format'
import type { ProductionEntry, ProductionRouting, ProductionSelection } from '../../production/types'
import type { RestaurantOrderLine } from '../types'

type Props = {
  entry: ProductionEntry
  line: RestaurantOrderLine
  disabled: boolean
  routing?: ProductionRouting
  onEdit: (line: RestaurantOrderLine) => void
  onSend?: (selection: ProductionSelection[]) => void
  onServe?: (lineId: string, componentId: string, quantity: number) => void
  onChangePass?: (input: { lineId: string; componentId: string; passId: string }) => void
}

export function MenuCourseRow({ entry, line, disabled, routing, onEdit, onSend, onServe, onChangePass }: Props) {
  const componentId = entry.componentId
  const component = line.components.find((candidate) => candidate.id === componentId)
  if (!component || !componentId) return null
  const served = entry.servedQuantity ?? line.servedQuantity
  const pending = Math.max(0, line.quantity - served)
  const sent = Math.max(0, pending - entry.unsentQuantity - entry.readyQuantity - (entry.preparingQuantity ?? 0))
  const status = pending === 0 ? 'Servido' : [
    entry.unsentQuantity > 0 ? `${formatQuantity(entry.unsentQuantity * component.quantity)} sin enviar` : '',
    sent > 0 ? `${formatQuantity(sent * component.quantity)} enviado` : '',
    (entry.preparingQuantity ?? 0) > 0 ? `${formatQuantity((entry.preparingQuantity ?? 0) * component.quantity)} en preparación` : '',
    entry.readyQuantity > 0 ? `${formatQuantity(entry.readyQuantity * component.quantity)} listo para servir` : '',
  ].filter(Boolean).join(' · ')
  return <article className="space-y-2 rounded-[16px] border border-[var(--separator)] bg-[var(--background)] p-3">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="font-bold">{formatQuantity(line.quantity * component.quantity)}× {component.productName}</p>
        <p className="text-xs font-semibold text-[var(--muted)]">{line.productName} · {component.selectionGroupName} · {component.priceDeltaCents === 0 ? 'Incluido' : 'Con suplemento'}</p>
        {(component.modifiers ?? []).length ? <p className="text-sm text-[var(--muted)]">{component.modifiers?.map((modifier) => modifier.name).join(', ')}</p> : null}
        <p className={`text-xs font-bold ${pending === 0 ? 'text-[var(--success)]' : 'text-[var(--muted)]'}`}>{status}</p>
      </div>
      <Button aria-label={`Cambiar ${component.productName} del menú`} disabled={disabled} onClick={() => onEdit(line)} size="sm" type="button" variant="tertiary"><Pencil className="h-4 w-4" /></Button>
    </div>
    {entry.sentQuantity === 0 && pending > 0 && routing && onChangePass ? <NativeSelect aria-label={`Pase de ${component.productName}`} disabled={disabled} value={entry.passId}
      onChange={(event) => onChangePass({ lineId: line.id, componentId, passId: event.target.value })} triggerClassName="min-h-10">
      {routing.passes.map((pass) => <option key={pass.id} value={pass.id}>{pass.name}</option>)}
    </NativeSelect> : null}
    <div className="flex flex-wrap gap-2">
      {entry.unsentQuantity > 0 && entry.hasProductionDestination && onSend ? <Button disabled={disabled} size="sm" type="button" variant="secondary"
        onClick={() => onSend([{ lineId: line.id, componentId, quantity: entry.unsentQuantity, passId: entry.passId, passName: entry.passName }])}><Send className="h-4 w-4" /> Enviar plato</Button> : null}
      {pending > 0 && onServe ? <Button disabled={disabled} size="sm" type="button" variant="secondary"
        onClick={() => onServe(line.id, componentId, served + Math.min(1, pending))}><Check className="h-4 w-4" /> Servir {formatQuantity(Math.min(1, pending) * component.quantity)}</Button> : null}
    </div>
  </article>
}
