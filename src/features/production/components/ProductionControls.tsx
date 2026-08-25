import { Minus, Plus, Send } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { AppModal, Button } from '../../../components/ui'
import type { RestaurantOrderDetail } from '../../tables/types'
import type { OrderProductionState, ProductionSelection } from '../types'

type Props = {
  disabled: boolean
  order: RestaurantOrderDetail
  state: OrderProductionState
  onSend: (selection?: ProductionSelection[]) => void
}

export function ProductionControls({ disabled, onSend, order, state }: Props) {
  const unsent = useMemo(() => new Map(state.lines.map((line) => [line.lineId, line.unsentQuantity])), [state.lines])
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setSelected((current) => Object.fromEntries(order.lines.map((line) => {
      const available = unsent.get(line.id) ?? 0
      return [line.id, Math.min(current[line.id] ?? available, available)]
    })))
  }, [order.lines, unsent])

  const availableLines = order.lines.filter((line) => (unsent.get(line.id) ?? 0) > 0)
  const selection = availableLines
    .map((line) => ({ lineId: line.id, quantity: selected[line.id] ?? 0 }))
    .filter((entry) => entry.quantity > 0)
  const selectedUnits = selection.reduce((sum, entry) => sum + entry.quantity, 0)
  if (!state.effective || availableLines.length === 0) return null

  const change = (lineId: string, direction: 1 | -1) => {
    const maximum = unsent.get(lineId) ?? 0
    setSelected((current) => ({
      ...current,
      [lineId]: Math.max(0, Math.min(maximum, (current[lineId] ?? maximum) + direction)),
    }))
  }

  const send = (value?: ProductionSelection[]) => { setOpen(false); onSend(value) }
  const totalAvailable = availableLines.reduce((sum, line) => sum + (unsent.get(line.id) ?? 0), 0)

  return <>
    <Button disabled={disabled} fullWidth onClick={() => setOpen(true)} size="lg" type="button" variant="primary"><Send className="h-5 w-5" /> Enviar a producción ({totalAvailable})</Button>
    {open ? <AppModal dismissDisabled={disabled} label="Enviar a producción" maxWidth={520} onClose={() => setOpen(false)} placement="bottom">
      <section className="w-full space-y-4 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]">
        <div><h2 className="text-xl font-black">Enviar a producción</h2><p className="text-sm font-semibold text-[var(--muted)]">Selecciona cantidades. El servidor vuelve a validar lo que sigue sin enviar.</p></div>
        <div className="max-h-72 space-y-2 overflow-y-auto">
      {availableLines.map((line) => <div className="flex items-center justify-between gap-2" key={line.id}>
        <span className="min-w-0 truncate text-sm font-bold">{line.productName} · {unsent.get(line.id)} sin enviar</span>
        <div className="flex items-center gap-1">
          <Button aria-label="Quitar una unidad del envío" disabled={disabled || (selected[line.id] ?? 0) === 0} onClick={() => change(line.id, -1)} size="sm" type="button" variant="tertiary"><Minus className="h-4 w-4" /></Button>
          <strong className="w-6 text-center font-mono">{selected[line.id] ?? 0}</strong>
          <Button aria-label="Añadir una unidad al envío" disabled={disabled || (selected[line.id] ?? 0) >= (unsent.get(line.id) ?? 0)} onClick={() => change(line.id, 1)} size="sm" type="button" variant="tertiary"><Plus className="h-4 w-4" /></Button>
        </div>
      </div>)}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button disabled={disabled} onClick={() => setOpen(false)} size="lg" type="button" variant="secondary">Cancelar</Button>
          <Button disabled={disabled || selectedUnits === 0} onClick={() => send(selection)} size="lg" type="button" variant="primary"><Send className="h-4 w-4" /> Enviar {selectedUnits}</Button>
        </div>
      </section>
    </AppModal> : null}
  </>
}
