import { CheckCircle2, Printer, TestTube2 } from 'lucide-react'
import type { Printer as PrinterType } from '../types'
import { Button } from '../../../components/ui'

export function PrinterList(props: {
  printers: PrinterType[]
  selectedPrinterId: string | null
  disabled?: boolean
  onSelect: (id: string) => void
  onTest: (id: string) => void
}) {
  if (!props.printers.length) return <div className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">No se han detectado impresoras.</div>
  return <div className="grid gap-3">{props.printers.map((printer) => {
    const selected = printer.id === props.selectedPrinterId
    return <article className={`rounded-[var(--radius)] border p-4 ${selected ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--separator)] bg-[var(--background)]'}`} key={printer.id}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 gap-3"><Printer className="mt-1 h-5 w-5 shrink-0" /><div className="min-w-0"><p className="font-black">{printer.displayName || printer.name || printer.model || 'Impresora termica'}</p><p className="text-xs text-[var(--muted)]">{[printer.manufacturer, printer.ip, printer.port, printer.mac].filter(Boolean).join(' · ') || printer.id}</p><p className="mt-1 text-xs font-semibold text-[var(--muted)]">Estado: {selected ? 'Seleccionada' : printer.status || 'Desconocida'}{printer.confidence ? ` · Confianza: ${printer.confidence}` : ''}</p></div></div>
        <div className="flex gap-2"><Button disabled={props.disabled} onClick={() => props.onTest(printer.id)} size="sm" variant="secondary"><TestTube2 className="h-4 w-4" />Prueba</Button><Button disabled={props.disabled || selected} onClick={() => props.onSelect(printer.id)} size="sm"><CheckCircle2 className="h-4 w-4" />{selected ? 'Seleccionada' : 'Seleccionar'}</Button></div></div>
    </article>
  })}</div>
}

