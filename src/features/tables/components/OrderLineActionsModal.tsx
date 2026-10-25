import { ArrowRightLeft, ChevronRight, MessageSquare, X } from 'lucide-react'
import { useState } from 'react'
import { AppModal, Button, TextArea } from '../../../components/ui'
import { NativeSelect } from '../../../components/ui/NativeSelect'
import type { ProductionEntry, ProductionRouting } from '../../production/types'
import type { RestaurantOrderLine } from '../types'
import { isMenuOrderLine } from '../menu-service-model'

type Props = {
  line: RestaurantOrderLine
  label?: string
  entries: ProductionEntry[]
  routing?: ProductionRouting
  disabled: boolean
  initialMode?: 'actions' | 'note'
  onClose: () => void
  onSetNote?: (lineId: string, note: string) => Promise<boolean>
  onChangePass?: (input: { lineId: string; componentId?: string | null; passId: string }) => void
}

export function OrderLineActionsModal({ line, label = line.productName, entries, routing, disabled, initialMode = 'actions', onClose, onSetNote, onChangePass }: Props) {
  const [mode, setMode] = useState<'actions' | 'pass' | 'note'>(initialMode)
  const [note, setNote] = useState(line.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocked = disabled || saving
  const editableEntries = entries.filter((entry) => entry.lineId === line.id && entry.unsentQuantity > 0 && entry.sentQuantity === 0)
  const canChangePass = Boolean(onChangePass && routing && routing.passes.length > 1 && editableEntries.length)
  const title = mode === 'note' ? 'Comentario para cocina' : mode === 'pass' ? 'Cambiar pase' : label

  async function save() {
    if (!onSetNote || blocked) return
    setSaving(true)
    setError(null)
    try {
      if (await onSetNote(line.id, note)) onClose()
      else setError('No se ha guardado el comentario. Revisa la conexión e inténtalo de nuevo.')
    } catch {
      setError('No se ha guardado el comentario. Inténtalo de nuevo.')
    } finally {
      setSaving(false)
    }
  }

  return <AppModal dismissDisabled={blocked} label={title} maxWidth={440} onClose={onClose} placement="center" scroll="content">
    <section className="flex max-h-[inherit] min-h-0 flex-col overflow-hidden bg-[var(--surface)] text-[var(--foreground)]">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--separator)] p-5">
        <div className="min-w-0"><h2 className="text-lg font-bold leading-6">{title}</h2>
          {mode !== 'actions' ? <p className="mt-1 text-sm text-[var(--muted)]">{label}</p> : null}</div>
        <Button aria-label="Cerrar opciones del producto" className="!size-11 !min-h-11 !min-w-11 shrink-0 border border-[var(--separator)] !p-0" disabled={blocked} onClick={onClose} type="button" variant="tertiary"><X aria-hidden="true" className="h-4 w-4" /></Button>
      </header>
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-5">
        {mode === 'actions' ? <>
          {onChangePass ? <Button className="!min-h-14 justify-between border border-[var(--separator)] !px-4 !text-[var(--foreground)]" disabled={blocked || !canChangePass} fullWidth onClick={() => setMode('pass')} type="button" variant="tertiary">
            <span className="flex items-center gap-3"><ArrowRightLeft aria-hidden="true" className="h-5 w-5" />Cambiar pase</span><ChevronRight aria-hidden="true" className="h-4 w-4" />
          </Button> : null}
          {onChangePass && !canChangePass ? <p className="text-xs text-[var(--muted)]">Solo se puede cambiar el pase de los platos que aún no se han enviado y si hay otros pases disponibles.</p> : null}
          {onSetNote ? <Button className="!min-h-14 justify-between border border-[var(--separator)] !px-4 !text-[var(--foreground)]" disabled={blocked} fullWidth onClick={() => setMode('note')} type="button" variant="tertiary">
            <span className="flex items-center gap-3"><MessageSquare aria-hidden="true" className="h-5 w-5" />{line.note ? 'Editar comentario' : 'Añadir comentario'}</span><ChevronRight aria-hidden="true" className="h-4 w-4" />
          </Button> : null}
        </> : null}
        {mode === 'pass' && routing ? <>
          <p className="text-sm text-[var(--muted)]">Elige el pase antes de enviar a cocina.</p>
          {editableEntries.map((entry) => <label className="block space-y-2" key={entry.componentId ?? entry.lineId}>
            <span className="text-sm font-semibold">{entry.productName}</span>
            <NativeSelect aria-label={`Pase de ${entry.productName}`} disabled={blocked} value={entry.passId} onChange={(event) => {
              if (event.target.value !== entry.passId) onChangePass?.({ lineId: line.id, componentId: entry.componentId, passId: event.target.value })
            }}>{routing.passes.map((pass) => <option key={pass.id} value={pass.id}>{pass.name}</option>)}</NativeSelect>
          </label>)}
        </> : null}
        {mode === 'note' ? <>
          <p className="text-sm text-[var(--muted)]">{isMenuOrderLine(line) ? 'Este comentario se aplica a todo el menú.' : 'Indicaciones para preparar este producto.'}</p>
          <label className="block space-y-2"><span className="text-sm font-semibold">Comentario</span>
            <TextArea aria-label="Comentario para cocina" className="min-h-32 w-full text-base" disabled={blocked} onChange={(event) => setNote(event.target.value)} placeholder="Ej. Sin sal, salsa aparte…" rows={4} value={note} />
          </label>
          <p className="text-xs text-[var(--muted)]">Para quitarlo, borra el texto y guarda.</p>
          {error ? <p className="text-sm font-semibold text-[var(--danger)]" role="alert">{error}</p> : null}
        </> : null}
      </div>
      {mode !== 'actions' ? <footer className="flex shrink-0 justify-end gap-3 border-t border-[var(--separator)] bg-[var(--background)] px-5 py-4">
        <Button className="!min-h-11 !px-4" disabled={blocked} onClick={onClose} type="button" variant="tertiary">{mode === 'note' ? 'Cancelar' : 'Cerrar'}</Button>
        {mode === 'note' ? <Button className="!min-h-11 !px-4" disabled={blocked} onClick={() => void save()} type="button" variant="primary">{saving ? 'Guardando…' : 'Guardar comentario'}</Button> : null}
      </footer> : null}
    </section>
  </AppModal>
}
