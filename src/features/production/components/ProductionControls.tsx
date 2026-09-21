import { Minus, Plus, Send } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { AppModal, Button } from '../../../components/ui'
import { formatQuantity } from '../../../lib/format'
import type { RestaurantOrderDetail } from '../../tables/types'
import type { OrderProductionState, ProductionSelection } from '../types'

type Props = {
  disabled: boolean
  order: RestaurantOrderDetail
  state: OrderProductionState
  onSend: (selection?: ProductionSelection[]) => void
}

export function ProductionControls({ disabled, onSend, order, state }: Props) {
  const available = useMemo(() => state.entries.map((entry) => {
    const line = order.lines.find((candidate) => candidate.id === entry.lineId)
    const productionLine = state.lines.find((candidate) => candidate.lineId === entry.lineId)
    return { ...entry, unsentQuantity: Math.max(0, entry.unsentQuantity - (line?.servedQuantity ?? 0)), hasProductionDestination: Boolean(productionLine?.hasProductionDestination && entry.hasProductionDestination) }
  }).filter((entry) => {
    const productionLine = state.lines.find((candidate) => candidate.lineId === entry.lineId)
    return productionLine?.hasProductionDestination && productionLine.unsentQuantity > 0 && entry.hasProductionDestination && entry.unsentQuantity > 0
  }), [order.lines, state.entries, state.lines])
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [open, setOpen] = useState(false)
  const keyFor = (lineId: string, componentId: string | null) => `${lineId}:${componentId ?? ''}`

  useEffect(() => {
    setSelected((current) => Object.fromEntries(available.map((entry) => {
      const key = keyFor(entry.lineId, entry.componentId)
      return [key, Math.min(current[key] ?? entry.unsentQuantity, entry.unsentQuantity)]
    })))
  }, [available])

  const selection = available.map((entry) => ({
    lineId: entry.lineId,
    componentId: entry.componentId,
    quantity: selected[keyFor(entry.lineId, entry.componentId)] ?? 0,
    passId: entry.passId,
    passName: entry.passName,
  })).filter((entry) => entry.quantity > 0)
  const selectedUnits = selection.reduce((sum, entry) => sum + entry.quantity, 0)
  if (!state.effective || available.length === 0) return null

  const change = (lineId: string, componentId: string | null, maximum: number, direction: 1 | -1) => {
    const key = keyFor(lineId, componentId)
    setSelected((current) => ({ ...current, [key]: Math.max(0, Math.min(maximum, Math.round(((current[key] ?? maximum) + direction) * 1000) / 1000)) }))
  }

  return <>
    <Button disabled={disabled} fullWidth onClick={() => setOpen(true)} size="lg" type="button" variant="secondary"><Send className="h-5 w-5" /> Selección manual</Button>
    {open ? <AppModal dismissDisabled={disabled} label="Enviar selección a producción" maxWidth={520} onClose={() => setOpen(false)} placement="bottom">
      <section className="w-full space-y-4 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]">
        <div><h2 className="text-xl font-black">Enviar selección</h2><p className="text-sm font-semibold text-[var(--muted)]">Selecciona cantidades. El servidor vuelve a validar las unidades sin enviar.</p></div>
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {available.map((entry) => {
            const key = keyFor(entry.lineId, entry.componentId)
            return <div className="flex items-center justify-between gap-2" key={key}>
              <span className="min-w-0 flex-1 truncate text-sm font-bold">{entry.productName}{entry.parentProductName ? ` · ${entry.parentProductName}` : ''} · {formatQuantity(entry.unsentQuantity)} sin enviar</span>
              <div className="flex items-center gap-1">
                <Button aria-label="Quitar una unidad del envío" disabled={disabled || (selected[key] ?? 0) === 0} onClick={() => change(entry.lineId, entry.componentId, entry.unsentQuantity, -1)} size="sm" type="button" variant="tertiary"><Minus className="h-4 w-4" /></Button>
                <strong className="min-w-6 text-center font-mono">{formatQuantity(selected[key] ?? 0)}</strong>
                <Button aria-label="Añadir una unidad al envío" disabled={disabled || (selected[key] ?? 0) >= entry.unsentQuantity} onClick={() => change(entry.lineId, entry.componentId, entry.unsentQuantity, 1)} size="sm" type="button" variant="tertiary"><Plus className="h-4 w-4" /></Button>
              </div>
            </div>
          })}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button disabled={disabled} onClick={() => setOpen(false)} size="lg" type="button" variant="secondary">Cancelar</Button>
          <Button disabled={disabled || selectedUnits === 0} onClick={() => { setOpen(false); onSend(selection) }} size="lg" type="button" variant="primary"><Send className="h-4 w-4" /> Enviar {formatQuantity(selectedUnits)}</Button>
        </div>
      </section>
    </AppModal> : null}
  </>
}
