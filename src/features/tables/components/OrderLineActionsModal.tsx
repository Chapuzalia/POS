import { Dropdown } from '@heroui/react'
import { ArrowRightLeft, ChevronRight, MessageSquare, Pencil, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AppModal, Button, TextArea } from '../../../components/ui'
import { NativeSelect } from '../../../components/ui/NativeSelect'
import type { ProductionEntry, ProductionRouting } from '../../production/types'
import type { RestaurantOrderLine } from '../types'
import { isMenuOrderLine } from '../menu-service-model'
import type { OrderLineActionPoint } from '../hooks/useOrderLineLongPress'

type Props = {
  line: RestaurantOrderLine
  label?: string
  entries: ProductionEntry[]
  routing?: ProductionRouting
  disabled: boolean
  initialMode?: 'actions' | 'note'
  point?: OrderLineActionPoint
  onClose: () => void
  onEdit?: () => void
  onSetNote?: (lineId: string, note: string) => Promise<boolean>
  onChangePass?: (input: { lineId: string; componentId?: string | null; passId: string }) => void
}

export function OrderLineActionsModal({ line, label = line.productName, entries, routing, disabled, initialMode = 'actions', point, onClose, onEdit, onSetNote, onChangePass }: Props) {
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

  if (mode === 'actions') return createPortal(<Dropdown isOpen onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
    <Dropdown.Trigger aria-label={`Opciones de ${label}`} className="pointer-events-none fixed h-px w-px opacity-0" style={{ left: point?.x ?? 24, top: point?.y ?? 24 }} excludeFromTabOrder />
    <Dropdown.Popover placement="bottom start" offset={6} containerPadding={12} className="!z-[75] w-72 max-w-[calc(100vw-24px)] !rounded-[14px] !border !border-[var(--separator)] !bg-[var(--surface)] !p-1.5 !text-[var(--foreground)] !shadow-[var(--shadow)]">
      <Dropdown.Menu aria-label={`Opciones de ${label}`} autoFocus="first" shouldCloseOnSelect={false} className="!gap-1 !p-0">
        {onEdit ? <Dropdown.Item id="edit" textValue="Modificar pedido" isDisabled={blocked} onAction={onEdit} className="min-h-12 gap-3 rounded-[9px] px-3 text-sm font-semibold data-[focused=true]:bg-[var(--surface-secondary)]">
          <Pencil aria-hidden="true" className="h-4 w-4 shrink-0" /><span className="flex-1">Modificar pedido</span>
        </Dropdown.Item> : null}
        {onChangePass ? <Dropdown.Item id="pass" textValue="Cambiar pase" isDisabled={blocked || !canChangePass} onAction={() => setMode('pass')} className="min-h-12 gap-3 rounded-[9px] px-3 text-sm font-semibold data-[focused=true]:bg-[var(--surface-secondary)]" aria-description={!canChangePass ? 'Solo disponible antes de enviar a cocina y si hay otros pases.' : undefined}>
          <ArrowRightLeft aria-hidden="true" className="h-4 w-4 shrink-0" /><span className="flex-1">Cambiar pase</span><ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--muted)]" />
        </Dropdown.Item> : null}
        {onSetNote ? <Dropdown.Item id="note" textValue={line.note ? 'Editar comentario' : 'Añadir comentario'} isDisabled={blocked} onAction={() => setMode('note')} className="min-h-12 gap-3 rounded-[9px] px-3 text-sm font-semibold data-[focused=true]:bg-[var(--surface-secondary)]">
          <MessageSquare aria-hidden="true" className="h-4 w-4 shrink-0" /><span className="flex-1">{line.note ? 'Editar comentario' : 'Añadir comentario'}</span><ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--muted)]" />
        </Dropdown.Item> : null}
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown>, document.body)

  return <AppModal dismissDisabled={blocked} label={title} maxWidth={440} onClose={onClose} placement="center" scroll="content">
    <section className="flex max-h-[inherit] min-h-0 flex-col overflow-hidden bg-[var(--surface)] text-[var(--foreground)]">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--separator)] p-5">
        <div className="min-w-0"><h2 className="text-lg font-bold leading-6">{title}</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{label}</p></div>
        <Button aria-label="Cerrar opciones del producto" className="!size-11 !min-h-11 !min-w-11 shrink-0 border border-[var(--separator)] !p-0" disabled={blocked} onClick={onClose} type="button" variant="tertiary"><X aria-hidden="true" className="h-4 w-4" /></Button>
      </header>
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-5">
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
      <footer className="flex shrink-0 justify-end gap-3 border-t border-[var(--separator)] bg-[var(--background)] px-5 py-4">
        <Button className="!min-h-11 !px-4" disabled={blocked} onClick={onClose} type="button" variant="tertiary">{mode === 'note' ? 'Cancelar' : 'Cerrar'}</Button>
        {mode === 'note' ? <Button className="!min-h-11 !px-4" disabled={blocked} onClick={() => void save()} type="button" variant="primary">{saving ? 'Guardando…' : 'Guardar comentario'}</Button> : null}
      </footer>
    </section>
  </AppModal>
}
