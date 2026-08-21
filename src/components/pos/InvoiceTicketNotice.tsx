import { FileText, Pencil, X } from 'lucide-react'

type Props = {
  customerName: string
  disabled?: boolean
  onChange: () => void
  onRemove: () => void
}

export function InvoiceTicketNotice({ customerName, disabled, onChange, onRemove }: Props) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--separator)] bg-[var(--surface-muted)] px-3 py-2 text-sm">
      <FileText className="h-4 w-4 shrink-0 text-[var(--accent)]" />
      <strong className="min-w-0 flex-1 truncate">Factura · {customerName}</strong>
      <button aria-label="Cambiar cliente" className="grid h-8 w-8 place-items-center rounded-[var(--radius)] text-[var(--muted)] hover:bg-[var(--background)]" disabled={disabled} onClick={onChange} title="Cambiar cliente" type="button"><Pencil className="h-4 w-4" /></button>
      <button aria-label="Quitar cliente y volver a ticket normal" className="grid h-8 w-8 place-items-center rounded-[var(--radius)] text-[var(--muted)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]" disabled={disabled} onClick={onRemove} title="Volver a ticket normal" type="button"><X className="h-4 w-4" /></button>
    </div>
  )
}
